/** Spec repair laps: /pb:spec-fix, /pb:spec-harden, pb_spec_fix_done, the claim check, and the driver that runs each lap in a session of its own. */
import * as path from "node:path";
import { Type } from "./schema.ts";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext
 } from "@earendil-works/pi-coding-agent";
import { snapshot } from "./checkpoint.ts";
import { claimCheckBrief, extraBlock, findingLine, reportRegister, SPEC_CLAIM_CHECK_SYSTEM, specFixPrompt } from "./prompts.ts";
import { REVIEW_TOOLS } from "./review.ts";
import { runFresh, runUsage } from "./runner.ts";
import { notifyDesktop } from "./notify.ts";
import { specHash, tokensOf } from "./spec.ts";
import { KEBAB_NAME } from "./names.ts";
import { type Checkpoint, type Finding, type Progress, Store, appendCheckpoint, cap, gitHead, now, pathExists } from "./store.ts";
import { agree, choose, cmd, evidenceLine, loadSpec, nextLine, phaseHeader, post, reply, revertFreshRun, safely, sessionGone, sessionModel, sessionIdOf, specCompletions, specFixCompletions, syncTasks, tree, unresolvedAnchors, warnLater, watchable } from "./kit.ts";
import { ensureSpecReviewed, recordedFindings, repairable, reviewDoor, reviewTarget, toFindings, verdictOn } from "./spec-review.ts";
import { unfinishedPhase } from "./phase.ts";

export const fixLive = (fix: NonNullable<Progress["fix"]>) => pathExists(fix.session) && Date.now() - fix.startedAt < 6 * 60 * 60 * 1000;

/**
 * Open a repair lap: the undo point first, so a lap that rewrote the plan can be dropped whole with
 * /pb:undo; then the lap record; then the brief, queued for driveRepair, which runs it in a fresh session
 * of its own and names that session as the one allowed to report. The lap is a real session, not a
 * read-only run: it probes with pb_try, asks you with pb_ask, and writes through the spec tools, so the
 * format gates and your standards still bind what it writes.
 */

const beginFixLap = (
  ctx: ExtensionContext,
  store: Store,
  name: string,
  p: Progress,
  list: { id: number; f: Finding }[],
  o: { work: "findings" | "claims"; driver: boolean; hash: string; run: string; reviews: number; answers?: string[] },
) => {
  const cfg = store.config();
  const session = ctx.sessionManager.getSessionFile();
  if (!session) {
    // The lap record names the one session allowed to report it; without a session file there is no
    // such name, and a lap nobody can report would sit there blocking the spec.
    ctx.ui.notify("This session has no session file, so pb cannot tie a repair lap to it and open one.", "warning");
    return;
  }
  const lap = (p.fix?.laps ?? 0) + 1;
  if (cfg.checkpoints) {
    const snap = snapshot(ctx.cwd, `pb: before ${name} spec lap ${lap}`);
    if (snap) {
      const rows = store.checkpoints(name);
      // Rows are looked up by id: a later run's lap 1 must not collide with an earlier run's.
      let id = `lap${lap}`;
      for (let n = 2; rows.some((c) => c.id === id); n++) id = `lap${lap}-${n}`;
      const row: Checkpoint = {
        id,
        at: now(),
        ...snap,
        head: gitHead(ctx.cwd),
        tasks: structuredClone(p.tasks),
        task: id,
        kind: "lap",
        spec: store.readSpec(name) ?? "",
        phase: p.phase,
        summary: `the spec repair in lap ${lap}`,
        entry: tree(ctx).getLeafId?.() ?? undefined,
      };
      if (appendCheckpoint(rows, row)) store.saveCheckpoints(name, rows);
    }
  }
  p.fix = {
    session,
    driver: o.driver,
    stage: "lap",
    startedAt: Date.now(),
    hash: o.hash,
    work: o.work,
    ids: list.map((x) => x.id),
    run: o.run,
    laps: lap,
    reviews: o.reviews,
    applied: p.fix?.applied ?? 0,
    rebutted: p.fix?.rebutted ?? 0,
    assumed: p.fix?.assumed ?? 0,
    parked: p.fix?.parked ?? [],
    ...(p.fix?.claimCheck ? { claimCheck: p.fix.claimCheck } : {}),
    ...(p.fix?.claimsTaken ? { claimsTaken: p.fix.claimsTaken } : {}),
  };
  store.saveProgress(p);
  const unverified = unresolvedAnchors(ctx.cwd, list.map(({ f }) => f));
  const extra = [store.extra("spec-fix")?.trim(), unverified.length ? `The review cites paths that don't exist in this project: ${unverified.join(", ")} — treat those locations as unverified; check before you fix or cite.` : undefined].filter(Boolean).join("\n\n");
  queuedLap = { name, lap, prompt: specFixPrompt({ name, work: o.work, items: list.map(({ id, f }) => findingLine(f, id)), lap, answers: o.answers, extra }) };
};

/** The lap beginFixLap opened, waiting for driveRepair to run it in a session of its own. */
let queuedLap: { name: string; lap: number; prompt: string } | undefined;
const takeQueuedLap = (name: string) => {
  const lap = queuedLap?.name === name ? queuedLap : undefined;
  queuedLap = undefined;
  return lap;
};

