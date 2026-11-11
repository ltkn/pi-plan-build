/** The spec review: the one fresh pass before a build, /pb:spec-review, and the findings it records. */
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { snapshot } from "./checkpoint.ts";
import { findingLine, specReviewBrief, SPEC_REVIEWER_SYSTEM, SPEC_CHECK_NAMES } from "./prompts.ts";
import { REVIEW_TOOLS } from "./review.ts";
import { freshProgress } from "./progress.ts";
import { runFresh, runUsage } from "./runner.ts";
import { specAssumptions, acceptanceCriteria, parseSpec, specHash } from "./spec.ts";
import { duration } from "./format.ts";
import { KEBAB_NAME } from "./names.ts";
import { type Finding, Store, cap, gitHead, readEvents } from "./store.ts";
import { safeLine } from "./markdown.ts";
import { P_ORDER, cmd, evidenceLine, loadSpec, nextLine, phaseHeader, post, revertFreshRun, sessionGone, sessionModel, specCompletions, specOfSession, warnLater } from "./kit.ts";
import { unfinishedPhase } from "./phase.ts";

/**
 * The two doors onto one pass. `/pb:build` runs it in front of T1; `/pb:spec-review` runs it on
 * demand for a spec that is ready but must not be built yet. The pass, the event it records and the
 * reuse by `specHash` are one piece of machinery; only what follows the verdict differs, and that
 * is all this carries. `retryCmd` is what to run again — after a fix, or a run that reported nothing.
 */

/**
 * What one gate on a spec text produced. "pass" and "block" are verdicts on exactly the bytes the
 * reviewer read; "error" is a run that reported nothing, "changed" is text edited mid-review, and
 * "gone" is a session replaced under it. A caller that claims coverage must accept only a verdict.
 */
type SpecReviewOutcome = "pass" | "block" | "error" | "changed" | "gone";

type ReviewDoor = {
  opening: string;
  retryCmd: string;
  blockNext: string;
  blockEvidence: string;
  passNext: string;
  passEvidence: string;
  advisoryEvidence: string;
  blockNotify: string;
  noReportNotify: string;
  advisoryNotify: (n: number) => string;
  /** a stored pass is the whole answer at this door, so it is shown; the build door has a T1 to walk into */
  repostStoredPass: boolean;
  /** shown to the human when the pass carries advisory findings: the next step pb offers, named */
  advisoryHint?: string;
};

/**
 * A fresh report's findings, normalized: an unknown priority or an empty title drops the item rather than
 * reaching the human as something they cannot act on. Shared by the spec review and the claim check, so a
 * report is read the same way wherever it comes from.
 */
/** A finding's check tag, as SPEC_CHECK_NAMES spells it; a name outside the list counts as Other rather than minting a category from model text. */
const checkName = (tag: string) => SPEC_CHECK_NAMES.find((n) => n.toLowerCase() === tag.trim().toLowerCase()) ?? "Other";

export const toFindings = (raw: unknown[] | undefined): Finding[] =>
  (raw ?? []).flatMap((item) => {
    const f = item as { priority?: unknown; title?: unknown; file?: unknown; line?: unknown; fix?: unknown; check?: unknown };
    if (typeof f.title !== "string" || !f.title.trim() || (f.priority !== "P0" && f.priority !== "P1" && f.priority !== "P2" && f.priority !== "P3")) return [];
    // Sanitised and bounded — but the bound is generous: the human reads this to decide, and a
    // clipped report is one they can't fully act on. Pathological output still can't fill the ledger.
    const FINDING_FIELD_CAP = 10_000;
    const field = (v: string, max: number) => cap(safeLine(v), max);
    return [{
      priority: f.priority,
      title: field(f.title.trim(), FINDING_FIELD_CAP),
      ...(typeof f.file === "string" && f.file.trim() ? { file: field(f.file.trim(), 300) } : {}),
      ...(typeof f.line === "number" && Number.isFinite(f.line) ? { line: f.line } : {}),
      ...(typeof f.fix === "string" && f.fix.trim() ? { fix: field(f.fix.trim(), FINDING_FIELD_CAP) } : {}),
      ...(typeof f.check === "string" && f.check.trim() ? { check: checkName(f.check) } : {}),
    }];
  });

