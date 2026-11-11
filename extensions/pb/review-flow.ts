/** The review: /pb:review, pb_report_findings, and the passes behind it. */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum, Type } from "./schema.ts";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext
 } from "@earendil-works/pi-coding-agent";
import { changedPaths, commitTime, skippedLargeFiles, snapshot, staleProseRefs } from "./checkpoint.ts";
import { tip } from "./help.ts";
import { acceptanceDrift, designProvenance, extraBlock, findingLine, isNone, ATTACKER_SYSTEM, reviewSessionPrompt, REVIEW_DIFF_CHARS, reviewerBrief } from "./prompts.ts";
import { REVIEW_TOOLS, acceptanceCoverage, fromProse, mergeFindings, normalizeAcceptance, sensitiveGround, unparsedReport, verdictOf, verifyFindings } from "./review.ts";
import { runFresh } from "./runner.ts";
import { acceptanceCriteria } from "./spec.ts";
import { duration } from "./format.ts";
import { KEBAB_NAME } from "./names.ts";
import { type AcceptanceCheck, type Finding, type ReviewRun, COHERE_TASK_ID, Store, cap, changedSince, diffStat, gitDiff, gitRepo, ledgerFindings, mapCounts, mapTagOf, now, readEvents, resolvesRevision, untrackedText } from "./store.ts";
import { runVerify } from "./verify.ts";
import { inRepo, resolveRepos } from "./repos.ts";
import { P_ORDER, approvalDrift, cmd, commands, contentText, evidenceLine, finalCheckCommands, loadSpec, nextLine, normSpecArg, phaseHeader, post, redNotes, reply, safely, sessionIdOf, sessionModel, sleep, specCompletions, specOfSession, suspiciousCommand, tree, watchable, withChecking } from "./kit.ts";
import { markReviewed, unfinishedPhase } from "./phase.ts";