/** Reminders a lap gets to report before its silence is read as "ended without reporting". */
const LAP_NUDGES = 2;

/**
 * Runs the laps a repair door opened, each in a fresh session seeded with the spec and its worklist — never in
 * the planning conversation, whose role, length and stale beliefs are not the lap's. Between laps it comes back
 * to the session that started the run, where the next step (claim check, review, next lap or digest) runs and
 * posts, so the human reads every result where they planned. The lap session is fenced by the lap record
 * (REPAIR_SESSION_TOOLS) and is the only one that may report.
 */
const driveRepair = async (ctx: ExtensionCommandContext, store: Store, name: string): Promise<void> => {
  const home = ctx.sessionManager.getSessionFile();
  const drop = (why: string) => {
    const p = store.progress(name);
    if (p?.fix) {
      p.fix = undefined;
      store.saveProgress(p);
    }
    ctx.ui.notify(why, "warning");
  };
  if (!home || typeof ctx.newSession !== "function") return drop("This Pi can't open a session for the repair lap, so none was started.");
  let live: ExtensionCommandContext = ctx;
  for (let lap = takeQueuedLap(name); lap; lap = takeQueuedLap(name)) {
    post(`\u25b6 spec-fix ${name} lap ${lap.lap} — in a fresh session seeded with the spec; pb brings you back with what it settled.`);
    // The lap thinks on the model this run started from, not on whatever a new session defaults to.
    const thinking = (live as { thinkingLevel?: string }).thinkingLevel;
    store.setCarry({ model: sessionModel(live), ...(thinking ? { thinking } : {}), spec: name, parent: live.sessionManager.getSessionFile() ?? undefined });
    let lapCtx: ExtensionCommandContext | undefined;
    const seed = lap.prompt;
    const opened = await live
      .newSession({
        parentSession: home,
        setup: async (sm) => {
          sm.appendSessionInfo(`spec-fix: ${name} · lap ${lap.lap}`);
        },
        withSession: async (c) => {
          const cc = c as ExtensionCommandContext;
          lapCtx = cc;
          const file = cc.sessionManager.getSessionFile();
          const p = store.progress(name);
          if (!file || !p?.fix) return;
          p.fix.session = file; // from here on only this session may report the lap
          store.saveProgress(p);
          await c.sendMessage({ customType: "pb-instruction", content: seed, display: true }, { triggerTurn: true });
          for (let n = 0; n < LAP_NUDGES; n++) {
            await cc.waitForIdle();
            if (store.progress(name)?.fix?.stage !== "lap") return; // reported
            await c.sendMessage({ customType: "pb-instruction", content: "Finish the repair lap with pb_spec_fix_done now: every number you were shown, in exactly one list. Then stop.", display: false }, { triggerTurn: true });
          }
          await cc.waitForIdle();
        },
      })
      .catch(() => ({ cancelled: true as const }));
    store.clearCarry(); // taken by the lap's session at its start; never left for an unrelated one
    if (opened.cancelled || !lapCtx) return drop(`The repair lap for ${name} could not open its session, so it was dropped; /${cmd("spec-fix")} ${name} starts it again.`);
    let back: ExtensionCommandContext | undefined;
    await lapCtx
      .switchSession(home, {
        withSession: async (c) => {
          back = c as ExtensionCommandContext;
        },
      })
      .catch(() => undefined);
    if (!back) return; // home is gone: the lap record stays, and /pb:status names the open lap
    live = back;
    const p = store.progress(name);
    if (p?.fix) await advanceSpecFix(live, store, name, p);
  }
};

/**
 * The one cheap question that makes an unattended repair safe to leave running: not "is this spec good"
 * (the full review's job, minutes, and it finds new subjects rather than confirming this repair) but
 * "which load-bearing claims still stand on nothing". Recorded as `spec-check`, never `spec-review`: the
 * build gate reuses review verdicts and must never read a claim check as one. A run that reports nothing
 * is an error, not a clean bill of health.
 */