export const reviewDoor = (name: string, entry: "build" | "standalone" | "harden"): ReviewDoor => {
  const fix = `fix the spec with \`/${cmd("spec")} ${name}\``;
  if (entry === "build") {
    return {
      opening: `▶ **Spec review** — one fresh reviewer checks **${name}** before T1; the verdict lands here.`,
      retryCmd: `/${cmd("build")}`,
      blockNext: `${fix}, then \`/${cmd("build")}\`.`,
      blockEvidence: "the P0 blocks T1; nothing was built",
      passNext: "T1 starts next.",
      passEvidence: "the recorded pass covers this text",
      advisoryEvidence: "the recorded pass covers this text; P1-P3 do not block",
      blockNotify: "❌ Spec review blocks T1 on a P0: fix the spec — the changed contract is reviewed again — or stop here.",
      noReportNotify: "❌ Spec review did not report; nothing was recorded. Run the build again, or point specReviewer.model at a model that reports.",
      advisoryNotify: (n) => `✅ Spec review passed with ${n} advisory finding${n === 1 ? "" : "s"} (shown above); building now.`,
      repostStoredPass: false,
    };
  }
  const again = `/${cmd("spec-review")} ${name}`;
  if (entry === "harden") {
    return {
      opening: `▶ **Spec review** — one fresh reviewer checks **${name}**; pb repairs what it finds.`,
      retryCmd: `/${cmd("spec-harden")} ${name}`,
      blockNext: `${fix}, then \`/${cmd("spec-harden")} ${name}\`.`,
      blockEvidence: "a P0 is repaired before this spec is built",
      passNext: "pb works through these in the next repair lap; the confirming review is its last act, then it is yours.",
      passEvidence: "the recorded verdict covers this text",
      advisoryEvidence: "the recorded verdict covers this text; the repair lap takes what it can settle",
      blockNotify: "❌ Spec review found a P0: pb works through it in the repair lap with the rest.",
      noReportNotify: `❌ Spec review did not report; nothing was recorded. Run \`/${cmd("spec-harden")} ${name}\` again, or point specReviewer.model at a model that reports.`,
      advisoryNotify: () => "✅ Spec review passed; pb takes the findings into the next repair lap.",
      repostStoredPass: true,
    };
  }
  return {
    opening: `▶ **Spec review** — one fresh reviewer checks **${name}** now; the verdict lands here, and \`/${cmd("build")} ${name}\` rides on it.`,
    retryCmd: again,
    blockNext: `${fix}, then \`${again}\`.`,
    blockEvidence: "a P0 means this plan should not be built as written",
    passNext: `\`/${cmd("build")} ${name}\` starts at T1 on this verdict — no second pass while the text is unchanged.`,
    passEvidence: "the recorded verdict covers this text",
    advisoryEvidence: "the recorded verdict covers this text; P1-P3 are yours to weigh",
    blockNotify: `❌ Spec review found a P0: this plan should not be built as written. Fix it with \`/${cmd("spec")} ${name}\`, then \`${again}\`.`,
    noReportNotify: `❌ Spec review did not report; nothing was recorded. Run \`${again}\` again, or point specReviewer.model at a model that reports.`,
    advisoryNotify: () => `✅ Spec review passed (shown above); /${cmd("build")} ${name} starts from this verdict.`,
    repostStoredPass: true,
    advisoryHint: `the advisory findings here are repairable: \`/${cmd("spec-harden")} ${name}\` — one command and it works through them, then hands you the rest.`,
  };
};

