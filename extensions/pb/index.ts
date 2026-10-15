/**
 * pi-plan-build (pb): plan a feature with Pi, turn it into a spec, build it task by task
 * behind checks the harness runs, and have it reviewed with fresh eyes.
 *
 *   /pb:plan <what you want> plan together; the project's files stay untouched (/pb:plan <spec>: continue one)
  *   /pb:approach [idea]    in planning: hear how Pi would approach it (chat only: no writes, no dialogs)
 *   /pb:compact [undo]     planning: write the plan to its spec and reset to it; build: compact to the build's state
 *   /pb:spec [which]       write or revise the spec(s) from the discussion
 *   /pb:build [name]       build a spec here (--fresh: in a new session; --force: skip the spec review); resumes after a pause
 *   /pb:review [focus]     fresh, independent review against the spec, or of any uncommitted change
 *   /pb:deps [scope]       check dependencies and propose upgrades, as a change of their own
 *   /pb:undo [id]          restore the files, and rewind the conversation, to before a task
 *   /pb:stats [all]        tasks, attempts, checks, tokens and cache per spec
 *   /pb:archive [name]     move a finished spec out of the way
 *   /pb:standards [stack]  write the current standards into this project's AGENTS.md (java | vue | plain | yours)
 *   /pb:status             every spec and where it stands
 *   /pb:help [topic]       what to do next
 *
 * Inspired by GVS5H (Gao et al., arXiv:2608.26480): small tasks, a verifier that
 * outranks the model's own "done", and fresh eyes against anchoring. pb has since
 * deviated far from it; see the README's credits.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Snapshot, changedPaths, cleanupIndexes, commitTime, dropCheckpoints, inWorktree, inspectChanges, restore, skippedLargeFiles, snapshot, staleProseRefs } from "./checkpoint.ts";
import { notifyDesktop } from "./notify.ts";
import { HELP_PATH, tip, topic, topics } from "./help.ts";
import {
  EXPLORER_SYSTEM,
  TRY_SYSTEM,
  approachPrompt,
  buildIntro,
  buildMechanics,
  buildStateSummary,
  checkpointPrompt,
  checkpointSummary,
  coherePrompt,
  reviewStateSummary,
  designProvenance,
  continuePlanPrompt,
  continuePrompt,
  depsPrompt,
  explorerBrief,
  tryBrief,
  extraBlock,
  findingLine,
  finishSpecPrompt,
  fixText,
  nudgePrompt,
  planPrompt,
  reviewSessionPrompt,
  reviewerBrief,
  specPrompt,
  specReviewBrief,
  SPEC_REVIEWER_SYSTEM,
  parseSpecReview,
  taskPrompt,
} from "./prompts.ts";
import { CARTOGRAPHER_SYSTEM, MAP_TOKENS, cartographerBrief, findingsOf, mapDiff, mapRepairPhase, mapTokens, missingPaths, normalizeMap, readMap, unresolvedPaths, writeMap } from "./map.ts";
import { type ExploreDetails, LIVE_FLUSH_MS, LIVE_STEPS, LIVE_WRITING_LINES, registerRenderers, renderExploreCall, renderExploreResult, renderTryCall, renderTryResult } from "./render.ts";
import { REVIEW_TOOLS, fromProse, mergeFindings, sensitiveGround, unparsedReport, verdictOf, verifyFindings } from "./review.ts";
import { runFresh, usageOf } from "./runner.ts";
import { type ParsedSpec, SPEC_NAME, type SpecTask, addDecision, buildTask, commitMessage, needsRed, parseSpec, redExemption, redSharing, sectionHeading, sectionOf, semanticErrors, setSection, setStatus, sharedTestCommands, specHash, specReviewGate, taskScopeSemanticErrors, tokensOf } from "./spec.ts";
import { type Stack, agentDir, findStandards, isUserTemplate, projectStack, sectionFor, stackNames, standardsLoaded, templatesDir, writeStandards } from "./standards.ts";
import { loadStats, renderAll, renderCard } from "./stats.ts";
import { type Checkpoint, type Finding, type Progress, type ReviewRun, type ReviewSessionState, type TaskProgress, COHERE_TASK_ID, PREFIX, Store, cap, changedSince, diffStat, gitDiff, gitHead, now, readEvents, untrackedText } from "./store.ts";
import { resolveBuild, resolveVerify, runVerify } from "./verify.ts";

const cmd = (verb: string) => `${PREFIX}:${verb}`;

/** What the pb_ask dialog promises: plain words, one trade-off per option, a reasoned recommendation. */
export const ASK_DESCRIPTION =
  "Ask the human one question and wait for the answer, without stopping your work: a choice between options, or an open question. In a pb build the answer is recorded in the spec's Decisions. Ask only what you can't sensibly decide yourself. Ask independent questions together; ask a question that depends on another's answer only after you have that answer. Phrase every question in plain words a non-expert can follow: one line per option with its trade-off, and your recommendation with one plain reason why — short enough to read in a dialog.";

/** One-line display text for markers and session names: collapse whitespace, cap length. */
const planTitle = (arg: string, n = 60) => {
  const flat = arg.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 3)}…` : flat;
};

/** Cap for the model copy of a /pb:plan description: generous; cap() itself discloses the cut. */
const MODEL_ARG_CAP = 4000;

/** Normalized form for catching near-miss spec names: case, underscores, trailing punctuation. */
const normSpecArg = (arg: string) => arg.toLowerCase().replace(/_/g, "-").trim().replace(/[.!?…]+$/, "").trim();

/**
 * True when an extension context's session is gone (replaced or reloaded while awaiting):
 * probes one guarded property, never throws. After a long await (a fresh-model run, a dialog
 * with a timeout, a suite run) the human may have moved on; a dead session must end the run
 * quietly — state in .pi/pb is already saved, and rerunning the command resumes from it —
 * instead of throwing a stale-context error.
 */
export const sessionGone = (ctx: Pick<ExtensionContext, "hasUI">): boolean => {
  try {
    void ctx.hasUI;
    return false;
  } catch {
    return true;
  }
};

/** Coherence pays off once slices can drift: smaller builds skip the pass. */
const COHERE_MIN_TASKS = 3;

/** Pi compacts at the context window minus this reserve (its default reserveTokens): a checkpoint must come earlier. */
const PI_RESERVE_TOKENS = 16384;
/** Above this, a spec gets a gentle note about its size; never a rejection. */
const LONG_SPEC_TOKENS = 12000;

/** What the model is told about a spec's size after writing it. */
const sizeNote = (tokens: number) =>
  `~${tokens} tokens${tokens > LONG_SPEC_TOKENS ? ". That's long: if it copies code or repeats facts, pointing to the code and stating each fact once would help the next reader; if it's all needed, keep it" : ""}`;

/**
 * Structural warnings for a spec's author: advisory, never rejections. A shared Test: command means the
 * later tasks auto-proceed as pre-green once the earlier proves it; missing Contracts on a multi-task
 * spec leaves every seam for the tasks to invent.
 */
/** A Test: command that cannot fail (so red is impossible and the build wedges demanding it). */
const noopCommand = (command: string) => {
  const cmd = command.trim();
  if (/^(true|:|exit 0)\s*$/.test(cmd)) return true;
  // A bare echo/printf with no shell operators always exits 0; piped ones can fail, so they're fine.
  return /^(echo|printf)(\s|$)/.test(cmd) && !/[|&;><$`]/.test(cmd);
};

/**
 * A Test: command that chains shells or reaches the network: it runs in the harness with your
 * privileges, so review it before building. The build's agent can already run bash, so this isn't
 * a new privilege — but the dry-run below must not execute it before you've approved the spec.
 */