const runClaimCheck = async (
  ctx: ExtensionContext,
  store: Store,
  name: string,
  md: string,
): Promise<{ claims: Finding[]; reported: boolean; ms: number; session?: string }> => {
  const cfg = store.config();
  const model = cfg.specFix.model ?? sessionModel(ctx);
  // The check is a narrow read; when unconfigured it should not inherit the whole model budget.
  const thinking = cfg.specFix.thinking ?? "low";
  const cwd = ctx.cwd;
  const before = snapshot(cwd, "pb: before spec-check");
  post(`\u25b7 **Claim check** — which load-bearing claims in **${name}** carry no evidence and no \`assumed\` tag.`);
  const started = Date.now();
  let lastStep: string | undefined;
  const paint = () => safely(() => ctx.ui.setWidget("pb-spec-check", [`pb spec-check ${name} · ${Math.round((Date.now() - started) / 1000)}s`, ...(lastStep ? [`  ↳ ${lastStep}`] : [])]));
  paint();
  const beat = watchable(ctx) ? setInterval(paint, 1000) : undefined;
  let res: Awaited<ReturnType<typeof runFresh>>;
  try {
    res = await runFresh({
      cwd,
      role: "spec-check",
      systemPrompt: SPEC_CLAIM_CHECK_SYSTEM + extraBlock(store.extra("spec-check")),
      brief: claimCheckBrief(name, md),
      prompt: "Check the claims in the attached spec.",
      tools: ["read", "grep", "find", "ls", "report_findings"],
      extensions: [REVIEW_TOOLS],
      model,
      thinking,
      maxConcurrent: cfg.maxConcurrent,
      sessionDir: store.sessionsDir("spec-check"),
      onActivity: (line) => { lastStep = line; paint(); },
    });
  } finally {
    if (beat !== undefined) clearInterval(beat);
    safely(() => ctx.ui.setWidget("pb-spec-check", undefined));
    revertFreshRun(cwd, (m) => warnLater(ctx, m), "the claim check", before, snapshot(cwd, "pb: after spec-check"));
  }
  const call = res.toolCalls.filter((c) => c.name === "report_findings").at(-1);
  const raw = call && Array.isArray(call.arguments.findings) ? call.arguments.findings : undefined;
  if (raw === undefined) {
    store.event(name, { type: "spec-check", verdict: "error", hash: specHash(md), findings: 0, reported: [], model, thinking, ms: res.ms, ...runUsage(res) });
    return { claims: [], reported: false, ms: res.ms };
  }
  const claims = toFindings(raw);
  store.event(name, { type: "spec-check", verdict: "pass", hash: specHash(md), findings: claims.length, reported: claims, model, thinking, session: res.sessionFile, ms: res.ms, ...runUsage(res) });
  return { claims, reported: true, ms: res.ms, session: res.sessionFile };
};

/**
 * A lap's parked questions, put to you once, each with pb's recommendation beside it. Unanswered past
 * askTimeoutSec the recommendation is taken and recorded as decided without you; dismissing stops the
 * run, because a human who pressed Esc has not agreed to anything.
 */

const askParked = async (
  ctx: ExtensionContext,
  store: Store,
  name: string,
  p: Progress,
  fix: NonNullable<Progress["fix"]>,
): Promise<{ answers: string[]; stopped: boolean }> => {
  const notes: string[] = [];
  const answers: string[] = [];
  for (const q of fix.parked) {
    const label = `${q.recommendation} (pb's recommendation)`;
    const choice = await choose(ctx, store, q.question, [label, "Neither — let me say"], label, notes);
    if (choice === undefined) return { answers, stopped: true };
    answers.push(`"${q.question}" \u2192 ${choice === label ? q.recommendation : choice}`);
    store.event(name, { type: "spec-fix-answer", run: fix.run, question: q.question, answer: answers[answers.length - 1] });
  }
  // on the record in the live object, not a copy: the caller saves this same progress after asking,
  // and a copy here would be overwritten by that save
  if (notes.length) p.unattended = [...(p.unattended ?? []), ...notes];
  return { answers, stopped: false };
};

/** What a repair run leaves behind: one block saying what it settled, argued, and what it could not establish. */

const fixDigest = (
  store: Store,
  name: string,
  fix: NonNullable<Progress["fix"]>,
  claims: Finding[],
  md: string,
  driver: boolean,
  stoppedWith?: string,
  session?: string,
): string => {
  const tokens = tokensOf(md);
  const clipped = claims.some((f) => /…\[truncated \d+ chars\]/.test(f.title ?? "") || (f.fix !== undefined && /…\[truncated \d+ chars\]/.test(f.fix)));
  const verdict = verdictOn(store, name, md);
  const blocked = verdict === "block";
  const next = stoppedWith
    ? stoppedWith
    : driver
      ? blocked
        ? `\`/${cmd("spec-fix")} ${name}\` — the confirming review still blocks on a P0${claims.length ? `; the un-evidenced claims above are yours to settle or tag \`assumed\`` : ""}.`
        : verdict
          ? `\`/${cmd("build")} ${name}\` — the review's verdict covers this text${claims.length ? `; the un-evidenced claims above are yours to settle or tag \`assumed\`` : ""}.`
          : `\`/${cmd("build")} ${name}\` — it reviews this text before T1${claims.length ? `; the un-evidenced claims above are yours to settle or tag \`assumed\`` : ""}.`
      : `\`/${cmd("spec-review")} ${name}\` — the text changed, so the verdict on the old text does not cover it.`;
  const stopped = stoppedWith !== undefined;
  const hardenStopped = driver && (blocked || stopped);
  return [
    phaseHeader(
      driver ? (hardenStopped ? "\u26a0" : "\u2705") : "\ud83d\udd27",
      driver ? (hardenStopped ? "Spec harden stopped" : "Spec hardened") : "Spec fix",
      name,
      `${fix.applied} applied`,
      `${fix.rebutted} rebutted`,
      fix.assumed ? `${fix.assumed} assumed` : "",
      // Claims a lap took are not re-checked by pb: say they went to a lap, never that none are left.
      claims.length ? `${claims.length} un-evidenced` : driver && fix.claimsTaken ? `${fix.claimsTaken} claim${fix.claimsTaken === 1 ? "" : "s"} sent to a lap` : "no un-evidenced claims",
    ),
    "",
    nextLine(next),
    evidenceLine(
      `${fix.laps} repair lap${fix.laps === 1 ? "" : "s"}`,
      driver ? `${fix.reviews} review${fix.reviews === 1 ? "" : "s"}` : "",
      tokens ? `spec now ~${tokens} tokens` : "",
      fix.parked.length
        ? `${fix.parked.length} question${fix.parked.length === 1 ? "" : "s"} it would not decide`
        : fix.assumed
          ? `${fix.assumed} claim${fix.assumed === 1 ? "" : "s"} tagged assumed`
          : claims.length
            ? `${claims.length} claim${claims.length === 1 ? "" : "s"} without a probe`
            : "it decided everything it was shown",
    ),
    ...(clipped && session ? ["", `Some fields above are clipped by pb's length bound; the uncut text is in the run log: \`pi --session ${path.relative(path.join(store.root, "..", ".."), session)}\`.`] : []),
    ...(claims.length ? [
      "",
      "**Claims with nothing behind them**",
      "Statements the build takes as fact that carry no probe and no `assumed:` tag: settle each with a measurement (the command and what it printed) or tag it `assumed:` with what would falsify it.",
      "",
      ...claims.map((f) => `- ${findingLine(f)}`),
    ] : []),
  ].join("\n");
};