/**
 * The pass: independent eyes on the frozen draft that attacks Decisions, re-tests rejected
 * alternatives and flags unmeasured claims. It records the hash of exactly the text it saw, and the
 * HEAD it read the repo in; only a P0 blocks, and a later door reuses that verdict until the spec
 * text changes.
 */

const runSpecReview = async (ctx: ExtensionContext, store: Store, name: string, md: string, door: ReviewDoor): Promise<{ findings: Finding[]; block: boolean; session?: string; prose?: string; ms: number }> => {
  const cfg = store.config();
  const reviewModel = cfg.specReviewer.model ?? sessionModel(ctx);
  const cwd = ctx.cwd;
  const reviewBefore = snapshot(cwd, "pb: before spec-review");
  post(door.opening);
  const progress = freshProgress(ctx, "pb-spec-review", `pb spec-review ${name}`, { sessionsRoot: cwd });
  progress.step("one fresh reviewer reads the frozen draft");
  let res: Awaited<ReturnType<typeof runFresh>>;
  try {
    res = await runFresh({
      cwd,
      role: "spec-review",
      systemPrompt: SPEC_REVIEWER_SYSTEM,
      brief: specReviewBrief(name, md),
      prompt: "Review the spec in the attached file.",
      // `--tools` is the whole selection, extension tools included: without report_findings named
      // here the reviewer has no way to report and every pass fails closed.
      tools: ["read", "grep", "find", "ls", "report_findings"],
      extensions: [REVIEW_TOOLS],
      model: reviewModel,
      thinking: cfg.specReviewer.thinking,
      maxConcurrent: cfg.maxConcurrent,
      sessionDir: store.sessionsDir("spec-review"),
      ...progress.hooks,
    });
  } finally {
    progress.stop();
    revertFreshRun(cwd, (m) => warnLater(ctx, m), "the spec reviewer", reviewBefore, snapshot(cwd, "pb: after spec-review"));
  }
  const call = res.toolCalls.filter((c) => c.name === "report_findings").at(-1);
  const raw = call && Array.isArray(call.arguments.findings) ? call.arguments.findings : undefined;
  const findings = toFindings(raw);
  const session = res.sessionFile;
  if (raw === undefined) {
    const prose = cap(res.text || res.error || "the reviewer returned no findings", 12000);
    store.event(name, { type: "spec-review", verdict: "error", hash: specHash(md), head: gitHead(cwd), findings: 0, reported: [], model: reviewModel, thinking: cfg.specReviewer.thinking, session, prose, ms: res.ms, ...runUsage(res) });
    // The reviewer's own words are the only thing the human can act on: a pass that wrote its whole
    // report as prose did the work, and losing it would leave a dead end with nothing to read.
    return { findings: [], block: true, session, ms: res.ms, ...(prose.trim() ? { prose: cap(prose.trim(), 2000) } : {}) };
  }
  const block = findings.some((f) => f.priority === "P0");
  store.event(name, { type: "spec-review", verdict: block ? "block" : "pass", hash: specHash(md), head: gitHead(cwd), findings: findings.length, reported: findings, model: reviewModel, thinking: cfg.specReviewer.thinking, session, ms: res.ms, ...runUsage(res) });
  return { findings, block, session, ms: res.ms };
};

/**
 * One review per spec text, whichever door asked for it: a pass or a block on this hash is reused;
 * editing the spec makes the next review read the new text. Only a P0 blocks the build; P1-P3 are
 * advisory. Returns whether this text may be built.
 *
 * `note` is what else belongs on the evidence line where the human stands: the standalone door names
 * a build already underway, because a plan-level pass does not re-gate a running one.
 */