import { confirmLiveBuild } from "./build-loop.ts";
import { areaNotesFor } from "./map.ts";
import type { ReplacedSessionContext } from "./kit.ts";
export function registerReviewFlow(pi: ExtensionAPI) {
  pi.registerTool({
    name: "pb_report_findings",
    label: "Report findings",
    description:
      "In a pb review session: report the review's findings and acceptance checklist, one call with all of them (empty lists when there are none). Call it again if they change.",
    parameters: Type.Object({
      findings: Type.Array(
        Type.Object({
          priority: StringEnum(["P0", "P1", "P2", "P3"]),
          file: Type.Optional(Type.String({ description: "path relative to the repository root" })),
          line: Type.Optional(Type.Number()),
          title: Type.String({ description: "the problem, in one sentence" }),
          fix: Type.Optional(Type.String({ description: "a concrete fix" })),
          outside: Type.Optional(Type.Boolean({ description: "true when the problem pre-dates this change (outside it): still a finding — give it the priority it deserves, and a serious one (P0/P1) still blocks" })),
          map: Type.Optional(StringEnum(["stated", "wrong"], { description: "in a code review: \"stated\" when the problem breaks a rule the project map in AGENTS.md states; \"wrong\" when the problem is that a map line is wrong (the code contradicts it)" })),
        }),
      ),
      acceptance: Type.Optional(
        Type.Array(
          Type.Object({
            criterion: Type.String({ description: 'the checklist id, e.g. "T1.1"' }),
            status: StringEnum(["met", "not met", "not verified"]),
            evidence: Type.String({ description: "file:line, test name, or why it is not verified; required for met and not met" }),
          }),
        ),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const store = new Store(ctx.cwd);
      const session = ctx.sessionManager.getSessionFile();
      const state = store.reviewSession(session);
      if (!session || !state) throw new Error("This is not a pb review session.");
      const findings = (params.findings as Finding[]).filter((f) => /^P[0-3]$/.test(f.priority) && f.title).map(({ map, ...f }) => (mapTagOf(map) ? { ...f, map: mapTagOf(map) } : f));
      if (state.role === "abuse") {
        store.saveReviewSession(session, { ...state, findings });
        return reply(`Recorded ${findings.length} finding(s). Now reply briefly, then stop.`);
      }
      const expected = state.run ? (store.reviewRun(state.run)?.acceptance ?? []) : [];
      const acceptance = normalizeAcceptance(Array.isArray(params.acceptance) ? params.acceptance : state.acceptance, expected);
      store.saveReviewSession(session, { ...state, findings, acceptance });
      const missing = expected.filter((c) => !acceptance.some((a) => a.criterion === c.id)).map((c) => c.id);
      const closing = missing.length
        ? `Not reported (counts as not verified): ${missing.join(", ")}. Check them if you can, report again, then stop.`
        : "Now reply briefly, then stop.";
      return reply(`Recorded ${findings.length} finding(s) and ${acceptance.length} acceptance result(s). ${closing}`);
    },
  });

  /**
   * The reviewer's pass in its own, real Pi session ("review: <spec> · spec"): you're moved into it and
   * watch it natively; its model is read-only and reports with pb_report_findings. It ends when the model
   * has reported and stopped, or at /pb:review done. Returns what it found, and whether you left meanwhile.
   */

  const drivePass = async (
    c: Pick<ExtensionContext, "isIdle" | "sessionManager">,
    send: ReplacedSessionContext["sendMessage"],
    store: Store,
    o: { label: string; brief: string; resume?: boolean },
  ) => {
    const started = Date.now();
    const idleMs = (store.config().reviewer.idleSec ?? 20) * 1000;
    const session = c.sessionManager.getSessionFile() ?? "";
    try {
      await send(
        {
          customType: "pb",
          content: o.resume
            ? `▶ Continuing the review of **${o.label}** where it was interrupted.`
            : `▶ Review of **${o.label}**, in a fresh session. The model can't change files; you can watch, interrupt and ask it anything. It ends when it has reported its findings and stops (\`/${cmd("review")} done\` ends it now); then pb takes you back.`,
          display: true,
        },
        { triggerTurn: false },
      );
      const first = o.resume
        ? "[pb] You were interrupted. Carry on where you were, then report all your findings with pb_report_findings (including any you reported before) and stop."
        : reviewSessionPrompt(o.brief, store.extra("review"));
      void send({ customType: "pb-instruction", content: first, display: false }, { triggerTurn: true });
      let idle = 0;
      let nudged = false;
      for (;;) {
        await sleep(200);
        const state = store.reviewSession(session);
        if (state?.done) break;
        if (!c.isIdle()) {
          idle = 0;
          continue;
        }
        idle += 200;
        if (state?.findings && idle >= 400) break; // reported, and stopped
        if (!state?.findings && idle >= idleMs) {
          if (nudged) break;
          nudged = true;
          idle = 0;
          void send(
            {
              customType: "pb-instruction",
              content:
                "[pb] Report your findings with pb_report_findings (an empty list if there are none) and every acceptance checklist id, then stop.",
              display: false,
            },
            { triggerTurn: true },
          );
        }
      }
      const branch = tree(c as ExtensionContext).getBranch?.() ?? [];
      const prose = [...branch].reverse().find((e) => e.type === "message" && e.message?.role === "assistant" && contentText(e.message.content).trim());
      const text = prose ? contentText(prose.message!.content).trim() : "";
      const state = store.reviewSession(session);
      if (state?.done) store.saveReviewSession(session, { ...state, done: undefined });
      const findings = state?.findings ?? fromProse(text);
      return { findings, acceptance: state?.acceptance ?? [], prose: text, unparsed: unparsedReport(state?.findings, text), left: false, session, ms: Date.now() - started };
    } catch {
      // You switched to another session: this one can't be driven any more.
      const state = store.reviewSession(session);
      return { findings: state?.findings ?? [], acceptance: state?.acceptance ?? [], prose: "", left: true, session, unparsed: false, ms: Date.now() - started };
    }
  };

  /**
   * The adversarial pass: a fresh background process, like the verifier. It attacks the change in the same
   * frozen brief the reviewer read and reports with the fresh-process tool; nobody needs to watch it, and
   * its saved session is named in the result.
   */

  const runAbusePass = async (ctx: ExtensionContext, store: Store, run: ReviewRun): Promise<ReviewRun["passes"][number]> => {
    const cfg = store.config();
    const started = Date.now();
    let lastStep: string | undefined;
    const paint = () => safely(() => ctx.ui.setWidget("pb-review", [`pb review ${run.label} — adversarial pass · ${Math.round((Date.now() - started) / 1000)}s`, ...(lastStep ? [`  ↳ ${lastStep}`] : [])]));
    paint();
    const beat = watchable(ctx) ? setInterval(paint, 1000) : undefined;
    let res: Awaited<ReturnType<typeof runFresh>>;
    try {
      res = await runFresh({
        cwd: run.cwd,
        role: "abuse",
        systemPrompt: ATTACKER_SYSTEM + extraBlock(store.extra("adversarial")),
        brief: run.brief,
        prompt: "Attack the change in the attached brief: find how it can be abused or broken. Report every finding with report_findings (one call), then stop.",
        tools: ["read", "grep", "find", "ls", "report_findings"],
        extensions: [REVIEW_TOOLS],
        model: run.model,
        thinking: run.thinking,
        maxConcurrent: cfg.maxConcurrent,
        sessionDir: run.name ? store.specSessionsDir(run.name, "abuse") : store.sessionsDir("abuse"),
        onActivity: (line) => {
          lastStep = line;
          paint();
        },
      });
    } finally {
      if (beat !== undefined) clearInterval(beat);
      safely(() => ctx.ui.setWidget("pb-review", undefined));
    }
    const call = res.toolCalls.filter((c) => c.name === "report_findings").at(-1);
    const raw = call && Array.isArray(call.arguments.findings) ? call.arguments.findings : undefined;
    const findings: Finding[] = (raw ?? []).flatMap((item) => {
      const f = item as { priority?: unknown; title?: unknown; file?: unknown; line?: unknown; fix?: unknown; outside?: unknown; map?: unknown };
      if (typeof f.title !== "string" || !f.title.trim() || (f.priority !== "P0" && f.priority !== "P1" && f.priority !== "P2" && f.priority !== "P3")) return [];
      return [{
        priority: f.priority,
        title: f.title.trim(),
        ...(typeof f.file === "string" && f.file.trim() ? { file: f.file.trim() } : {}),
        ...(typeof f.line === "number" && Number.isFinite(f.line) ? { line: f.line } : {}),
        ...(typeof f.fix === "string" && f.fix.trim() ? { fix: f.fix.trim() } : {}),
        ...(f.outside === true ? { outside: true } : {}),
        ...(mapTagOf(f.map) ? { map: mapTagOf(f.map) } : {}),
      }];
    });
    // undefined = no report call; [] = an explicit clean report. A non-empty call that yields no
    // valid finding is malformed and falls back to the prose check, like a missing call.
    const reported = raw === undefined || (raw.length > 0 && findings.length === 0) ? undefined : findings;
    // Its tokens are part of what the review cost: record them like the watched reviewer's own turns.
    if (run.name && res.tokens.input + res.tokens.output + res.tokens.cacheRead + res.tokens.cacheWrite > 0)
      store.event(run.name, {
        type: "review-usage",
        role: "abuse",
        input: res.tokens.input,
        output: res.tokens.output,
        cacheRead: res.tokens.cacheRead,
        cacheWrite: res.tokens.cacheWrite,
        cost: res.cost,
      });
    return { role: "abuse", findings, acceptance: [], prose: res.text, session: res.sessionFile ?? "", left: false, unparsed: unparsedReport(reported, res.text), ms: res.ms, ...(res.error ? { error: res.error } : {}) };
  };

  /** A finished pass joins the run, and its time adds to the review's total. */

  const addPass = (run: ReviewRun, pass: ReviewRun["passes"][number]) => {
    run.passes.push(pass);
    run.ms = (run.ms ?? 0) + (pass.ms ?? 0);
  };

  /**
   * The rest of a review from its saved state: the reviewer in a new session, then the adversarial pass in
   * the background, then the finish. When you leave the reviewer mid-pass, the state is kept (with the
   * interrupted pass) so /pb:review can continue it instead of starting over.
   */

  const reviewNext = async (from: ExtensionCommandContext, store: Store, run: ReviewRun, left = false): Promise<void> => {
    if (left) {
      const cut = run.passes.at(-1);
      store.saveReviewRun({ ...run, interrupted: cut ? { role: cut.role, session: cut.session } : undefined });
      writeReview(store, run, true);
      return;
    }
    const ran = (role: "review" | "abuse") => run.passes.some((p) => p.role === role);
    if (ran("review")) {
      if (run.security && !ran("abuse")) {
        store.saveReviewRun(run);
        addPass(run, await runAbusePass(from, store, run));
        return reviewNext(from, store, run);
      }
      return reviewFinish(from, store, run);
    }
    store.saveReviewRun(run);
    // The carry's parent is the session calling newSession (not the review's home): takeCarry only
    // hands it to that session's child, so an unrelated new session can't steal it.
    const caller = (from as ExtensionContext).sessionManager?.getSessionFile() ?? run.home ?? undefined;
    store.setCarry({ model: run.model, thinking: run.thinking, spec: run.name ?? "", review: { role: "review", spec: run.name }, parent: caller });
    const result = await from.newSession({
      parentSession: run.home,
      setup: async (sm) => {
        sm.appendSessionInfo(`review: ${run.label} · ${run.name ? "spec" : "intent"}`);
      },
      withSession: async (c) => {
        // Fail closed: even if the carry was stolen or expired, this session is a review session.
        const reviewSession = (c as ExtensionContext).sessionManager.getSessionFile();
        if (reviewSession) store.saveReviewSession(reviewSession, { role: "review", spec: run.name, run: run.id });
        const r = await drivePass(c, c.sendMessage, store, { label: run.label, brief: run.brief });
        addPass(run, { role: "review", ...r });
        await reviewNext(c, store, run, r.left);
      },
    }).catch((e) => {
      store.clearCarry(); // a throw must not leave the handover behind either
      throw e;
    });
    if (result.cancelled) {
      store.clearCarry(); // its handover must not leak into a later, unrelated new session
      return reviewNext(from, store, run, true);
    }
  };

  /** Continue an interrupted pass in its own session (`c` is that session), then the rest of the review. */

  const reviewContinue = async (c: ExtensionCommandContext, send: ReplacedSessionContext["sendMessage"], store: Store, run: ReviewRun, cut: NonNullable<ReviewRun["interrupted"]>) => {
    run.passes = run.passes.filter((x) => x.session !== cut.session);
    run.interrupted = undefined;
    store.saveReviewRun(run);
    // Only the reviewer runs in a session to continue; an older run's interrupted adversarial pass
    // now runs in the background like every other.
    if (cut.role !== "review") return reviewNext(c, store, run);
    const r = await drivePass(c, send, store, { label: run.label, brief: run.brief, resume: true });
    addPass(run, { role: "review", ...r });
    await reviewNext(c, store, run, r.left);
  };

  /** The review's message: verdict, findings, what was dismissed or changed during the review, and the sessions. */

  const reviewMessage = (
    run: ReviewRun,
    o: { findings: Finding[]; dismissed: { finding: Finding; evidence: string }[]; changedDuring: string[]; partial: boolean; verificationFailed?: string; verified?: boolean; verificationMs?: number; thrash?: boolean; midBuild?: string[] },
  ) => {
    const findings = [...o.findings].sort((a, b) => P_ORDER.indexOf(a.priority) - P_ORDER.indexOf(b.priority));
    const inChange = findings.filter((f) => !f.outside);
    const outside = findings.filter((f) => f.outside);
    // /pb:fix numbers the stored P0-P2 list; display numbers must match it exactly: in-change
    // first, then outside, P3 nits unnumbered and never fixable.
    const fixable = [...inChange, ...outside].filter((f) => f.priority !== "P3");
    const number = new Map(fixable.map((f, i) => [f, i + 1] as const));
    const counts = P_ORDER.map((k) => findings.filter((f) => f.priority === k).length);
    const finished = (role: "review" | "abuse") => run.passes.some((x) => x.role === role && !x.left && !x.error);
    const unparsed = run.passes.filter((x) => x.unparsed && !x.left).map((x) => (x.role === "review" ? (run.name ? "spec" : "intent") : "adversarial"));
    const failed = run.passes.filter((x) => x.error).map((x) => x.error!.split("\n")[0]);
    // A pass that answered in prose only lost whatever it reported: with nothing parseable
    // there is no verdict to give — a clean one would wave through the very review this is for.
    const lost = unparsed.length > 0 && !findings.length;
    const coverage = acceptanceCoverage(
      run.acceptance,
      run.passes.filter((x) => x.role === "review").flatMap((x) => x.acceptance ?? []),
    );
    // pb's own check outranks the reviewers: over a red one the best a review can say is UNVERIFIED.
    const judged = !run.passes.length || lost ? "none" : verdictOf(findings, coverage);
    const failedChecks = run.failedChecks ?? [];
    const verdict = judged === "pass" && failedChecks.length ? "unverified" : judged;
    const tally = findings.length || o.dismissed.length ? counts.map((c, n) => `P${n} ${c}`).join(" · ") : "";
    const sessions = run.passes
      .filter((x) => x.session)
      .map((x) => `${x.role === "review" ? (run.name ? "spec" : "intent") : "adversarial"} \`pi --session ${sessionIdOf(x.session)}\``);
    const notVerified = coverage.notVerified.length + coverage.missing.length;
    const acceptanceLine = (l: (typeof coverage.lines)[number]) => {
      const mark = l.status === "met" ? "✓ met" : l.status === "not met" ? "✗ not met" : l.status === "not reported" ? "? not verified (not reported)" : "? not verified";
      return `- ${mark} ${l.criterion.id}: ${l.criterion.text}${l.evidence ? ` — ${l.evidence}` : ""}`;
    };
    // What the next review carries: the whole checklist, with an omission stored as not verified.
    const acceptance: AcceptanceCheck[] = coverage.lines.map((l) => ({
      criterion: l.criterion.id,
      status: l.status === "not reported" ? "not verified" : l.status,
      evidence: l.status === "not reported" ? "not reported" : (l.evidence ?? ""),
    }));
    const midBuild = o.midBuild ?? [];
    const stepName = (id: string) => (id === COHERE_TASK_ID ? "coherence pass" : id === "final" ? "final check" : id);
    const midBuildView = midBuild.map(stepName);
    const fixIds = fixable.map((_, i) => i + 1).join(" ");
    // /pb:fix resolves against the recorded review (progress.review.findings), which only a
    // complete run writes: an incomplete one (the adversarial pass missing) would send the
    // human after ids that resolve to nothing — or, on a follow-up, to the previous review.
    const complete = finished("review") && (!run.security || finished("abuse"));
    const next = o.partial
      ? `\`/${cmd("review")}\` continues this review.`
      : lost
        ? `read the ${unparsed.join(" and ")} session${unparsed.length === 1 ? "" : "s"}, then \`/${cmd("review")}\` again.`
        : verdict === "unverified" && failedChecks.length && judged === "pass"
          ? `make ${failedChecks.map((c) => `\`${c}\``).join(", ")} pass (or fix what keeps ${failedChecks.length === 1 ? "it" : "them"} from running), then \`/${cmd("review")}\` again.`
          : verdict === "unverified"
          ? `check each unverified criterion (or amend the spec), then \`/${cmd("review")}\` again — \`/${cmd("review")} --full\` if nothing else changed.`
          : verdict === "changes_needed"
            ? run.name && fixIds && complete
              ? `\`/${cmd("fix")} ${fixIds}\` (or fix them by hand), then \`/${cmd("review")}\` again.`
              : run.name && fixIds
                ? `fix them by hand for now, then \`/${cmd("review")}\` again — this result is incomplete, so \`/${cmd("fix")}\` does not see these findings yet.`
                : run.name
                  ? `fix the P3 nits by hand if you want them, then \`/${cmd("review")}\` again.`
                  : `fix what is above, then \`/${cmd("review")}\` again.`
            : verdict === "pass"
              ? midBuild.length
                ? `\`/${cmd("build")}\` continues the build${midBuildView.length ? `; ${midBuildView.join(", ")} still to do` : ""}.`
                : run.name
                  ? `\`/${cmd("commit")} ${run.name}\` (you see the files and the message first), then \`/${cmd("archive")} ${run.name}\`.`
                  : "commit when ready."
              : `\`/${cmd("review")}\` again, or read the sessions below.`;
    const tipKey = verdict === "pass" ? (midBuild.length ? "review.mid-build" : "review.pass") : verdict === "changes_needed" ? "review.changes" : verdict === "unverified" ? "review.unverified" : "review.other";
    const passMark = finished("review") ? "✓" : run.passes.some((x) => x.role === "review" && x.error) ? "✗" : "—";
    const abuseMark = run.security ? (finished("abuse") ? "✓" : run.passes.some((x) => x.role === "abuse" && x.error) ? "✗" : "—") : "";
    const verifier = o.verified === undefined ? "" : o.verificationFailed ? "verifier ✗" : !o.verified ? "verifier skipped" : (o.verificationMs ?? 1) > 0 ? "verifier ✓" : "verifier —";
    const stat = diffStat(run.cwd, run.before?.commit ?? run.base).split("\n").map((l) => l.trim()).filter(Boolean).at(-1);
    const scopeFacts = [stat, run.base ? `base ${run.base.slice(0, 7)}` : ""];
    const result = lost ? "NO VERDICT" : verdict === "pass" ? "PASS" : verdict === "changes_needed" ? "CHANGES NEEDED" : verdict === "unverified" ? "UNVERIFIED" : "no verdict";
    const text = [
      phaseHeader(verdict === "pass" ? "✅" : verdict === "changes_needed" ? "❌" : "⚠", "Review", `${run.label}${run.followUp ? " (follow-up)" : ""}`, result, tally, finished("abuse") ? "with an adversarial pass" : "", run.ms !== undefined ? duration(run.ms) : ""),
      "",
      nextLine(next),
      evidenceLine(`${run.name ? "spec" : "intent"} pass ${passMark}`, abuseMark ? `adversarial ${abuseMark}` : "", verifier, coverage.enforced ? `${coverage.met}/${coverage.lines.length} criteria met` : "", ...scopeFacts, midBuildView.length ? `mid-build · ${midBuildView.join(", ")} still to build` : ""),
      ...(o.partial
        ? ["", `⚠ You left the review before it finished: this is what had been reported. \`/${cmd("review")}\` continues it.`]
        : []),
      ...(unparsed.length
        ? [
            "",
            lost
              ? `⚠ The ${unparsed.join(" and ")} pass${unparsed.length === 1 ? "" : "es"} reported in prose only — nothing parseable, so there is no verdict. Read the session${unparsed.length === 1 ? "" : "s"} and judge the change yourself, or run /${cmd("review")} again.`
              : `⚠ The ${unparsed.join(" and ")} pass${unparsed.length === 1 ? "" : "es"} reported in prose only — nothing parseable, so findings may be missing above. Read the session${unparsed.length === 1 ? "" : "s"} before trusting this verdict.`,
          ]
        : []),
      ...(failedChecks.length ? ["", `⚠ **pb's check failed before the review**: ${failedChecks.map((c) => `\`${c}\``).join(", ")} — a review never passes over a red check.`] : []),
      "",
      run.passes.find((x) => x.role === "review")?.prose ?? "",
      ...(coverage.enforced
        ? [
            "",
            `**Acceptance** — ${coverage.met}/${coverage.lines.length} met${coverage.notMet.length ? `, ${coverage.notMet.length} not met` : ""}${notVerified ? `, ${notVerified} not verified` : ""}`,
            "",
            ...coverage.lines.map(acceptanceLine),
            ...(notVerified
              ? [
                  "",
                  `A missing or unchecked criterion is never a pass: verify it (or amend the spec if it is not checkable), then run /${cmd("review")} again. If nothing else changed, \`/${cmd("review")} --full\` re-checks the whole change.`,
                ]
              : []),
          ]
        : []),
      ...(inChange.length ? ["", "**Findings**", "", ...inChange.map((f) => findingLine(f, number.get(f)))] : []),
      ...(outside.length ? ["", "**Outside the change** — pre-existing, not caused by this revision", "", ...outside.map((f) => findingLine(f, number.get(f)))] : []),
      ...(o.dismissed.length ? ["", "Dismissed after a second look:", ...o.dismissed.map((d) => `- [${d.finding.priority}${d.finding.outside ? " · Outside the change" : ""}] ${d.finding.title} — ${d.evidence}`)] : []),
      ...(o.changedDuring.length ? ["", `⚠ Files changed while the review ran (left as they are — the reviewer can't write, so these are yours or another session's): ${o.changedDuring.join(", ")}`] : []),
      ...(run.largeFiles?.length ? ["", `⚠ Untracked files over 20 MB are in no snapshot or diff (read them yourself): ${run.largeFiles.join(", ")}`] : []),
      ...(o.thrash ? ["", "⚠ A review pass compacted repeatedly without new reads and wrapped up early: treat its findings as a partial pass."] : []),
      ...(failed.length ? ["", `⚠ The adversarial pass failed (${failed.join("; ")}): its findings are missing, so this result is incomplete. Run \`/${cmd("review")}\` again.`] : []),
      ...(o.verificationFailed ? ["", `⚠ The second look at the blocking findings couldn't run (${o.verificationFailed}): they are reported unconfirmed.`] : []),
      ...(sessions.length ? ["", `The review sessions: ${sessions.join(" · ")}`] : []),
      "",
      tip(tipKey, { spec: run.label }),
    ].join("\n");
    return { text, verdict, counts, findings: fixable, acceptance, complete, abuse: finished("abuse") };
  };

  const allFindings = (run: ReviewRun) => run.passes.flatMap((x) => (x.role === "abuse" ? x.findings.map((f) => ({ ...f, title: `Adversarial: ${f.title}` })) : x.findings));

  /** Never lost: the result (or what was reported so far) is kept with the spec. */

  const writeReview = (store: Store, run: ReviewRun, partial: boolean) => {
    const m = reviewMessage(run, { findings: allFindings(run), dismissed: [], changedDuring: [], partial, verificationFailed: undefined });
    fs.mkdirSync(path.dirname(store.reviewFile(run.name)), { recursive: true });
    fs.writeFileSync(store.reviewFile(run.name), `${m.text}\n`);
    return m;
  };

  /** Double-check, report anything changed while the review ran, record the result, and take you home with it. */

  const reviewFinish = async (from: ExtensionCommandContext, store: Store, run: ReviewRun): Promise<void> => {
    const cfg = store.config();
    const widget = (t?: string[]) => safely(() => from.ui.setWidget("pb-review", t));
    const all = mergeFindings(allFindings(run));
    const checked =
      cfg.reviewer.verify === false
        ? { findings: all, dismissed: [], error: undefined as string | undefined, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0, ms: 0 }
        : await verifyFindings({
            cwd: run.cwd,
            findings: all,
            base: run.base,
            diff: run.diff,
            specPath: run.name ? store.rel("specs", run.name, "spec.md") : undefined,
            model: run.model,
            thinking: run.thinking,
            maxConcurrent: cfg.maxConcurrent,
            sessionDir: run.name ? store.specSessionsDir(run.name, "verifier") : store.sessionsDir("verifier"),
            // Activity only, never the verifier's streaming prose: the verdict lands in the session,
            // and the saved run holds the whole transcript for audit.
            onActivity: (a) => widget([`pb review ${run.label} — verifying P0/P1 findings`, `  ↳ ${a}`]),
          });
    widget(undefined);
    run.ms = (run.ms ?? 0) + checked.ms;
    const after = run.before ? snapshot(run.cwd, `pb: after review ${run.label}`) : undefined;
    // The reviewer has no shell and cannot edit or write, so anything that changed while it ran is
    // someone else's (another session, an editor). Name the paths; never revert another writer's work.
    const changedDuring = run.before && after ? changedPaths(run.cwd, run.before.commit, after.commit) : [];
    // A large untracked file that appeared while the review ran is invisible to that diff too:
    // add it to the ones the brief already named, so the result says what the review couldn't see.
    if (run.before) run.largeFiles = [...new Set([...(run.largeFiles ?? []), ...skippedLargeFiles(run.cwd, commitTime(run.cwd, run.before.commit))])];
    // A stall from an earlier run of this spec must not mark this one: the events carry the run id.
    const thrash = run.name && run.id ? readEvents(path.join(store.specDir(run.name), "events.jsonl")).some((e) => e.type === "compact" && e.run === run.id && (e as { thrash?: unknown }).thrash === true) : false;
    const p = run.name ? store.progress(run.name) : undefined;
    // Synthetic steps included: a review during a coherence pass or the final check must not
    // mark a build that still has work as reviewed.
    const remaining = p ? p.tasks.filter((t) => t.status !== "done").map((t) => t.id) : [];
    const m = reviewMessage(run, {
      findings: checked.findings,
      dismissed: checked.dismissed,
      changedDuring,
      partial: false,
      verificationFailed: checked.error?.split("\n")[0],
      verified: cfg.reviewer.verify !== false,
      verificationMs: checked.ms,
      thrash,
      midBuild: remaining,
    });
    if (run.name && p) {
      store.event(run.name, { type: "review", security: m.abuse, verdict: m.verdict, p: m.counts, dismissed: checked.dismissed.length, ...mapCounts(checked.findings), followUp: run.followUp, ms: run.ms, ...checked.tokens, cost: checked.cost });
      // A lead for later features: completed findings survive the review's own files and the archive.
      const ledger = ledgerFindings(checked.findings);
      if (ledger.length) store.event(run.name, { type: "review-findings", review: run.id, findings: ledger });
      if (m.complete) {
        p.review = { at: now(), snapshot: run.before?.commit, verdict: m.verdict, findings: m.findings, acceptance: m.acceptance };
        // A pass only finishes a finished build: with tasks still open the phase stays,
        // or the next /pb:build strands and /pb:archive offers a half-built spec.
        if (m.verdict === "pass" && !remaining.length) markReviewed(p);
      }
      p.reviewUnshown = true;
      store.saveProgress(p);
    }
    fs.mkdirSync(path.dirname(store.reviewFile(run.name)), { recursive: true });
    fs.writeFileSync(store.reviewFile(run.name), `${m.text}\n`);
    store.clearReviewRun(run.id);
    if (!run.home) return;
    try {
      await from.switchSession(run.home, {
        withSession: async (c) => {
          await c.sendMessage({ customType: "pb", content: m.text, display: true }, { triggerTurn: false });
          const q = run.name ? store.progress(run.name) : undefined;
          if (q) {
            q.reviewUnshown = undefined;
            store.saveProgress(q);
          }
        },
      });
    } catch {
      // you went elsewhere meanwhile: review.md has it, and the next /pb:review shows it
    }
  };

  pi.registerCommand(cmd("review"), {
    description:
      "Independent review: a spec pass by a reviewer who never saw the build, in a fresh session you watch, then an adversarial pass in the background, against the spec or any uncommitted change's intent; pb brings you back with the result. Follow-ups look only at what changed (--full: everything). /pb:review done ends a review session now",
    getArgumentCompletions: specCompletions,
    handler: async (args, ctx) => {
      const store = new Store(ctx.cwd);
      // Inside a review session: /pb:review done ends it.
      const session = ctx.sessionManager.getSessionFile();
      const here = store.reviewSession(session);
      const saved = here ? store.reviewRunForSession(session) : store.interruptedReview(session);
      if (here) {
        // Inside a review session: done ends the pass; continue picks up an interrupted one.
        const cut = saved?.interrupted;
        if (args.trim() === "continue" && saved && cut && cut.session === session) {
          if (!ctx.isIdle()) return ctx.ui.notify("Pi is busy. Wait for the current turn to finish.", "warning");
          return reviewContinue(ctx, async (m, o) => pi.sendMessage(m, o), store, saved, cut);
        }
        if (args.trim() !== "done") return ctx.ui.notify(`This is a review session: \`/${cmd("review")} done\` ends it${saved?.interrupted?.session === session ? `; \`/${cmd("review")} continue\` picks it up where it was interrupted` : ""}.`, "info");
        store.saveReviewSession(session!, { ...here, done: true });
        return ctx.ui.notify("Ending this review pass…", "info");
      }
      if (!ctx.isIdle()) return ctx.ui.notify("Pi is busy. Wait for the current turn to finish.", "warning");
      // An interrupted review: continue it rather than start over.
      if (saved?.interrupted) {
        // An older run's adversarial pass ran in a watched session; it runs in the background now, so
        // the review simply carries on from here instead of reopening that session.
        if (saved.interrupted.role !== "review") {
          const run = { ...saved, interrupted: undefined };
          store.saveReviewRun(run);
          return reviewNext(ctx, store, run);
        }
        const CONTINUE = `Continue the interrupted review of ${saved.label} (the spec pass didn't finish)`;
        const SHOW = "Show what it had reported";
        const NEW = "Start a new review";
        const choice = ctx.hasUI ? await ctx.ui.select("A review was interrupted", [CONTINUE, SHOW, NEW]) : CONTINUE;
        if (!choice) return;
        if (choice === SHOW) {
          if (!fs.existsSync(store.reviewFile(saved.name))) {
            store.clearReviewRun(saved.id); // the spec went away (archived?): this run is dead
            return ctx.ui.notify("The review's file is gone (was the spec archived?). Start a new review.", "warning");
          }
          return post(fs.readFileSync(store.reviewFile(saved.name), "utf8"));
        }
        if (choice === CONTINUE) {
          // Not "interrupted" any more as you arrive: pb is continuing it, no need to say how.
          const cut = saved.interrupted;
          const run = { ...saved, interrupted: undefined };
          store.saveReviewRun(run);
          try {
            await ctx.switchSession(cut.session, { withSession: (c) => reviewContinue(c, c.sendMessage, store, run, cut) });
          } catch {
            store.clearReviewRun(run.id); // its session is gone too: nothing left to continue
            ctx.ui.notify("The interrupted review's session is gone. Start a new review.", "warning");
          }
          return;
        }
        store.clearReviewRun(saved.id);
      }
      // Any older run from this session is superseded now (a crash leaves no interrupted marker,
      // so /pb:review can't offer it): clear them before starting, or they linger unseen.
      store.clearReviewRunsForHome(session);
      const full = /(^|\s)--full(\s|$)/.test(args);
      const rest = args.replace(/(^|\s)--full(?=\s|$)/g, " ").trim();
      const { cfg, testCmd, buildCmd, lintCmd, extraCmds } = commands(ctx.cwd, store);

      // done/continue only mean something inside a review session (handled above).
      if (rest === "done" || rest === "continue") {
        return ctx.ui.notify(`\`/${cmd("review")} ${rest}\` only works inside a review session: \`/${cmd("review")} done\` ends a pass there.`, "info");
      }
      // What to review: a named spec wins over this session's spec (as in /pb:build);
      // without a name, this session's spec; else a built one or the uncommitted change.
      const words = rest.split(/\s+/).filter(Boolean);
      let name: string | undefined;
      let focusRest = rest;
      if (words[0]) {
        const w = words[0];
        // A word that names an existing spec is that spec; one readable under a legacy name is
        // refused. Anything else — path-like words included, which specDir's guard keeps out of
        // paths anyway — falls through as intent text below, unlike /pb:build where it would
        // become a new spec's topic.
        if (KEBAB_NAME.test(w) && store.readSpec(w)) {
          name = w;
          focusRest = words.slice(1).join(" ");
        } else if (!KEBAB_NAME.test(w)) {
          const near = normSpecArg(w);
          const hit = near !== "off" && KEBAB_NAME.test(near) ? store.specNames().filter((n) => n === near) : [];
          if (hit.length === 1 && store.readSpec(hit[0])) {
            name = hit[0];
            focusRest = words.slice(1).join(" ");
          } else if (store.readSpec(w)) {
            return ctx.ui.notify(`\`${w}\` isn't a valid spec name (spec names are lowercase with hyphens). To review, name a spec exactly as written.`, "warning");
          }
        }
      }
      if (!name) name = specOfSession(ctx).name;
      if (!name) {
        const built = store.specNames().filter((n) => ["built", "reviewed", "building", "paused"].includes(store.progress(n)?.phase ?? ""));
        const ADHOC = "The uncommitted change (no spec)";
        if (built.length) {
          const choice = ctx.hasUI ? await ctx.ui.select("Review what?", [...built, ADHOC]) : built[0];
          if (!choice) return;
          name = choice === ADHOC ? undefined : choice;
        }
      }
      const loaded = name ? loadSpec(store, name) : undefined;
      const p = name ? store.progress(name) : undefined;
      if (name && (!loaded || !p)) return ctx.ui.notify(`${store.rel("specs", name, "spec.md")} doesn't parse.`, "error");
      // The code is judged against the spec it was built from: a contract edited after approval
      // hasn't been approved, so the review would bless work against text nobody agreed to.
      const drift = p && p.phase !== "written" ? approvalDrift(store, p) : undefined;
      if (drift) {
        return ctx.ui.notify(
          drift === "missing"
            ? `${name}'s approved copy is missing or no longer matches its approval: run /${cmd("build")} ${name} to re-approve the spec as it stands, then /${cmd("review")} ${name}.`
            : `${name}'s contract changed since the build was approved: run /${cmd("build")} ${name} to re-approve the revision, then /${cmd("review")} ${name}.`,
          "warning",
        );
      }
      // A review that finished while you were elsewhere: show it first.
      if (name && p?.reviewUnshown) {
        if (!fs.existsSync(store.reviewFile(name))) {
          return ctx.ui.notify("The review's file is gone (was the spec archived?). Start a new review.", "warning");
        }
        p.reviewUnshown = undefined;
        store.saveProgress(p);
        return post(fs.readFileSync(store.reviewFile(name), "utf8"));
      }
      // A recorded base that no longer resolves (rewritten history, a shallow clone) would make
      // the diff come back empty and the review pass blind: fall back to HEAD and say so.
      const recordedBase = p?.baseCommit && /^[0-9a-f]{7,64}$/i.test(p.baseCommit) ? p.baseCommit : undefined;
      const base = recordedBase && resolvesRevision(ctx.cwd, recordedBase) ? recordedBase : undefined;
      const baseWarning = !name
        ? undefined
        : recordedBase && !base
          ? `The build's base commit \`${recordedBase}\` no longer resolves here (history rewritten or garbage-collected?): the review compares against HEAD and may miss work committed since.`
          : !recordedBase && gitRepo(ctx.cwd)
            ? "The build didn't record a base commit: the review compares against HEAD and can't separate this change from work committed earlier."
            : undefined;
      if (baseWarning) ctx.ui.notify(baseWarning, "warning");
      const changed = changedSince(ctx.cwd, base);
      // Untracked files over the snapshot cap are in no diff: the reviewer is told to read them.
      // A follow-up only counts those that moved since the last review; a first review uses the
      // build's base. They also keep "nothing changed" from hiding a file no snapshot can see.
      const reviewSince = !full && p?.review?.snapshot ? commitTime(ctx.cwd, p.review.snapshot) : undefined;
      const largeFiles = skippedLargeFiles(ctx.cwd, reviewSince ?? (base ? commitTime(ctx.cwd, base) : undefined));
      if (!name && !changed.length && !largeFiles.length) return ctx.ui.notify("Nothing to review: there are no uncommitted changes.", "info");
      const intent = name ? "" : rest || (ctx.hasUI ? ((await ctx.ui.input("What is the change meant to do? (optional)")) ?? "") : "");

      // Once per project: the model that built the change shares its blind spots; offer a different one.
      if (!cfg.reviewer.model && ctx.hasUI && !store.asked("reviewer-model")) {
        const current = sessionModel(ctx);
        const registry = (ctx as { modelRegistry?: { getAvailable?(): { provider: string; id: string }[] } }).modelRegistry;
        const others = (registry?.getAvailable?.() ?? []).map((m) => `${m.provider}/${m.id}`).filter((m) => m !== current);
        if (others.length) {
          store.markAsked("reviewer-model");
          const KEEP = `Keep ${current ?? "the session's model"}`;
          const choice = await ctx.ui.select(`The reviewer runs on ${current ?? "the session's model"}, which likely built this too. A different model family catches different mistakes:`, [KEEP, ...others]);
          if (choice && choice !== KEEP) {
            store.updateConfig((raw) => ({ ...raw, reviewer: { ...(raw.reviewer ?? {}), model: choice } }));
            cfg.reviewer.model = choice;
            ctx.ui.notify(`The reviewer now runs on ${choice} (reviewer.model in ${store.rel("config.json")}).`, "info");
          }
        }
      }

      const label = name ?? "the uncommitted change";
      // Another session may be building this spec: confirm before reviewing, so its in-flight
      // files aren't mistaken for the review's own and reported as changed during it.
      if (!(await confirmLiveBuild(ctx, store, name, ["building", "paused"], "Review it here anyway?"))) return;
      // The tree as the reviewer sees it, snapshotted before the harness's own check: anything
      // the check or the review changes is reported (never silently reverted), and the next
      // review's delta starts here too.
      const before = cfg.checkpoints ? snapshot(ctx.cwd, `pb: review ${label}`) : undefined;
      // The change as the review starts: the brief's diff, the security read and the verifier's brief
      // all use this one capture, so a check or a later edit cannot change what was reviewed. Capped
      // once, the same text the reviewer reads (and the saved run keeps).
      // The sibling repositories the spec also changes: each one's diff since the build's base there, under its name,
      // in the same frozen capture — the reviewer has no shell to take it, and a change is reviewed whole.
      const siblings = resolveRepos(ctx.cwd, loaded?.spec.repos ?? []).flatMap((r) => {
        if (!r.root) return [];
        const since = p?.repoBases?.[r.name];
        const files = changedSince(r.root, since);
        return files.length ? [{ name: r.name, files, diff: `${gitDiff(r.root, since)}${untrackedText(r.root, files)}`.trim() }] : [];
      });
      const siblingDiffs = siblings.map((s) => `\n\n# The change in ${s.name} (the paths in this diff are inside ${s.name}/)\n\n${s.diff}`).join("");
      const reviewDiff = cap(`${gitDiff(ctx.cwd, base)}${untrackedText(ctx.cwd, changed)}${siblingDiffs}`.trim(), REVIEW_DIFF_CHARS);
      const changedEverywhere = [...changed, ...siblings.flatMap((s) => s.files.map((f) => inRepo(s.name, f)))];
      // Fresh ground truth first: the reviewer should judge what's on disk now. pb runs the build's final-step
      // checks, then each finished task's Test: command — the reviewer has no shell, so these runs are the
      // evidence it can cite for an acceptance line. A red one caps the verdict: a review never passes over it.
      const projectChecks = finalCheckCommands(loaded?.spec, { testCmd, buildCmd, lintCmd, extraCmds });
      const finished = new Set((p?.tasks ?? []).filter((t) => t.status === "done").map((t) => t.id));
      const taskChecks = new Map<string, string[]>();
      for (const t of loaded?.spec.tasks ?? []) {
        // A command that chains shells or reaches the network is never run unasked (as at the pre-approval dry run).
        if (!t.test || !finished.has(t.id) || projectChecks.includes(t.test) || suspiciousCommand(t.test)) continue;
        taskChecks.set(t.test, [...(taskChecks.get(t.test) ?? []), t.id]);
      }
      const results: string[] = [];
      const failedChecks: string[] = [];
      for (const command of [...projectChecks, ...taskChecks.keys()]) {
        safely(() => ctx.ui.setWidget("pb-review", [`pb review ${label} — checking: ${command}`]));
        const v = await withChecking(() => runVerify(command, ctx.cwd, cfg.verifyTimeoutSec, cfg.testOutputCap));
        const owners = taskChecks.get(command);
        results.push(owners ? `${owners.join(", ")}'s Test: ${v.summary}` : v.summary);
        if (v.ok === false) failedChecks.push(command);
        if (command === projectChecks[0] && p && !unfinishedPhase(p.phase)) {
          // A mid-build review must not clobber the build's own last result.
          p.lastVerify = v;
          store.saveProgress(p);
        }
      }
      safely(() => ctx.ui.setWidget("pb-review", undefined));
      const check = results.length ? results.join("\n\n") : "(not run)";

      const prevReview = p?.review;
      let previous: { snapshot: string; findings: Finding[]; changed: string[]; acceptance?: AcceptanceCheck[] } | undefined;
      // A review without a verdict is not a baseline to skip from: the documented next step is
      // another /pb:review, so run it fresh on the same tree instead of reporting "nothing changed".
      if (!full && prevReview?.snapshot && prevReview.verdict !== "none" && before) {
        const since = changedPaths(ctx.cwd, prevReview.snapshot, before.commit);
        if (!since.length && !largeFiles.length) return ctx.ui.notify(`Nothing changed since the last review (${prevReview.verdict}). /${cmd("review")} --full reviews everything again.`, "info");
        previous = { snapshot: prevReview.snapshot, findings: prevReview.findings, changed: since, acceptance: prevReview.acceptance };
      }
      // Fix laps report into their own sessions, not the brief: hand the follow-up review the
      // reports (claims plus test results) so it judges evidence, capped like any test output.
      // The boundary is event order: the last review event at or before the previous review's
      // time (a report stamped in that same second still reads as earlier than it — clock
      // strings truncate to seconds). No such event: every fix event counts, as before.
      const fixReports = (() => {
        if (!name || !previous) return undefined;
        const events = readEvents(path.join(store.specDir(name), "events.jsonl"));
        const at = prevReview?.at ?? "";
        let boundary = -1;
        for (let i = events.length - 1; i >= 0; i--) {
          if (events[i].type === "review" && typeof events[i].at === "string" && (events[i].at as string) <= at) {
            boundary = i;
            break;
          }
        }
        const reports = events
          .slice(boundary + 1)
          .filter((e) => e.type === "fix" && Array.isArray(e.fixed))
          .slice(-3)
          .map((e) => ({
            fixed: (e.fixed as unknown[]).filter((x): x is string => typeof x === "string"),
            skipped: Array.isArray(e.skipped) ? (e.skipped as unknown[]).filter((x): x is string => typeof x === "string") : [],
            tests: typeof e.tests === "string" ? cap(e.tests, cfg.testOutputCap) : "",
          }));
        return reports.length ? reports : undefined;
      })();

      // The abuse pass: on sensitive ground by default (reviewer.security "auto"), or on every review ("always").
      const mode = cfg.reviewer.security ?? "auto";
      const security = mode === "always" ? "always" : mode === "off" ? undefined : sensitiveGround({ spec: loaded?.md, files: changedEverywhere, diff: reviewDiff });
      const acceptance = loaded && name ? acceptanceCriteria(loaded.md, loaded.spec) : undefined;
      const brief = reviewerBrief({
        spec: loaded && name ? { name, parsed: loaded.spec } : undefined,
        acceptance,
        intent,
        base,
        diff: reviewDiff,
        changed: changedEverywhere,
        areaNotes: areaNotesFor(ctx.cwd, changedEverywhere),
        stat: diffStat(ctx.cwd, base),
        check,
        focus: name ? focusRest : "",
        previous,
        testChanges: p?.testChanges,
        redNotes: loaded && p ? redNotes(loaded.spec, p) : undefined,
        openNotes: loaded && p ? p.tasks.flatMap((t) => (t.open && !isNone(t.open) ? [`${t.id}: ${t.open}`] : [])) : undefined,
        fixReports,
        designNote: loaded && name ? designProvenance(loaded.md, readEvents(path.join(store.specDir(name), "events.jsonl"))) : undefined,
        acceptanceDrift: loaded && name ? acceptanceDrift(loaded.md, readEvents(path.join(store.specDir(name), "events.jsonl"))) : undefined,
        humanOverride: p?.edited ? "This spec was edited by hand after writing: judge its shape (Threats, measurements, Contracts, evidence, reasons) as well as its truth." : undefined,
        staleRefs: staleProseRefs(ctx.cwd, base),
        baseWarning,
        largeFiles,
      });
      // Only plain values from here on: `ctx` belongs to this session, which the first pass replaces.
      const run: ReviewRun = {
        cwd: ctx.cwd,
        id: randomUUID(),
        name,
        label,
        brief,
        base,
        diff: reviewDiff,
        security,
        acceptance,
        followUp: !!previous,
        home: ctx.sessionManager.getSessionFile(),
        before: before ? { commit: before.commit, tree: before.tree } : undefined,
        largeFiles,
        model: cfg.reviewer.model ?? sessionModel(ctx),
        thinking: cfg.reviewer.thinking ?? (pi.getThinkingLevel() as string | undefined),
        passes: [],
        ...(failedChecks.length ? { failedChecks } : {}),
      };
      await reviewNext(ctx, store, run);
    },
  });

  /** Laps per finding set before the fix loop stops and escalates (S3 cap). */
}