/**
 * The step owed after a repair lap's turn ends — one place, both doors. A lap that never reported is
 * stopped, not looped on; a lap that changed nothing is not checked or re-reviewed (same bytes, same
 * answers, minutes wasted); otherwise the text goes to the claim check, and the driver either hands the
 * next lap, spends its confirming review, or finishes with the digest. A manual lap stops at the check.
 */

export const advanceSpecFix = async (ctx: ExtensionContext, store: Store, name: string, p: Progress): Promise<boolean> => {
  const fix = p.fix;
  if (!fix) return false;
  if (unfinishedPhase(p.phase)) {
    // A build took the plan while this lap's turn was still open: the build holds whatever text the lap
    // had reached, and repairing under it would move the contract that build is holding. Answer false —
    // the build's own settling still owes its pause.
    p.fix = undefined;
    store.saveProgress(p);
    post([
      phaseHeader("\u23f8", "Spec fix", name, `lap ${fix.laps} dropped: the build took the plan`),
      "",
      nextLine(`the build owns the plan now; harden it with \`/${cmd("spec-harden")} ${name}\` after the review.`),
    ].join("\n"));
    return false;
  }
  const cfg = store.config();
  const maxLaps = cfg.specFix.maxLaps ?? 3;
  if (fix.stage === "lap") {
    p.fix = undefined;
    store.saveProgress(p);
    post([
      phaseHeader("\u26a0", "Spec fix", name, `lap ${fix.laps} ended without reporting`),
      "",
      nextLine(`nothing was recorded. \`/${cmd("spec-fix")} ${name}\` to run the lap again, or say what to settle and it will do that.`),
      evidenceLine("a lap that did not report cannot count as one that settled something"),
    ].join("\n"));
    return true;
  }
  const loaded = loadSpec(store, name);
  if (!loaded) {
    p.fix = undefined;
    store.saveProgress(p);
    ctx.ui.notify(`${store.rel("specs", name, "spec.md")} doesn't parse, so the repair stops here. Rewrite it with /${cmd("spec")} ${name}.`, "error");
    return true;
  }
  // The lap's questions come first: they are the part only you can settle.
  let answers: string[] = [];
  if (fix.parked.length) {
    const asked = await askParked(ctx, store, name, p, fix);
    answers = asked.answers;
    fix.parked = [];
    store.saveProgress(p);
    if (asked.stopped) {
      p.fix = undefined;
      store.saveProgress(p);
      post([phaseHeader("\u23f8", "Spec fix", name, "stopped at your question"), "", nextLine(`say what you think, then \`/${cmd("spec-fix")} ${name}\`.`)].join("\n"));
      return true;
    }
  }
  if (specHash(loaded.md) === fix.hash) {
    // Nothing in the text changed: the same check and the same review would return the same list, and a
    // lap given that list again would change nothing again. Say what is left instead of burning minutes.
    p.fix = undefined;
    store.saveProgress(p);
    post(fixDigest(store, name, fix, [], loaded.md, fix.driver, `the lap changed nothing (it parked or assumed everything it was shown): \`/${cmd("spec-review")} ${name}\` when you have decided, or \`/${cmd("spec-fix")} ${name}\` with the numbers you want argued.`, undefined));
    return true;
  }
  const claimCheck = async () => {
    const check = await runClaimCheck(ctx, store, name, loaded.md);
    if (sessionGone(ctx)) return undefined;
    if (!check.reported) {
      p.fix = undefined;
      store.saveProgress(p);
      ctx.ui.notify("The claim check did not report, so pb stopped rather than read silence as clean. Run the lap again, or point specFix.model at a model that reports.", "warning");
      return undefined;
    }
    return check;
  };
  // A manual lap is one lap, on the human's say-so: the claim check is its last step.
  if (!fix.driver) {
    const check = await claimCheck();
    if (!check) return true;
    p.fix = undefined;
    store.saveProgress(p);
    post(fixDigest(store, name, fix, check.claims, loaded.md, false, undefined, check.session));
    return true;
  }
  // The harden run checks claims once, on the first repaired text and before any confirming review: each lap
  // already checks what it wrote, and a check after every lap cost the most for the least. A claim lap runs
  // only while a lap stays free for what the confirming review brings back — those are the findings that
  // matter most, and claim laps must not spend their budget.
  const maxReviews = cfg.specFix.maxReviews ?? 2;
  const reviewsLeft = fix.reviews < maxReviews;
  let checkSession: string | undefined;
  if (!fix.claimCheck) {
    const check = await claimCheck();
    if (!check) return true;
    checkSession = check.session;
    if (check.claims.length && fix.laps < maxLaps - (reviewsLeft ? 1 : 0)) {
      fix.claimCheck = [];
      fix.claimsTaken = check.claims.length;
      store.saveProgress(p);
      beginFixLap(ctx, store, name, p, check.claims.map((f, i) => ({ id: i + 1, f })), { work: "claims", driver: true, hash: specHash(loaded.md), run: fix.run, reviews: fix.reviews, answers: answers.length ? answers : undefined });
      return true;
    }
    fix.claimCheck = check.claims;
    store.saveProgress(p);
  }
  // What the one check found that no lap took: still standing, and yours.
  const claims = fix.claimCheck;
  if (reviewsLeft) {
    fix.reviews += 1;
    store.saveProgress(p);
    const reviewed = await ensureSpecReviewed(ctx, store, name, loaded.md, reviewDoor(name, "harden"));
    if (sessionGone(ctx) || reviewed === "gone") return true;
    if (reviewed !== "pass" && reviewed !== "block") {
      // No verdict on the text: never finish by claiming one covers it. The review door has already
      // said what failed; this marks where the run ended — the probes and edits are in the file,
      // nothing was declared hardened.
      p.fix = undefined;
      store.saveProgress(p);
      const md = store.readSpec(name) ?? loaded.md;
      const stoppedWith = reviewed === "error"
        ? `the confirming review did not report (point \`specReviewer.model\` in ${store.rel("config.json")} at a model that reports, then /${cmd("spec-harden")} ${name} again)`
        : `the spec changed while the confirming review ran (/${cmd("spec-harden")} ${name} again)`;
      post(fixDigest(store, name, fix, claims, md, true, `${stoppedWith} — nothing was declared hardened.`, checkSession));
      return true;
    }
    const md = store.readSpec(name);
    const fresh = md === undefined ? [] : repairable(recordedFindings(store, name, md));
    if (fresh.length && fix.laps < maxLaps) {
      beginFixLap(ctx, store, name, p, fresh, { work: "findings", driver: true, hash: specHash(md ?? loaded.md), run: fix.run, reviews: fix.reviews, answers: answers.length ? answers : undefined });
      return true;
    }
  }
  const md = store.readSpec(name) ?? loaded.md;
  const blocked = verdictOn(store, name, md) === "block";
  store.event(name, { type: "spec-harden", run: fix.run, hash: specHash(md), laps: fix.laps, reviews: fix.reviews, applied: fix.applied, rebutted: fix.rebutted, assumed: fix.assumed, unEvidenced: claims.length, findingsOnText: md === undefined ? 0 : recordedFindings(store, name, md).length });
  p.fix = undefined;
  store.saveProgress(p);
  post(fixDigest(store, name, fix, claims, md, true, undefined, checkSession));
  if (cfg.notify) notifyDesktop(blocked ? "pb: spec harden stopped" : "pb: spec hardened", `${name}: ${fix.laps} repair laps, ${fix.applied} applied, ${claims.length} claims left for you`);
  return true;
};