export const ensureSpecReviewed = async (ctx: ExtensionContext, store: Store, name: string, md: string, door: ReviewDoor, note?: string, opts?: { fresh?: boolean }): Promise<SpecReviewOutcome> => {
  const hash = specHash(md);
  // A pass is bound to the spec bytes alone: the repository its citations were checked in is not in
  // that hash. A moved HEAD says that ground has moved on, so it is said out loud — and never used
  // to void the pass, because uncommitted drift moves no HEAD: as a gate it would miss half its cases.
  const moved = (recorded: unknown) => {
    const was = typeof recorded === "string" ? recorded : "";
    const at = gitHead(ctx.cwd);
    return was && at && was !== at ? `it read the code at ${was.slice(0, 8)}, HEAD is now ${at.slice(0, 8)}` : "";
  };
  const parsed = parseSpec(md).spec;
  const criteria = acceptanceCriteria(md, parsed).length;
  const assumptions = specAssumptions(md).length;
  const scope = [parsed ? `${parsed.tasks.length} task${parsed.tasks.length === 1 ? "" : "s"}` : "", criteria ? `${criteria} acceptance line${criteria === 1 ? "" : "s"}` : "", assumptions ? `${assumptions} assumption${assumptions === 1 ? "" : "s"}` : ""];
  const last = readEvents(path.join(store.specDir(name), "events.jsonl"))
    .filter((e) => e.type === "spec-review" && (e.verdict === "pass" || e.verdict === "block") && e.hash === hash)
    .at(-1);
  if (!opts?.fresh && last?.verdict === "block") {
    const findings = Array.isArray(last.reported) ? (last.reported as Finding[]) : [];
    const p0 = findings.filter((f) => f.priority === "P0").length;
    post([
      phaseHeader("❌", "Spec review", name, "FAIL", p0 ? `P0 ${p0}` : "", typeof last.ms === "number" ? duration(last.ms) : ""),
      "",
      nextLine(door.blockNext),
      evidenceLine(door.blockEvidence, door.passEvidence, moved(last.head), note),
      "",
      ...(findings.length ? findings.map((f) => `- ${findingLine(f)}`) : ["The reviewer's answer could not be read as findings."]),
    ].join("\n"));
    ctx.ui.notify(door.blockNotify, "warning");
    return "block";
  }
  if (!opts?.fresh && last?.verdict === "pass") {
    // The build door has a T1 to walk into; at this door the recorded verdict is the whole answer, so
    // it is shown with its findings instead of the pass being consumed silently.
    if (!door.repostStoredPass) return "pass";
    const findings = Array.isArray(last.reported) ? (last.reported as Finding[]) : [];
    post([
      phaseHeader("✅", "Spec review", name, "PASS (already on record)", findings.length ? `P1-P3 ${findings.length}` : "no findings", typeof last.ms === "number" ? duration(last.ms) : ""),
      "",
      nextLine(door.passNext),
      evidenceLine(...scope, door.passEvidence, moved(last.head), note),
      ...(findings.length ? ["", "**Advisory**", "", ...findings.map((f) => `- ${findingLine(f)}`)] : []),
      ...(findings.length && door.advisoryHint ? ["", door.advisoryHint] : []),
      ...(typeof last.session === "string" ? ["", `The whole run: \`pi --session ${path.relative(ctx.cwd, last.session)}.\``] : []),
    ].join("\n"));
    ctx.ui.notify(`✅ ${name} already has a pass on this exact text: /${cmd("build")} ${name} starts without a second review.`, "info");
    return "pass";
  }
  const review = await runSpecReview(ctx, store, name, md, door);
  if (sessionGone(ctx)) return "gone";
  if (store.readSpec(name) !== md) {
    ctx.ui.notify(`The spec changed while it was under review: run \`${door.retryCmd}\` again and the new text will be reviewed.`, "warning");
    return "changed";
  }
  const sessionNote = review.session ? `The whole run: \`pi --session ${path.relative(ctx.cwd, review.session)}\`.` : "";
  if (review.block && !review.findings.length) {
    post([
      phaseHeader("❌", "Spec review", name, "FAIL", "no report", review.ms !== undefined ? duration(review.ms) : ""),
      "",
      nextLine(`\`${door.retryCmd}\` to try again, or point the reviewer at a model that reports: \`"specReviewer": {"model": "provider/id"}\` in ${store.rel("config.json")}.`),
      evidenceLine("the reviewer returned no findings through its tool", "nothing was recorded"),
      ...(review.prose ? ["", `What it wrote instead:\n\n${review.prose}`] : []),
      ...(sessionNote ? ["", sessionNote] : []),
    ].join("\n"));
    ctx.ui.notify(door.noReportNotify, "warning");
    return "error";
  }
  if (review.findings.length) {
    const p0 = review.findings.filter((f) => f.priority === "P0");
    const rest = review.findings.filter((f) => f.priority !== "P0");
    const counts = P_ORDER.map((k) => review.findings.filter((f) => f.priority === k).length);
    const tally = counts.map((c, n) => `P${n} ${c}`).join(" · ");
    const sections = [
      phaseHeader(review.block ? "❌" : "✅", "Spec review", name, review.block ? "FAIL" : "PASS", tally, review.ms !== undefined ? duration(review.ms) : ""),
      "",
      nextLine(review.block ? door.blockNext : door.passNext),
      evidenceLine(...scope, review.block ? door.blockEvidence : door.advisoryEvidence, note),
    ];
    if (p0.length) sections.push("", "**P0**", "", ...p0.map((f) => `- ${findingLine(f)}`));
    if (rest.length) sections.push("", "**Advisory**", "", ...rest.map((f) => `- ${findingLine(f)}`));
    if (rest.length && door.advisoryHint) sections.push("", door.advisoryHint);
    if (sessionNote) sections.push("", sessionNote);
    post(sections.join("\n"));
  } else {
    post([
      phaseHeader("✅", "Spec review", name, "PASS", "no findings", review.ms !== undefined ? duration(review.ms) : ""),
      "",
      nextLine(door.passNext),
      evidenceLine(...scope, door.passEvidence, note),
      ...(sessionNote ? ["", sessionNote] : []),
    ].join("\n"));
  }
  if (review.block) {
    ctx.ui.notify(door.blockNotify, "warning");
    return "block";
  }
  if (review.findings.length) ctx.ui.notify(door.advisoryNotify(review.findings.length), "info");
  return "pass";
};