const suspiciousCommand = (command: string) => {
  const cmd = command.trim();
  if (/[;`$<>]/.test(cmd)) return true;
  if (/\|/.test(cmd)) return true;
  return /\b(curl|wget)\b/.test(cmd);
};

/**
 * Rewriting a finished spec keeps its done state (statuses carry by task id): warn when the
 * new task list differs, so a new change on an old name doesn't silently inherit "done".
 * Advisory only: revising a reviewed spec after findings is legitimate.
 */
const rewriteWarning = (name: string, prev: Progress | undefined, spec: ParsedSpec): string | undefined => {
  if (!prev || !["built", "reviewed"].includes(prev.phase)) return undefined;
  if (!(prev.tasks ?? []).some((t) => t.status === "done")) return undefined;
  const same = spec.tasks.length === prev.tasks.length && spec.tasks.every((t) => prev.tasks.some((o) => o.id === t.id && o.title === t.title));
  if (same) return undefined;
  return `\`${name}\` was already ${prev.phase} with done tasks: they keep their status. If this is a new change rather than a revision, write a new spec instead — new specs start with all tasks todo`;
};

/**
 * Acceptance lines on tasks with a Test: line must name their proof `(tests: ...)` or their
 * exemption `(non-testable: ...)`, so uncovered lines can't slip to review unnoticed. Qualified
 * variants (`Acceptance (abuse):`, `Acceptance (race):`) count as acceptance lines too: a label
 * must not smuggle a line past the gate. Tasks without a Test: line are proven by the gate suite
 * by construction. Readers stay lenient: only the write tools call this, so in-flight specs keep working.
 */
const acceptanceLine = /^\s*-\s*Acceptance(\s*\([^)]*\))?:/m;
const acceptanceMarkerErrors = (spec: ParsedSpec): string[] =>
  spec.tasks.flatMap((t) => {
    if (!t.test) return [];
    return t.text
      .split("\n")
      .filter((l) => acceptanceLine.test(l) && !/\(tests:|\(non-testable:/.test(l))
      .map((l) => `${t.id} ${l.trim()} — add (tests: ...) naming the proving tests, or (non-testable: reason)`);
  });

const specWarnings = (md: string, spec: ParsedSpec): string[] => {
  const redEligible = (t: SpecTask) => spec.gate === "tests" && spec.newTests && !/^\(refactor\)/i.test(t.title);
  const shared = sharedTestCommands(spec).map(
    ({ command, ids }) => `\`${command}\` is the Test: of ${ids.join(", ")}: the later auto-proceed as pre-green once the earlier proves it (the reviewer sees each) — a shared command must still fail at each task's turn`,
  );
  const contracts =
    spec.tasks.length > 1 && !new RegExp(`^##\\s+Contracts\\s*$`, "mi").test(md)
      ? [`${spec.tasks.length} tasks and no ## Contracts: pin every seam they share (and which task owns each side); if truly independent, ignore this`]
      : [];
  const untestable = spec.tasks.flatMap((t) => {
    if (!redEligible(t) || !acceptanceLine.test(t.text)) return [];
    if (t.test) {
      if (noopCommand(t.test)) return [`${t.id}'s Test: \`${t.test}\` always passes — the build will wedge demanding red; omit Test: (disclosed to the reviewer) or write a command that fails without the change`];
      if (suspiciousCommand(t.test)) return [`${t.id}'s Test: \`${t.test}\` chains shells or reaches the network — it runs with your privileges, so review it before building; the dry-run below doesn't execute it`];
      return [];
    }
    // A declared doc-only task (doc-only, documentation-only, prose-only) whose every acceptance
    // line is already exempted needs no nudge: the reviewer judges whether the exemption is
    // legitimate, as with any (non-testable:) line.
    if (/doc(?:s|umentation)?[- ]only|prose[- ]only/i.test(t.text) && t.text.split("\n").filter((l) => acceptanceLine.test(l)).every((l) => /\(non-testable:/.test(l))) return [];
    return [`${t.id} adds behaviour but has no Test: line — add a targeted command, or leave it out and the reviewer judges its tests at the end`];
  });
  return [...shared, ...contracts, ...untestable];
};

/** Spec names for argument completion (completions run without a ctx, in Pi's working directory). */
const specCompletions = (prefix: string) =>
  new Store(process.cwd())
    .specNames()
    .filter((n) => n.startsWith(prefix))
    .map((n) => ({ value: n, label: n }));

type Entry = { id: string; parentId: string | null; type: string; message?: { role?: string; content?: unknown } };
type Tree = { getLeafId?(): string | null; getEntry?(id: string): Entry | undefined; getSessionName?(): string | undefined; getBranch?(): Entry[] };
const contentText = (c: unknown) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((x: { type?: string; text?: string }) => (x.type === "text" ? (x.text ?? "") : "")).join("") : "");
const tree = (ctx: ExtensionContext) => ctx.sessionManager as unknown as Tree;

const text = (t: string) => [{ type: "text" as const, text: t }];
/** What `pi --session` takes for a session file: its id, as getSessionId() derives it. */
const sessionIdOf = (file: string) => path.basename(file, ".jsonl");
/** A tool result the agent carries on from. */
const reply = (t: string) => ({ content: text(t), details: undefined });
/** The last few non-empty lines of a text being written, for a live view. */
const tail = (t: string, n = 3) =>
  t
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim())
    .slice(-n);

/** A UI update from a callback that may outlive its session (you switched away): skipped instead of crashing Pi. */
const safely = (f: () => void) => {
  try {
    f();
  } catch {
    // the session was replaced: there's nothing to draw on any more
  }
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The context Pi hands over after a session switch (newSession/switchSession's withSession). */
type ReplacedSessionContext = Parameters<NonNullable<Parameters<ExtensionCommandContext["newSession"]>[0]>["withSession"] & {}>[0];

/** The tools a review session's model gets: read-only, plus the one it reports with. */
const REVIEW_SESSION_TOOLS = ["read", "grep", "find", "ls", "bash", "pb_report_findings"];

/** A tool result that ends the agent's run: the build paused or finished. */
const stop = (t: string) => ({ content: text(t), details: undefined, terminate: true });

export default function pb(pi: ExtensionAPI) {
  /* ------------------------------- helpers ------------------------------- */

  /** Visible in the session, and part of its context so you can discuss it (during a run, Pi adds it at the end of the turn). */
  const post = (content: string) => pi.sendMessage({ customType: "pb", content, display: true }, { triggerTurn: false });
  /** A short visible marker plus full instructions that start a turn. */
  const instruct = (marker: string, prompt: string) => {
    post(marker);
    pi.sendMessage({ customType: "pb-instruction", content: prompt, display: false }, { triggerTurn: true, deliverAs: "followUp" });
  };

  const commands = (cwd: string, store: Store) => {
    const cfg = store.config();
    return { cfg, testCmd: resolveVerify(cfg.verify, cwd), buildCmd: resolveBuild(cfg.build, cwd) };
  };

  const loadSpec = (store: Store, name: string): { md: string; spec: ParsedSpec } | undefined => {
    const md = store.readSpec(name);
    const spec = md ? parseSpec(md).spec : undefined;
    return md && spec ? { md, spec } : undefined;
  };

  /**
   * Append one Decisions line to a spec, or refuse with the reason. The result must still parse: a
   * writer that doesn't recognise a heading its readers accept once produced a duplicate section.
   * The one write path for decisions, assumptions and /pb:build guidance.
   */
  const appendDecision = (store: Store, name: string, text: string, update: "decisions" | "guidance" = "decisions"): string | undefined => {
    const md = store.readSpec(name);
    if (!md) return `no spec "${name}"`;
    const updated = addDecision(md, text);
    const errors = parseSpec(updated).errors;
    if (errors.length) return `the spec wouldn't parse afterwards: ${errors.join("; ")}`;
    store.writeSpec(name, updated);
    store.event(name, { type: "spec", update });
    return undefined;
  };

  /** Put back what a fresh run (explorer, trier) changed; a guard that couldn't run is said out loud. */
  const revertFreshRun = (ctx: ExtensionContext, what: string, before: Snapshot | undefined, after: Snapshot | undefined) => {
    if (!before || !after || before.tree === after.tree) return;
    const r = restore(ctx.cwd, after.commit, before.commit);
    if (r.guardFailed) ctx.ui.notify(`Couldn't check what ${what} changed (the guard snapshot failed), so nothing was put back: check the working tree yourself.`, "warning");
  };

  /** Keep task statuses by id when a spec is (re)written; new tasks start as todo. */
  const syncTasks = (spec: ParsedSpec, old: TaskProgress[] = []): TaskProgress[] => {
    const sharing = redSharing(spec);
    const byId = new Map(old.map((o) => [o.id, o]));
    return spec.tasks.map((t) => {
      const prev = byId.get(t.id);
      // A red proof belongs to the exact Test: command it ran. A rewritten command re-requires proof;
      // legacy proofs without a recorded command can't be verified, so they don't carry over.
      const redKept = prev?.red && prev?.redCommand !== undefined ? prev.redCommand === t.test : undefined;
      const red = redKept ? prev!.red : undefined;
      const redCommand = redKept ? prev!.redCommand : undefined;
      // A pre-green pointer is valid only when the earlier task still exists before this one,
      // still runs the same command, and still holds its own proof.
      let preGreen: string | undefined;
      if (prev?.preGreen) {
        const earlierId = prev.preGreen;
        const earlier = spec.tasks.find((x) => x.id === earlierId);
        const earlierPrev = byId.get(earlierId);
        const earlierIndex = earlier ? spec.tasks.indexOf(earlier) : -1;
        const currentIndex = spec.tasks.indexOf(t);
        if (
          earlier &&
          earlierIndex >= 0 &&
          earlierIndex < currentIndex &&
          earlier.test !== undefined &&
          earlier.test === t.test &&
          earlierPrev?.status === "done" &&
          earlierPrev.red &&
          (earlierPrev.redCommand === undefined || earlierPrev.redCommand === earlier.test)
        ) {
          preGreen = earlierId;
        }
      }
      return { id: t.id, title: t.title, status: prev?.status ?? "todo", attempts: prev?.attempts ?? 0, summary: prev?.summary, changed: prev?.changed, caveat: prev?.caveat, rejected: prev?.rejected, open: prev?.open, red, redCommand, redShared: sharing.get(t.id), preGreen };
    });
  };

  /**
   * Files finished tasks changed, from their checkpoints: what the current task inherits and
   * must not redo. Harness-computed from snapshots (never the model's claim), so a task that
   * changed nothing outside its slice shows up here. Empty outside git or without checkpoints.
   */
  const touchedSuffix = (ctx: ExtensionContext, store: Store, p: Progress, currentId: string): string => {
    if (!store.config().checkpoints) return "";
    let cps: ReturnType<Store["checkpoints"]> = [];
    try {
      cps = store.checkpoints(p.spec);
    } catch {
      return "";
    }
    const lines: string[] = [];
    for (const t of p.tasks) {
      if (t.id === currentId || t.status !== "done") continue;
      const files = cps.find((c) => c.id === t.id)?.files ?? [];
      if (!files.length) continue;
      lines.push(`- ${t.id}: ${files.slice(0, 12).join(", ")}${files.length > 12 ? `, +${files.length - 12} more` : ""}`);
    }
    return lines.length ? `\n\nTouched so far, by finished tasks (re-read what you need; don't redo it, and flag a file outside the task's slice):\n${lines.join("\n")}` : "";
  };

  /** What the agent is told for a step of the build: a spec task. */
  const stepPrompt = (ctx: ExtensionContext, store: Store, spec: ParsedSpec, p: Progress, task: SpecTask, attempts: number) => {
    const { cfg, testCmd, buildCmd } = commands(ctx.cwd, store);
    const tp = p.tasks.find((t) => t.id === task.id);
    const red = needsRed(spec, task);
    return taskPrompt(task, attempts, cfg.maxAttempts, checkCommand(spec, task, testCmd, buildCmd, false, cfg.taskChecks === "each"), red && !tp?.red) + touchedSuffix(ctx, store, p, task.id);
  };

  /**
   * The tasks whose new tests carry no proof, for the reviewer and the build's end: each with why it has
   * none, or — proven, but sharing its Test: command — why that run doesn't prove its own tests.
   */
  const redNotes = (spec: ParsedSpec, p: Progress): string[] =>
    spec.tasks.flatMap((t) => {
      const tp = p.tasks.find((x) => x.id === t.id);
      if (tp?.preGreen) return [`${t.id}: \`${t.test}\` already satisfied by ${tp.preGreen}'s proven run, so no run proves ${t.id}'s own tests`];
      if (!tp?.red) return [`${t.id}: ${redExemption(spec, t) ?? "its new tests were never seen failing"}`];
      return tp.redShared ? [`${t.id}: \`${t.test}\` is also ${tp.redShared}'s Test: command, so that one run doesn't prove ${t.id}'s own tests`] : [];
    });

  const mark = (t: TaskProgress) => (t.status === "done" ? "✓" : t.status === "doing" ? "▸" : t.status === "blocked" ? "✗" : "·");
  const taskLine = (t: TaskProgress) => `${mark(t)} ${t.id} ${t.title}${t.attempts > 1 ? ` (${t.attempts} attempts)` : ""}`;

  /** The standards to put in a message: none when this session already loaded them from AGENTS.md. */
  const standardsFor = (ctx: ExtensionContext): string => {
    const found = findStandards(ctx.cwd);
    if (!found) return "";
    const opts = (ctx as Partial<ExtensionCommandContext>).getSystemPromptOptions?.();
    return opts && standardsLoaded(opts.contextFiles) ? "" : found.text;
  };

  const sessionModel = (ctx: ExtensionContext) => (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
  const findModel = (ctx: ExtensionContext, spec: string) => {
    const slash = spec.indexOf("/");
    return (ctx as { modelRegistry?: { find(p: string, id: string): unknown } }).modelRegistry?.find(spec.slice(0, slash), spec.slice(slash + 1));
  };

  const specOfSession = (ctx: ExtensionContext) => {
    const store = new Store(ctx.cwd);
    const name = store.specForSession(ctx.sessionManager.getSessionFile());
    return { store, name, progress: name ? store.progress(name) : undefined };
  };

  const unfinishedPhase = (phase?: string) => ["building", "paused"].includes(phase ?? "");
  const nextTodo = (p: Progress) => p.tasks.find((t) => t.status === "doing" || t.status === "todo");

  /** The build's task list above the editor while it runs. */
  const showProgress = (ctx: ExtensionContext, p: Progress | undefined, note?: string) => {
    if (!ctx.hasUI) return;
    if (!p || !unfinishedPhase(p.phase)) return ctx.ui.setWidget("pb", undefined);
    const status = note ?? (p.phase === "paused" ? "paused" : "");
    ctx.ui.setWidget("pb", [`pb ${p.spec}  ${p.tasks.map((t) => `${mark(t)}${t.id}`).join(" ")}${status ? `  · ${status}` : ""}`]);
  };

  /**
   * Dialog patience: ms counts idle time, not wall time. Any terminal input (TUI only)
   * restarts the countdown, so a slow-but-present human never loses a dialog while a truly
   * away human still gets the fallback. Headless keeps the absolute timeout. Returns the
   * dialog result plus whether it timed out while idle.
   */
  const patiently = async <T>(ctx: ExtensionContext, ms: number, run: (opts: { signal?: AbortSignal; timeout?: number } | undefined) => Promise<T>): Promise<{ result: T; timedOut: boolean }> => {
    const canHear = ctx.hasUI && ctx.mode === "tui" && typeof ctx.ui.onTerminalInput === "function";
    if (ms <= 0 || !canHear) {
      const asked = Date.now();
      const result = await run(ms > 0 ? { timeout: ms } : undefined);
      return { result, timedOut: ms > 0 && Date.now() - asked >= ms - 1000 };
    }
    const ctrl = new AbortController();
    let lastActive = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => ctrl.abort(), Math.max(0, ms - (Date.now() - lastActive)));
    };
    const unsub = ctx.ui.onTerminalInput(() => {
      lastActive = Date.now();
      arm();
    });
    arm();
    try {
      const result = await run({ signal: ctrl.signal });
      return { result, timedOut: result === undefined && Date.now() - lastActive >= ms - 1000 };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      unsub();
    }
  };

  /**
   * A dialog that goes on without you: after askTimeoutSec idle (with a countdown), `fallback`
   * is taken and noted in `notes`, so a build started before you walk away doesn't wait all night.
   * Esc still cancels (undefined). A replaced session also reads as dismissed (undefined): every
   * caller already treats that as stop, so a moved-on human never gets a stale-context error.
   */
  const choose = async (ctx: ExtensionContext, store: Store, title: string, options: string[], fallback: string, notes?: string[]): Promise<string | undefined> => {
    try {
      if (!ctx.hasUI) return fallback;
    } catch (e) {
      if (!sessionGone(ctx)) throw e;
      return undefined;
    }
    // It goes on without you: tell you, in case you're in another window.
    if (store.config().notify) notifyDesktop("pb: your choice", title);
    const ms = store.config().askTimeoutSec * 1000;
    const { result: choice, timedOut } = await patiently(ctx, ms, (opts) => ctx.ui.select(title, options, opts));
    if (choice !== undefined) return choice;
    if (timedOut) {
      notes?.push(`${title} → ${fallback} (no answer within ${Math.max(1, Math.round(ms / 60_000))} min)`);
      return fallback;
    }
    return undefined;
  };
  /** A yes/no that goes on (yes) without you. */
  const agree = async (ctx: ExtensionContext, store: Store, title: string, notes?: string[]) => {
    const GO = "Yes, go on";
    return (await choose(ctx, store, title, [GO, "No, stop here"], GO, notes)) === GO;
  };

  /**
   * Where to rewind the conversation to for an entry: navigating to a user or custom message would
   * move its text into the editor, so step back to the entry before it. keepUser: stop at your own
   * message (going back to a branch, its text returns to the editor instead of being lost).
   */
  const rewindPoint = (ctx: ExtensionContext, from: string | undefined, keepUser = false): string | undefined => {
    const sm = tree(ctx);
    let id: string | undefined = from;
    while (id) {
      const e = sm.getEntry?.(id);
      if (!e) return undefined;
      const userLike = e.type === "custom_message" || (!keepUser && e.type === "message" && e.message?.role === "user");
      if (!userLike) return id;
      id = e.parentId ?? undefined;
    }
    return undefined;
  };

  /**
   * The command that checks a task. The final check: the full suite (a compile for the build gate). Per task,
   * only with taskChecks "each": its Test: line, else a compile.
   */
  const checkCommand = (spec: ParsedSpec, task: SpecTask | undefined, testCmd: string | null, buildCmd: string | null, final: boolean, each: boolean) => {
    if (spec.gate === "none") return null;
    if (final) return spec.gate === "tests" ? testCmd : buildCmd;
    if (!each) return null;
    return spec.gate === "tests" ? (task?.test ?? buildCmd) : buildCmd;
  };

  // Checks running right now: the prompt cache is certain to be needed afterwards.
  let checking = 0;
  const withChecking = async <T>(fn: () => Promise<T>): Promise<T> => {
    checking += 1;
    try {
      return await fn();
    } finally {
      checking -= 1;
    }
  };
  /**
   * Mid-task compactions with no forward progress in a row, by session: the thrash guard's memory.
   * In-memory (a crash just delays it); a task boundary is progress by construction, so only the
   * Pi-compaction path reads it. `findings` counts what a review pass has reported, so findings
   * written between two compactions count as progress even when nothing new was read.
   */
  const compactStalls = new Map<string, { task?: string; changed: string[]; read: string[]; tokens: number; strikes: number; findings?: number }>();
  /** How many sessions' stall state is kept; older ones are dropped so a long-lived process doesn't grow. */
  const STALL_MEMORY = 64;
  /** Compacting this often with nothing changed, read, shrunk or reported means stuck, not long: pause instead of looping. */
  const COMPACT_STALL_LIMIT = 3;
  const rememberStall = (session: string, stall: { task?: string; changed: string[]; read: string[]; tokens: number; strikes: number; findings?: number }) => {
    compactStalls.set(session, stall);
    for (const k of compactStalls.keys()) {
      if (compactStalls.size <= STALL_MEMORY) break;
      if (k !== session) compactStalls.delete(k);
    }
  };
  // Set by /pb:undo while it rewinds the conversation: the branch summary pb supplies instead of an LLM's.
  let undoSummary: string | undefined;
  // A task boundary happened in this turn: the moment pruning is allowed.
  let boundary = false;
  const baselineSessions = new Set<string>();

  registerRenderers(pi);

  /* -------------------------------- tools -------------------------------- */

  pi.registerTool({
    name: "pb_write_spec",
    label: "Write spec",
    description:
      "Write or rewrite a pb feature spec (.pi/pb/specs/<name>/spec.md). Use it when the user runs /pb:spec or /pb:build asks for the spec. The content must follow the spec format the user's instructions give; the tool rejects a spec that doesn't parse and says why.",
    parameters: Type.Object({
      name: Type.String({ description: "short kebab-case spec name (the folder under .pi/pb/specs/, not a path), e.g. order-cancellation" }),
      content: Type.String({ description: "the complete spec in markdown" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!SPEC_NAME.test(params.name)) throw new Error(`"${params.name}" is not a valid name: use short kebab-case, e.g. order-cancellation`);
      if (params.name === "off") throw new Error(`"off" is reserved (/${cmd("plan")} off ends planning): pick another spec name.`);
      const { spec, errors } = parseSpec(params.content);
      if (!spec) throw new Error(`The spec doesn't parse:\n- ${errors.join("\n- ")}\nFix it and call pb_write_spec again.`);
      const markerErrs = acceptanceMarkerErrors(spec);
      if (markerErrs.length) throw new Error(`Acceptance lines need proof markers:\n- ${markerErrs.join("\n- ")}\nAdd (tests: ...) or (non-testable: reason) to each.`);
      const semErrs = semanticErrors(params.content, spec);
      if (semErrs.length) throw new Error(`The spec needs senior shape before it is ready:\n- ${semErrs.join("\n- ")}\nFix it and call pb_write_spec again.`);
      const store = new Store(ctx.cwd);
      const prev = store.progress(params.name);
      store.writeSpec(params.name, params.content);
      store.saveProgress({
        ...(prev ?? { spec: params.name, phase: "written" }),
        spec: params.name,
        tasks: syncTasks(spec, prev?.tasks),
        writtenIn: ctx.sessionManager.getSessionFile(),
        edited: false,
        compacted: false,
        updatedAt: now(),
      });
      store.event(params.name, { type: "spec", tasks: spec.tasks.length, gate: spec.gate, newTests: spec.newTests, status: spec.status, tokens: tokensOf(params.content) });
      const what = spec.status === "planning" ? "status planning" : `${spec.tasks.length} tasks, verification ${spec.gate}${spec.newTests ? "" : ", no new tests"}`;
      const warnings = [...specWarnings(params.content, spec)];
      const rw = rewriteWarning(params.name, prev, spec);
      if (rw) warnings.push(rw);
      const notes = warnings.map((w) => `\nNote: ${w}.`);
      return reply(`Wrote ${store.rel("specs", params.name, "spec.md")}: "${spec.title}", ${what}${spec.dependsOn ? `, depends on ${spec.dependsOn}` : ""}; ${sizeNote(tokensOf(params.content))}.${notes.join("")}`);
    },
  });

  pi.registerTool({
    name: "pb_update_spec",
    label: "Update spec",
    description:
      "Change part of an existing pb spec instead of rewriting it: replace or append to one section (e.g. Findings, Decisions, Design, Tasks), and/or set its Status (planning | ready). The result must still parse, or nothing is written.",
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "the spec's name; the one this session is building or writing, if omitted" })),
      section: Type.Optional(Type.String({ description: 'the "## " section to change, e.g. Decisions; created if missing' })),
      content: Type.Optional(Type.String({ description: "the section's new body (without its heading), or the lines to append" })),
      mode: Type.Optional(StringEnum(["replace", "append"])),
      status: Type.Optional(StringEnum(["planning", "ready"])),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const store = new Store(ctx.cwd);
      const name = params.name ?? specOfSession(ctx)?.progress?.spec;
      if (!name) throw new Error("Which spec? Give its name.");
      let md = store.readSpec(name);
      if (!md) throw new Error(`No spec "${name}": write it with pb_write_spec.`);
      if (params.section) {
        if (params.content === undefined) throw new Error("content is required with section.");
        md = setSection(md, params.section, params.content, (params.mode as "replace" | "append" | undefined) ?? "replace");
      }
      if (params.status) md = setStatus(md, params.status as "planning" | "ready");
      const { spec, errors } = parseSpec(md);
      if (!spec) throw new Error(`Not written: the spec wouldn't parse:\n- ${errors.join("\n- ")}`);
      const sectionName = params.section?.replace(/^#+\s*/, "").trim().toLowerCase() ?? "";
      if (sectionName === "tasks") {
        const markerErrs = acceptanceMarkerErrors(spec);
        if (markerErrs.length) throw new Error(`Not written: acceptance lines need proof markers:\n- ${markerErrs.join("\n- ")}\nAdd (tests: ...) or (non-testable: reason) to each.`);
      }
      // A call that makes the spec ready re-checks the full senior shape, whatever else it wrote
      // in the same call (findings and decisions evidence included). A Tasks edit on an already-ready
      // spec re-checks the task-scoped gates; other section edits stay quiet so build-time notes flow.
      const prevMd = store.readSpec(name) ?? "";
      const wasReady = parseSpec(prevMd).spec?.status === "ready";
      const becameReady = spec.status === "ready" && !wasReady && params.status === "ready";
      if (becameReady) {
        const semErrs = semanticErrors(md, spec);
        if (semErrs.length) throw new Error(`Not written: the spec needs senior shape before it is ready:\n- ${semErrs.join("\n- ")}`);
      } else if (spec.status === "ready" && sectionName === "tasks") {
        const taskErrs = taskScopeSemanticErrors(md, spec);
        if (taskErrs.length) throw new Error(`Not written: the spec needs senior shape before it is ready:\n- ${taskErrs.join("\n- ")}`);
      }
      store.writeSpec(name, md);
      const prev = store.progress(name);
      store.saveProgress({ ...(prev ?? { spec: name, phase: "written" }), spec: name, tasks: syncTasks(spec, prev?.tasks), writtenIn: ctx.sessionManager.getSessionFile(), updatedAt: now() });
      store.event(name, { type: "spec", update: params.section ?? "status", status: spec.status, tokens: tokensOf(md) });
      const isTasks = params.section?.replace(/^#+\s*/, "").trim().toLowerCase() === "tasks";
      const rw = isTasks ? rewriteWarning(name, prev, spec) : undefined;
      const notes = isTasks ? [...specWarnings(md, spec), ...(rw ? [rw] : [])].map((w) => `\nNote: ${w}.`) : [];
      return reply(`Updated ${store.rel("specs", name, "spec.md")}${params.section ? ` (${params.section})` : ""}: status ${spec.status}; ${sizeNote(tokensOf(md))}.${notes.join("")}`);
    },
  });

  pi.registerTool({
    name: "pb_record_decision",
    label: "Record decision",
    description:
      "In a pb build session: record in the spec's Decisions a decision the human just made, or (assumption: true) a choice you made where the spec was ambiguous or didn't match the code, so it survives compaction and reaches the reviewer.",
    parameters: Type.Object({
      decision: Type.String({ description: "the decision or choice, self-contained, with its reason, in one or two sentences" }),
      assumption: Type.Optional(Type.Boolean({ description: "true when it is your choice, not the human's" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const { store, name, progress } = specOfSession(ctx);
      const md = name ? store.readSpec(name) : undefined;
      if (!name || !md || !progress) throw new Error("This is not a pb build session. In planning, decisions stay in the discussion and enter the spec via /pb:spec or /pb:build — carry on.");
      const entry = params.assumption ? `Assumption (build${progress.current ? `, ${progress.current}` : ""}): ${params.decision}` : params.decision;
      const refused = appendDecision(store, name, entry);
      if (refused) throw new Error(`Not recorded: ${refused}. Fix the spec (pb_update_spec) and record the decision again.`);
      if (params.assumption) {
        progress.assumptions = [...(progress.assumptions ?? []), entry];
        store.saveProgress(progress);
      }
      return reply("Recorded in the spec's Decisions.");
    },
  });

  pi.registerTool({
    name: "pb_ask",
    label: "Ask",
    description: ASK_DESCRIPTION,
    parameters: Type.Object({
      question: Type.String({ description: "one precise question" }),
      options: Type.Optional(Type.Array(Type.String(), { description: "2 to 4 answers to choose from; the human can always type another" })),
      recommended: Type.Optional(Type.String({ description: "your recommendation: one of the options, or a suggested answer" })),
    }),
    // One dialog at a time: Pi shows a single dialog, and a second one opened in parallel dismisses the first.
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const { store, name, progress: p } = specOfSession(ctx);
      const building = !!name && !!p && p.phase === "building";
      const session = ctx.sessionManager.getSessionFile() ?? "";
      if (checkpointing.has(session)) return reply("Not now: this is a checkpoint. Write the question under Open questions in the spec instead.");
      // The human may have walked away: during a build, while /pb:build writes the spec, and while planning.
      const planning = store.planningSessions().includes(session);
      const unattended = building || specWriting.has(session) || store.pendingBuild(session) || planning;
      if (!ctx.hasUI) {
        if (building) {
          pauseBuild(ctx, store, p!, `${p!.current} question: ${params.question}`, "build.paused", "question");
          return stop("No one can answer here: the build is paused with your question. Stop here.");
        }
        return reply("No one can answer right now: take the sensible reading, say which one you took, and carry on.");
      }
      // During a build the human may be away: after askTimeoutSec idle it goes on with the recommendation.
      const timeoutMs = unattended ? store.config().askTimeoutSec * 1000 : 0;
      if (store.config().notify) notifyDesktop("pb: a question for you", params.question);
      // Lettered, so "A and C" is a complete answer whenever it comes: in the dialog, in the
      // chat later, or typed freehand after picking "Something else".
      const letter = (i: number) => String.fromCharCode(65 + i);
      const lettered = (params.options ?? []).map((o, i) => `${letter(i)}. ${o}${o === params.recommended ? " (recommended)" : ""}`);
      let answer: string | undefined;
      let timedOut = false;
      const OTHER = "Something else (type it)";
      if (params.options?.length) {
        const labels = params.options.map((o) => (o === params.recommended ? `${o} (recommended)` : o));
        const sel = await patiently(ctx, timeoutMs, (opts) => ctx.ui.select(params.question, [...labels, OTHER], opts));
        timedOut = sel.timedOut;
        if (sel.result === OTHER) {
          // The options vanish the moment the typing dialog opens, and the choice is often
          // written from them: keep them in the chat, where they stay visible while typing.
          post([`**Answering with your own words:**`, "", params.question, "", ...lettered, "", `Type it here — a letter is enough, or write guidance based on the options above.`].join("\n"));
          const inp = await patiently(ctx, timeoutMs, (opts) => ctx.ui.input(params.question, "A letter is enough, or your own words based on the options above", opts));
          timedOut = timedOut || inp.timedOut;
          answer = inp.result;
        } else answer = sel.result ? params.options[labels.indexOf(sel.result)] : undefined;
      } else {
        const inp = await patiently(ctx, timeoutMs, (opts) => ctx.ui.input(params.question, params.recommended, opts));
        timedOut = inp.timedOut;
        answer = inp.result;
      }
      if (!answer?.trim()) {
        // Silence is not consent before anything is built: in planning (or while the spec
        // is being written) an unanswered question stays an open question, and planning stays
        // incomplete. Only a build already underway goes on with the recommendation.
        const stayedOpen = !building && (planning || specWriting.has(session) || store.pendingBuild(session));
        // The dialog is gone; the question stays in the chat, to answer whenever the human is back.
        const KEPT = ` The question stays in the chat${lettered.length ? `, its options lettered (${lettered.map((o) => o.replace(/ \(recommended\)$/, "")).join("; ")})` : ""}: if the human answers later, by letter or in words, follow their answer.`;
        post(
          [
            `**Unanswered question** (${timedOut ? `no answer within ${Math.max(1, Math.round(timeoutMs / 60_000))} min` : "the dialog was closed"}; ${stayedOpen ? "nothing was decided — the question stays open" : `Pi went on with ${params.recommended ? `its recommendation, ${params.recommended}` : "the sensible reading"}`}):`,
            "",
            params.question,
            ...(lettered.length ? ["", ...lettered] : []),
            "",
            `To answer, type it here any time${lettered.length ? ` (a letter is enough)` : ""}: if Pi is working, it reads it after its current step.`,
          ].join("\n"),
        );
        if (timedOut && building && params.recommended) {
          const minutes = Math.round(timeoutMs / 60_000);
          const entry = `Assumption (build, ${p!.current}, no answer within ${minutes} min): ${params.question.replace(/\s+$/, "")} → ${params.recommended}`;
          const refused = appendDecision(store, name!, entry);
          p!.assumptions = [...(p!.assumptions ?? []), entry];
          store.saveProgress(p!);
          store.event(name!, { type: "ask", task: p!.current, timedOut: true });
          return reply(`No answer within ${minutes} min: go on with your recommendation (${params.recommended}); ${refused ? `the spec wouldn't take it (${refused}) — it stays among the build's assumptions in the build summary; record it with pb_record_decision once the spec parses` : "it's recorded as an assumption for the review"}.${KEPT}`);
        }
        const record = building
          ? ", record it with pb_record_decision (assumption: true)"
          : "";
        return reply(`${timedOut ? "No answer in time" : "The human dismissed the question"}: ${stayedOpen ? "leave this undecided — record it under Open questions and do not take a reading or write it as an Assumption. Planning stays incomplete until it is answered." : `take the sensible reading${timedOut && params.recommended ? ` (your recommendation: ${params.recommended})` : ""}${record} and carry on.`}${KEPT}`);
      }
      let recorded = "";
      if (building) {
        // Human answers are decisions, not assumptions: they live in the spec's Decisions for the
        // reviewer. p.assumptions is only for builder-made choices (timeout recommendations above).
        const refused = appendDecision(store, name!, `${params.question.replace(/\s+$/, "")} → ${answer.trim()}`);
        store.event(name!, { type: "ask", task: p!.current });
        recorded = refused ? ` (the spec wouldn't take it: ${refused} — record it with pb_record_decision)` : " (recorded in the spec's Decisions)";
      }
      return reply(`The human answered: ${answer.trim()}${recorded}`);
    },
  });

  pi.registerTool({
    name: "pb_explore",
    label: "Explore",
    description:
      "Answer a question about the code from a separate, read-only context and get back only the answer: where things live, how a similar feature is built, the conventions, what calls what. It reads code only (no curl, scripts or builds: those stay in this session). Use it for broad or multi-file questions when you need the conclusion; when you know the 1-3 files, read them yourself. Several calls can run in parallel.",
    parameters: Type.Object({
      question: Type.String({ description: "what to find out, specific enough to answer in a short report" }),
    }),
    executionMode: "parallel",
    // What it's doing, from the explorer's own steps: shown to you, never sent to the model.
    renderCall: (args, theme) => renderExploreCall(args, theme),
    renderResult: (result, opts, theme, context) => renderExploreResult(result as { content: { type: string; text?: string }[]; details?: ExploreDetails }, opts, theme, context?.isError),
    async execute(_id, params, signal, onUpdate, ctx) {
      const store = new Store(ctx.cwd);
      const cfg = store.config();
      const name = tree(ctx).getSessionName?.();
      const before = snapshot(ctx.cwd, "pb: before explore");
      const started = Date.now();
      const steps: string[] = [];
      const files = new Set<string>();
      let writing = "";
      const details = (): ExploreDetails => ({ steps: steps.slice(-LIVE_STEPS), count: steps.length, files: [...files], started, writing: tail(writing, LIVE_WRITING_LINES) });
      // Bursts of sub-second tool calls repaint faster than anyone can read: coalesce them,
      // trailing-edge so the latest state always lands. Terminal states flush on their own path.
      let lastPaint = 0;
      let paintTimer: ReturnType<typeof setTimeout> | undefined;
      let pendingContent: { type: "text"; text: string }[] | undefined;
      const paint = (content: { type: "text"; text: string }[]) => {
        if (!onUpdate) return;
        pendingContent = content;
        if (paintTimer !== undefined) return; // a flush is queued; it picks up the latest content
        const wait = LIVE_FLUSH_MS - (Date.now() - lastPaint);
        if (wait <= 0) {
          lastPaint = Date.now();
          onUpdate({ content: pendingContent, details: details() });
          pendingContent = undefined;
        } else {
          paintTimer = setTimeout(() => {
            paintTimer = undefined;
            lastPaint = Date.now();
            if (pendingContent) onUpdate?.({ content: pendingContent, details: details() });
            pendingContent = undefined;
          }, wait);
        }
      };
      // Heartbeat so the elapsed counter ticks even between tool calls on quiet stretches.
      const beat = setInterval(() => paint(text("")), 1000);
      const res = await runFresh({
        cwd: ctx.cwd,
        role: "explorer",
        systemPrompt: EXPLORER_SYSTEM,
        brief: explorerBrief(params.question, name?.startsWith("plan: ") ? name.slice(6) : undefined),
        prompt: "Answer the question in the attached file.",
        tools: ["read", "grep", "find", "ls", "bash"],
        model: cfg.explorer.model ?? sessionModel(ctx),
        thinking: cfg.explorer.thinking ?? "max",
        signal,
        onActivity: (line, call) => {
          steps.push(line);
          const p = call.arguments.path ?? call.arguments.file_path;
          if (call.name === "read" && typeof p === "string") files.add(p);
          paint(text(`↳ ${line}`));
        },
        onText: (t) => {
          writing = t;
          paint(text(""));
        },
        sessionDir: store.sessionsDir("explorer"),
      }).finally(() => {
        clearInterval(beat);
        if (paintTimer !== undefined) {
          // A trailing repaint is obsolete now: the returned details carry the final state.
          clearTimeout(paintTimer);
          paintTimer = undefined;
        }
      });
      const after = snapshot(ctx.cwd, "pb: after explore");
      revertFreshRun(ctx, "the explorer", before, after);
      store.exploreEvent({ session: ctx.sessionManager.getSessionFile(), ...res.tokens, cost: res.cost, ms: res.ms });
      if (res.aborted) throw new Error("Exploration stopped. Narrow the question to one area or split it across two calls in one block; what was already read is listed above.");
      if (!res.text.trim()) throw new Error(`The explorer produced no answer${res.error ? `: ${res.error}` : ""}`);
      const t = res.tokens;
      const session = res.sessionFile ? path.relative(ctx.cwd, res.sessionFile) : undefined;
      return { content: text(res.text.trim()), details: { ...details(), writing: [], ms: res.ms, tokens: t.input + t.output + t.cacheRead + t.cacheWrite, tokensIn: t.input + t.cacheRead + t.cacheWrite, tokensOut: t.output, session }, usage: usageOf(res) };
    },
  });

  pi.registerTool({
    name: "pb_try",
    label: "Try",
    description:
      "When a decision needs something only running code shows (library behaviour or limits, performance, a read-only query), call pb_try with the question to settle: back come Commands, Result and Conclusion. If settling it needs a scratch script file — or its output won't fit in a few lines — it belongs in pb_try; single read-only commands stay in this session. It reads the project but writes scratch files only outside it, and anything it changes in the project is put back. Prefer local code, docs and local/test data first; a read-only production query only when local data cannot answer it (state why, table, row cap at most ~500 rows); never write, never notify. Several calls can run in parallel.",
    parameters: Type.Object({
      goal: Type.String({ description: "the question to settle by running, specific enough to probe in one go" }),
    }),
    executionMode: "parallel",
    renderCall: (args, theme) => renderTryCall(args, theme),
    renderResult: (result, opts, theme, context) => renderTryResult(result as { content: { type: string; text?: string }[]; details?: ExploreDetails }, opts, theme, context?.isError),
    async execute(_id, params, signal, onUpdate, ctx) {
      const store = new Store(ctx.cwd);
      const cfg = store.config();
      const name = tree(ctx).getSessionName?.();
      const before = snapshot(ctx.cwd, "pb: before try");
      const started = Date.now();
      const steps: string[] = [];
      const files = new Set<string>();
      let writing = "";
      const details = (): ExploreDetails => ({ steps: steps.slice(-LIVE_STEPS), count: steps.length, files: [...files], started, writing: tail(writing, LIVE_WRITING_LINES) });
      let lastPaint = 0;
      let paintTimer: ReturnType<typeof setTimeout> | undefined;
      let pendingContent: { type: "text"; text: string }[] | undefined;
      const paint = (content: { type: "text"; text: string }[]) => {
        if (!onUpdate) return;
        pendingContent = content;
        if (paintTimer !== undefined) return;
        const wait = LIVE_FLUSH_MS - (Date.now() - lastPaint);
        if (wait <= 0) {
          lastPaint = Date.now();
          onUpdate({ content: pendingContent, details: details() });
          pendingContent = undefined;
        } else {
          paintTimer = setTimeout(() => {
            paintTimer = undefined;
            lastPaint = Date.now();
            if (pendingContent) onUpdate?.({ content: pendingContent, details: details() });
            pendingContent = undefined;
          }, wait);
        }
      };
      // Heartbeat so the elapsed counter ticks even between tool calls on quiet stretches.
      const beat = setInterval(() => paint(text("")), 1000);
      const res = await runFresh({
        cwd: ctx.cwd,
        role: "try",
        systemPrompt: TRY_SYSTEM,
        brief: tryBrief(params.goal, name?.startsWith("plan: ") ? name.slice(6) : undefined),
        prompt: "Establish the goal in the attached file. Scratch files go to a temporary directory outside the project; read-only queries only.",
        tools: ["read", "grep", "find", "ls", "bash"],
        model: cfg.explorer.model ?? sessionModel(ctx),
        thinking: cfg.explorer.thinking ?? "max",
        signal,
        onActivity: (line, call) => {
          steps.push(line);
          const p = call.arguments.path ?? call.arguments.file_path;
          if (call.name === "read" && typeof p === "string") files.add(p);
          paint(text(`↳ ${line}`));
        },
        onText: (t) => {
          writing = t;
          paint(text(""));
        },
        sessionDir: store.sessionsDir("try"),
      }).finally(() => {
        clearInterval(beat);
        if (paintTimer !== undefined) {
          clearTimeout(paintTimer);
          paintTimer = undefined;
        }
      });
      const after = snapshot(ctx.cwd, "pb: after try");
      revertFreshRun(ctx, "the trier", before, after);
      store.exploreEvent({ session: ctx.sessionManager.getSessionFile(), ...res.tokens, cost: res.cost, ms: res.ms });
      if (res.aborted) throw new Error("Probe stopped. Split the goal into smaller steps or bound it (fewer rows, less work); rerun the smaller probe.");
      if (!res.text.trim()) throw new Error(`The trier produced no answer${res.error ? `: ${res.error}` : ""}`);
      const t = res.tokens;
      const session = res.sessionFile ? path.relative(ctx.cwd, res.sessionFile) : undefined;
      return { content: text(res.text.trim()), details: { ...details(), writing: [], ms: res.ms, tokens: t.input + t.output + t.cacheRead + t.cacheWrite, tokensIn: t.input + t.cacheRead + t.cacheWrite, tokensOut: t.output, session }, usage: usageOf(res) };
    },
  });

  pi.registerTool({
    name: "pb_report_findings",
    label: "Report findings",
    description:
      "In a pb review session: report the review's findings, one call with all of them (an empty list when there are none). Call it again if they change.",
    parameters: Type.Object({
      findings: Type.Array(
        Type.Object({
          priority: StringEnum(["P0", "P1", "P2", "P3"]),
          file: Type.Optional(Type.String({ description: "path relative to the repository root" })),
          line: Type.Optional(Type.Number()),
          title: Type.String({ description: "the problem, in one sentence" }),
          fix: Type.Optional(Type.String({ description: "a concrete fix" })),
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const store = new Store(ctx.cwd);
      const session = ctx.sessionManager.getSessionFile();
      const state = store.reviewSession(session);
      if (!session || !state) throw new Error("This is not a pb review session.");
      const findings = (params.findings as Finding[]).filter((f) => /^P[0-3]$/.test(f.priority) && f.title);
      store.saveReviewSession(session, { ...state, findings });
      return reply(`Recorded ${findings.length} finding(s). Now reply briefly${state.role === "review" ? " (the acceptance checklist, and anything worth knowing that isn't a finding)" : ""}, then stop.`);
    },
  });

  pi.registerTool({
    name: "pb_task_done",
    label: "Task done",
    description:
      'In a pb build: finish the task the harness gave you. status done: the harness runs the task\'s check and answers with the failure to fix, or the next task — report changed (what you changed), caveat (what the next task must respect), rejected (what you tried and discarded) and open (what is still unchecked), each required, "none" where there is genuinely nothing. status blocked: it can\'t be done properly (summary says why); the build pauses for the human.',
    parameters: Type.Object({
      task: Type.String({ description: 'the task id, e.g. "T2" (or "final" for the final check)' }),
      status: StringEnum(["done", "blocked"]),
      summary: Type.Optional(Type.String({ description: 'blocked only: why it can\'t be done properly' })),
      changed: Type.Optional(Type.String({ description: "done only: what you changed" })),
      caveat: Type.Optional(Type.String({ description: 'done only: what the next task must respect ("none" when nothing)' })),
      rejected: Type.Optional(Type.String({ description: 'done only: what you tried and discarded ("none" when nothing)' })),
      open: Type.Optional(Type.String({ description: 'done only: what is still unchecked ("none" when nothing)' })),
    }),
    executionMode: "sequential",
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { store, progress: p } = specOfSession(ctx);
      if (!p || p.phase !== "building") throw new Error("No pb build is running in this session.");
      if (params.task !== p.current) throw new Error(`The current task is ${p.current ?? "none"}, not ${params.task}.`);
      const tp = p.tasks.find((t) => t.id === p.current);
      const blank = (v: unknown) => typeof v !== "string" || !v.trim();
      if (params.status === "blocked") {
        if (blank(params.summary)) throw new Error(`status "blocked" needs summary: why it can't be done properly.`);
        if (tp) tp.summary = (params.summary as string).trim();
      } else {
        const missing = (["changed", "caveat", "rejected", "open"] as const).filter((k) => blank(params[k]));
        if (missing.length)
          throw new Error(
            `status "done" needs ${missing.join(", ")}: report what changed, what the next task must respect, what was tried and discarded, and what is still unchecked (write "none" where there is genuinely nothing).`,
          );
        if (tp) {
          tp.changed = (params.changed as string).trim();
          tp.caveat = (params.caveat as string).trim();
          tp.rejected = (params.rejected as string).trim();
          tp.open = (params.open as string).trim();
        }
      }
      const loaded = loadSpec(store, p.spec);
      if (!loaded) {
        pauseBuild(ctx, store, p, `${store.rel("specs", p.spec, "spec.md")} no longer parses; fix it, then /${cmd("build")}.`, "build.paused", "spec");
        return stop("The spec no longer parses: the build is paused. Stop here.");
      }
      if (params.status === "blocked") {
        pauseBuild(ctx, store, p, `${params.task} blocked: ${params.summary}`, "build.paused", "blocked");
        return stop("The build is paused: the human decides how to go on. Stop here.");
      }
      const task = loaded.spec.tasks.find((t) => t.id === p.current);
      if (tp && needsRed(loaded.spec, task) && !tp.red && !tp.preGreen) {
        // Not an attempt: nothing was checked yet.
        store.saveProgress(p);
        return reply(`${p.current}'s new tests were never seen failing, so nothing shows they test the change. Call pb_tests_red: if you already made the change, set it aside first (the tests must fail without it), then put it back.`);
      }
      return await checkAndAdvance(ctx, store, p, loaded.spec, signal);
    },
  });

  pi.registerTool({
    name: "pb_tests_red",
    label: "Tests fail first",
    description:
      "In a pb build, for a task with a Test: line: after writing its tests and before the change, the harness runs the task's test command and requires it to FAIL, proving the tests check the behaviour that is missing. pb_task_done for that task needs it.",
    parameters: Type.Object({
      task: Type.String({ description: 'the task id, e.g. "T2"' }),
      tests: Type.String({ description: "the tests you wrote and the failure each should show" }),
    }),
    executionMode: "sequential",
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { store, progress: p } = specOfSession(ctx);
      if (!p || p.phase !== "building") throw new Error("No pb build is running in this session.");
      if (params.task !== p.current) throw new Error(`The current task is ${p.current ?? "none"}, not ${params.task}.`);
      const spec = loadSpec(store, p.spec)?.spec;
      const task = spec?.tasks.find((t) => t.id === p.current);
      const tp = p.tasks.find((t) => t.id === p.current);
      if (!spec || !task?.test || !tp || !needsRed(spec, task)) return reply(`${params.task} doesn't need this: finish it with pb_task_done.`);
      if (tp.red) return reply(`Already seen failing (${tp.red}). Make the change, then pb_task_done.`);
      if (tp.preGreen) return reply(`Already satisfied by ${tp.preGreen}: confirm ${params.task}'s acceptance holds on top of that change, then pb_task_done.`);
      const cfg = store.config();
      showProgress(ctx, p, `${p.current}: its tests must fail first: ${task.test}`);
      const testCmd = task.test;
      let r: Awaited<ReturnType<typeof runVerify>>;
      r = await withChecking(() => runVerify(testCmd, ctx.cwd, cfg.verifyTimeoutSec, cfg.testOutputCap, signal));
      store.event(p.spec, { type: "red", task: p.current, ok: r.ok === false, command: task.test });
      if (r.ok !== false) {
        // Pre-green: an earlier task, done and proven, runs this very command — its implementation already
        // satisfies it, so red is impossible for this task. No wedge: confirm and finish, disclosed.
        const earlier = spec.tasks
          .slice(0, spec.tasks.findIndex((t) => t.id === p.current))
          .find((t) => t.test === task.test && p.tasks.some((x) => x.id === t.id && x.status === "done" && x.red));
        if (earlier) {
          tp.preGreen = earlier.id;
          store.saveProgress(p);
          return reply(
            `\`${task.test}\` already passes: ${earlier.id} (done, same Test: command) proved it and its change satisfies it — red is impossible for ${p.current} now. Confirm ${p.current}'s acceptance holds on top of ${earlier.id}'s change (read the code and tests; don't rerun the command), say so in your changed, then pb_task_done. This run proves nothing of ${p.current}'s own tests; the reviewer is told.`,
          );
        }
        return reply(
          `\`${task.test}\` passes without the change, so these tests don't check it (or that command doesn't run them). Make them fail for the behaviour that is missing, then pb_tests_red again.\n\n${r.summary}`,
        );
      }
      tp.red = r.summary.split("\n")[0];
      tp.redCommand = task.test;
      store.saveProgress(p);
      return reply(
        `Seen failing: \`${task.test}\`\n\n${r.summary}\n\nCheck that each fails for the reason you expect (the missing behaviour, not a typo or an unrelated error); fix any that don't, without calling this again. Then make the change and finish with pb_task_done.`,
      );
    },
  });

  pi.registerTool({
    name: "pb_fix_done",
    label: "Fixes done",
    description:
      "In a pb fixes session (opened by /pb:fix): report which review findings this lap fixed and which need a design decision (spec revision) instead of an edit, with the test results. Then stop: the home session runs /pb:review next to check the delta.",
    parameters: Type.Object({
      fixed: Type.Array(Type.String(), { description: "titles of the findings this lap fixed" }),
      skipped: Type.Array(Type.String(), { description: "titles of findings that need a design decision (spec revision), not an edit" }),
      tests: Type.String({ description: "test commands run and what each showed" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const store = new Store(ctx.cwd);
      const session = ctx.sessionManager.getSessionFile();
      const rec = store.fixSession(session);
      if (!session || !rec) throw new Error("This is not a pb fixes session. Fix review findings only inside the session /pb:fix opened — carry on there, or run /pb:fix for a new one.");
      store.event(rec.spec, { type: "fix", fixed: params.fixed, skipped: params.skipped, tests: params.tests });
      store.clearFixSession(session);
      return reply(`Recorded fix report for \`${rec.spec}\`: fixed ${params.fixed.length}, skipped ${params.skipped.length}. Reply briefly, then stop: run /pb:review back home to check the delta.`);
    },
  });

  /* --------------------------------- plan -------------------------------- */
  /** Run the test suite in the background; its result is posted into the session when it's done. Returns whether it started (a second plan in the same session shares the one in flight). */
  const startBaseline = (ctx: ExtensionContext, store: Store, command: string, say?: (content: string) => void): boolean => {
    const session = ctx.sessionManager.getSessionFile();
    // One baseline per session: re-planning here reuses the one in flight, a second planning session gets its own.
    if (session) {
      if (baselineSessions.has(session)) return false;
      baselineSessions.add(session);
    }
    const origin = session;
    const cfg = store.config();
    const head = gitHead(ctx.cwd);
    // Outside git there is no worktree to isolate the run: it shares the working copy, so its
    // artifacts (coverage, caches) may show up as planning changes — reviewPlanningChanges will list them.
    if (!head) ctx.ui.notify("Not a git repo, so the baseline runs in the working copy; its test artifacts may show as planning changes.", "warning");
    // In a worktree at the captured HEAD: the planner's own builds in the working copy can't collide with it.
    checking += 1;
    void inWorktree(ctx.cwd, (dir) => runVerify(command, dir, cfg.verifyTimeoutSec, cfg.testOutputCap), head ?? "HEAD")
      .then((r) => {
        store.saveBaseline({ ...r, head }, origin ?? undefined);
        const poster =
          say ??
          ((content: string) => {
            try {
              if (ctx.sessionManager.getSessionFile() !== origin) return;
            } catch {
              return;
            }
            post(content);
          });
        try {
          poster(`**Baseline** (the test suite on the last commit): ${r.ok ? r.summary : `${r.summary}\n\nThe final check runs the whole suite, so it fails until this is fixed.`}`);
        } catch {
          // the session was replaced meanwhile: baseline.json still has the result
        }
      })
      .finally(() => {
        checking -= 1;
        if (session) baselineSessions.delete(session);
      });
    return true;
  };

  /** Why pb can't list what changed while planning when no snapshot was taken. */
  const noSnapshotWarning = (checkpoints: boolean) =>
    checkpoints
      ? "Could not snapshot the working tree, so pb can't list what changed while planning; review the working tree yourself."
      : "Checkpoints are off, so pb can't list what changed while planning; review the working tree yourself.";

  /** The project map may have rotted since it was written: name the paths that no longer resolve. */
  const warnStaleMap = (ctx: ExtensionContext) => {
    const gone = missingPaths(ctx.cwd, readMap(ctx.cwd));
    if (gone.length)
      ctx.ui.notify(
        `The project map in AGENTS.md names ${gone.length} path(s) that no longer exist (${gone.slice(0, 3).join(", ")}${gone.length > 3 ? ", …" : ""}): /${cmd("map")} refreshes it.`,
        "warning",
      );
  };

  /** Start planning mode for this session (the snapshot shows later what changed while it was on). */
  const startPlanning = (ctx: ExtensionContext, store: Store, request?: string): boolean => {
    const session = ctx.sessionManager.getSessionFile();
    if (!session) {
      // Every planning guard keys off the session file (edit/write block, undo snapshots, checkpointing): without it,
      // "the project's files stay untouched" would be a promise pb can't keep, so planning doesn't start.
      ctx.ui.notify("No session file for this session, so the planning protections can't run. Start Pi with a saved session and try again.", "error");
      return false;
    }
    const existing = store.planning(session)?.snapshot;
    const checkpoints = store.config().checkpoints;
    const snap = existing ? undefined : checkpoints ? snapshot(ctx.cwd, "pb: start of planning") : undefined;
    // The verbatim request is recorded (an explicit arg wins, otherwise whatever is already there survives),
    // so the checkpoint summary keeps what was asked even after a long discussion.
    store.setPlanning(session, true, existing ?? snap?.commit, request ?? store.planning(session)?.request);
    store.detachSession(session);
    ctx.ui.setWidget("pb-plan", ["planning · /pb:plan off"]);
    if (!existing && !snap?.commit) ctx.ui.notify(noSnapshotWarning(checkpoints), "warning");
    return true;
  };

  /**
   * Files that changed in the project while this session was planning (bash can write where edit and
   * write are blocked). Asks whether to keep or restore them; false = cancel.
   */
  const reviewPlanningChanges = async (ctx: ExtensionContext, store: Store, notes?: string[]): Promise<boolean> => {
    const session = ctx.sessionManager.getSessionFile();
    const rec = session ? store.planning(session) : undefined;
    if (!session || !rec) return true;
    const snap = rec.snapshot;
    if (!snap) {
      ctx.ui.notify(noSnapshotWarning(store.config().checkpoints), "warning");
      return true;
    }
    const cur = snapshot(ctx.cwd, "pb: end of planning");
    if (!cur) {
      ctx.ui.notify(noSnapshotWarning(store.config().checkpoints), "warning");
      return true;
    }
    const files = changedPaths(ctx.cwd, snap, cur.commit);
    const since = commitTime(ctx.cwd, snap);
    const big = skippedLargeFiles(ctx.cwd, since);
    if (big.length) ctx.ui.notify(`Large files changed while planning (not captured by pb's snapshots, so changes to them aren't in the list above and a restore won't touch them): ${big.slice(0, 5).join(", ")}${big.length > 5 ? ", …" : ""} — check them yourself.`, "warning");
    if (!files.length) return true;
    const list = `${files.slice(0, 10).join(", ")}${files.length > 10 ? ` … (+${files.length - 10})` : ""}`;
    const KEEP = "Keep them";
    const RESTORE = "Restore them to how they were when planning began";
    const choice = await choose(ctx, store, `These project files changed while planning: ${list}`, [KEEP, RESTORE, "Cancel"], KEEP, notes);
    if (choice === RESTORE) {
      const r = restore(ctx.cwd, cur.commit, snap, files);
      if (r.guardFailed) {
        ctx.ui.notify("Nothing was put back: the guard snapshot failed, so changes made meanwhile can't be told apart from the planning changes. Check the files yourself, then try again.", "error");
        return false;
      }
      ctx.ui.notify(`Restored ${r.restored.length} file(s).`, "info");
      const skipped = files.filter((f) => !r.restored.includes(f));
      if (skipped.length) ctx.ui.notify(`Left alone because they changed again since: ${skipped.slice(0, 5).join(", ")}${skipped.length > 5 ? ", …" : ""}`, "warning");
    } else if (choice !== KEEP) return false;
    else if (!ctx.hasUI) ctx.ui.notify(`Kept files changed while planning: ${list}`, "warning");
    store.setPlanning(session, store.planningSessions().includes(session), (choice === RESTORE ? undefined : cur.commit) ?? snap);
    return true;
  };

  /**
   * Standards live in AGENTS.md (Pi loads it everywhere); offer pb's section once per project, at the
   * first /pb:plan, /pb:deps or /pb:build. A stack's own section (Java, Vue) goes only in the project's AGENTS.md,
   * so the shared one stays free of stack rules. A Vue project that only finds a shared section (a
   * parent's or the agent directory's, e.g. the backend's) is offered its frontend one next to it.
   */
  const offerStandards = async (ctx: ExtensionContext, store: Store) => {
    if (!ctx.hasUI || store.asked("standards")) return;
    const found = findStandards(ctx.cwd);
    const stack = projectStack(ctx.cwd);
    const shared = !!found && path.dirname(found.file) !== path.resolve(ctx.cwd);
    // A shared section that this stack's own one merely extends (Java: pb's plus one line) is enough.
    if (found && !(shared && stack && !sectionFor(stack).includes(found.text))) return;
    store.markAsked("standards");
    const HERE =
      stack === "vue"
        ? "Add pb's frontend standards to this project's AGENTS.md"
        : stack && isUserTemplate(stack)
          ? `Add your ${stack} standards to this project's AGENTS.md`
          : "Add pb's engineering standards to this project's AGENTS.md";
    const ALL = `Add them to ${path.join(agentDir(), "AGENTS.md")} (all projects)`;
    const covers =
      stack && isUserTemplate(stack)
        ? `your ${stack} template`
        : `quality, dependencies, comments without history, tests, security, ${stack === "vue" ? "the page's role, backend refusals, browser security, Vue" : "concurrency"}`;
    const title = found
      ? `This project only gets the standards in ${found.file}, not its own (${stackLabel(stack)}). Pi loads both files, so that section stays in force next to this project's: keep the shared AGENTS.md free of stack-specific rules`
      : `Engineering standards (${covers})`;
    const choice = await ctx.ui.select(title, stack ? [HERE, "No thanks"] : [HERE, ALL, "No thanks"]);
    if (choice !== HERE && choice !== ALL) return;
    const file = choice === HERE ? path.join(ctx.cwd, "AGENTS.md") : path.join(agentDir(), "AGENTS.md");
    writeStandards(file, stack);
    ctx.ui.notify(`Added to ${file}${stack ? ` (${stackLabel(stack)})` : ""}: edit them there. Pi loads them into every session from now on.`, "info");
  };

  /** Which standards a stack gets, in words. */
  const stackLabel = (stack?: Stack) =>
    stack && isUserTemplate(stack)
      ? `your ${stack} template`
      : stack === "java"
        ? "the backend ones, with Java 25"
        : stack === "vue"
          ? "the frontend ones, for a Vue project"
          : stack && stack !== "plain"
            ? stack
            : "the plain ones";

  /** Continue planning a spec in a fresh session, seeded from it: clean context, exact checkpoint. */
  const continuePlan = async (ctx: ExtensionCommandContext, store: Store, name: string) => {
    let md = store.readSpec(name)!;
    const oldSession = ctx.sessionManager.getSessionFile();
    // Files the old planning session's bash wrote are reviewed before we move on.
    if (!(await reviewPlanningChanges(ctx, store))) return;
    // A finished plan reopened: the spec says so while it is replanned, or the next /pb:build would build it mid-replan.
    if (parseSpec(md).spec?.status === "ready") {
      const reopened = setStatus(md, "planning");
      if (parseSpec(reopened).spec) {
        md = reopened;
        store.writeSpec(name, md);
        store.event(name, { type: "spec", update: "status", status: "planning" });
        ctx.ui.notify(`\`${name}\` was Status: ready; set back to planning while we replan it.`, "info");
      }
    }
    store.setCarry({ model: sessionModel(ctx), thinking: pi.getThinkingLevel() as string | undefined, spec: name, parent: oldSession ?? undefined });
    let newSessionFile: string | undefined;
    const result = await ctx.newSession({
      parentSession: oldSession,
      setup: async (sm) => {
        sm.appendSessionInfo(`plan: ${name}`);
      },
      withSession: async (c) => {
        // Only `c` from here on: the captured pi and ctx belong to the replaced session.
        // Snapshot here, in the new session's working copy: the old session's tree may differ.
        const ns = new Store(c.cwd);
        const checkpoints = ns.config().checkpoints;
        const snap = checkpoints ? snapshot(c.cwd, "pb: start of planning") : undefined;
        const session = c.sessionManager.getSessionFile();
        newSessionFile = session ?? undefined;
        if (session) ns.setPlanning(session, true, snap?.commit, store.planning(oldSession ?? "")?.request);
        if (session) c.ui.setWidget("pb-plan", ["planning · /pb:plan off"]);
        if (!snap?.commit) c.ui.notify(noSnapshotWarning(checkpoints), "warning");
        // Same staleness check as /pb:plan: the map may have rotted since the old session.
        warnStaleMap(c);
        const p = ns.progress(name);
        if (p) ns.saveProgress({ ...p, writtenIn: session, compacted: false });
        else {
          const parsed = parseSpec(md).spec;
          if (parsed && session) ns.saveProgress({ spec: name, phase: "written", writtenIn: session, tasks: syncTasks(parsed, []), edited: false, compacted: false, updatedAt: now() });
        }
        // A fresh session gets a fresh baseline, not the previous session's result.
        const { cfg, testCmd } = commands(c.cwd, ns);
        const baseline = cfg.baseline && !!testCmd;
        if (baseline) startBaseline(c, ns, testCmd!, (content) => c.sendMessage({ customType: "pb", content, display: true }, { triggerTurn: false }));
        await c.sendMessage(
          {
            customType: "pb",
            content: `▶ Planning **${name}** on, from ${ns.rel("specs", name, "spec.md")} (the project's files stay untouched).${baseline ? ` Running \`${testCmd}\` in the background for a baseline.` : ""}\nThis session: "plan: ${name}" · back to it with /resume, or \`pi --session ${c.sessionManager.getSessionId()}\` · \`/${cmd("plan")}\` off ends planning`,
            display: true,
          },
          { triggerTurn: false },
        );
        void c.sendMessage({ customType: "pb-instruction", content: continuePlanPrompt(name, md, "", ns.extra("plan")), display: false }, { triggerTurn: true });
      },
    }).catch((e) => {
      store.clearCarry(); // a throw must not leave the handover behind either
      throw e;
    });
    if (result.cancelled) {
      store.clearCarry(); // its handover must not leak into a later, unrelated new session
      if (!sessionGone(ctx)) ctx.ui.notify("Cancelled.", "info");
      return;
    }
    if (oldSession && newSessionFile && oldSession !== newSessionFile && store.planning(oldSession) && store.specsOfPlanning(oldSession).length === 0) {
      store.setPlanning(oldSession, false);
    }
  };

  pi.registerCommand(cmd("plan"), {
    description: "Plan something with Pi: /pb:plan <describe what you want to build or change, in your own words>, or /pb:plan <spec> to continue planning a spec in a fresh session. Pi can run anything to investigate but won't touch the project's files. /pb:plan off ends that",
    getArgumentCompletions: (prefix: string) => [{ value: "off", label: "off" }, ...specCompletions(prefix)].filter((c) => c.value.startsWith(prefix)),
    handler: async (args, ctx) => {
      const arg = args.trim();
      const store = new Store(ctx.cwd);
      const session = ctx.sessionManager.getSessionFile();
      if (arg === "off") {
        if (!session || !store.planningSessions().includes(session)) return ctx.ui.notify("Not in planning mode.", "info");
        if (!(await liftPlanning(ctx, store))) return;
        return ctx.ui.notify("Planning mode off: Pi can change the project's files again.", "info");
      }
      if (!arg)
        return ctx.ui.notify(`Describe what you want, in your own words, e.g.\n/${cmd("plan")} let admins cancel an order while it is still pending, and notify the customer`, "warning");
      if (SPEC_NAME.test(arg) && store.readSpec(arg)) {
        const phase = store.progress(arg)?.phase ?? "written";
        if (phase === "written") {
          if (!ctx.isIdle()) return ctx.ui.notify("Pi is busy. Wait for the current turn to finish.", "warning");
          return continuePlan(ctx, store, arg);
        }
        const next = unfinishedPhase(phase)
          ? `\`/${cmd("build")} ${arg}\` continues the unfinished build, \`/${cmd("spec")} ${arg}\` revises its spec`
          : `\`/${cmd("review")} ${arg}\` reviews it, \`/${cmd("spec")} ${arg}\` revises its spec`;
        return ctx.ui.notify(
          `\`${arg}\` is not being planned (its phase is ${phase}): ${next}. To plan something new, describe it in your own words.`,
          "warning",
        );
      }
      // A near-miss spec name silently starting a new plan costs a duplicate spec downstream:
      // redirect in the same style as the phase-mismatch message above.
      const near = normSpecArg(arg);
      if (near !== arg && near !== "off" && SPEC_NAME.test(near)) {
        const hit = store.specNames().filter((n) => n === near);
        if (hit.length === 1 && store.readSpec(hit[0])) {
          return ctx.ui.notify(
            `\`${arg}\` isn't a spec name (spec names are lowercase with hyphens). Did you mean \`${hit[0]}\`? \`/${cmd("plan")} ${hit[0]}\` continues it; to plan something new, describe it in your own words.`,
            "warning",
          );
        }
      }
      // A name makes the planning session easy to find again in /resume, e.g. after a crash.
      if (!ctx.isIdle()) return ctx.ui.notify("Pi is busy. Wait for the current turn to finish.", "warning");
      const title = planTitle(arg);
      const { cfg, testCmd } = commands(ctx.cwd, store);

      await offerStandards(ctx, store);

      // After the standards offer: its AGENTS.md isn't a change made while planning.
      if (!startPlanning(ctx, store, arg)) return;
      pi.setSessionName(`plan: ${title}`);
      // A cheap staleness check of the project map, no model call: paths it names that are gone.
      warnStaleMap(ctx);

      // The baseline costs no tokens: the harness runs the suite while the discussion starts.
      const baseline = cfg.baseline && !!testCmd;
      const started = baseline ? startBaseline(ctx, store, testCmd!) : false;
      instruct(
        `▶ /${cmd("plan")} — ${title} (the project's files stay untouched)${baseline ? (started ? ` · running \`${testCmd}\` in the background for a baseline` : ` · baseline already running — its result lands here`) : ""}\nThis session: "plan: ${title}" · back to it any time with /resume, or \`pi --session ${ctx.sessionManager.getSessionId()}\` · \`/${cmd("plan")}\` off ends planning\n\n${arg.split("\n").map((l) => `> ${l}`).join("\n")}`,
        planPrompt(cap(arg, MODEL_ARG_CAP), testCmd, standardsFor(ctx), baseline ? "running" : "none", store.extra("plan")),
      );
    },
  });

  pi.registerCommand(cmd("approach"), {
    description: "In a planning session: hear how Pi would approach the implementation — architecture, seams, non-goals, test strategy, alternatives, risks, open questions (listed, not asked). Optional: which idea to expand",
    handler: async (args, ctx) => {
      const store = new Store(ctx.cwd);
      const session = ctx.sessionManager.getSessionFile();
      if (!session || !store.planningSessions().includes(session))
        return ctx.ui.notify(`/${cmd("approach")} is for planning sessions: run /${cmd("plan")} first, then ask for the approach mid-discussion.`, "warning");
      if (!ctx.isIdle()) return ctx.ui.notify("Pi is busy. Wait for the current turn to finish.", "warning");
      const focus = args.trim();
      const shown = planTitle(focus);
      instruct(
        `▶ /${cmd("approach")}${shown ? ` — ${shown}` : ""} (chat only: nothing is written)`,
        approachPrompt(focus, standardsFor(ctx), store.extra("plan")),
      );
    },
  });

  pi.registerCommand(cmd("deps"), {
    description: "Check dependencies (versions, deprecations) and propose upgrades as a change of their own. Optional: which ones",
    handler: async (args, ctx) => {
      const store = new Store(ctx.cwd);
      if (!ctx.isIdle()) return ctx.ui.notify("Pi is busy. Wait for the current turn to finish.", "warning");
      await offerStandards(ctx, store);
      if (!startPlanning(ctx, store, args.trim() ? `/pb:deps ${args.trim()}` : "/pb:deps")) return;
      pi.setSessionName(`deps: ${planTitle(args.trim()) || "all"}`);
      // Same staleness check as /pb:plan: the investigation starts from the map.
      warnStaleMap(ctx);
      instruct(`▶ /${cmd("deps")}${args.trim() ? ` — ${planTitle(args.trim())}` : ""} (the project's files stay untouched)`, depsPrompt(args.trim()));
    },
  });

  // Planning mode, first layer: edit/write inside the project are blocked synchronously.
  // Anything else that can write (bash, other tools) is caught by reviewPlanningChanges at the end of planning.
  pi.on("tool_call", (e, ctx) => {
    const ev = e as { toolName: string; input: { path?: string } };
    if (ev.toolName !== "edit" && ev.toolName !== "write") return;
    const session = ctx.sessionManager.getSessionFile();
    const store = new Store(ctx.cwd);
    if (session && store.reviewSession(session)) return { block: true, reason: "This is a review session: read-only. Report what should change with pb_report_findings." };
    if (!session || !store.planningSessions().includes(session)) return;
    const target = path.resolve(ctx.cwd, ev.input.path ?? "");
    if (target !== ctx.cwd && !target.startsWith(ctx.cwd + path.sep)) return; // outside the project: scratch files are fine
    return {
      block: true,
      reason: `Planning mode: the project's files stay untouched until /${cmd("build")}. Put scratch files outside the project (e.g. in a mktemp -d directory), or say what you would change.`,
    };
  });

  /* --------------------------------- spec -------------------------------- */

  pi.registerCommand(cmd("spec"), {
    description: "Write the spec for what we planned (one per feature); run it again to revise. Optional: which feature",
    getArgumentCompletions: specCompletions,
    handler: async (args, ctx) => {
      const store = new Store(ctx.cwd);
      const which = args.trim();
      const md = which && SPEC_NAME.test(which) ? store.readSpec(which) : undefined;
      instruct(`▶ /${cmd("spec")}${which ? ` — ${which}` : ""}`, specPrompt(which, store.specNames(), md ? { name: which, markdown: md } : undefined, store.extra("spec")));
    },
  });

  /** Let the human edit a spec in the editor; it's saved only when it still parses. */
  const editSpec = async (ctx: ExtensionContext, store: Store, name: string) => {
    let md = store.readSpec(name) ?? "";
    for (;;) {
      const edited = await ctx.ui.editor(`Edit ${name} (it must keep the spec format)`, md);
      if (edited === undefined || edited === md) return;
      const { spec, errors } = parseSpec(edited);
      if (!spec) {
        ctx.ui.notify(`Not saved, the spec doesn't parse: ${errors.join("; ")}`, "warning");
        md = edited;
        continue;
      }
      store.writeSpec(name, edited);
      const prev = store.progress(name);
      if (prev) store.saveProgress({ ...prev, tasks: syncTasks(spec, prev.tasks), edited: true });
      // Human edits save on parse alone: the human is the guardrail here, not the
      // model. Senior-shape drift is reported visibly (never silently bypassed).
      const shapeAdvisory = semanticErrors(edited, spec);
      store.event(name, { type: "spec", tasks: spec.tasks.length, gate: spec.gate, newTests: spec.newTests, by: "human", ...(shapeAdvisory.length ? { override: true, issues: shapeAdvisory.length } : {}) });
      if (shapeAdvisory.length)
        return ctx.ui.notify(
          `Saved ${store.rel("specs", name, "spec.md")} with human override: ${shapeAdvisory.length} senior-shape note(s) bypassed (the reviewer still judges truth):\n- ${shapeAdvisory.join("\n- ")}`,
          "warning",
        );
      return ctx.ui.notify(`Saved ${store.rel("specs", name, "spec.md")}.`, "info");
    }
  };

  /* --------------------------------- build ------------------------------- */

  /**
   * Snapshot and mark a task as started (a new task gets an undo entry); returns what to tell the agent.
   * inTool: started from pb_task_done, mid-run: the rewind point is set at the end of the turn.
   */
  const beginTask = (
    ctx: ExtensionContext,
    store: Store,
    p: Progress,
    taskId: string,
    o: { inTool?: boolean; countAttempt?: boolean; intro?: boolean } = {},
  ): { marker: string; prompt: string; task: SpecTask } | undefined => {
    const loaded = loadSpec(store, p.spec);
    const task = loaded ? buildTask(loaded.spec, taskId) : undefined;
    const tp = p.tasks.find((t) => t.id === taskId);
    if (!loaded || !task || !tp) return;
    const { cfg } = commands(ctx.cwd, store);
    if (tp.status === "todo" && cfg.checkpoints) {
      const snap = snapshot(ctx.cwd, `pb: before ${p.spec} ${taskId}`);
      if (snap) {
        const list = store.checkpoints(p.spec);
        // Mid-run starts record a fallback entry now (crash before turn_end still rewinds somewhere);
        // turn_end refines it to the end-of-turn leaf once the handover settles.
        const where = o.inTool
          ? { entry: tree(ctx).getLeafId?.() ?? undefined, pendingEntry: true as const, intro: o.intro || undefined }
          : { entry: tree(ctx).getLeafId?.() ?? undefined, intro: o.intro || undefined };
        list.push({ id: taskId, at: now(), ...snap, head: gitHead(ctx.cwd), tasks: structuredClone(p.tasks), task: taskId, ...where });
        store.saveCheckpoints(p.spec, list);
      }
      // Outside git snapshot() is undefined: no undo point, and /pb:undo already says so. No silent failure.
    }
    tp.status = "doing";
    if (o.countAttempt ?? true) tp.attempts += 1;
    tp.attempts = Math.max(tp.attempts, 1);
    p.current = taskId;
    p.pause = undefined;
    p.phase = "building";
    store.saveProgress(p);
    showProgress(ctx, p);
    return {
      task,
      marker: `▶ ${taskId}: ${task.title}${tp.attempts > 1 ? ` (attempt ${tp.attempts})` : ""}`,
      prompt: stepPrompt(ctx, store, loaded.spec, p, task, tp.attempts),
    };
  };

  /** Coherence pays off once slices can drift: single- and two-task builds skip the pass. */
  const needsCohere = (spec: ParsedSpec) => spec.tasks.length >= COHERE_MIN_TASKS;

  /**
   * Open the coherence pass: snapshot for undo (replacing any stale checkpoint from an undone pass),
   * record the synthetic step, and mark the turn boundary. Callers compose the marker and prompt.
   */
  const beginCohereEntry = (ctx: ExtensionContext, store: Store, p: Progress): void => {
    const { cfg } = commands(ctx.cwd, store);
    if (cfg.checkpoints) {
      const kept = store.checkpoints(p.spec).filter((c) => c.id !== COHERE_TASK_ID);
      const snap = snapshot(ctx.cwd, `pb: before ${p.spec} cohere`);
      if (snap) {
        kept.push({ id: COHERE_TASK_ID, at: now(), ...snap, head: gitHead(ctx.cwd), tasks: structuredClone(p.tasks), task: COHERE_TASK_ID, entry: tree(ctx).getLeafId?.() ?? undefined, pendingEntry: true });
        store.saveCheckpoints(p.spec, kept);
      }
    }
    p.tasks.push({ id: COHERE_TASK_ID, title: "Coherence pass: consolidate what slicing split apart", status: "doing", attempts: 1 });
    p.current = COHERE_TASK_ID;
    p.phase = "building";
    p.pause = undefined;
    store.saveProgress(p);
    showProgress(ctx, p);
    boundary = true;
  };
  const COHERE_MARKER = "▶ coherence pass";

  /** The build's state as a summary, for a reset at a task boundary or a compaction in the middle of a task. */
  const stateSummary = (ctx: ExtensionContext, store: Store, p: Progress, reason: "reset" | "compaction", extra: { changed?: string[]; read?: string[]; previous?: string } = {}) => {
    const loaded = loadSpec(store, p.spec);
    const { cfg, testCmd, buildCmd } = commands(ctx.cwd, store);
    const each = cfg.taskChecks === "each";
    const tp = p.tasks.find((t) => t.id === p.current);
    const task = loaded ? buildTask(loaded.spec, p.current) : undefined;
    const current =
      p.current === "final"
        ? fixText("final", `\`${p.lastVerify?.command ?? "the full suite"}\``, p.lastVerify?.summary ?? "", tp?.attempts ?? 1, cfg.maxAttempts, false)
        : p.current === COHERE_TASK_ID
          ? coherePrompt(p.baseCommit, tp?.attempts ?? 1, cfg.maxAttempts)
          : task && loaded
            ? stepPrompt(ctx, store, loaded.spec, p, task, tp?.attempts ?? 1)
            : `Carry on with ${p.current ?? "the build"}; finish it with pb_task_done.`;
    return buildStateSummary({ p, markdown: loaded?.md, mechanics: loaded ? buildMechanics(loaded.spec, buildCmd, each, store.extra("build")) : "", current, reason, ...extra });
  };

  /** When a build session should be reset at a task boundary: past checkpointAt, always before Pi would compact. */
  const pastCheckpoint = (ctx: ExtensionContext, store: Store, specTokens: number) => {
    const cfg = store.config();
    const usage = ctx.getContextUsage();
    if (!cfg.checkpointAt || !usage || usage.tokens == null) return undefined;
    const limit = Math.min((usage.contextWindow * cfg.checkpointAt) / 100, usage.contextWindow - PI_RESERVE_TOKENS - Math.max(12000, 2 * specTokens));
    return usage.tokens >= limit ? Math.round((100 * usage.tokens) / usage.contextWindow) : undefined;
  };

  const pauseBuild = (ctx: ExtensionContext, store: Store, p: Progress, reason: string, tipKey: string, why: string, vars: Record<string, string | number> = {}, say = post) => {
    p.phase = "paused";
    p.pause = reason;
    store.saveProgress(p);
    store.event(p.spec, { type: "pause", why, task: p.current });
    showProgress(ctx, p);
    say(`**⏸ Build paused** — ${reason}\n\nTo continue, run \`/${cmd("build")}\` (plain chat like "resume" won't re-attach the harness).\n\n${tip(tipKey, { spec: p.spec, ...vars })}`);
  };

  /**
   * A resume buys an exhausted step a fresh set of attempts; any other pause keeps its count.
   * Resets and returns true only when the step had exhausted its budget; the next handout
   * counts the new attempt.
   */
  const resetExhausted = (tp: { attempts: number } | undefined, max: number): boolean => {
    const exhausted = (tp?.attempts ?? 0) >= max;
    if (exhausted && tp) tp.attempts = 0;
    return exhausted;
  };

  /**
   * What a task did to existing tests (deleted, fewer cases, new skips) and to earlier tasks' files.
   * Nothing here fails a task: a refactor legitimately moves and merges tests. Test changes are listed
   * at the end of the build and handed to the reviewer, who judges whether each was justified.
   */
  const inspectTask = (ctx: ExtensionContext, store: Store, p: Progress): string[] => {
    const cps = store.checkpoints(p.spec);
    const entry = cps.find((c) => c.id === p.current);
    const start = cps[0];
    const after = entry && store.config().checkpoints ? snapshot(ctx.cwd, `pb: after ${p.spec} ${p.current}`) : undefined;
    if (!entry || !start || !after) return [];
    const others = new Set(cps.filter((c) => c.task && c.task !== p.current).flatMap((c) => c.files ?? []));
    const flags = inspectChanges(ctx.cwd, entry, after, start, others);
    entry.files = changedPaths(ctx.cwd, entry.commit, after.commit);
    store.saveCheckpoints(p.spec, cps);
    const tests = flags.filter((f) => f.kind === "tampering").map((f) => `${p.current}: ${f.detail}`);
    if (tests.length) p.testChanges = [...(p.testChanges ?? []).filter((c) => !c.startsWith(`${p.current}: `)), ...tests];
    return flags.map((f) => `${f.kind === "tampering" ? "existing tests changed (the review checks them)" : f.kind}: ${f.detail}`);
  };

  /**
   * pb_task_done said "done": check the current task inside the tool call, so the run (and with it
   * the prompt cache) stays alive. A failure goes back as the tool result; a pass hands out the next
   * task, the final check, or ends the build.
   */
  /** A check of the current step failed: back to the agent with a new attempt, or paused after the last one. */
  const failedCheck = (ctx: ExtensionContext, store: Store, p: Progress, what: string, failure: string) => {
    const cfg = store.config();
    const tp = p.tasks.find((t) => t.id === p.current);
    const attempts = tp?.attempts ?? 1;
    if (attempts >= cfg.maxAttempts) {
      if (tp) tp.status = "doing";
      pauseBuild(ctx, store, p, `${p.current} still fails after ${attempts} attempts.`, "build.paused-attempts", "attempts", { task: p.current ?? "" });
      return stop(fixText(p.current!, what, failure, attempts, cfg.maxAttempts, true));
    }
    if (tp) tp.attempts += 1;
    store.saveProgress(p);
    showProgress(ctx, p);
    return reply(fixText(p.current!, what, failure, attempts + 1, cfg.maxAttempts, false));
  };

  const checkAndAdvance = async (
    ctx: ExtensionContext,
    store: Store,
    p: Progress,
    spec: ParsedSpec,
    signal: AbortSignal | undefined,
  ): Promise<ReturnType<typeof reply> | ReturnType<typeof stop>> => {
    const final = p.current === "final";
    const { cfg, testCmd, buildCmd } = commands(ctx.cwd, store);
    const each = cfg.taskChecks === "each";
    const task = spec.tasks.find((t) => t.id === p.current);
    const tp = p.tasks.find((t) => t.id === p.current);
    const found = final ? [] : inspectTask(ctx, store, p);

    let failure: string | undefined;
    let what = "";
    const ran = checkCommand(spec, task, testCmd, buildCmd, final, each);
    if (ran) {
      showProgress(ctx, p, `checking ${final ? "everything" : p.current}: ${ran}`);
      p.lastVerify = await withChecking(() => runVerify(ran, ctx.cwd, cfg.verifyTimeoutSec, cfg.testOutputCap, signal));
      store.saveProgress(p);
      if (signal?.aborted) {
        pauseBuild(ctx, store, p, `you stopped the check of ${p.current}.`, "build.paused", "stopped");
        return stop("The check was stopped: the build is paused. Stop here.");
      }
      if (p.lastVerify.ok === false) {
        failure = p.lastVerify.summary;
        what = `\`${ran}\``;
      }
    }
    store.event(p.spec, { type: "check", task: p.current, attempt: tp?.attempts ?? 1, ok: !failure, command: ran, notices: found });

    if (failure) return failedCheck(ctx, store, p, what, failure);
    return advanceAfterCheck(ctx, store, p, spec, signal, found, ran);
  };

  /**
   * A check passed: close the finished step, then hand out the next task, open the
   * coherence pass, run the final check, or finish the build — the build's state machine.
   */
  const advanceAfterCheck = async (
    ctx: ExtensionContext,
    store: Store,
    p: Progress,
    spec: ParsedSpec,
    signal: AbortSignal | undefined,
    found: string[],
    ran: string | null,
  ): Promise<ReturnType<typeof reply> | ReturnType<typeof stop>> => {
    const { cfg, testCmd, buildCmd } = commands(ctx.cwd, store);
    const each = cfg.taskChecks === "each";
    const final = p.current === "final";
    const tp = p.tasks.find((t) => t.id === p.current);
    // Passed: close the task and move on.
    if (tp) tp.status = "done";
    const cps = store.checkpoints(p.spec);
    const cp = cps.find((c) => c.id === p.current);
    if (cp) {
      cp.summary = `${p.current} ✓ · ${(cp.files ?? []).length} files · ${(tp?.changed ?? tp?.summary ?? "").replace(/\s+/g, " ")}`;
      store.saveCheckpoints(p.spec, cps);
    }
    const notices = found.length ? `\n⚠ ${found.join("\n⚠ ")}` : "";
    const passed = `✓ ${p.current} ${ran ? `passed (\`${ran}\`)` : spec.gate === "none" ? "done (no checks for this feature)" : each ? "done (no check for this task)" : "done (checked after the last task)"}${notices}`;

    const next = nextTodo(p);
    if (next) {
      const t = beginTask(ctx, store, p, next.id, { inTool: true });
      if (!t) {
        pauseBuild(ctx, store, p, `${store.rel("specs", p.spec, "spec.md")} no longer parses; fix it, then /${cmd("build")}.`, "build.paused", "spec");
        return stop("The spec no longer parses: the build is paused. Stop here.");
      }
      boundary = true;
      return reply(`${passed}\n\n${t.prompt}`);
    }
    // Every spec task done: on builds big enough to drift, one coherence pass before the final check.
    if (!final && p.current !== COHERE_TASK_ID && !p.tasks.some((t) => t.id === COHERE_TASK_ID) && needsCohere(spec)) {
      beginCohereEntry(ctx, store, p);
      return reply(`${passed}\n\n${COHERE_MARKER}\n\n${coherePrompt(p.baseCommit, 1, cfg.maxAttempts)}`);
    }
    // Every task done: one full check, unless the last task's check was that already.
    const endCmd = checkCommand(spec, undefined, testCmd, buildCmd, true, each);
    if (!final && endCmd && ran !== endCmd) {
      p.current = "final";
      p.tasks.push({ id: "final", title: `Final check: ${spec.gate === "tests" ? "full suite" : "compile"}`, status: "doing", attempts: 1 });
      store.saveProgress(p);
      const r = await checkAndAdvance(ctx, store, p, spec, signal);
      return { ...r, content: text(`${passed}\nRunning \`${endCmd}\`…\n\n${r.content[0].text}`) };
    }
    p.tasks = p.tasks.filter((t) => t.id !== "final");
    p.phase = "built";
    p.current = undefined;
    p.nudged = undefined;
    store.saveProgress(p);
    store.event(p.spec, { type: "built" });
    showProgress(ctx, p);
    // The plan may have been split into several specs: the others are still waiting.
    const rest = p.writtenIn ? store.specsOfPlanning(p.writtenIn) : [];
    const stale = staleProseRefs(ctx.cwd, p.baseCommit);
    post(
      [
        `**✅ BUILD COMPLETE — ${p.spec}**${notices}`,
        "",
        "```",
        ...p.tasks.map(taskLine),
        "```",
        `Check: ${p.lastVerify?.summary.split("\n")[0] ?? `none (verification ${spec.gate})`}`,
        p.assumptions?.length ? `\nChoices the build made where the spec was unclear (in the spec's Decisions; the review checks them):\n${p.assumptions.map((a) => `- ${a}`).join("\n")}` : "",
        p.unattended?.length ? `\nDecided without you (no answer in time):\n${p.unattended.map((c) => `- ${c}`).join("\n")}` : "",
        p.testChanges?.length ? `\nExisting tests the build changed (the review checks whether each was justified):\n${p.testChanges.map((c) => `- ${c}`).join("\n")}` : "",
        redNotes(spec, p).length ? `\nNew tests never seen failing (the review judges each):\n${redNotes(spec, p).map((n) => `- ${n}`).join("\n")}` : "",
        stale.length ? `\nPossibly stale prose references (renamed or deleted identifiers still cited — intentional history is fine):\n${stale.map((s) => `- ${s.symbol}: ${s.referrers.join(", ")}`).join("\n")}` : "",
        "",
        commitBlock(commitMessage(store.readSpec(p.spec) ?? "")),
        "",
        tip("build.done", { spec: p.spec }),
        ...rest.map((n, i) => `${i ? "" : "\nStill to build, from the same plan:\n"}- ${n}: \`/${cmd("build")} ${n}\``),
      ].join("\n"),
    );
    return stop(`${passed}\n\nBuild complete: every check passed. Stop here; the harness shows the summary.`);
  };

  // The build session's own instance applies the carried-over model and thinking level before its first turn.
  pi.on("session_start", async (e, ctx) => {
    const store = new Store(ctx.cwd);
    const session = ctx.sessionManager.getSessionFile();
    const ev = e as { reason?: string; previousSessionFile?: string };
    const carry = ev.reason === "new" ? store.takeCarry(ev.previousSessionFile) : undefined;
    if (carry?.review && session) store.saveReviewSession(session, carry.review);
    // A review session's model reads and reports only; everywhere else pb_report_findings isn't offered.
    const active = pi.getActiveTools();
    if (store.reviewSession(session)) {
      pi.setActiveTools(REVIEW_SESSION_TOOLS);
      if (store.reviewRun()?.interrupted?.session === session) ctx.ui.notify(`This review was interrupted: \`/${cmd("review")} continue\` picks it up where it was.`, "info");
    }
    else if (active.includes("pb_report_findings")) pi.setActiveTools(active.filter((t) => t !== "pb_report_findings"));
    if (!carry) return;
    if (carry.model) {
      const model = findModel(ctx, carry.model);
      if (model) await pi.setModel(model as Parameters<typeof pi.setModel>[0]);
    }
    if (carry.thinking) pi.setThinkingLevel(carry.thinking as Parameters<typeof pi.setThinkingLevel>[0]);
  });

  // Like a stop hook: an agent that ends its run mid-task gets one reminder per attempt before the build pauses.
  pi.on("agent_before_settle", (e, ctx) => {
    if ((e as { outcome?: string }).outcome !== "completed") return;
    const { store, progress: p } = specOfSession(ctx);
    if (!p || p.phase !== "building" || !p.current) return;
    const key = `${p.current}#${p.tasks.find((t) => t.id === p.current)?.attempts ?? 0}`;
    if (p.nudged === key) return;
    p.nudged = key;
    store.saveProgress(p);
    store.event(p.spec, { type: "nudge", task: p.current });
    return { entries: [{ type: "custom_message" as const, customType: "pb-instruction", content: nudgePrompt(p.current), display: false }], continue: true };
  });

  /*
   * The planning checkpoint. Past checkpointAt (and always before Pi would compact), the model writes the
   * plan to its spec while it still has the whole discussion; at the end of that run pb resets the session
   * to the spec: a compaction whose summary is the spec, keeping nothing else. No summarizing model call,
   * and the spec is the smarter summary: what was found, decided and rejected, and what is still open.
   */
  const checkpointing = new Map<string, { since: string; percent: number; from?: string; last: { human?: string; answer?: string } }>();
  // Don't ask again until the session has grown another 5% of its window (after a failed or undone checkpoint).
  const checkpointQuiet = new Map<string, number>();

  /** The human's last message and the reply to it, for the reset summary: the thread you were in stays word for word. */
  const lastExchange = (ctx: ExtensionContext) => {
    const branch = tree(ctx).getBranch?.() ?? [];
    let human: string | undefined;
    let answer: string | undefined;
    for (let i = branch.length - 1; i >= 0 && !human; i--) {
      const e = branch[i];
      if (e.type !== "message") continue;
      const t = contentText(e.message?.content).trim();
      if (!t) continue;
      if (e.message?.role === "assistant" && !answer) answer = t;
      else if (e.message?.role === "user") human = t;
    }
    return { human, answer };
  };

  /** Ask for the checkpoint now: the spec is written in this run, and the reset follows when it settles. */
  const requestCheckpoint = (ctx: ExtensionContext, store: Store, session: string) => {
    const usage = ctx.getContextUsage();
    const percent = usage?.tokens != null ? Math.round((100 * usage.tokens) / usage.contextWindow) : Math.round(usage?.percent ?? 0);
    checkpointing.set(session, { since: now(), percent, from: tree(ctx).getLeafId?.() ?? undefined, last: lastExchange(ctx) });
    return checkpointPrompt(percent, store.specsOfPlanning(session));
  };

  pi.registerCommand(cmd("compact"), {
    description:
      "pb's compaction. Planning: write the plan to its spec, then reset the session to it (e.g. before quitting); /pb:compact undo brings the whole discussion back. Build: compact to the build's state, no summarizing model call",
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) return ctx.ui.notify("Pi is busy. Wait for the current turn to finish.", "warning");
      const store = new Store(ctx.cwd);
      const session = ctx.sessionManager.getSessionFile();
      const build = specOfSession(ctx).progress;
      if (session && build && unfinishedPhase(build.phase) && args.trim() !== "undo") {
        // A build: Pi compacts, with the summary pb writes from the build's state (session_before_compact).
        return ctx.compact({
          onComplete: () => ctx.ui.notify("Compacted to the build's state: tasks, the current task and what it changed, the spec.", "info"),
          onError: (e) => ctx.ui.notify(`Compaction failed: ${e.message}`, "error"),
        });
      }
      if (!session || !store.planningSessions().includes(session))
        return ctx.ui.notify(`/${cmd("compact")} is for planning and build sessions; elsewhere, Pi's /compact.`, "warning");
      if (args.trim() !== "undo") return instruct(`▶ /${cmd("compact")} — writing the plan to its spec, then resetting to it`, requestCheckpoint(ctx, store, session));

      const from = store.planning(session)?.checkpointFrom;
      const nav = (ctx as Partial<ExtensionCommandContext>).navigateTree;
      if (!from || !nav || !tree(ctx).getEntry?.(from)) return ctx.ui.notify("Nothing to undo: no planning reset in this session.", "info");
      const branch = tree(ctx).getBranch?.() ?? [];
      const reset = branch.map((e) => e.type).lastIndexOf("compaction");
      const since = reset < 0 ? 0 : branch.slice(reset + 1).filter((e) => e.type === "message").length;
      if (since && ctx.hasUI && !(await ctx.ui.confirm("Undo the reset?", `The ${since} message(s) since it stay on the other branch (reachable with /tree).`))) return;
      const r = await nav(from, { summarize: false, label: "pb: compact undone" });
      if (r.cancelled) return;
      store.setCheckpointFrom(session, undefined);
      checkpointQuiet.set(session, ctx.getContextUsage()?.tokens ?? Number.MAX_SAFE_INTEGER);
      post(`**↺ Reset undone**: the whole discussion is back in the context. The spec keeps what was written to it; \`/${cmd("compact")}\` writes and resets again when you want.`);
    },
  });

  pi.on("agent_before_settle", (e, ctx) => {
    if ((e as { outcome?: string }).outcome !== "completed") return;
    const session = ctx.sessionManager.getSessionFile();
    if (!session) return;
    const store = new Store(ctx.cwd);
    if (!store.planningSessions().includes(session)) return;
    const cfg = store.config();
    const usage = ctx.getContextUsage();
    const pending = checkpointing.get(session);
    if (pending) {
      checkpointing.delete(session);
      const planned = store.specsOfPlanning(session);
      if (!planned.some((n) => (store.progress(n)?.updatedAt ?? "") >= pending.since)) {
        checkpointQuiet.set(session, usage?.tokens ?? 0);
        return { entries: [{ type: "custom_message" as const, customType: "pb", content: "pb: the plan wasn't written to a spec, so the conversation goes on as it is (Pi compacts it when it's full).", display: true }] };
      }
      const specs = planned.map((n) => ({ name: n, markdown: store.readSpec(n) ?? "" }));
      store.setCheckpointFrom(session, pending.from);
      for (const n of planned) {
        const q = store.progress(n)!;
        store.saveProgress({ ...q, compacted: false });
        store.event(n, { type: "checkpoint", tokensBefore: usage?.tokens, percent: pending.percent });
      }
      return {
        entries: [
          { type: "compaction" as const, summary: checkpointSummary(specs, pending.last, store.planning(session)?.request), firstKeptEntryId: null, details: { pb: "checkpoint", specs: planned } },
          {
            type: "custom_message" as const,
            customType: "pb",
            content: `**Plan checkpointed** to ${planned.map((n) => store.rel("specs", n, "spec.md")).join(", ")}: the conversation was reset to it (it was ${pending.percent}% full). Carry on; \`/${cmd("build")}\` when ready · \`/${cmd("compact")} undo\` brings the whole discussion back.`,
            display: true,
          },
        ],
      };
    }
    if (!cfg.checkpointAt || !usage || usage.tokens == null) return;
    const specTokens = store.specsOfPlanning(session).reduce((n, name) => n + tokensOf(store.readSpec(name) ?? ""), 0);
    const limit = Math.min((usage.contextWindow * cfg.checkpointAt) / 100, usage.contextWindow - PI_RESERVE_TOKENS - Math.max(12000, 2 * specTokens));
    if (usage.tokens < limit) return;
    const quietUntil = checkpointQuiet.get(session);
    if (quietUntil !== undefined && usage.tokens < quietUntil + usage.contextWindow * 0.05) return; // don't insist every turn
    return { entries: [{ type: "custom_message" as const, customType: "pb-instruction", content: requestCheckpoint(ctx, store, session), display: false }], continue: true };
  });

  pi.on("agent_settled", async (_e, ctx) => {
    if (await offerPendingBuild(ctx)) return;
    const { store, progress: p } = specOfSession(ctx);
    if (p?.phase === "building") pauseBuild(ctx, store, p, "the agent stopped without finishing its task (you stopped it, or it stopped again after a reminder).", "build.paused", "stopped");
  });

  /*
   * At the end of a turn: rewind points for tasks started mid-run, and the build's reset. Right after a task
   * passed and the next was handed out, past checkpointAt, the session is reset to the build's state: the
   * finished task is done and summarized, the next hasn't started, so nothing half-done is lost (unlike a
   * compaction in the middle of a task). No summarizing model call.
   */
  pi.on("turn_end", (_e, ctx) => {
    const { store, name, progress: p } = specOfSession(ctx);
    const wasBoundary = boundary;
    boundary = false;
    if (!name || !p) return;
    const leaf = tree(ctx).getLeafId?.() ?? undefined;
    const cps = store.checkpoints(name);
    let changed = false;
    // A reset in the last turn: the task it handed out starts at that reset (undo goes back to it).
    const branch = tree(ctx).getBranch?.() ?? [];
    const lastReset = [...branch].reverse().find((x) => x.type === "compaction")?.id;
    for (const c of cps.filter((c) => c.pendingReset)) {
      if (!lastReset) continue; // no reset happened: keep pending for the next turn
      c.entry = lastReset;
      delete c.pendingReset;
      changed = true;
    }
    for (const c of cps.filter((c) => c.pendingEntry)) {
      c.entry = leaf;
      delete c.pendingEntry;
      changed = true;
    }
    if (changed) store.saveCheckpoints(name, cps);

    if (!wasBoundary || p.phase !== "building" || !p.current) return;
    const percent = pastCheckpoint(ctx, store, tokensOf(store.readSpec(name) ?? ""));
    if (percent === undefined) return;
    const cp = cps.find((c) => c.id === p.current);
    if (cp) {
      cp.pendingReset = true;
      store.saveCheckpoints(name, cps);
    }
    store.event(name, { type: "reset", task: p.current, percent });
    return {
      entries: [
        { type: "compaction" as const, summary: stateSummary(ctx, store, p, "reset"), firstKeptEntryId: null, details: { pb: "build-reset", task: p.current } },
        { type: "custom_message" as const, customType: "pb", content: `**Context reset** before ${p.current} (it was ${percent}% full): the build goes on from its state and the spec.`, display: true },
      ],
    };
  });

  // Stats: every model turn in a build session, with its tokens and cache use.
  pi.on("message_end", (e, ctx) => {
    const m = (e as { message?: { role?: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } } } }).message;
    if (m?.role !== "assistant" || !m.usage) return;
    const review = new Store(ctx.cwd).reviewSession(ctx.sessionManager.getSessionFile());
    if (review) {
      // A review session's turns count as the review's cost, for the spec it reviews.
      const u = m.usage;
      if (review.spec) new Store(ctx.cwd).event(review.spec, { type: "review-usage", role: review.role, input: u.input ?? 0, output: u.output ?? 0, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0, cost: u.cost?.total ?? 0 });
      return;
    }
    const { store, name, progress } = specOfSession(ctx);
    if (!name || !progress) return;
    const u = m.usage;
    store.event(name, {
      type: "usage",
      task: progress.current ?? "chat",
      input: u.input ?? 0,
      output: u.output ?? 0,
      cacheRead: u.cacheRead ?? 0,
      cacheWrite: u.cacheWrite ?? 0,
      cost: u.cost?.total ?? 0,
      window: (ctx.model as { contextWindow?: number } | undefined)?.contextWindow,
    });
  });

  /*
   * Compaction without another model call. A build session: the summary comes from the build's state.
   * A planning session with a spec: the spec is the summary (normally the checkpoint below resets the
   * session before Pi compacts; this covers a single turn that overshoots). Anywhere else Pi summarizes,
   * and the specs this session wrote are no longer in its context word for word.
   */
  pi.on("session_before_compact", (e, ctx) => {
    const { store, name, progress: p } = specOfSession(ctx);
    const ev = e as { preparation: { firstKeptEntryId: string; tokensBefore: number; previousSummary?: string }; reason?: string };
    if (!name || !p || !unfinishedPhase(p.phase)) {
      const session = ctx.sessionManager.getSessionFile();
      const review = store.reviewSession(session);
      const run = review ? store.reviewRun() : undefined;
      if (review && run) {
        // A review session: reset to its role, the brief verbatim, the findings so far, and the
        // files read — plus a wrap-up directive when compactions repeat with nothing new read.
        const ops = (ev.preparation as { fileOps?: { read?: Iterable<string>; edited?: Iterable<string>; written?: Iterable<string> } }).fileOps;
        const read = ops?.read ? [...ops.read] : undefined;
        const tokens = ev.preparation.tokensBefore;
        // Findings reported between two compactions are progress too: the end of a review is
        // reading done, writing findings and running checks, which reads nothing new.
        const findings = [...run.passes.flatMap((x) => x.findings), ...(review.findings ?? [])].length;
        const prev = session ? compactStalls.get(session) : undefined;
        const progressed = !prev || (read?.some((f) => !prev.read.includes(f)) ?? false) || findings > (prev.findings ?? 0) || tokens < prev.tokens;
        const strikes = progressed ? 0 : (prev?.strikes ?? 0) + 1;
        if (session) rememberStall(session, { task: `review:${review.role}`, changed: [], read: read ?? [], tokens, strikes, findings });
        const wrapUp = strikes >= COMPACT_STALL_LIMIT;
        if (run.name) store.event(run.name, { type: "compact", reason: ev.reason, tokensBefore: ev.preparation.tokensBefore, review: review.role, ...(run.id ? { run: run.id } : {}), ...(wrapUp ? { thrash: true } : {}) });
        return {
          compaction: {
            summary: reviewStateSummary({
              label: run.label,
              role: review.role,
              brief: run.brief,
              findings: [...run.passes.flatMap((x) => x.findings), ...(review.findings ?? [])],
              read,
              wrapUp,
            }),
            firstKeptEntryId: ev.preparation.firstKeptEntryId,
            tokensBefore: ev.preparation.tokensBefore,
          },
        };
      }
      const planned = session ? store.specsOfPlanning(session) : [];
      if (session && planned.length && store.planningSessions().includes(session)) {
        for (const n of planned) store.event(n, { type: "compact", reason: ev.reason, tokensBefore: ev.preparation.tokensBefore, planning: true });
        return {
          compaction: {
            summary: checkpointSummary(planned.map((n) => ({ name: n, markdown: store.readSpec(n) ?? "" })), undefined, store.planning(session)?.request),
            firstKeptEntryId: ev.preparation.firstKeptEntryId,
            tokensBefore: ev.preparation.tokensBefore,
          },
        };
      }
      for (const n of planned) {
        const q = store.progress(n)!;
        store.saveProgress({ ...q, compacted: true });
      }
      return;
    }
    store.event(name, { type: "compact", reason: ev.reason, tokensBefore: ev.preparation.tokensBefore, task: p.current });
    // No compacted flag for builds: stateSummary below includes the spec markdown, so the session still
    // knows it (knowsSpec stays true) and continuePrompt correctly omits resending it. The flag is only
    // for planning sessions whose compaction drops the spec.
    // What the current task has done so far, from git: the files it changed since its undo point.
    const cp = store.checkpoints(name).find((c) => c.id === p.current);
    const now_ = cp ? snapshot(ctx.cwd, `pb: compaction during ${p.current}`) : undefined;
    const changed = cp && now_ ? changedPaths(ctx.cwd, cp.commit, now_.commit) : undefined;
    const ops = (ev.preparation as { fileOps?: { read?: Iterable<string>; edited?: Iterable<string>; written?: Iterable<string> } }).fileOps;
    const read = ops?.read ? [...ops.read].filter((f) => !changed?.includes(f)) : undefined;
    // The thrash guard: compacting the same task over and over with nothing new changed, read, or
    // shrunk is stuck, not long (a giant output refilling the context, or a loop). Pause with the
    // likely causes instead of compacting forever; any one sign of progress resets the count.
    const session = ctx.sessionManager.getSessionFile();
    const tokens = ev.preparation.tokensBefore;
    const prev = session ? compactStalls.get(session) : undefined;
    const progressed =
      !prev || prev.task !== p.current || (changed?.some((f) => !prev.changed.includes(f)) ?? false) || (read?.some((f) => !prev.read.includes(f)) ?? false) || tokens < prev.tokens;
    const strikes = progressed ? 0 : (prev?.strikes ?? 0) + 1;
    if (session) rememberStall(session, { task: p.current, changed: changed ?? [], read: read ?? [], tokens, strikes });
    if (strikes >= COMPACT_STALL_LIMIT && p.phase === "building") {
      pauseBuild(
        ctx,
        store,
        p,
        `compacted ${strikes} times during ${p.current ?? "the build"} without getting anywhere (no new files read or changed, context not shrinking). Something is stuck: one giant tool output refilling the context (a verbose Test: command? \`testOutputCap\` trims to ${store.config().testOutputCap} chars), an oversized spec, or the task looping. Look at the session, then /${cmd("build")} to go on, /${cmd("undo")} ${p.current ?? "start"} to throw it away, or /${cmd("spec")} ${p.spec} to split the task.`,
        "build.paused",
        "thrash",
      );
      // The pause is the whole answer: a compaction here would hand the model a step prompt for a
      // build the harness now refuses to continue. A resume starts the guard over.
      if (session) compactStalls.delete(session);
      return { cancel: true };
    }
    return {
      compaction: {
        summary: stateSummary(ctx, store, p, "compaction", { changed, read, previous: ev.preparation.previousSummary }),
        firstKeptEntryId: ev.preparation.firstKeptEntryId,
        tokensBefore: ev.preparation.tokensBefore,
      },
    };
  });

  pi.on("session_before_tree", () => (undoSummary ? { summary: { summary: undoSummary } } : undefined));

  // Best-effort: this process's private index files are inert but not git's business to keep.
  pi.on("session_shutdown", (_e, ctx) => cleanupIndexes(ctx.cwd));

  // Keep the cache warm while a check runs: the agent certainly continues afterwards.
  pi.on("cache_warming_decision", () => (checking > 0 ? { action: "warm" as const } : undefined));

  /**
   * Everything that must hold before a build starts: a parseable, finished spec, a check
   * command for its gate, the dependency built, a green (or accepted red) baseline, and
   * planning changes reviewed. Returns the loaded spec and its build command, or undefined
   * after telling the human why not.
   */
  const preBuildChecks = async (
    ctx: ExtensionContext,
    store: Store,
    name: string,
    o: { checked?: boolean; notes?: string[] },
  ) => {
    const notes = o.notes ?? [];
    const loaded = loadSpec(store, name);
    if (!loaded) {
      ctx.ui.notify(`${store.rel("specs", name, "spec.md")} doesn't parse. Rewrite it with /${cmd("spec")} ${name}.`, "error");
      return undefined;
    }
    const { spec, md } = loaded;
    if (spec.status === "planning") {
      ctx.ui.notify(`${name} is still being planned: /${cmd("build")} ${name} finishes it first.`, "warning");
      return undefined;
    }
    const { cfg, testCmd, buildCmd } = commands(ctx.cwd, store);
    if (spec.gate === "tests" && !testCmd) {
      ctx.ui.notify(`Verification is "tests" but no test command is set: set "verify" in ${store.rel("config.json")}, or use Verification: build/none in the spec.`, "warning");
      return undefined;
    }
    if (spec.gate === "build" && !buildCmd) {
      ctx.ui.notify(`Verification is "build" but no build command is set: set "build" in ${store.rel("config.json")}.`, "warning");
      return undefined;
    }
    if (spec.dependsOn) {
      const dep = store.progress(spec.dependsOn)?.phase;
      if (dep !== "built" && dep !== "reviewed") {
        if (!(await agree(ctx, store, `${name} depends on ${spec.dependsOn}, which isn't built yet. Build ${name} anyway?`, notes))) return undefined;
      }
    }
    if (!o.checked && spec.gate === "tests" && baselineApplies(ctx, store, testCmd)) {
      if (!(await agree(ctx, store, baselineQuestion(store.baseline(ctx.sessionManager.getSessionFile() ?? undefined)!), notes))) return undefined;
    }
    if (!o.checked && !(await reviewPlanningChanges(ctx, store, notes))) return undefined;
    // Post-ready drift (e.g. via human edits, which save on parse alone) is advisory
    // here, never blocking: the human sees it now, the reviewer judges it later.
    const shapeAdvisory = semanticErrors(md, spec);
    if (shapeAdvisory.length) {
      notes.push(`Spec-shape advisory (build proceeds):\n${shapeAdvisory.map((e) => `- ${e}`).join("\n")}`);
      ctx.ui.notify(`Spec-shape advisory: ${shapeAdvisory.length} senior-shape note(s); listed in the build summary for the reviewer to judge.`, "warning");
    }
    if (!cfg.checkpoints) ctx.ui.notify("Checkpoints are off: this build runs without undo points, and without the test-tampering checks.", "warning");
    return { spec, md, cfg, buildCmd };
  };

  /**
   * Fresh progress for (re)starting a build: finished tasks stay done with their proofs,
   * everything else goes back to todo — attempts included, so a crash grants no fresh budget.
   * Returns the progress and the first unfinished step, or undefined when nothing is left.
   */
  const initBuildProgress = (ctx: ExtensionContext, store: Store, name: string, spec: ParsedSpec, notes: string[]) => {
    const prev = store.progress(name);
    const restart = !!prev && unfinishedPhase(prev.phase);
    const p: Progress = {
      ...prev,
      spec: name,
      phase: "building",
      baseCommit: restart ? (prev!.baseCommit ?? gitHead(ctx.cwd)) : gitHead(ctx.cwd),
      // A task's tests seen failing stay proven: only /pb:undo takes that back, with the files.
      // Attempts are preserved on restart: a crash must not grant a fresh budget. A fresh set comes
      // only from answering an exhausted task via /pb:build guidance (see the build command below).
      tasks: syncTasks(spec, prev?.tasks).map((t) => (t.status === "done" ? t : { ...t, status: "todo" as const })),
      current: undefined,
      pause: undefined,
      nudged: undefined,
      needsIntro: prev?.needsIntro,
      detached: undefined,
      unattended: notes.length ? notes : undefined,
      updatedAt: now(),
    };
    const first = p.tasks.find((t) => t.status !== "done")?.id ?? (needsCohere(spec) && !prev?.tasks.some((t) => t.id === COHERE_TASK_ID && t.status === "done") ? COHERE_TASK_ID : undefined);
    if (!first) {
      ctx.ui.notify(`Every task of ${name} is done. Next: /${cmd("review")} ${name}.`, "info");
      return undefined;
    }
    return { p, first, restart };
  };

  /** The start-of-build undo point, in the session that builds. */
  const saveStartCheckpoint = (c: ExtensionContext, store: Store, name: string, p: Progress, checkpoints: boolean, restart: boolean) => {
    if (!checkpoints || (restart && store.checkpoints(name).length)) return;
    const snap = snapshot(c.cwd, `pb: start of ${name}`);
    const entry = tree(c).getLeafId?.() ?? undefined;
    store.saveCheckpoints(name, snap ? [{ id: "start", at: now(), ...snap, head: p.baseCommit, tasks: structuredClone(p.tasks), entry, intro: true }] : []);
  };

  interface LaunchBuild {
    ctx: ExtensionContext;
    store: Store;
    name: string;
    spec: ParsedSpec;
    md: string;
    p: Progress;
    first: string;
    restart: boolean;
    buildModel: unknown;
    switching: boolean;
    session: string | undefined;
  }

  /** Same session: lift the planning protection, send the build instructions and the first task. */
  const launchBuildHere = async (o: LaunchBuild): Promise<void> => {
    const { ctx, store, name, spec, md, p, first, restart, buildModel, switching, session } = o;
    const { cfg, buildCmd } = commands(ctx.cwd, store);
    if (buildModel && switching) await pi.setModel(buildModel as Parameters<typeof pi.setModel>[0]);
    p.session = session;
    if (!(await liftPlanning(ctx, store))) return;
    store.saveProgress(p);
    saveStartCheckpoint(ctx, store, name, p, cfg.checkpoints, restart);
    store.event(name, { type: "build-start", tasks: spec.tasks.length, gate: spec.gate, fresh: false });
    const knowsSpec = !!session && p.writtenIn === session && !p.edited && !p.compacted;
    const cohereFirst = first === COHERE_TASK_ID;
    if (cohereFirst) beginCohereEntry(ctx, store, p);
    const task = cohereFirst ? null : beginTask(ctx, store, p, first, { intro: true });
    if (!task && !cohereFirst) return ctx.ui.notify(`${store.rel("specs", name, "spec.md")} no longer parses. Fix it (or /${cmd("spec")} ${name}), then /${cmd("build")}.`, "error");
    const marker = cohereFirst ? COHERE_MARKER : task!.marker;
    const prompt = cohereFirst ? coherePrompt(p.baseCommit, 1, cfg.maxAttempts) : task!.prompt;
    instruct(
      `▶ Building **${name}** here${switching ? ` on ${cfg.buildModel}` : ""}${knowsSpec ? "" : " (the spec comes along: this session didn't write it, or it was edited since)"}.\n${marker}`,
      `${buildIntro(name, spec, buildCmd, cfg.taskChecks === "each", standardsFor(ctx), knowsSpec ? undefined : md, store.extra("build"))}\n\n${prompt}`,
    );
  };

  /** Fresh session: seeded with the spec, on the model and thinking level you planned with. */
  const launchBuildFresh = async (o: LaunchBuild): Promise<void> => {
    const { ctx, store, name, spec, md, p, first, restart, buildModel, switching, session } = o;
    const { cfg, buildCmd } = commands(ctx.cwd, store);
    const cctx = ctx as ExtensionCommandContext;
    const carried = { model: buildModel ? cfg.buildModel : sessionModel(ctx), thinking: pi.getThinkingLevel() as string | undefined };
    store.setCarry({ ...carried, spec: name, parent: session ?? undefined });
    // A new session loads AGENTS.md itself: the standards needn't come along.
    const intro = buildIntro(name, spec, buildCmd, cfg.taskChecks === "each", "", md, store.extra("build"));
    const result = await cctx.newSession({
      parentSession: session,
      setup: async (sm) => {
        sm.appendSessionInfo(`build: ${name}`);
      },
      withSession: async (c) => {
        // Only `c` from here on: the captured pi and ctx belong to the replaced session.
        // The new session gets a fresh runtime with the default tools, so editing is on.
        p.session = c.sessionManager.getSessionFile();
        store.saveProgress(p);
        saveStartCheckpoint(c, store, name, p, cfg.checkpoints, restart);
        if (!cfg.checkpoints) c.ui.notify("Checkpoints are off: this build runs without undo points, and without the test-tampering checks.", "warning");
        store.event(name, { type: "build-start", tasks: spec.tasks.length, gate: spec.gate, fresh: true });
        const cohereFirst = first === COHERE_TASK_ID;
        if (cohereFirst) beginCohereEntry(c, store, p);
        const task = cohereFirst ? null : beginTask(c, store, p, first, { intro: true });
        if (!task && !cohereFirst) {
          pauseBuild(c, store, p, `${store.rel("specs", name, "spec.md")} no longer parses; fix it, then /${cmd("build")}.`, "build.paused", "spec", {}, (content) =>
            c.sendMessage({ customType: "pb", content, display: true }, { triggerTurn: false }),
          );
          return;
        }
        const prompt = cohereFirst ? coherePrompt(p.baseCommit, 1, cfg.maxAttempts) : task!.prompt;
        await c.sendMessage(
          {
            customType: "pb",
            content: `▶ Building **${name}** from ${store.rel("specs", name, "spec.md")}${carried.model ? `, on ${carried.model}` : ""}${carried.thinking ? `, thinking ${carried.thinking}` : ""}.\nThis session: "build: ${name}" · back to it with /resume, or \`pi --session ${c.sessionManager.getSessionId()}\`\n${cohereFirst ? COHERE_MARKER : task!.marker}`,
            display: true,
          },
          { triggerTurn: false },
        );
        // Not awaited: the build runs on in this session while the command returns.
        void c.sendMessage({ customType: "pb-instruction", content: `${intro}\n\n${prompt}`, display: false }, { triggerTurn: true });
      },
    }).catch((e) => {
      store.clearCarry(); // a throw must not leave the handover behind either
      throw e;
    });
    if (result.cancelled) {
      store.clearCarry(); // its handover must not leak into a later, unrelated new session
      if (!sessionGone(ctx)) ctx.ui.notify("Build cancelled.", "info");
    }
  };

  /**
   * Start building a spec. In this session by default: the conversation that planned it
   * stays, and the prompt cache with it. `fresh` opens a new session seeded with the spec
   * instead (command context only: sessions can't be replaced from event handlers).
   * decided: the human already chose where (the spec-approval dialog).
   */
  /**
   * Fresh eyes on the plan before the first task: a spec-sized review that attacks Decisions,
   * re-tests "Not doing X" rejections and flags unmeasured quantitative claims. A pass covers
   * exactly the text it saw, hash and all, on its {type:"spec-review"} event: a later start
   * re-runs it when the text changed (the earlier findings first, to judge), re-posts a standing
   * block instead of re-running, and --force skips it as recorded acceptance. Only the way into a
   * build gates; resumes after T1 started never do, however the spec has changed since.
   */
  const runSpecReview = async (ctx: ExtensionContext, store: Store, name: string, md: string, prior: Finding[] = []): Promise<{ findings: Finding[]; block: boolean }> => {
    const hash = specHash(md);
    const res = await runFresh({
      cwd: ctx.cwd,
      role: "spec-review",
      systemPrompt: SPEC_REVIEWER_SYSTEM,
      brief: specReviewBrief(name, md, prior),
      prompt: prior.length ? "Review the spec again in the attached file, judging the earlier findings first." : "Review the spec in the attached file.",
      tools: ["read", "grep", "find", "ls", "bash"],
      model: sessionModel(ctx),
      sessionDir: store.sessionsDir("spec-review"),
    });
    const parsed = parseSpecReview(res.text);
    store.event(name, { type: "spec-review", verdict: parsed.block ? "block" : "pass", findings: parsed.findings.length, reported: parsed.findings, hash, followUp: prior.length > 0 });
    return parsed;
  };

  const startBuild = async (
    ctx: ExtensionContext,
    store: Store,
    name: string,
    fresh: boolean,
    o: { decided?: boolean; checked?: boolean; notes?: string[]; force?: boolean } = {},
  ): Promise<void> => {
    const notes = o.notes ?? [];
    const checked = await preBuildChecks(ctx, store, name, o);
    if (!checked) return;
    const { spec, md, cfg } = checked;

    // The review gates only the way into a build: once T1 has started, the spec changes as the
    // build runs (Design, Decisions) and a resume or restart must not re-litigate those.
    // Findings of any priority stop the build here, so the review is read before anything builds.
    const phase = store.progress(name)?.phase ?? "written";
    if (phase === "written") {
      const hash = specHash(md);
      const gate = specReviewGate(readEvents(path.join(store.specDir(name), "events.jsonl")), hash);
      if (o.force && gate.action !== "skip") {
        const accepted = gate.action === "repost" ? gate.findings : [];
        store.event(name, { type: "spec-review", verdict: "forced", hash, findings: accepted.length, reported: accepted });
        post(
          accepted.length
            ? `**Spec review forced** — building the spec as it stands; ${accepted.length} standing finding${accepted.length === 1 ? "" : "s"} recorded as accepted.`
            : "**Spec review forced** — building the spec without a review of this text.",
        );
      } else if (gate.action === "repost") {
        post(`**Spec review** — changes needed before T1 (the spec is unchanged since that review):\n${gate.findings.map((f, i) => findingLine(f, i + 1)).join("\n")}`);
        ctx.ui.notify(
          `Spec review still blocks T1: the spec hasn't changed since it was reviewed. Amend it (or record a rebuttal in Decisions) and rebuild — the next pass judges your change; /${cmd("build")} --force builds it as it stands.`,
          "warning",
        );
        return;
      } else if (gate.action === "review") {
        const review = await runSpecReview(ctx, store, name, md, gate.prior);
        if (sessionGone(ctx)) return; // replaced while it ran: the verdict is recorded, rerunning resumes from it
        if (store.readSpec(name) !== md) {
          ctx.ui.notify(`The spec changed while it was under review: run /${cmd("build")} again and the new text will be reviewed.`, "warning");
          return;
        }
        if (review.findings.length) {
          post(`**Spec review** — ${review.block ? "changes needed before T1" : "advisory findings"}:\n${review.findings.map((f, i) => findingLine(f, i + 1)).join("\n")}`);
        }
        if (review.block) {
          ctx.ui.notify(
            `Spec review blocks T1: amend the spec (or record a rebuttal in Decisions) and rebuild — the next pass judges your change; /${cmd("build")} --force builds it as it stands.`,
            "warning",
          );
          return;
        }
        // Advisory findings pause here too: the point is to read the review before anything builds.
        if (review.findings.length) {
          ctx.ui.notify(
            `Spec review passed with ${review.findings.length} advisory finding${review.findings.length === 1 ? "" : "s"}: read them, then /${cmd("build")} again to build as it stands (the recorded pass covers this text, so nothing is re-reviewed), or amend the spec and let the next pass judge the change.`,
            "warning",
          );
          return;
        }
      }
    }

    // Optionally build on another model (e.g. plan on a strong one, build on a local one).
    let buildModel: unknown;
    if (cfg.buildModel) {
      buildModel = findModel(ctx, cfg.buildModel);
      if (!buildModel) ctx.ui.notify(`buildModel "${cfg.buildModel}" isn't a model Pi knows; building on ${sessionModel(ctx) ?? "the current model"}.`, "warning");
    }
    const switching = !!buildModel && cfg.buildModel !== sessionModel(ctx);
    const canOpenSession = typeof (ctx as Partial<ExtensionCommandContext>).newSession === "function";
    if (!fresh && !o.decided) {
      const usage = ctx.getContextUsage()?.percent;
      const full = usage != null && usage > cfg.freshAbove;
      if ((full || switching) && ctx.hasUI) {
        const why = switching ? `building on ${cfg.buildModel} here sends this whole conversation to it again, uncached` : `this session is ${Math.round(usage!)}% full`;
        const FRESH = "Build in a fresh session, from the spec (recommended)";
        const HERE = "Build here anyway";
        const choice = await choose(ctx, store, `Build ${name}: ${why}`, [FRESH, HERE], canOpenSession ? FRESH : HERE, notes);
        if (!choice) return;
        fresh = choice === FRESH;
      } else if (switching) fresh = true;
    }
    if (fresh && !canOpenSession) {
      ctx.ui.setEditorText(`/${cmd("build")} ${name} --fresh`);
      return ctx.ui.notify(`Press Enter to build ${name} in a fresh session.`, "info");
    }

    const session = ctx.sessionManager.getSessionFile();
    const init = initBuildProgress(ctx, store, name, spec, notes);
    if (!init) return;
    const launch = { ctx, store, name, spec, md, p: init.p, first: init.first, restart: init.restart, buildModel, switching, session };
    if (!fresh) return launchBuildHere(launch);
    return launchBuildFresh(launch);
  };

  /** The spec that was just written: its tasks in the session, the whole of it as a view (not sent to the model: it wrote it). */
  /** A commit message to paste, shown wherever the work may end: after the build, the review and the archive. */
  const commitBlock = (message: string | undefined) => (message ? `**Commit message**, to paste:\n\n\`\`\`text\n${message}\n\`\`\`` : "");

  /** A hung task command must not stall approval: the dry-run caps each well below a real check. */
  const DRY_RUN_TIMEOUT_SEC = 120;

  /**
   * Each red-eligible task command, run once before the human approves the build: failing is expected
   * (nothing built yet), passing smells pre-existing behaviour, erroring smells a broken command. Advisory
   * only — small changes (other gates, no new tests, refactors) have no red-eligible commands and skip this.
   */
  const dryRunTests = async (ctx: ExtensionContext, store: Store, name: string): Promise<string[]> => {
    const loaded = loadSpec(store, name);
    if (!loaded) return [];
    const cfg = store.config();
    const commands = [...new Set(loaded.spec.tasks.filter((t) => needsRed(loaded.spec, t) && t.test).map((t) => t.test!))];
    if (!commands.length) return [];
    const results: Array<{ command: string; result: string; line: string }> = [];
    for (const command of commands) {
      if (suspiciousCommand(command)) {
        results.push({ command, result: "unknown", line: "not run here: chains shells or reaches the network — review before building" });
        continue;
      }
      const r = await withChecking(() => runVerify(command, ctx.cwd, Math.min(cfg.verifyTimeoutSec, DRY_RUN_TIMEOUT_SEC), cfg.testOutputCap));
      const line = r.summary.split("\n")[0];
      const result = r.ok ? "pass" : /TIMEOUT|ENOENT|not found|No such file/i.test(r.summary) ? "unknown" : "fail";
      results.push({ command, result, line });
    }
    store.event(name, { type: "dryrun", results: results.map(({ command, result }) => ({ command, result })) });
    const describe: Record<string, (c: string, l: string) => string> = {
      fail: (c) => `✗ \`${c}\` fails (expected: nothing built yet — if it fails for the wrong reason, like no runner, fix the command)`,
      pass: (c) => `⚠ \`${c}\` passes before the build: the behaviour may already exist (re-slice?) or the tests don't cover it yet (carry on — the build still requires red)`,
      unknown: (c, l) => `? \`${c}\` couldn't run here (${l}) — unknown, not a verdict`,
    };
    return ["", `Test commands, run once before you approve:`, ...results.map((r) => `- ${describe[r.result](r.command, r.line)}`)];
  };

  const showSpec = (store: Store, name: string, names: string[] = [name], extra: string[] = []) => {
    const loaded = loadSpec(store, name);
    if (!loaded) return;
    post(
      [
        `**Spec written: ${name}** (${store.rel("specs", name, "spec.md")})${names.length > 1 ? ` · also: ${names.filter((n) => n !== name).join(", ")}` : ""}`,
        "",
        ...loaded.spec.tasks.map((t) => `- ${t.id}: ${t.title}${t.test ? ` · \`${t.test}\`` : ""}`),
        "",
        `Verification: ${loaded.spec.gate}${loaded.spec.newTests ? "" : " · no new tests"}`,
        ...assumptionsOf(loaded.md).map((a, i) => `${i ? "" : "\nSettled without asking you (the review checks them):\n"}- ${a}`),
        ...extra,
      ].join("\n"),
    );
    pi.appendEntry("pb-spec", { name, markdown: loaded.md });
  };

  /** The spec's recorded assumptions (Decisions lines starting "Assumption"), as written while writing it. */
  const assumptionsOf = (md: string) => {
    const decisions = md.split(sectionHeading("Decisions"))[1]?.split(/^##\s+(?!#)/m)[0] ?? "";
    return [...decisions.matchAll(/^\s*-\s*(Assumption(?! \(build)[^\n]*)/gm)].map((m) => m[1].trim());
  };

  const baselineApplies = (ctx: ExtensionContext, store: Store, testCmd: string | null | undefined) => {
    const b = store.baseline(ctx.sessionManager.getSessionFile() ?? undefined);
    // A red baseline blocks the build only when it describes this commit; a newer HEAD may already have fixed it.
    // No head (outside git): nothing to compare against, so block conservatively.
    return b?.ok === false && b.command === testCmd && (!b.head || b.head === gitHead(ctx.cwd));
  };

  const baselineQuestion = (b: { summary: string; at: string }) =>
    `The test suite already failed when planning began (${b.summary.split("\n")[0]}, ${b.at}): the final check runs it, so it fails too unless that's fixed. Build anyway?`;

  /** The specs this session has written, ready to build, first those nothing else among them depends on. */
  const readySpecs = (store: Store, session: string | undefined, since = "") => {
    const names = store
      .specNames()
      .map((n) => ({ n, p: store.progress(n) }))
      .filter((x) => x.p?.writtenIn === session && x.p?.phase === "written" && x.p.updatedAt >= since && loadSpec(store, x.n)?.spec.status === "ready")
      .sort((a, b) => b.p!.updatedAt.localeCompare(a.p!.updatedAt))
      .map((x) => x.n);
    return names.sort((a, b) => Number(names.includes(loadSpec(store, a)?.spec.dependsOn ?? "")) - Number(names.includes(loadSpec(store, b)?.spec.dependsOn ?? "")));
  };

  /**
   * /pb:build before there's a (ready) spec. Everything that needs you is asked now, while you're here:
   * files changed while planning, a red baseline, where to build, and whether to see the spec first. Then
   * Pi writes the spec and, unless you wanted to see it, this command waits for it and starts the build
   * itself: from a command, a fresh session can be opened too. Nothing waits on you after this point
   * except pb_ask questions, which go on with the recommendation after askTimeoutSec.
   */
  const specWriting = new Set<string>();
  const specThenBuild = async (ctx: ExtensionCommandContext, store: Store, marker: string, prompt: string, force = false) => {
    const session = ctx.sessionManager.getSessionFile();
    const { cfg, testCmd } = commands(ctx.cwd, store);
    const notes: string[] = [];
    if (!(await reviewPlanningChanges(ctx, store, notes))) return;
    const baseline = store.baseline(session ?? undefined);
    if (baselineApplies(ctx, store, testCmd) && !(await agree(ctx, store, baselineQuestion(baseline!), notes))) return;

    const usage = ctx.getContextUsage()?.percent;
    const switching = !!cfg.buildModel && cfg.buildModel !== sessionModel(ctx) && !!findModel(ctx, cfg.buildModel);
    const preferFresh = switching || (usage != null && usage > cfg.freshAbove);
    const HERE = "Build here as soon as the spec is written (keeps our discussion; the cache stays warm)";
    const FRESH = `Build in a fresh session as soon as the spec is written (${switching ? `on ${cfg.buildModel}, ` : ""}lean context)`;
    const SHOW = "Show me the spec first";
    const options = preferFresh ? [FRESH, HERE, SHOW] : [HERE, FRESH, SHOW];
    const choice = await choose(ctx, store, "Pi writes the spec first. Then?", options, options[0], notes);
    if (!choice) return;
    if (choice === SHOW) {
      store.setPendingBuild(session);
      return instruct(marker, `${prompt}\n\nAfter writing it, stop: the harness shows it to me and asks whether to build.`);
    }

    const since = now();
    if (session) specWriting.add(session);
    instruct(marker, `${prompt}\n\nAfter writing it, stop: the build starts by itself.`);
    // Wait for the spec here, in the command: the run starts right after this handler hands it over.
    // Capped: on timeout the pending offer below picks the spec up once it is written.
    // The human may move on while waiting: a dead session ends the wait quietly (nothing is
    // consumed, so a later /pb:build still offers the spec).
    try {
      for (let i = 0; i < 40 && ctx.isIdle(); i++) await new Promise((r) => setTimeout(r, 50));
      if (cfg.specWaitSec > 0) await Promise.race([ctx.waitForIdle(), sleep(cfg.specWaitSec * 1000)]);
      else await ctx.waitForIdle();
    } catch (e) {
      if (!sessionGone(ctx)) throw e;
    } finally {
      if (session) specWriting.delete(session);
    }
    if (sessionGone(ctx)) return;
    const ready = readySpecs(store, session, since);
    if (!ready.length) {
      // A question in chat, or the spec isn't ready yet: pb offers the build once it is.
      store.setPendingBuild(session);
      const finished = store.specNames().filter((n) => {
        const p = store.progress(n);
        return !!p && p.writtenIn === session && ["built", "reviewed"].includes(p.phase ?? "");
      });
      const hint = finished.length
        ? ` Note: ${finished.map((n) => `\`${n}\` is already ${store.progress(n)?.phase}`).join("; ")} — to change it again, write a new spec: rewriting a finished spec keeps its done state.`
        : "";
      return post(`No spec ready to build yet. Answer Pi's questions; once the spec is written, pb shows it and asks how to build.${hint}`);
    }
    const dry = await dryRunTests(ctx, store, ready[0]);
    if (sessionGone(ctx)) return; // replaced during the dry run: a later /pb:build still offers the spec
    showSpec(store, ready[0], ready, dry);
    await startBuild(ctx, store, ready[0], choice === FRESH, { decided: true, checked: true, notes, force });
  };

  /** After /pb:build asked for the spec: once it's written, show it and ask how to go on. */
  const offerPendingBuild = async (ctx: ExtensionContext): Promise<boolean> => {
    const store = new Store(ctx.cwd);
    const session = ctx.sessionManager.getSessionFile();
    if (!store.pendingBuild(session)) return false;
    const names = readySpecs(store, session);
    if (!names.length) return true; // still talking (e.g. a question before writing): keep waiting
    if (session) store.clearPendingBuild(session);
    const name = names[0];
    const loaded = loadSpec(store, name);
    if (!loaded) return true;
    const { spec } = loaded;
    const dry = await dryRunTests(ctx, store, name);
    if (sessionGone(ctx)) {
      // Replaced during the dry run: offer again on a later turn instead of dying mid-offer.
      if (session) store.setPendingBuild(session);
      return true;
    }
    showSpec(store, name, names, dry);
    if (!ctx.hasUI) {
      post(tip("spec.next"));
      return true;
    }
    const cfg = store.config();
    const usage = ctx.getContextUsage()?.percent;
    const switching = !!cfg.buildModel && cfg.buildModel !== sessionModel(ctx) && !!findModel(ctx, cfg.buildModel);
    const preferFresh = switching || (usage != null && usage > cfg.freshAbove);
    const HERE = "Build here (keeps our discussion; the cache stays warm)";
    const FRESH = `Build in a fresh session, from the spec (${switching ? `on ${cfg.buildModel}, ` : ""}lean context)`;
    const EDIT = "Edit the spec first";
    const LATER = "Not now";
    const notes: string[] = [];
    for (;;) {
      // Unanswered, it builds here: a fresh session can't be opened from here, only from a command.
      const choice = await choose(ctx, store, `Build ${name} now? ${spec.tasks.length} tasks`, preferFresh ? [FRESH, HERE, EDIT, LATER] : [HERE, FRESH, EDIT, LATER], HERE, notes);
      if (sessionGone(ctx)) {
        // Replaced while deciding: offer again on a later turn instead of dying mid-offer.
        if (session) store.setPendingBuild(session);
        return true;
      }
      if (choice === EDIT) {
        await editSpec(ctx, store, name);
        continue;
      }
      if (choice === HERE) await startBuild(ctx, store, name, false, { decided: true, notes });
      else if (choice === FRESH) await startBuild(ctx, store, name, true, { decided: true, notes });
      else post(tip("spec.next"));
      return true;
    }
  };

  /**
   * Leave planning mode for a build (or for good): show files bash wrote while planning,
   * then clear the planning state and its widget. False = the human cancelled.
   */
  const liftPlanning = async (ctx: ExtensionContext, store: Store): Promise<boolean> => {
    const session = ctx.sessionManager.getSessionFile();
    if (!session || !store.planningSessions().includes(session)) return true;
    if (!(await reviewPlanningChanges(ctx, store))) return false;
    store.setPlanning(session, false);
    ctx.ui.setWidget("pb-plan", undefined);
    return true;
  };

  /** Record trailing /pb:build words as a Decisions line, so nothing the human typed is dropped. False = nothing was written (no spec, or it wouldn't parse); the callers warn. */
  const recordGuidance = (store: Store, name: string, text: string): boolean => {
    if (!text.trim()) return true;
    return !appendDecision(store, name, text.trim(), "guidance");
  };

  /** "3h ago" style staleness for a progress updatedAt ("2026-10-01 10:00:00"). */
  const staleness = (updatedAt?: string): string => {
    const ms = updatedAt ? Date.now() - new Date(updatedAt.replace(" ", "T")).getTime() : NaN;
    if (!(ms >= 0)) return "with no recent activity";
    const m = Math.floor(ms / 60000);
    if (m < 1) return "active just now";
    if (m < 60) return `active ${m} min ago`;
    const h = Math.floor(m / 60);
    return h < 48 ? `active ${h}h ago` : `active ${Math.floor(h / 24)}d ago`;
  };

  /**
   * Another session may own this spec's build: confirm before two agents race it.
   * The build command passes ["building"] (resuming a paused build is the normal path);
   * /pb:review passes ["building", "paused"] (its finish-time restore would revert even a
   * paused builder's files). Headless has no dialog: agree() goes on, as documented
   * recovery must work there.
   */
  const confirmLiveBuild = async (ctx: ExtensionContext, store: Store, name: string | undefined, phases: Array<"building" | "paused">, action: string): Promise<boolean> => {
    if (!name) return true;
    const session = ctx.sessionManager.getSessionFile();
    const pr = store.progress(name);
    if (!pr || !(phases as string[]).includes(pr.phase) || pr.session === session) return true;
    return agree(ctx, store, `\`${name}\` looks like it is building in another session (${staleness(pr.updatedAt)}). ${action}`);
  };

  pi.registerCommand(cmd("build"), {
    description: "Build the planned feature here, task by task, each checked (writes the spec first if there isn't one). --fresh builds in a new session, --force builds an unreviewed spec as it stands. In a paused build: continue, optionally with guidance",
    getArgumentCompletions: (prefix: string) => [{ value: "--fresh", label: "--fresh" }, { value: "--force", label: "--force" }, ...specCompletions(prefix)].filter((c) => c.value.startsWith(prefix)),
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) return ctx.ui.notify("Pi is busy. Wait for the current turn to finish.", "warning");
      const store = new Store(ctx.cwd);
      const fresh = /(^|\s)--fresh(\s|$)/.test(args);
      const force = /(^|\s)--force(\s|$)/.test(args);
      const words = args.replace(/(^|\s)--(fresh|force)(?=\s|$)/g, " ").trim().split(/\s+/).filter(Boolean);
      const session = ctx.sessionManager.getSessionFile();
      const { cfg, buildCmd } = commands(ctx.cwd, store);

      // The name is the only user string that reaches path.join, and store.specDir refuses anything
      // that isn't a valid spec name (or a folder already under specs/). Here the arg counts as a
      // name only when valid; a path-like or legacy-named arg is refused, not read or reinterpreted.
      if (words[0] && !SPEC_NAME.test(words[0])) {
        const near = normSpecArg(words[0]);
        const hit = near !== "off" && SPEC_NAME.test(near) ? store.specNames().filter((n) => n === near) : [];
        if (hit.length === 1 && store.readSpec(hit[0])) {
          return ctx.ui.notify(
            `\`${words[0]}\` isn't a spec name (spec names are lowercase with hyphens). Did you mean \`${hit[0]}\`? \`/${cmd("build")} ${hit[0]}\` continues it; to start something else, describe it without a leading name.`,
            "warning",
          );
        }
        if (/[/\\]/.test(words[0]) || store.readSpec(words[0])) {
          return ctx.ui.notify(`\`${words[0]}\` isn't a valid spec name (spec names are lowercase with hyphens). To build, name a spec exactly as written.`, "warning");
        }
      }

      // This session has an unfinished build: continue it — unless a different spec was named.
      const here = specOfSession(ctx);
      const named = words[0] && SPEC_NAME.test(words[0]) && store.readSpec(words[0]) ? words[0] : undefined;
      if (here.name && here.progress && unfinishedPhase(here.progress.phase) && (!named || named === here.name)) {
        const p = here.progress;
        if (fresh) ctx.ui.notify("`--fresh` only applies when starting a build: continuing here instead.", "warning");
        if (force) ctx.ui.notify("`--force` only applies when starting a build: continuing here instead.", "warning");
        // Resuming lifts planning protection: a /pb:plan or /pb:deps after the pause turned it back on.
        if (!(await liftPlanning(ctx, store))) return;
        // The spec name itself isn't guidance: only what follows it is.
        const guidance = (named ? words.slice(1) : words).join(" ");
        if (guidance && !recordGuidance(store, p.spec, guidance)) {
          ctx.ui.notify("Guidance not recorded: it would leave the spec unparseable.", "warning");
        }
        const from = guidance ? `\n\nFrom the human: ${guidance}` : "";
        if (p.current === "final") {
          const fin = p.tasks.find((t) => t.id === "final");
          resetExhausted(fin, cfg.maxAttempts);
          const attempt = (fin?.attempts ?? 0) + 1;
          if (fin) fin.attempts = attempt;
          p.phase = "building";
          p.pause = undefined;
          store.saveProgress(p);
          showProgress(ctx, p);
          return instruct("▶ final check", fixText("final", `\`${p.lastVerify?.command ?? "the full suite"}\``, p.lastVerify?.summary ?? "", attempt, cfg.maxAttempts, false) + from);
        }
        if (p.current === COHERE_TASK_ID) {
          const cc = p.tasks.find((t) => t.id === COHERE_TASK_ID);
          if (!cc) {
            beginCohereEntry(ctx, store, p);
            return instruct(COHERE_MARKER, `${coherePrompt(p.baseCommit, 1, cfg.maxAttempts)}${from}`);
          }
          resetExhausted(cc, cfg.maxAttempts);
          const attempt = cc.attempts + 1;
          cc.attempts = attempt;
          p.phase = "building";
          p.pause = undefined;
          store.saveProgress(p);
          showProgress(ctx, p);
          return instruct("▶ coherence pass", `${coherePrompt(p.baseCommit, attempt, cfg.maxAttempts)}${from}`);
        }
        const cur = p.current ?? nextTodo(p)?.id;
        const tp = p.tasks.find((t) => t.id === cur);
        const loaded = loadSpec(store, p.spec);
        if (!loaded) return ctx.ui.notify(`${store.rel("specs", p.spec, "spec.md")} doesn't parse. Fix it (or /${cmd("spec")} ${p.spec}), then /${cmd("build")}.`, "error");
        // Undone past the coherence pass (or a restart that dropped it): all spec tasks done, pass pending.
        if ((!cur || !tp) && needsCohere(loaded.spec) && !p.tasks.some((t) => t.id === COHERE_TASK_ID)) {
          beginCohereEntry(ctx, store, p);
          return instruct(COHERE_MARKER, `${coherePrompt(p.baseCommit, 1, cfg.maxAttempts)}${from}`);
        }
        if (!cur || !tp) return ctx.ui.notify("Nothing left to build here.", "info");
        // Your answer to a task that kept failing buys it a fresh set of attempts; other pauses cost none.
        const exhausted = resetExhausted(tp, cfg.maxAttempts);
        const again = exhausted || tp.status === "todo";
        const intro = !!p.needsIntro;
        p.needsIntro = undefined;
        const t = beginTask(ctx, store, p, cur, { countAttempt: again, intro });
        if (!t) return ctx.ui.notify(`${store.rel("specs", p.spec, "spec.md")} doesn't parse. Fix it (or /${cmd("spec")} ${p.spec}), then /${cmd("build")}.`, "error");
        const knowsSpec = !!session && p.writtenIn === session && !p.edited && !p.compacted;
        const body = intro
          ? `${buildIntro(p.spec, loaded.spec, buildCmd, cfg.taskChecks === "each", standardsFor(ctx), knowsSpec ? undefined : loaded.md, store.extra("build"))}\n\n${t.prompt}`
          : again
            ? t.prompt
            : continuePrompt(t.task) + touchedSuffix(ctx, store, p, cur);
        return instruct(t.marker, body + from);
      }

      // Building without a /pb:plan first: the standards are offered here instead.
      await offerStandards(ctx, store);

      // Which spec: a named one; else the ones this session wrote; else any ready one.
      const phaseOf = (n: string) => store.progress(n)?.phase ?? "written";
      const offered = store.specNames().filter((n) => phaseOf(n) === "written" || unfinishedPhase(phaseOf(n)));
      let name = words[0] && SPEC_NAME.test(words[0]) && store.readSpec(words[0]) ? words[0] : undefined;
      if (!name) {
        const mine = offered.filter((n) => store.progress(n)?.writtenIn === session);
        const planning = !!session && store.planningSessions().includes(session);
        if (!mine.length && (planning || !offered.length)) {
          // No spec from this discussion yet: write it first, then build it.
          return specThenBuild(ctx, store, `▶ /${cmd("build")} — writing the spec first`, specPrompt(words.join(" "), store.specNames(), undefined, store.extra("spec")), force);
        }
        const pool = mine.length ? mine : offered;
        const labelOf = (n: string) => {
          const bits: string[] = [];
          const owner = store.progress(n)?.session ?? store.progress(n)?.writtenIn;
          if (owner && owner !== session) bits.push("from another session");
          if (unfinishedPhase(phaseOf(n))) bits.push("restart the build, finished tasks stay done");
          return bits.length ? `${n} (${bits.join("; ")})` : n;
        };
        if (pool.length === 1 || !ctx.hasUI) name = pool[0];
        else {
          const labels = pool.map(labelOf);
          const choice = await ctx.ui.select("Build which spec?", labels);
          name = choice ? pool[labels.indexOf(choice)] : undefined;
        }
        if (!name) return;
      }
      if (!(await confirmLiveBuild(ctx, store, name, ["building"], "Restart it here — finished tasks stay done?"))) return;
      if (loadSpec(store, name)?.spec.status === "planning") {
        // A checkpoint of an unfinished discussion: finish it (tasks, verification), then build it.
        return specThenBuild(ctx, store, `▶ /${cmd("build")} — finishing the spec ${name} first`, finishSpecPrompt(name, store.extra("spec")).replace(/\s*After writing it, stop:[^\n]*/, ""), force);
      }
      if (words[0] === name && words.length > 1) {
        // Trailing words with a named spec are guidance (as on resume); without a name
        // they are the new spec's topic, not guidance.
        if (!recordGuidance(store, name, words.slice(1).join(" "))) {
          ctx.ui.notify("Guidance not recorded: it would leave the spec unparseable.", "warning");
        }
      }
      await startBuild(ctx, store, name, fresh, { force });
    },
  });

  /* -------------------------------- review ------------------------------- */

  const P_ORDER = ["P0", "P1", "P2", "P3"] as const;

  /**
   * One review pass in its own, real Pi session ("review: <spec> · spec" or "· adversarial"): you're moved into it
   * and watch it natively; its model is read-only and reports with pb_report_findings. It ends when the model
   * has reported and stopped, or at /pb:review done. Returns what it found, and whether you left meanwhile.
   */
  const drivePass = async (
    c: Pick<ExtensionContext, "isIdle" | "sessionManager">,
    send: ReplacedSessionContext["sendMessage"],
    store: Store,
    o: { role: "review" | "abuse"; label: string; brief: string; resume?: boolean },
  ) => {
    const idleMs = (store.config().reviewer.idleSec ?? 20) * 1000;
    const session = c.sessionManager.getSessionFile() ?? "";
    try {
      await send(
        {
          customType: "pb",
          content: o.resume
            ? `▶ Continuing the ${o.role === "review" ? "review" : "adversarial pass"} of **${o.label}** where it was interrupted.`
            : `▶ ${o.role === "review" ? "Review" : "Adversarial pass"} of **${o.label}**, in a fresh session. The model can't change files; you can watch, interrupt and ask it anything. It ends when it has reported its findings and stops (\`/${cmd("review")} done\` ends it now); then pb takes you back.`,
          display: true,
        },
        { triggerTurn: false },
      );
      const first = o.resume
        ? "[pb] You were interrupted. Carry on where you were, then report all your findings with pb_report_findings (including any you reported before) and stop."
        : reviewSessionPrompt(o.role, o.brief, store.extra(o.role === "review" ? "review" : "adversarial"));
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
          void send({ customType: "pb-instruction", content: "[pb] Report your findings with pb_report_findings (an empty list if there are none), then stop.", display: false }, { triggerTurn: true });
        }
      }
      const branch = tree(c as ExtensionContext).getBranch?.() ?? [];
      const prose = [...branch].reverse().find((e) => e.type === "message" && e.message?.role === "assistant" && contentText(e.message.content).trim());
      const text = prose ? contentText(prose.message!.content).trim() : "";
      const state = store.reviewSession(session);
      if (state?.done) store.saveReviewSession(session, { ...state, done: undefined });
      const findings = state?.findings ?? fromProse(text);
      return { findings, prose: text, unparsed: unparsedReport(state?.findings, text), left: false, session };
    } catch {
      // You switched to another session: this one can't be driven any more.
      return { findings: store.reviewSession(session)?.findings ?? [], prose: "", left: true, session, unparsed: false };
    }
  };

  /**
   * The rest of a review from its saved state: the next pass in a new session, or the finish. When you leave
   * mid-pass, the state is kept (with the interrupted pass) so /pb:review can continue it instead of starting over.
   */
  const reviewNext = async (from: ExtensionCommandContext, store: Store, run: ReviewRun, left = false): Promise<void> => {
    if (left) {
      const cut = run.passes.at(-1);
      store.saveReviewRun({ ...run, interrupted: cut ? { role: cut.role, session: cut.session } : undefined });
      writeReview(store, run, true);
      return;
    }
    let todo: "review" | "abuse" | undefined = !run.passes.length ? "review" : run.security && run.passes.length === 1 ? "abuse" : undefined;
    if (todo === "abuse") {
      // The adversarial pass is optional: asked when the review is done; unanswered, it runs.
      const RUN = "Run the adversarial pass";
      const choice = await choose(from, store, "The review is done. Run the adversarial pass now (someone trying to break the change)?", [RUN, "Skip it"], RUN);
      if (choice !== RUN) {
        run.security = undefined;
        run.abuseSkipped = true;
        todo = undefined;
      }
    }
    if (!todo) return reviewFinish(from, store, run);
    store.saveReviewRun(run);
    // The carry's parent is the session calling newSession (not the review's home): takeCarry only
    // hands it to that session's child, so an unrelated new session can't steal it.
    const caller = (from as ExtensionContext).sessionManager?.getSessionFile() ?? run.home ?? undefined;
    store.setCarry({ model: run.model, thinking: run.thinking, spec: run.name ?? "", review: { role: todo, spec: run.name }, parent: caller });
    const result = await from.newSession({
      parentSession: run.home,
      setup: async (sm) => {
        // Both passes are part of one review: named together, so they sort together in /resume.
        sm.appendSessionInfo(`review: ${run.label} · ${todo === "abuse" ? "adversarial" : run.name ? "spec" : "intent"}`);
      },
      withSession: async (c) => {
        // Fail closed: even if the carry was stolen or expired, this session is a review session.
        const reviewSession = (c as ExtensionContext).sessionManager.getSessionFile();
        if (reviewSession) store.saveReviewSession(reviewSession, { role: todo, spec: run.name });
        const r = await drivePass(c, c.sendMessage, store, { role: todo, label: run.label, brief: run.brief });
        run.passes.push({ role: todo, ...r });
        await reviewNext(c, store, run, r.left);
      },
    });
    if (result.cancelled) return reviewNext(from, store, run, true);
  };

  /** Continue an interrupted pass in its own session (`c` is that session), then the rest of the review. */
  const reviewContinue = async (c: ExtensionCommandContext, send: ReplacedSessionContext["sendMessage"], store: Store, run: ReviewRun, cut: NonNullable<ReviewRun["interrupted"]>) => {
    const role = cut.role;
    run.passes = run.passes.filter((x) => x.session !== cut.session);
    run.interrupted = undefined;
    store.saveReviewRun(run);
    const r = await drivePass(c, send, store, { role, label: run.label, brief: run.brief, resume: true });
    run.passes.push({ role, ...r });
    await reviewNext(c, store, run, r.left);
  };

  /** The review's message: verdict, findings, what was dismissed or put back, and the sessions. */
  const reviewMessage = (
    run: ReviewRun,
    o: { findings: Finding[]; dismissed: { finding: Finding; evidence: string }[]; restored: string[]; restoreGuardFailed?: boolean; partial: boolean; verificationFailed?: string; thrash?: boolean },
  ) => {
    const findings = [...o.findings].sort((a, b) => P_ORDER.indexOf(a.priority) - P_ORDER.indexOf(b.priority));
    const counts = P_ORDER.map((k) => findings.filter((f) => f.priority === k).length);
    const finished = (role: "review" | "abuse") => run.passes.some((x) => x.role === role && !x.left);
    const verdict = run.passes.length ? verdictOf(findings) : "none";
    const tally = findings.length || o.dismissed.length ? ` · ${counts.map((c, n) => `P${n} ${c}`).join(" · ")}` : "";
    const unparsed = run.passes.filter((x) => x.unparsed && !x.left).map((x) => (x.role === "review" ? (run.name ? "spec" : "intent") : "adversarial"));
    const sessions = run.passes.map((x) => `${x.role === "review" ? (run.name ? "spec" : "intent") : "adversarial"} \`pi --session ${sessionIdOf(x.session)}\``);
    const text = [
      `**Review of ${run.label}**${run.followUp ? " (follow-up)" : ""} — ${verdict === "pass" ? "✅ PASS" : verdict === "changes_needed" ? "✗ CHANGES NEEDED" : "no verdict"}${tally}${finished("abuse") ? " · with an adversarial pass" : run.abuseSkipped ? " · adversarial pass skipped" : ""}`,
      ...(o.partial
        ? ["", `⚠ You left the review before it finished: the ${finished("review") ? "adversarial pass" : "review"} didn't finish; this is what had been reported. \`/${cmd("review")}\` continues it.`]
        : []),
      ...(unparsed.length ? ["", `⚠ The ${unparsed.join(" and ")} pass${unparsed.length === 1 ? "" : "es"} reported in prose only — nothing parseable, so findings may be missing above. Read the session${unparsed.length === 1 ? "" : "s"} before trusting this verdict.`] : []),
      "",
      run.passes.find((x) => x.role === "review")?.prose ?? "",
      ...(findings.length ? ["", "**Findings**", "", ...findings.map((f, i) => findingLine(f, i + 1))] : []),
      ...(o.dismissed.length ? ["", "Dismissed after a second look:", ...o.dismissed.map((d) => `- [${d.finding.priority}] ${d.finding.title} — ${d.evidence}`)] : []),
      ...(o.restored.length ? ["", `⚠ Files changed during the review were put back: ${o.restored.join(", ")}`] : []),
      ...(o.restoreGuardFailed ? ["", "⚠ Files changed during the review couldn't be told apart from work that moved on meanwhile (the guard snapshot failed), so nothing was put back: check the working tree."] : []),
      ...(o.thrash ? ["", "⚠ A review pass compacted repeatedly without new reads and wrapped up early: treat its findings as a partial pass."] : []),
      ...(o.verificationFailed ? ["", `⚠ The second look at the blocking findings couldn't run (${o.verificationFailed}): they are reported unconfirmed.`] : []),
      ...(sessions.length ? ["", `The review sessions: ${sessions.join(" · ")}`] : []),
      ...(run.name && !o.partial ? ["", commitBlock(commitMessage(new Store(run.cwd).readSpec(run.name) ?? ""))] : []),
      "",
      tip(verdict === "pass" ? "review.pass" : verdict === "changes_needed" ? "review.changes" : "review.other", { spec: run.label }),
    ].join("\n");
    return { text, verdict, counts, findings, complete: finished("review") && (!run.security || finished("abuse")), abuse: finished("abuse") };
  };

  const allFindings = (run: ReviewRun) => run.passes.flatMap((x) => (x.role === "abuse" ? x.findings.map((f) => ({ ...f, title: `Adversarial: ${f.title}` })) : x.findings));

  /** Never lost: the result (or what was reported so far) is kept with the spec. */
  const writeReview = (store: Store, run: ReviewRun, partial: boolean) => {
    const m = reviewMessage(run, { findings: allFindings(run), dismissed: [], restored: [], partial, verificationFailed: undefined });
    fs.mkdirSync(path.dirname(store.reviewFile(run.name)), { recursive: true });
    fs.writeFileSync(store.reviewFile(run.name), `${m.text}\n`);
    return m;
  };

  /** Double-check, put back anything changed, record the result, and take you home with it. */
  const reviewFinish = async (from: ExtensionCommandContext, store: Store, run: ReviewRun): Promise<void> => {
    const cfg = store.config();
    const widget = (t?: string[]) => safely(() => from.ui.setWidget("pb-review", t));
    const all = mergeFindings(allFindings(run));
    const checked =
      cfg.reviewer.verify === false
        ? { findings: all, dismissed: [], error: undefined as string | undefined, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 }
        : await verifyFindings({
            cwd: run.cwd,
            findings: all,
            base: run.base,
            spec: run.name ? store.readSpec(run.name) : undefined,
            model: run.model,
            thinking: run.thinking,
            sessionDir: run.name ? store.specSessionsDir(run.name, "verifier") : store.sessionsDir("verifier"),
            // Activity only, never the verifier's streaming prose: the verdict lands in the session,
            // and the saved run holds the whole transcript for audit.
            onActivity: (a) => widget([`pb review ${run.label} — verifying P0/P1 findings`, `  ↳ ${a}`]),
          });
    widget(undefined);
    const after = run.before ? snapshot(run.cwd, `pb: after review ${run.label}`) : undefined;
    const reverted = run.before && after && run.before.tree !== after.tree ? restore(run.cwd, after.commit, run.before.commit) : { restored: [], guardFailed: false };
    // A stall from an earlier run of this spec must not mark this one: the events carry the run id.
    const thrash = run.name && run.id ? readEvents(path.join(store.specDir(run.name), "events.jsonl")).some((e) => e.type === "compact" && e.run === run.id && (e as { thrash?: unknown }).thrash === true) : false;
    const m = reviewMessage(run, { findings: checked.findings, dismissed: checked.dismissed, restored: reverted.restored, restoreGuardFailed: reverted.guardFailed, partial: false, verificationFailed: checked.error?.split("\n")[0], thrash });
    const p = run.name ? store.progress(run.name) : undefined;
    if (run.name && p) {
      store.event(run.name, { type: "review", security: m.abuse, verdict: m.verdict, p: m.counts, dismissed: checked.dismissed.length, followUp: run.followUp, ...checked.tokens, cost: checked.cost });
      const remaining = p.tasks.filter((t) => t.status !== "done").map((t) => t.id);
      if (m.complete) {
        p.review = { at: now(), snapshot: run.before?.commit, verdict: m.verdict, findings: m.findings.filter((f) => f.priority !== "P3") };
        // A pass only finishes a finished build: with tasks still open the phase stays,
        // or the next /pb:build strands and /pb:archive offers a half-built spec.
        if (m.verdict === "pass" && !remaining.length) p.phase = "reviewed";
        else if (m.verdict === "pass") m.text += `\n\nMid-build review: ${remaining.join(", ")} still to build — phase left as ${p.phase}.`;
      }
      p.reviewUnshown = true;
      store.saveProgress(p);
    }
    fs.mkdirSync(path.dirname(store.reviewFile(run.name)), { recursive: true });
    fs.writeFileSync(store.reviewFile(run.name), `${m.text}\n`);
    store.saveReviewRun(undefined);
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
      "Independent review in fresh sessions you watch: a spec pass by a reviewer who never saw the build, then an adversarial pass, against the spec or any uncommitted change's intent; pb brings you back with the result. Follow-ups look only at what changed (--full: everything). /pb:review done ends a review session now",
    getArgumentCompletions: specCompletions,
    handler: async (args, ctx) => {
      const store = new Store(ctx.cwd);
      // Inside a review session: /pb:review done ends it.
      const session = ctx.sessionManager.getSessionFile();
      const here = store.reviewSession(session);
      const saved = store.reviewRun();
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
        const CONTINUE = `Continue the interrupted review of ${saved.label} (the ${saved.interrupted.role === "review" ? "spec pass" : "adversarial pass"} didn't finish)`;
        const SHOW = "Show what it had reported";
        const NEW = "Start a new review";
        const choice = ctx.hasUI ? await ctx.ui.select("A review was interrupted", [CONTINUE, SHOW, NEW]) : CONTINUE;
        if (!choice) return;
        if (choice === SHOW) {
          if (!fs.existsSync(store.reviewFile(saved.name))) {
            store.saveReviewRun(undefined); // the spec went away (archived?): this run is dead
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
            store.saveReviewRun(undefined); // its session is gone too: nothing left to continue
            ctx.ui.notify("The interrupted review's session is gone. Start a new review.", "warning");
          }
          return;
        }
        store.saveReviewRun(undefined);
      }
      const full = /(^|\s)--full(\s|$)/.test(args);
      const rest = args.replace(/(^|\s)--full(?=\s|$)/g, " ").trim();
      const { cfg, testCmd, buildCmd } = commands(ctx.cwd, store);

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
        if (SPEC_NAME.test(w) && store.readSpec(w)) {
          name = w;
          focusRest = words.slice(1).join(" ");
        } else if (!SPEC_NAME.test(w)) {
          const near = normSpecArg(w);
          const hit = near !== "off" && SPEC_NAME.test(near) ? store.specNames().filter((n) => n === near) : [];
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
      // A review that finished while you were elsewhere: show it first.
      if (name && p?.reviewUnshown) {
        if (!fs.existsSync(store.reviewFile(name))) {
          return ctx.ui.notify("The review's file is gone (was the spec archived?). Start a new review.", "warning");
        }
        p.reviewUnshown = undefined;
        store.saveProgress(p);
        return post(fs.readFileSync(store.reviewFile(name), "utf8"));
      }
      const base = p?.baseCommit;
      const changed = changedSince(ctx.cwd, base);
      if (!name && !changed.length) return ctx.ui.notify("Nothing to review: there are no uncommitted changes.", "info");
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
      // Another session may be building this spec: confirm before the snapshot below arms
      // the finish-time restore, which would put back that builder's in-flight files.
      if (!(await confirmLiveBuild(ctx, store, name, ["building", "paused"], "Review it here anyway?"))) return;
      // The tree as the reviewer sees it: snapshotted before the harness's own check, so the
      // check's artifacts (coverage, caches) are put back with anything else the review changed.
      // The next review's delta starts here too.
      const before = cfg.checkpoints ? snapshot(ctx.cwd, `pb: review ${label}`) : undefined;
      // Fresh ground truth first: the reviewer should judge what's on disk now.
      const command = loaded ? (loaded.spec.gate === "tests" ? testCmd : loaded.spec.gate === "build" ? buildCmd : null) : (testCmd ?? buildCmd);
      let check = "(not run)";
      if (command) {
        safely(() => ctx.ui.setWidget("pb-review", [`pb review ${label} — checking: ${command}`]));
        const v = await withChecking(() => runVerify(command, ctx.cwd, cfg.verifyTimeoutSec, cfg.testOutputCap));
        safely(() => ctx.ui.setWidget("pb-review", undefined));
        check = v.summary;
        if (p && !unfinishedPhase(p.phase)) {
          // A mid-build review must not clobber the build's own last result.
          p.lastVerify = v;
          store.saveProgress(p);
        }
      }

      const prevReview = p?.review;
      let previous: { snapshot: string; findings: Finding[]; changed: string[] } | undefined;
      if (!full && prevReview?.snapshot && before) {
        const since = changedPaths(ctx.cwd, prevReview.snapshot, before.commit);
        if (!since.length) return ctx.ui.notify(`Nothing changed since the last review (${prevReview.verdict}). /${cmd("review")} --full reviews everything again.`, "info");
        previous = { snapshot: prevReview.snapshot, findings: prevReview.findings, changed: since };
      }

      // The abuse pass: on sensitive ground by default (reviewer.security "auto"), or on every review ("always").
      const mode = cfg.reviewer.security ?? "auto";
      const diffText = mode === "auto" ? gitDiff(ctx.cwd, base) : "";
      const security =
        mode === "always" ? "always" : mode === "off" ? undefined : sensitiveGround({ spec: loaded?.md, files: changed, diff: diffText + untrackedText(ctx.cwd, changed) });
      const brief = reviewerBrief({
        spec: loaded && name ? { name, markdown: loaded.md, parsed: loaded.spec } : undefined,
        intent,
        base,
        changed,
        stat: diffStat(ctx.cwd, base),
        check,
        focus: name ? focusRest : "",
        previous,
        testChanges: p?.testChanges,
        redNotes: loaded && p ? redNotes(loaded.spec, p) : undefined,
        designNote: loaded && name ? designProvenance(loaded.md, readEvents(path.join(store.specDir(name), "events.jsonl"))) : undefined,
        humanOverride: p?.edited ? "This spec was edited by hand after writing, so write-time gates were bypassed visibly rather than silently: judge its shape (Threats, measurements, Contracts, evidence, reasons) as well as its truth." : undefined,
        staleRefs: staleProseRefs(ctx.cwd, base),
      });
      // Only plain values from here on: `ctx` belongs to this session, which the first pass replaces.
      const run: ReviewRun = {
        cwd: ctx.cwd,
        id: randomUUID(),
        name,
        label,
        brief,
        base,
        security,
        followUp: !!previous,
        home: ctx.sessionManager.getSessionFile(),
        before: before ? { commit: before.commit, tree: before.tree } : undefined,
        model: cfg.reviewer.model ?? sessionModel(ctx),
        thinking: cfg.reviewer.thinking ?? (pi.getThinkingLevel() as string | undefined),
        passes: [],
      };
      await reviewNext(ctx, store, run);
    },
  });

  /** Laps per finding set before the fix loop stops and escalates (S3 cap). */
  const FIX_LAPS = 3;
  /** Finish-nudges before a silent lap stops the loop (never retried: a second silent session doubles nothing). */
  const FIX_NUDGES = 2;

  /**
   * One fixes lap: open a fenced session seeded with the remaining findings and wait for its
   * pb_fix_done report. Returns the live lap session for chaining (like reviewNext: a session
   * that opened a new one is stale afterwards) plus the report — or no report when the lap
   * went silent (nudges unanswered) or its session never opened.
   */
  const runFixLap = async (
    ctx: ExtensionCommandContext,
    store: Store,
    spec: string,
    remaining: Finding[],
  ): Promise<{ live: ExtensionCommandContext; report?: { fixed: string[]; skipped: string[]; tests: string } } | undefined> => {
    const findings = remaining.map((f, i) => findingLine(f, i + 1)).join("\n");
    const seed =
      `[pb:fix ${spec}] Fix exactly the review findings below — nothing else.\n\nFindings:\n${findings}\n\n` +
      `Fence: touch only what these findings require — no new behaviour, API, or data beyond a finding's Fix; keep the suite green; run each affected task's Test: line (full suite once at the end); new tests must be seen failing first. ` +
      `If a finding needs a design decision instead of an edit, don't redesign it: report it as skipped. ` +
      `Reply shape, one block per finding: files changed, test command, result. Do not commit, archive, or write under .pi/. ` +
      `When done, call pb_fix_done with fixed ids (titles), skipped ids, and test results; then stop.`;
    let live: ExtensionCommandContext | undefined;
    const since = now();
    const result = await ctx.newSession({
      parentSession: ctx.sessionManager.getSessionFile() ?? undefined,
      setup: async (sm) => {
        sm.appendSessionInfo(`fix: ${spec}`);
      },
      withSession: async (c) => {
        const cc = c as ExtensionCommandContext;
        live = cc;
        const lapFile = cc.sessionManager.getSessionFile() ?? undefined;
        if (lapFile) store.saveFixSession(lapFile, { spec, findings: remaining });
        store.event(spec, { type: "fix-start", findings: remaining.map((f) => f.title) });
        await c.sendMessage({ customType: "pb-fix", content: seed, display: true }, { triggerTurn: true });
        for (let nudge = 0; nudge < FIX_NUDGES; nudge++) {
          await cc.waitForIdle();
          if (!lapFile || !store.fixSession(lapFile)) return; // reported
          await c.sendMessage({ customType: "pb-fix", content: "Finish with pb_fix_done now: report fixed ids, skipped ids and test results, then stop.", display: false }, { triggerTurn: true });
        }
        await cc.waitForIdle();
      },
    }).catch(() => ({ cancelled: true as const }));
    if (result.cancelled || !live) return undefined;
    const reports = readEvents(path.join(store.specDir(spec), "events.jsonl")).filter(
      (e) => (e as { type?: unknown }).type === "fix" && typeof (e as { at?: unknown }).at === "string" && ((e as { at: string }).at ?? "") >= since,
    );
    const last = reports.at(-1) as { fixed?: unknown; skipped?: unknown; tests?: unknown } | undefined;
    if (!last || !Array.isArray(last.fixed)) return { live };
    return { live, report: { fixed: last.fixed.filter((x): x is string => typeof x === "string"), skipped: Array.isArray(last.skipped) ? last.skipped.filter((x): x is string => typeof x === "string") : [], tests: typeof last.tests === "string" ? last.tests : "" } };
  };

  /**
   * Unattended fix loop: lap until every finding is fixed or skipped-as-spec-revision, up to
   * FIX_LAPS, then come home with the outcome. The human runs /pb:review next.
   */
  const driveFix = async (ctx: ExtensionCommandContext, store: Store, spec: string, first: Finding[]): Promise<void> => {
    const home = ctx.sessionManager.getSessionFile() ?? undefined;
    let live: ExtensionCommandContext = ctx;
    let remaining = first;
    const fixed: string[] = [];
    const skipped: string[] = [];
    let laps = 0;
    let silent = false;
    while (remaining.length && laps < FIX_LAPS) {
      laps++;
      const out = await runFixLap(live, store, spec, remaining);
      if (!out) return; // its session never opened (cancelled): user is present, nothing to say
      live = out.live;
      if (!out.report) {
        silent = true;
        break;
      }
      fixed.push(...out.report.fixed);
      skipped.push(...out.report.skipped);
      const done = new Set([...fixed, ...skipped]);
      remaining = remaining.filter((f) => !done.has(f.title));
    }
    const open = remaining.map((f) => f.title);
    const skippedNote = skipped.length ? `; skipped as needing spec revision: ${skipped.join(", ")}` : "";
    const summary = !open.length && !silent
      ? `Fixes for \`${spec}\` complete in ${laps} lap(s): fixed ${fixed.join(", ") || "none"}${skippedNote}. Run /pb:review to check the delta.`
      : silent
        ? `Fix lap for \`${spec}\` went silent (no report after ${FIX_NUDGES} nudges). Fixed so far: ${fixed.join(", ") || "none"}; still open: ${open.join(", ") || "none"}${skippedNote}.`
        : `Fixes for \`${spec}\` stopped after ${laps} laps: fixed ${fixed.join(", ") || "none"}; still open: ${open.join(", ")}${skippedNote}.`;
    try {
      if (!home) throw new Error("no home session");
      await live.switchSession(home, {
        withSession: async (c) => {
          await c.sendMessage({ customType: "pb", content: summary, display: true }, { triggerTurn: false });
        },
      });
    } catch {
      // Home is gone: the summary still lands in the spec's events for the next session to find.
      store.event(spec, { type: "fix-summary", summary });
    }
  };

  pi.registerCommand(cmd("fix"), {
    description: "Fix P0-P2 review findings in a fresh fenced session: /pb:fix [finding ids]. No ids = all open findings (P3 nits are never open: fix those by hand). Run /pb:review afterwards: it checks only those findings and what changed",
    handler: async (args, ctx) => {
      const store = new Store(ctx.cwd);
      const session = ctx.sessionManager.getSessionFile();
      const words = args.trim().split(/\s+/).filter(Boolean);
      // Spec: named, else this session's. Findings: all open, else the named ones.
      let name = words[0] && SPEC_NAME.test(words[0]) && store.readSpec(words[0]) ? words[0] : undefined;
      const ids = name ? words.slice(1) : words;
      if (!name) name = specOfSession(ctx).name;
      if (!name && session) {
        // A planning session that wrote the spec but never built it: its writtenIn names it.
        const mine = store.specNames().filter((n) => store.progress(n)?.writtenIn === session);
        if (mine.length === 1) name = mine[0];
        else if (mine.length > 1) return ctx.ui.notify(`Several specs here (${mine.join(", ")}): name one: \`/${cmd("fix")} <spec> [ids].`, "warning");
      }
      if (!name) return ctx.ui.notify(`No spec here: run /${cmd("fix")} from a build or review session, or name a spec.`, "warning");
      const open = store.progress(name)?.review?.findings ?? [];
      if (!open.length) return ctx.ui.notify(`\`${name}\` has no open review findings to fix.`, "info");
      let picked = open;
      if (ids.length) {
        const misses: string[] = [];
        picked = [];
        for (const id of ids) {
          const hit = /^\d+$/.test(id)
            ? open[Number(id) - 1]
            : open.filter((f) => f.title.toLowerCase().includes(id.toLowerCase())).length === 1
              ? open.filter((f) => f.title.toLowerCase().includes(id.toLowerCase()))[0]
              : undefined;
          if (!hit || picked.includes(hit)) {
            if (!hit) misses.push(id);
            continue;
          }
          picked.push(hit);
        }
        if (misses.length || !picked.length) {
          return ctx.ui.notify(
            `No such finding${misses.length === 1 ? "" : "s"}: ${(misses.length ? misses : ids).join(", ")}. \`/pb:fix\` takes P0–P2 ids (P3 nits are never open: fix those by hand). Open findings for \`${name}\`:${open.map((f, i) => `\n${i + 1}. ${f.title}`).join("")}`,
            "warning",
          );
        }
      }
      if (!ctx.isIdle()) return ctx.ui.notify("Pi is busy. Wait for the current turn to finish.", "warning");
      const cctx = ctx as ExtensionCommandContext;
      if (typeof cctx.newSession !== "function") return ctx.ui.notify("This Pi can't open sessions: fix the findings here instead.", "warning");
      await driveFix(cctx, store, name!, picked);
    },
  });

  /* -------------------------------- stats -------------------------------- */

  pi.registerCommand(cmd("stats"), {
    description: "How a build went: tasks, first-try rate, checks, pauses, tokens and cache. A spec name, or all",
    getArgumentCompletions: specCompletions,
    handler: async (args, ctx) => {
      const store = new Store(ctx.cwd);
      const arg = args.trim();
      const all = loadStats(store);
      if (arg === "all") return post(renderAll(all));
      const name = arg || specOfSession(ctx).name || (all.length === 1 ? all[0].name : undefined);
      const one = all.find((s) => s.name === name);
      if (!one) return all.length ? post(renderAll(all)) : ctx.ui.notify("No stats yet: they are collected while building.", "info");
      post(renderCard(one));
    },
  });

  /* ------------------------------ project map ----------------------------- */

  /**
   * Update the project map in a fresh, read-only call (the session doesn't grow). Paths that don't resolve,
   * and a map over the budget, go back to it once to be corrected; then the map is written, with the change shown and /pb:map undo to
   * go back. It asks first only when something looks off: paths that still don't resolve, or a large part of
   * the existing map removed (unanswered: the current map stays). Returns the changes when it wrote the map.
   */
  const updateMap = async (ctx: ExtensionContext, store: Store, o: { spec?: { name: string; findings: string }; changed?: string[]; focus?: string } = {}): Promise<string[] | undefined> => {
    const cfg = store.config();
    const current = readMap(ctx.cwd);
    const started = Date.now();
    const abort = new AbortController();
    const canEsc = ctx.hasUI && ctx.mode === "tui" && typeof ctx.ui.onTerminalInput === "function";
    const unsubEsc = canEsc ? ctx.ui.onTerminalInput((d) => (d === "\x1b" ? (abort.abort(), { consume: true }) : undefined)) : undefined;
    const render = (phase: string, activity?: string) =>
      safely(() => ctx.ui.setWidget("pb-map", [`pb map — ${phase}${canEsc ? "   (Esc to stop)" : ""}`, ...(activity ? [`  ↳ ${activity}`] : [])]));
    let mapSession: string | undefined;
    const cartographer = (brief: string, phase: string) =>
      runFresh({
        cwd: ctx.cwd,
        role: "cartographer",
        systemPrompt: CARTOGRAPHER_SYSTEM + extraBlock(store.extra("map")),
        brief,
        prompt: "Do what the attached file asks; report the whole map with report_map.",
        tools: ["read", "grep", "find", "ls", "bash", "report_map"],
        extensions: [REVIEW_TOOLS],
        model: cfg.explorer.model ?? sessionModel(ctx),
        thinking: cfg.explorer.thinking ?? "max",
        signal: abort.signal,
        // Activity only, never the cartographer's streaming prose: the proposed map arrives
        // via the approve step, and the saved run holds the whole transcript for audit.
        onActivity: (a) => render(phase, a),
        sessionDir: store.sessionsDir("cartographer"),
      }).then((r) => {
        mapSession = r.sessionFile ?? mapSession;
        return r;
      });
    const mapOf = (r: Awaited<ReturnType<typeof runFresh>>) => {
      const call = r.toolCalls.filter((c) => c.name === "report_map").at(-1);
      return {
        map: typeof call?.arguments.map === "string" ? normalizeMap(call.arguments.map) : "",
        changes: Array.isArray(call?.arguments.changes) ? (call.arguments.changes as string[]) : [],
      };
    };
    let body = "";
    let changes: string[] = [];
    let unresolved: { path: string; line: string }[] = [];
    try {
      render("reading the project");
      const first = await cartographer(cartographerBrief({ current, ...o }), "reading the project");
      store.exploreEvent({ session: ctx.sessionManager.getSessionFile(), ...first.tokens, cost: first.cost, ms: first.ms });
      if (first.aborted) return void ctx.ui.notify("Map update stopped.", "info");
      ({ map: body, changes } = mapOf(first));
      if (!body) return void ctx.ui.notify(`No map came back${first.error ? `: ${first.error}` : ""}.`, "warning");
      unresolved = unresolvedPaths(ctx.cwd, body);
      const overBy = mapTokens(body) - MAP_TOKENS;
      if (unresolved.length || overBy > 0) {
        // Once: the cartographer corrects or removes what doesn't resolve and trims to the budget, still able to
        // read the code; nothing is deleted behind its back.
        const phase = mapRepairPhase(unresolved.length, overBy > 0 ? overBy : 0);
        const second = await cartographer(cartographerBrief({ current, proposed: body, unresolved, overBy: overBy > 0 ? overBy : undefined }), phase);
        store.exploreEvent({ session: ctx.sessionManager.getSessionFile(), ...second.tokens, cost: second.cost, ms: second.ms });
        if (second.aborted) return void ctx.ui.notify("Map update stopped.", "info");
        const fixed = mapOf(second).map;
        if (fixed) {
          body = fixed;
          unresolved = unresolvedPaths(ctx.cwd, body);
        }
      }
    } finally {
      unsubEsc?.();
      ctx.ui.setWidget("pb-map", undefined);
    }

    const diff = mapDiff(current, body);
    if (!diff.length) return void ctx.ui.notify("The project map is up to date: nothing to change.", "info");
    const tokens = mapTokens(body);
    const currentLines = current.split("\n").filter((l) => l.trim()).length;
    const removed = diff.filter((l) => l.startsWith("-")).length;
    const warnings = [
      ...unresolved.map((u) => `\`${u.path}\` doesn't resolve`),
      ...(currentLines >= 6 && removed / currentLines > 0.3 ? [`it removes ${removed} of the map's ${currentLines} lines`] : []),
    ];
    pi.appendEntry("pb-map", { diff, warnings, tokens, map: body, changes });
    if (warnings.length) {
      const APPLY = "Apply it anyway";
      const EDIT = "Edit it first";
      const KEEP = "Keep the current map";
      const choice = await choose(ctx, store, `The proposed project map needs a look: ${warnings.join("; ")}`, [KEEP, APPLY, EDIT], KEEP);
      if (choice === EDIT) {
        const edited = await ctx.ui.editor("Edit the project map", body);
        if (edited === undefined) return void ctx.ui.notify("Map not changed.", "info");
        body = normalizeMap(edited);
      } else if (choice !== APPLY) return void ctx.ui.notify("Map not changed.", "info");
    }
    store.saveMapPrevious(current);
    writeMap(ctx.cwd, body);
    ctx.ui.notify(
      `Project map ${current ? "updated" : "written"} in AGENTS.md (~${tokens} tokens in ${Math.max(1, Math.round((Date.now() - started) / 1000))}s${changes.length ? `: ${changes.slice(0, 3).join("; ")}${changes.length > 3 ? "; …" : ""}` : ""}). \`/${cmd("map")} undo\` puts the previous one back.${mapSession ? ` The whole run: \`pi --session ${path.relative(ctx.cwd, mapSession)}\`` : ""}`,
      "info",
    );
    return changes;
  };

  pi.registerCommand(cmd("standards"), {
    description: `Write the current engineering standards into this project's AGENTS.md: created if missing, pb's section replaced, the rest untouched. Optional: which stack (java, vue, plain, or a template of yours in ${templatesDir()}); default: detected`,
    getArgumentCompletions: (prefix: string) => stackNames().filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s })),
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      const names = stackNames();
      if (arg && !names.includes(arg)) return ctx.ui.notify(`/${cmd("standards")} takes ${names.join(", ")} (default: detected from the project). Your own go in ${templatesDir()}.`, "warning");
      const stack = arg ? (arg === "plain" ? undefined : arg) : projectStack(ctx.cwd);
      const file = path.join(ctx.cwd, "AGENTS.md");
      const result = writeStandards(file, stack);
      new Store(ctx.cwd).markAsked("standards");
      if (result === "broken") return ctx.ui.notify(`${file} has "<!-- pb:standards -->" without its "<!-- /pb:standards -->": add the end marker where pb's section ends, then run /${cmd("standards")} again.`, "error");
      const what = { created: "Created", added: "Added pb's standards to", replaced: "Replaced pb's standards in", unchanged: "pb's standards are already current in" }[result];
      const shared = findStandards(path.dirname(ctx.cwd));
      ctx.ui.notify(
        `${what} ${file} (${stackLabel(stack)})${result === "created" ? ", with pb's standards" : ""}.${result === "replaced" || result === "added" ? " The rest of the file is untouched." : ""}${result === "unchanged" ? "" : " Sessions already running keep the ones they loaded until restarted."}${shared ? ` ${shared.file} also has a pb section: Pi loads both.` : ""}`,
        "info",
      );
    },
  });

  pi.registerCommand(cmd("map"), {
    description: "Refresh the project map in AGENTS.md (layout, patterns, constraints) from the code as it is now. Optional: what to focus on; /pb:map undo puts the previous map back",
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) return ctx.ui.notify("Pi is busy. Wait for the current turn to finish.", "warning");
      const store = new Store(ctx.cwd);
      if (args.trim() === "undo") {
        const previous = store.mapPrevious();
        if (previous === undefined) return ctx.ui.notify("No previous map to go back to.", "info");
        const now_ = readMap(ctx.cwd);
        writeMap(ctx.cwd, previous);
        store.saveMapPrevious(now_);
        return ctx.ui.notify(`The previous project map is back in AGENTS.md (\`/${cmd("map")} undo\` again swaps them back).`, "info");
      }
      await updateMap(ctx, store, { focus: args.trim() || undefined });
    },
  });

  /* ------------------------------- archive ------------------------------- */

  pi.registerCommand(cmd("archive"), {
    description: "Put a finished spec (and its history) away in .pi/pb-archive/",
    getArgumentCompletions: specCompletions,
    handler: async (args, ctx) => {
      const store = new Store(ctx.cwd);
      const candidates = store.specNames().filter((n) => ["built", "reviewed"].includes(store.progress(n)?.phase ?? ""));
      let name = args.trim() || undefined;
      if (!name) {
        if (!candidates.length) return ctx.ui.notify("No finished spec to archive.", "info");
        name = candidates.length === 1 || !ctx.hasUI ? candidates[0] : await ctx.ui.select("Archive which spec?", candidates);
        if (!name) return;
      }
      if (!store.readSpec(name)) return ctx.ui.notify(`No spec "${name}".`, "warning");
      if (!candidates.includes(name) && ctx.hasUI && !(await ctx.ui.confirm(`${name} isn't finished`, "Archive it anyway?"))) return;
      const markdown = store.readSpec(name) ?? "";
      const changed = changedSince(ctx.cwd, store.progress(name)?.baseCommit);
      // The feature is finished: its review runs and the explorer and map runs so far aren't needed any more.
      store.dropSessions(name);
      let dest: string;
      try {
        dest = store.archive(name);
      } catch (e) {
        return ctx.ui.notify(`Could not archive ${name}: ${(e as Error).message}`, "error");
      }
      if (!store.specNames().length) dropCheckpoints(ctx.cwd); // no live spec left to undo: let git reclaim the snapshots
      // The feature is done: what it established about the project goes into the map every session reads.
      let mapChanges: string[] | undefined;
      // What it established about the project: its Findings, and the design the build settled on.
      const design = sectionOf(markdown, "Design");
      const findings = [findingsOf(markdown), design ? `The design as built (its "## Design"):\n${design}` : ""].filter(Boolean).join("\n\n");
      // Writing the first map is always worth one read; an update needs stated findings —
      // changed files alone rarely justify a full re-read, and the next feature's run covers placement.
      const mapNews = !!findings.trim() || !readMap(ctx.cwd);
      const willMap = store.config().mapOnArchive && mapNews;
      ctx.ui.notify(`Archived ${name} to ${path.relative(ctx.cwd, dest)}.${willMap ? ` Updating the project map from ${name}…` : ""}`, "info");
      if (store.config().mapOnArchive && !mapNews) {
        ctx.ui.notify(`No new findings in ${name} for the project map; skipping.`, "info");
      } else if (willMap) {
        mapChanges = await updateMap(ctx, store, { spec: { name, findings }, changed });
      }
      // What's left to commit: the feature itself if it wasn't committed yet, and the map.
      const feature = changedSince(ctx.cwd).some((f) => f !== "AGENTS.md" && !f.startsWith(".pi/"));
      const title = parseSpec(markdown).spec?.title ?? name;
      const mapNote = mapChanges ? ["Update the project map in AGENTS.md", ...(mapChanges.length ? ["", ...mapChanges.map((c) => `- ${c}`)] : [])] : [];
      const message = feature
        ? [commitMessage(markdown) ?? title, ...(mapChanges ? ["", "Also updates the project map in AGENTS.md."] : [])].join("\n")
        : mapChanges
          ? [`${mapNote[0]} after ${title}`, ...mapNote.slice(1)].join("\n")
          : undefined;
      if (message) post(commitBlock(message));
    },
  });

  /* --------------------------------- undo -------------------------------- */

  pi.registerCommand(cmd("undo"), {
    description: "Go back to before a task of this build: files, task list and conversation, picked from a list",
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) return ctx.ui.notify("Pi is busy. Wait for the current turn to finish.", "warning");
      const { store, name, progress: p } = specOfSession(ctx);
      if (!name || !p) return ctx.ui.notify(`Run /${cmd("undo")} in the build session of a spec.`, "warning");
      const cps = store.checkpoints(name);
      if (!cps.length) return ctx.ui.notify("No checkpoints for this build.", "info");
      const label = (c: Checkpoint) => (c.id === "start" ? `⌂ start of the build (${c.at})` : c.id.startsWith("u") ? `↺ before undo (${c.at})` : `${c.id}  ${c.summary ?? "(not finished)"}`);
      const newest = [...cps].reverse();
      const [idArg] = args.trim().split(/\s+/);
      let target = idArg ? cps.find((c) => c.id.toLowerCase() === idArg.toLowerCase()) : undefined;
      if (!target && ctx.hasUI && !idArg) {
        const labels = newest.map(label);
        const choice = await ctx.ui.select("Restore the working tree to the state BEFORE…", labels);
        target = choice ? newest[labels.indexOf(choice)] : undefined;
      }
      if (!target) return idArg ? ctx.ui.notify(`No checkpoint "${idArg}".`, "warning") : post(["```", ...newest.map((c) => `${c.id.padEnd(6)} ${label(c)}`), "```", `\`/${cmd("undo")} <id>\``].join("\n"));

      const cur = snapshot(ctx.cwd, "pb: before undo");
      if (!cur) return ctx.ui.notify("Could not snapshot the working tree (is this a git repository?). Nothing was changed.", "error");
      const files = changedPaths(ctx.cwd, cur.commit, target.commit);
      const idx = cps.indexOf(target);
      const undoneCps = cps.slice(idx).filter((c) => c.task);
      const undone = undoneCps.map((c) => c.id);
      const head = gitHead(ctx.cwd);
      const summary = [
        `Files: ${files.length ? files.slice(0, 20).join(", ") + (files.length > 20 ? ` … (+${files.length - 20})` : "") : "none"}`,
        undone.length ? `Tasks back to todo: ${undone.join(", ")}` : "",
        target.head && head && target.head !== head ? "⚠ You committed since then: undo restores files but never moves your branch." : "",
      ]
        .filter(Boolean)
        .join("\n");
      if (ctx.hasUI && !(await ctx.ui.confirm(`Undo to before ${target.id === "start" ? "the build" : target.id}?`, summary))) return;
      const reverted = restore(ctx.cwd, cur.commit, target.commit);
      if (reverted.guardFailed) return ctx.ui.notify("Nothing was undone: the guard snapshot for the drift check failed (is git healthy?). Your files are as they were; try again.", "error");

      // The conversation goes back too, so the discarded attempt doesn't anchor the next one;
      // everything before that point is still in the prompt cache.
      const oldLeaf = tree(ctx).getLeafId?.() ?? undefined;
      const reverting = target.id.startsWith("u");
      let point = rewindPoint(ctx, target.entry, reverting);
      // A point before the latest compaction or reset would bring back the whole old context: files only then.
      const branch = tree(ctx).getBranch?.() ?? [];
      const at = point ? branch.findIndex((x) => x.id === point) : -1;
      const beforeCompaction = !!point && !reverting && (at < 0 || at < branch.map((x) => x.type).lastIndexOf("compaction"));
      if (beforeCompaction) point = undefined;
      const nav = (ctx as Partial<ExtensionCommandContext>).navigateTree;
      let rewound = false;
      if (point && nav && point !== oldLeaf) {
        // What the human said in the part that's rewound would go with it: the note keeps it.
        const said: string[] = [];
        for (let id = oldLeaf; id && id !== point; ) {
          const e = tree(ctx).getEntry?.(id);
          if (!e) break;
          if (e.type === "message" && e.message?.role === "user") {
            const c = e.message.content;
            const t = typeof c === "string" ? c : Array.isArray(c) ? c.map((x: { text?: string }) => x.text ?? "").join("") : "";
            if (t.trim()) said.unshift(t.trim().replace(/\s+/g, " "));
          }
          id = e.parentId ?? undefined;
        }
        undoSummary = reverting
          ? undefined
          : `[pb] The human undid the work from ${target.id === "start" ? "the start of the build" : target.id} on (/pb:undo restored the files). What had been done: ${undoneCps.map((c) => c.summary ?? `${c.id} (unfinished)`).join("; ") || "nothing finished"}. Don't simply repeat it.${said.length ? ` What the human said meanwhile, still valid unless they say otherwise: ${said.map((x) => `"${x}"`).join("; ")}` : ""}`;
        try {
          const r = await nav(point, { summarize: !reverting, label: `pb: before ${target.id}` });
          rewound = !r.cancelled;
        } catch (e) {
          ctx.ui.notify(`Files restored, but the conversation couldn't be rewound: ${(e as Error).message}`, "warning");
        } finally {
          undoSummary = undefined;
        }
      }
      const undoEntry: Checkpoint = { id: `u${cps.filter((c) => c.id.startsWith("u")).length + 1}`, at: now(), ...cur, head, tasks: structuredClone(p.tasks), entry: rewound ? oldLeaf : undefined };
      store.saveCheckpoints(name, [...cps.slice(0, idx).concat(target.id === "start" ? [target] : []), undoEntry]);
      p.tasks = structuredClone(target.tasks).filter((t) => t.id !== "final" && t.id !== COHERE_TASK_ID);
      p.current = undefined;
      p.phase = "paused";
      p.pause = `undone to before ${target.id}`;
      p.needsIntro = rewound && !!target.intro ? true : undefined;
      store.saveProgress(p);
      showProgress(ctx, p);
      store.event(name, { type: "undo", to: target.id, tasks: undone, rewound });
      const note = beforeCompaction
        ? `\nThe conversation wasn't rewound (that point is before a context reset or compaction). What was undone: ${undoneCps.map((c) => c.summary ?? `${c.id} (unfinished)`).join("; ") || "nothing finished"}.`
        : "";
      post(
        `**↺ Undone to before ${target.id === "start" ? "the build" : target.id}** — ${files.length} file(s) restored${rewound ? ", the conversation rewound" : ""}.\n${summary}${note}\n\n${tip("undo.done", { id: undoEntry.id })}`,
      );
    },
  });

  /* -------------------------------- status ------------------------------- */

  pi.registerCommand(cmd("status"), {
    description: "Every spec and where it stands",
    handler: async (_args, ctx) => {
      const store = new Store(ctx.cwd);
      const names = store.specNames();
      if (!names.length) return ctx.ui.notify(`No specs yet. Start with /${cmd("plan")} <feature>.`, "info");
      const here = store.specForSession(ctx.sessionManager.getSessionFile());
      const lines = names.flatMap((n) => {
        const p = store.progress(n);
        const s = loadSpec(store, n)?.spec;
        const where = p?.session && n !== here ? ` · session: pi --session ${sessionIdOf(p.session)}` : "";
        const head = `${n === here ? "▸ " : ""}${n} — ${p?.phase ?? "written"}${where}${s ? ` · verification ${s.gate}${s.newTests ? "" : " · no new tests"}${s.dependsOn ? ` · depends on ${s.dependsOn}` : ""}` : " · ⚠ doesn't parse"}${p?.pause ? ` · paused: ${p.pause}` : ""}`;
        return [head, ...(p && p.phase !== "written" ? p.tasks.map((t) => `    ${taskLine(t)}`) : [])];
      });
      ctx.ui.notify([...lines, `help: /${cmd("help")}`].join("\n"), "info");
    },
  });

  /* --------------------------------- help -------------------------------- */

  pi.registerCommand(cmd("help"), {
    description: "What to do next and how to handle edge cases. /pb:help <topic> shows one section",
    handler: async (args, ctx) => {
      const name = args.trim().toLowerCase();
      const body = name ? topic(name) : undefined;
      if (body) return post(`${body}\n\n(Full guide: ${HELP_PATH})`);
      const list = topics().map((t) => `- \`/${cmd("help")} ${t.name}\` — ${t.title}`);
      if (!list.length) return ctx.ui.notify(`Help file not found: ${HELP_PATH}`, "warning");
      post([name ? `No help topic "${name}".` : "**pb help** — pick a topic:", "", ...list, "", `Full guide: ${HELP_PATH}`].join("\n"));
    },
  });
}