/**
 * What a repair lap reports. The numbers it may name are the ones its brief showed it, so a report can
 * neither claim a finding it was never given nor quietly drop one by renumbering; only the session the
 * lap record names may report, so another session cannot bless work it did not do.
 */

const openRepair = async (
  ctx: ExtensionContext,
  store: Store,
  named: string | undefined,
  numbers: number[],
): Promise<{ name: string; p: Progress; picked: { id: number; f: Finding }[]; hash: string } | undefined> => {
  const name = await reviewTarget(ctx, store, named);
  if (!name) return undefined;
  const loaded = loadSpec(store, name);
  if (!loaded) {
    ctx.ui.notify(`${store.rel("specs", name, "spec.md")} doesn't parse. Rewrite it with /${cmd("spec")} ${name}.`, "error");
    return undefined;
  }
  if (loaded.spec.status === "planning") {
    ctx.ui.notify(`${name} is still being planned: there is no contract to repair yet. Finish it with /${cmd("spec")} ${name}.`, "warning");
    return undefined;
  }
  const p: Progress = store.progress(name) ?? { spec: name, phase: "written", tasks: syncTasks(loaded.spec, []), updatedAt: now() };
  // One lap per session: two open laps mean pb cannot tell which finding list a report closes, and
  // the other only deadlocks its spec against /pb:build. A dead lap elsewhere is dropped, not obeyed.
  const session = ctx.sessionManager.getSessionFile();
  for (const other of store.fixesOfSession(session)) {
    if (other.name === name) continue; // the named spec's own lap is checked below
    if (!fixLive(other.p.fix!)) {
      other.p.fix = undefined;
      store.saveProgress(other.p);
      continue;
    }
    ctx.ui.notify(`A repair lap for ${other.name} is already open in this session; one session owns one lap. Let it report, or /${cmd("undo")} to take its lap back.`, "warning");
    return undefined;
  }
  if (p.fix && !fixLive(p.fix)) {
    ctx.ui.notify(`The repair lap recorded for ${name} was left open by a session that is gone; pb dropped it and opened this one.`, "info");
    p.fix = undefined;
    store.saveProgress(p);
  } else if (p.fix) {
    ctx.ui.notify(`A repair lap for ${name} is already open${p.fix.session ? ` in \`pi --session ${sessionIdOf(p.fix.session)}\`` : ""}. Let it finish, or /${cmd("undo")} to take its lap back.`, "warning");
    return undefined;
  }
  if (unfinishedPhase(p.phase)) {
    ctx.ui.notify(`${name} is being built: repairing its plan now would change the contract under the running build. Its code is reviewed with /${cmd("review")} ${name}; rewrite the spec with /${cmd("spec")} ${name} after.`, "warning");
    return undefined;
  }
  const all = recordedFindings(store, name, loaded.md);
  if (!all.length) {
    ctx.ui.notify(`Nothing is recorded against this exact text, so there is nothing to repair: /${cmd("spec-review")} ${name} first — a lap repairs findings, it never invents them.`, "info");
    return undefined;
  }
  const byId = new Map(all.map((x) => [x.id, x]));
  if (numbers.length) {
    const missing = numbers.filter((n) => !byId.has(n));
    if (missing.length) {
      ctx.ui.notify(`${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not among the ${all.length} findings recorded for this text (${all.map((x) => x.id).join(", ")}).`, "warning");
      return undefined;
    }
    return { name, p, picked: numbers.map((n) => byId.get(n)!), hash: specHash(loaded.md) };
  }
  const picked = repairable(all);
  if (!picked.length) {
    ctx.ui.notify(`Every finding recorded for ${name} is P3 polish (${all.map((x) => x.id).join(", ")}): name the numbers to have them repaired.`, "info");
    return undefined;
  }
  return { name, p, picked, hash: specHash(loaded.md) };
};

/**
 * Auto-pilot over a written spec: laps that settle, a claim check after each, one confirming review, one
 * last lap. The budget is the point — the loop cannot chase "no findings", because a fresh full pass
 * never runs out of subjects, so it stops on facts it can check (nothing un-evidenced left, laps or
 * review budget spent, or a lap that changed nothing) and hands you what is left with its reasoning.
 */

export function registerRepair(pi: ExtensionAPI) {
  pi.registerTool({
    name: "pb_spec_fix_done",
    label: "Spec repair done",
    description:
      "At the end of a pb spec repair lap (started by /pb:spec-fix or /pb:spec-harden): report which numbered items you applied, which you rebutted (you wrote the argument in Decisions), which you park for the human (question + your recommendation), and which you marked assumed (the claim and what would falsify it), with one line on what the spec now says differently. Every number the brief showed you must appear in exactly one list. Then stop: pb checks the new text for un-evidenced claims and reviews it. " + reportRegister,
    parameters: Type.Object({
      applied: Type.Array(Type.Number(), { description: "the numbers this lap settled by evidence, decision or deletion, as shown in its brief" }),
      rebutted: Type.Array(Type.Number(), { description: "the numbers you argued against, having written the argument and its citation into Decisions" }),
      parked: Type.Array(
        Type.Object({
          id: Type.Number({ description: "the number this question is about, as shown in the brief" }),
          question: Type.String({ description: "one question only the human can answer, in a sentence" }),
          recommendation: Type.String({ description: "what you recommend, and why — it is what runs if nobody answers" }),
        }),
        { description: "only where two defensible answers genuinely differ; not a place to park work you could have settled" },
      ),
      assumed: Type.Array(
        Type.Object({
          id: Type.Number({ description: "the number this claim was shown as, from the brief" }),
          claim: Type.String({ description: "the claim as you tagged it assumed, and what would falsify it" }),
        }),
        { description: "items only the human or production can settle; every one must name what would falsify it" },
      ),
      summary: Type.String({ description: "one line: what the spec says differently now" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const store = new Store(ctx.cwd);
      const owner = store.fixOfSession(ctx.sessionManager.getSessionFile());
      const fix = owner?.p.fix;
      if (!owner || !fix || fix.stage !== "lap") {
        throw new Error("No spec repair lap is open in this session, so nothing was recorded. Report a lap only in the session /pb:spec-fix or /pb:spec-harden started it in.");
      }
      const show = (n: number) => Number.isInteger(n) && fix.ids.includes(n);
      const covered = new Map<number, string>();
      const claim = (n: number, what: string) => {
        if (!show(n)) throw new Error(`${n} is not one of the numbers this lap was shown (${fix.ids.join(", ")}). Report only what the brief gave you.`);
        const previous = covered.get(n);
        if (previous === what) throw new Error(`${n} is in "${what}" twice.`);
        if (previous) throw new Error(`${n} reported both ${previous} and ${what}: it is one or the other.`);
        covered.set(n, what);
      };
      const applied = params.applied ?? [];
      const rebutted = params.rebutted ?? [];
      for (const n of applied) claim(n, "applied");
      for (const n of rebutted) claim(n, "rebutted");
      const parked = (params.parked ?? []).map((q) => {
        const id = Number(q.id);
        claim(id, "parked");
        const question = cap(String(q.question ?? "").trim(), 400);
        const recommendation = cap(String(q.recommendation ?? "").trim(), 400);
        if (!question || !recommendation) throw new Error(`The parked question for ${id} needs both a question and a recommendation.`);
        return { id, question, recommendation };
      });
      const assumed = (params.assumed ?? []).map((a) => {
        const id = Number(a.id);
        claim(id, "assumed");
        const text = cap(String(a.claim ?? "").trim(), 300);
        if (!text) throw new Error(`The assumed entry for ${id} needs the claim and what would falsify it.`);
        return { id, claim: text };
      });
      const missing = fix.ids.filter((n) => !covered.has(n));
      if (missing.length) {
        throw new Error(
          `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} missing from the report: every number the lap was shown (${fix.ids.join(", ")}) must be applied, rebutted, parked or assumed — a partial report would advance on work it never accounted for.`,
        );
      }
      const md = store.readSpec(owner.name);
      store.event(owner.name, {
        type: "spec-fix",
        hash: fix.hash,
        run: fix.run,
        lap: fix.laps,
        work: fix.work,
        applied,
        rebutted,
        parked,
        assumed,
        summary: cap(String(params.summary ?? "").trim(), 600),
        ...(md === undefined ? {} : { tokens: tokensOf(md) }),
        by: "model",
      });
      fix.stage = "advance";
      fix.applied += applied.length;
      fix.rebutted += rebutted.length;
      fix.assumed += assumed.length;
      fix.parked = [...fix.parked, ...parked];
      store.saveProgress(owner.p);
      return reply(`Lap ${fix.laps} recorded: ${applied.length} applied, ${rebutted.length} rebutted, ${parked.length} parked, ${assumed.length} assumed. pb now checks what you wrote and decides the next step — stop here and let it.`);
    },
  });

  /**
   * One repair lap, on your say-so: it works the findings recorded against the exact text now on disk.
   * P3 polish is not picked by default (name its number and it joins) — the default is what a lap can
   * settle without your judgment, which is also what the next review will otherwise find again.
   */

  pi.registerCommand(cmd("spec-fix"), {
    description: "Repair a reviewed spec: one lap over the findings recorded against this exact text — it probes what needs measuring, applies the fix it recommends, argues in Decisions when a finding is wrong, and parks only what it will not decide. Optional: which spec, then the finding numbers (every P0-P2 by default)",
    getArgumentCompletions: specFixCompletions,
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) return ctx.ui.notify("Pi is busy. Wait for the current turn to finish.", "warning");
      const store = new Store(ctx.cwd);
      const words = args.trim().split(/\s+/).filter(Boolean);
      const named = words[0] && !/^\d+$/.test(words[0]) && KEBAB_NAME.test(words[0]) ? words[0] : undefined;
      if (words[0] && !named && !/^\d+$/.test(words[0])) {
        return ctx.ui.notify(`\`${words[0]}\` isn't a valid spec name (spec names are lowercase with hyphens). Name a spec exactly as written, or give finding numbers: \`/${cmd("spec-fix")} 1 4\`.`, "warning");
      }
      const opened = await openRepair(ctx, store, named, words.slice(named ? 1 : 0).filter((w) => /^\d+$/.test(w)).map(Number));
      if (!opened) return;
      beginFixLap(ctx, store, opened.name, opened.p, opened.picked, { work: "findings", driver: false, hash: opened.hash, run: now(), reviews: 0 });
      await driveRepair(ctx, store, opened.name);
    },
  });

  /**
   * The checks a repair door shares: the spec resolves and parses, it isn't mid-build (repairing a plan
   * under a running build would change the contract that build is holding), and no lap is already open.
   * Plus, for the manual door, the findings picked from what the review recorded for this text.
   */

  pi.registerCommand(cmd("spec-harden"), {
    description: "Auto-pilot for a written spec: a review if this text has no verdict, then repair laps with a claim check after each, one confirming review, and a last lap over what it finds. Each finding is settled with evidence, a cut, a decision or an `assumed:` tag; a wrong finding is rebutted in `## Decisions`; only genuinely open calls come back to you. Optional: which spec",
    getArgumentCompletions: specCompletions,
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) return ctx.ui.notify("Pi is busy. Wait for the current turn to finish.", "warning");
      const store = new Store(ctx.cwd);
      const word = args.trim().split(/\s+/).filter(Boolean)[0];
      if (word && !KEBAB_NAME.test(word)) {
        return ctx.ui.notify(`\`${word}\` isn't a valid spec name (spec names are lowercase with hyphens). Name a spec exactly as written, or run it with no name for this session's spec.`, "warning");
      }
      const cfg = store.config();
      const notes: string[] = [];
      const named = word && KEBAB_NAME.test(word) && store.readSpec(word) ? word : undefined;
      const name = await reviewTarget(ctx, store, named);
      if (!name) return;
      const loaded = loadSpec(store, name);
      if (!loaded) return ctx.ui.notify(`${store.rel("specs", name, "spec.md")} doesn't parse. Rewrite it with /${cmd("spec")} ${name}.`, "error");
      if (loaded.spec.status === "planning") return ctx.ui.notify(`${name} is still being planned: there is no contract to harden yet. Finish it with /${cmd("spec")} ${name}.`, "warning");
      const p: Progress = store.progress(name) ?? { spec: name, phase: "written", tasks: syncTasks(loaded.spec, []), updatedAt: now() };
      if (p.fix && !fixLive(p.fix)) {
        ctx.ui.notify(`The repair lap recorded for ${name} was left open by a session that is gone; pb dropped it.`, "info");
        p.fix = undefined;
        store.saveProgress(p);
      } else if (p.fix) return ctx.ui.notify(`A repair lap for ${name} is already open${p.fix.session ? ` in \`pi --session ${sessionIdOf(p.fix.session)}\`` : ""}.`, "warning");
      if (unfinishedPhase(p.phase)) return ctx.ui.notify(`${name} is being built: its plan is frozen while the build holds it. Harden it before /${cmd("build")}, or after the review.`, "warning");

      const recorded = recordedFindings(store, name, loaded.md);
      let findings = repairable(recorded);
      let reviews = 0;
      const verdict = verdictOn(store, name, loaded.md);
      post([
        `\u25b6 **Spec harden** — **${name}**`,
        "",
        `- ${
          findings.length
            ? `${findings.length} finding${findings.length === 1 ? "" : "s"} already recorded against this text${recorded.length > findings.length ? ` (P3 polish is left to you: \`/${cmd("spec-fix")} ${name} <numbers>\` repairs one)` : ""}`
            : verdict
              ? `a ${verdict} is on record for this text; pb reuses it`
              : "no verdict on this text yet: pb runs one review pass first to find the work"
        }`,
        `- budget: at most ${cfg.specFix.maxLaps} repair laps and ${cfg.specFix.maxReviews} review pass${cfg.specFix.maxReviews === 1 ? "" : "es"} in total`,
        `- a lap settles each finding one of four ways: with evidence (it runs the read-only probe and writes the command and result beside the claim), by cutting a claim that nothing supports or needs, by a decision in the spec that says why and names the alternative it rejected, or by an \`assumed:\` tag that says what would prove it wrong`,
        `- a finding it can prove wrong is rebutted in \`## Decisions\` with a \`path:line\` citation, never silently dropped`,
        `- each lap re-checks what it wrote before reporting; after the first lap, one quick check names the claims still standing on nothing, and they get a lap only while one stays free for what the confirming review finds; a lap that changes nothing ends the run`,
        `- P0-P2 are repaired; P3 polish is left to you`,
        `- the calls it won't make come back as questions, each with its recommendation (if you don't answer in time, it takes the recommendation and records that)`,
      ].join("\n"));
      if (!(await agree(ctx, store, `Harden ${name} now?`, notes))) return;

      let md = loaded.md;
      if (!findings.length) {
        if (reviews >= (cfg.specFix.maxReviews ?? 2)) {
          return ctx.ui.notify(`No review budget left to find the work: run /${cmd("spec-review")} ${name} first, then /${cmd("spec-harden")} ${name}.`, "info");
        }
        reviews += 1;
        const reviewed = await ensureSpecReviewed(ctx, store, name, md, reviewDoor(name, "harden"));
        if (sessionGone(ctx) || reviewed === "gone" || reviewed === "changed" || reviewed === "error") return;
        const after = store.readSpec(name);
        if (after === undefined || after !== md) {
          return ctx.ui.notify(`The spec changed while it was under review: run \`/${cmd("spec-harden")} ${name}\` again and the new text will be hardened.`, "warning");
        }
        findings = repairable(recordedFindings(store, name, after));
        if (!findings.length) {
          if (reviewed === "block") {
            return ctx.ui.notify(`The review blocked ${name} but recorded no findings pb can read, so there is no worklist and nothing was declared hardened. Run /${cmd("spec-review")} ${name} again.`, "warning");
          }
          const polish = recordedFindings(store, name, after).length;
          return post([
            phaseHeader("\u2705", "Spec hardened", name, "nothing to repair"),
            "",
            nextLine(`\`/${cmd("build")} ${name}\` — the pass above covers this text and reported ${polish ? `only P3 polish (${polish}); \`/${cmd("spec-fix")} ${name} <numbers>\` repairs one you want` : "no findings"}.`),
            evidenceLine(polish ? "P3 polish is left to you: it adds text the next review reads" : "the review found nothing a repair lap could settle"),
          ].join("\n"));
        }
      }
      beginFixLap(ctx, store, name, p, findings, { work: "findings", driver: true, hash: specHash(md), run: now(), reviews, answers: notes.length ? notes : undefined });
      await driveRepair(ctx, store, name);
    },
  });

  /**
   * Start building a spec. In this session by default: the conversation that planned it
   * stays, and the prompt cache with it. `fresh` opens a new session seeded with the spec
   * instead (command context only: sessions can't be replaced from event handlers).
   * decided: the human already chose where (the spec-approval dialog).
   */
}