/** Which spec to review: the named one, else this session's, else the only ready one, else ask. */

export const reviewTarget = async (ctx: ExtensionContext, store: Store, word: string | undefined): Promise<string | undefined> => {
  if (word) {
    if (store.readSpec(word)) return word;
    ctx.ui.notify(`No spec \`${word}\` here. /${cmd("status")} lists what there is.`, "warning");
    return undefined;
  }
  const ready = store.specNames().filter((n) => loadSpec(store, n)?.spec.status === "ready");
  if (!ready.length) {
    ctx.ui.notify(`Nothing ready to review yet: /${cmd("spec")} writes the spec first.`, "info");
    return undefined;
  }
  const session = ctx.sessionManager.getSessionFile();
  // Two laps can't be told apart by the one "this session wrote" guess: with several candidates,
  // prefer the one spec the session owns (a build/paused one), else refuse — never pick arbitrarily.
  const written = session ? ready.filter((n) => store.progress(n)?.writtenIn === session) : [];
  const mine = specOfSession(ctx).name ?? (written.length === 1 ? written[0] : undefined);
  if (mine && ready.includes(mine)) return mine;
  if (ready.length === 1) return ready[0];
  if (!ctx.hasUI) {
    // Headless, more than one ready spec: nobody is here to pick, so pb doesn't guess.
    ctx.ui.notify(`Which spec? ${ready.join(", ")} — name it: /${cmd("spec-review")} <name>.`, "warning");
    return undefined;
  }
  const choice = await ctx.ui.select("Review which spec?", ready);
  return choice && ready.includes(choice) ? choice : undefined;
};

/**
 * The pre-build review on its own, for a spec that is ready but must not be built yet: the same
 * fresh pass and the same recorded verdict, so the build that follows starts at T1 without
 * re-reviewing the text. Nothing here reaches a build: that gate stays the one in startBuild, which
 * re-reads the text and compares hashes before anything is approved.
 */

const lastReviewOn = (store: Store, name: string, md: string) => {
  const hash = specHash(md);
  return readEvents(path.join(store.specDir(name), "events.jsonl"))
    .filter((e) => e.type === "spec-review" && (e.verdict === "pass" || e.verdict === "block") && e.hash === hash)
    .at(-1);
};

/** What a lap repairs unless the human names numbers: P0-P2. P3 is polish, and polish adds text the next review reads. */
export const repairable = (list: { id: number; f: Finding }[]) => list.filter((x) => x.f.priority !== "P3");

export const recordedFindings = (store: Store, name: string, md: string): { id: number; f: Finding }[] => {
  const last = lastReviewOn(store, name, md);
  const reported = last && Array.isArray(last.reported) ? (last.reported as Finding[]) : [];
  return reported.map((f, i) => ({ id: i + 1, f }));
};

export const verdictOn = (store: Store, name: string, md: string): "pass" | "block" | undefined => {
  const verdict = lastReviewOn(store, name, md)?.verdict;
  return verdict === "pass" || verdict === "block" ? verdict : undefined;
};

/**
 * A lap is live while the session that owes its report still exists and its report is recent: a lap left
 * by a killed or abandoned session would otherwise lock the spec out of repair until someone found the
 * file to clear. Six hours is a working day, not a wall clock anyone waits on.
 */

export function registerSpecReview(pi: ExtensionAPI) {
  pi.registerCommand(cmd("spec-review"), {
    description: "Review a ready spec with fresh eyes without building it: the same read-only pass that gates T1 (only a P0 counts as blocking), recorded against the exact text, so /pb:build then starts at T1 without a second review. Optional: which spec; --fresh pays for another pass at the same text instead of reusing the recorded verdict",
    getArgumentCompletions: specCompletions,
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) return ctx.ui.notify("Pi is busy. Wait for the current turn to finish.", "warning");
      const store = new Store(ctx.cwd);
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const fresh = tokens.includes("--fresh");
      const word = tokens.filter((t) => t !== "--fresh")[0];
      // The name is the only user string that reaches a path: anything that isn't one is refused here,
      // before store.specDir is ever asked about it.
      if (word && !KEBAB_NAME.test(word)) {
        return ctx.ui.notify(`\`${word}\` isn't a valid spec name (spec names are lowercase with hyphens). Name a spec exactly as written, or run it with no name to review this session's spec.`, "warning");
      }
      const name = await reviewTarget(ctx, store, word);
      if (!name) return;
      const loaded = loadSpec(store, name);
      if (!loaded) {
        return ctx.ui.notify(`${store.rel("specs", name, "spec.md")} doesn't parse. Rewrite it with /${cmd("spec")} ${name}.`, "error");
      }
      if (loaded.spec.status === "planning") {
        return ctx.ui.notify(`${name} is still being planned: there is no contract to review yet. Finish it with /${cmd("spec")} ${name}.`, "warning");
      }
      const p = store.progress(name);
      const underway = p && unfinishedPhase(p.phase) ? `a build of ${name} is underway: this pass does not re-gate it — \`/${cmd("review")} ${name}\` judges the code` : undefined;
      await ensureSpecReviewed(ctx, store, name, loaded.md, reviewDoor(name, "standalone"), underway, { fresh });
    },
  });

  /* --------------------------- spec repair laps ---------------------------- */

  /**
   * The findings recorded against exactly this text, each numbered as its repair lap will be shown them.
   * No verdict on these bytes means no worklist: findings judged different bytes, and pb never carries a
   * finding across an edit — once a build has started, spec prose is the code reviewer's to judge.
   */
}
