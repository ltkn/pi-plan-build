/** Shared machinery of pi-plan-build: everything more than one role needs.
 *
 *  The spec guard logic (the build's contract hash, approval drift, the read-only review)
 *  is deliberately here and small, so the trust boundaries stay legible in one place; the
 *  command and tool handlers live in their own modules.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext
 } from "@earendil-works/pi-coding-agent";
import { type Snapshot, changedPaths, commitTime, restore, skippedLargeFiles, snapshot } from "./checkpoint.ts";
import { notifyDesktop } from "./notify.ts";
import { tip } from "./help.ts";
import { PI_RESERVE_TOKENS, specReference, taskPrompt } from "./prompts.ts";
import { ignoredPathsFor, projectFiles, resolveProjectPath, resolveSiblingFile } from "./map.ts";
import { type ParsedSpec, type SpecTask, addDecision, contractHash, earlierProof, isAcceptanceLine, needsRed, parseSpec, redExemption, sharedTestCommands, specHash, specPathRefs } from "./spec.ts";
import { duration } from "./format.ts";
import { type Stack, findStandards, isUserTemplate, standardsLoaded } from "./standards.ts";
import { buildTimeLabel, buildTiming } from "./stats.ts";
import { type Checkpoint, type Progress, type TaskProgress, COHERE_TASK_ID, PREFIX, Store, now, readEvents, type PlannerSettings, type ThinkingLevel, THINKING_LEVELS } from "./store.ts";
import { lintsEachStep, pauseAt, unfinishedPhase } from "./phase.ts";
import { resolveBuild, resolveLint, resolveVerify } from "./verify.ts";

export const cmd = (verb: string) => `${PREFIX}:${verb}`;

/** What the pb_ask dialog promises: plain words, one trade-off per option, a reasoned recommendation. */
export const ASK_DESCRIPTION =
  "Ask the human one question and wait for the answer: a choice between options, or an open question. Use it while planning; a pb build never asks — it takes the sensible reading, records it as an assumption, and stops only when the Goal or a Contract cannot be built as written. Ask only what you can't sensibly decide yourself. Ask independent questions together; ask a question that depends on another's answer only after you have that answer. Phrase every question in plain words a non-expert can follow: one line per option with its trade-off, and your recommendation with one plain reason why — short enough to read in a dialog.";

/** One-line display text for markers and session names: collapse whitespace, cap length. */
export const planTitle = (arg: string, n = 60) => {
  const flat = arg.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 3)}…` : flat;
};

/** Cap for the model copy of a /pb:plan description: generous; cap() itself discloses the cut. */
export const MODEL_ARG_CAP = 4000;

/** Normalized form for catching near-miss spec names: case, underscores, trailing punctuation. */
export const normSpecArg = (arg: string) => arg.toLowerCase().replace(/_/g, "-").trim().replace(/[.!?…]+$/, "").trim();

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
export const COHERE_MIN_TASKS = 3;

/** Above this, a spec gets a gentle note about its size; never a rejection. */
export const LONG_SPEC_TOKENS = 12000;

/**
 * The token line a session resets under: Pi's own compaction reserve, plus the summary the reset
 * writes. `writtenTokens` is that summary's own size — 0 when it carries no spec.
 */
export const resetLimit = (window: number, writtenTokens = 0) => window - PI_RESERVE_TOKENS - 2 * writtenTokens;

/** What the model is told about a spec's size after writing it. */
export const sizeNote = (tokens: number) =>
  `~${tokens} tokens${tokens > LONG_SPEC_TOKENS ? ". That's long: if it copies code or repeats facts, pointing to the code and stating each fact once would help the next reader; if it's all needed, keep it" : ""}`;

/**
 * Structural warnings for a spec's author: advisory, never rejections. A shared Test: command means the
 * later tasks auto-proceed as pre-green once the earlier proves it; missing Contracts on a multi-task
 * spec leaves every seam for the tasks to invent.
 */
/** A Test: command that cannot fail (so red is impossible and the build wedges demanding it). */
export const noopCommand = (command: string) => {
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
export const suspiciousCommand = (command: string) => {
  const cmd = command.trim();
  if (/[;`$<>]/.test(cmd)) return true;
  if (/\|/.test(cmd)) return true;
  // Any `&` chains (`a&b` backgrounds a and runs b; `&&` and `2>&1` are caught here too).
  if (/&&|&|\n/.test(cmd)) return true;
  return /\b(curl|wget)\b/.test(cmd);
};

/**
 * Rewriting a finished spec keeps its done state (statuses carry by task id): warn when the
 * new task list differs, so a new change on an old name doesn't silently inherit "done".
 * Advisory only: revising a reviewed spec after findings is legitimate.
 */
export const rewriteWarning = (name: string, prev: Progress | undefined, spec: ParsedSpec): string | undefined => {
  if (!prev || !["built", "reviewed"].includes(prev.phase)) return undefined;
  if (!(prev.tasks ?? []).some((t) => t.status === "done")) return undefined;
  const same = spec.tasks.length === prev.tasks.length && spec.tasks.every((t) => prev.tasks.some((o) => o.id === t.id && o.title === t.title));
  if (same) return undefined;
  return `\`${name}\` was already ${prev.phase} with done tasks: they keep their status. If this is a new change rather than a revision, write a new spec instead — new specs start with all tasks todo`;
};

/** The number of lines in a text file, or undefined when it can't be counted (binary, huge). */
export const fileLines = (file: string): number | undefined => {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 2_000_000) return undefined;
    const text = fs.readFileSync(file, "utf8");
    if (text.includes("\0")) return undefined;
    return text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  } catch {
    return undefined;
  }
};

/**
 * A repair lap is shown the reviewer's file:line anchors; one that does not resolve is usually the
 * reviewer guessing, and a lap that probes a file that doesn't exist finds nothing. The worklist is
 * not withheld — an unresolvable anchor may be real (outside the project) or not — but it is named,
 * so the lap verifies instead of trusting it.
 */
export const unresolvedAnchors = (cwd: string, findings: { file?: string }[]): string[] => {
  const files = projectFiles(cwd);
  return [...new Set(findings.flatMap((f) => (f.file ? [f.file] : [])))]
    .filter((p) => resolveProjectPath(cwd, p, files) === undefined && resolveSiblingFile(cwd, p) === undefined)
    .sort();
};

/**
 * A ready spec's `path:line` citations must resolve to a real file and a real line, in the project or in a sibling
 * repository (`resolveSiblingFile`). A citation the visible
 * file list can't answer is asked of the working tree once for all of them, and the file that answers is
 * line-checked like any other, so a gitignored file must really carry the line it is cited at.
 */
export const specPathErrors = (md: string, cwd: string): string[] => {
  const files = projectFiles(cwd);
  const refs = specPathRefs(md);
  const visible = new Map(refs.map((ref) => [ref.path, resolveProjectPath(cwd, ref.path, files)]));
  const rescued = ignoredPathsFor(cwd, [...new Set(refs.filter((ref) => !visible.get(ref.path)).map((ref) => ref.path))]);
  return refs.flatMap((ref) => {
    const found = visible.get(ref.path) ?? rescued.get(ref.path) ?? resolveSiblingFile(cwd, ref.path);
    if (!found)
      return [`the spec cites \`${ref.path}:${ref.line}\`, but that path is not in the project${ref.path.startsWith("../") ? ", nor a file in a sibling repository (`../<repo>/<path>`, one folder up, no dot-named part)" : ""}`];
    let isFile = false;
    try {
      isFile = fs.statSync(found).isFile();
    } catch {
      // A path that vanished between resolution and inspection is as unusable as one that never existed.
    }
    if (!isFile) return [`the spec cites \`${ref.path}:${ref.line}\`, but that path does not name a file`];
    const lines = fileLines(found);
    if (lines !== undefined && ref.line > lines) {
      return [`the spec cites \`${ref.path}:${ref.line}\`, but \`${ref.path}\` has ${lines} line${lines === 1 ? "" : "s"}`];
    }
    return [];
  });
};

export const specWarnings = (md: string, spec: ParsedSpec): string[] => {
  const redEligible = (t: SpecTask) => spec.gate === "tests" && spec.newTests && !/^\(refactor\)/i.test(t.title);
  const shared = sharedTestCommands(spec).map(
    ({ command, ids }) => `\`${command}\` is the Test: of ${ids.join(", ")}: one run cannot show each task's own new tests failing — give each task its own command`,
  );
  const contracts =
    spec.tasks.length > 1 && !new RegExp(`^##\\s+Contracts\\s*$`, "mi").test(md)
      ? [`${spec.tasks.length} tasks and no ## Contracts: pin every seam they share (and which task owns each side); if truly independent, ignore this`]
      : [];
  const suite = spec.tasks.flatMap((t) => {
    const line = t.text.split("\n").find((l) => /\b(?:run|runs|running|execute|executes|executing)\b[^\n]*\b(?:(?:full|whole|entire)\s+(?:test\s+)?suite|all\s+(?:the\s+)?tests)\b/i.test(l));
    if (!line) return [];
    const excerpt = line.trim().length > 120 ? `${line.trim().slice(0, 117)}...` : line.trim();
    return [`${t.id} names a full-suite run ("${excerpt}"): the harness runs the full suite after the last task, so keep this task's Test: targeted and split a task that already bundles several changes`];
  });
  const untestable = spec.tasks.flatMap((t) => {
    if (!redEligible(t) || !t.text.split("\n").some(isAcceptanceLine)) return [];
    if (t.test) {
      if (noopCommand(t.test)) return [`${t.id}'s Test: \`${t.test}\` always passes — the build will wedge demanding red; omit Test: (disclosed to the reviewer) or write a command that fails without the change`];
      if (suspiciousCommand(t.test)) return [`${t.id}'s Test: \`${t.test}\` chains shells or reaches the network — it runs with your privileges, so review it before building; the dry-run below doesn't execute it`];
      return [];
    }
    // A declared doc-only task (doc-only, documentation-only, prose-only) needs no Test: nudge:
    // the reviewer judges its acceptance lines like any other task's.
    if (/doc(?:s|umentation)?[- ]only|prose[- ]only/i.test(t.text)) return [];
    return [`${t.id} adds behaviour but has no Test: line — add a targeted command, or leave it out and the reviewer judges its tests at the end`];
  });
  return [...shared, ...contracts, ...suite, ...untestable];
};

/** Spec names for argument completion (completions run without a ctx, in Pi's working directory). */
export const specCompletions = (prefix: string) =>
  new Store(process.cwd())
    .specNames()
    .filter((n) => n.startsWith(prefix))
    .map((n) => ({ value: n, label: n }));

type Entry = { id: string; parentId: string | null; type: string; message?: { role?: string; content?: unknown } };
type Tree = { getLeafId?(): string | null; getEntry?(id: string): Entry | undefined; getSessionName?(): string | undefined; getBranch?(): Entry[] };
export const contentText = (c: unknown) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((x: { type?: string; text?: string }) => (x.type === "text" ? (x.text ?? "") : "")).join("") : "");
export const tree = (ctx: ExtensionContext) => ctx.sessionManager as unknown as Tree;

export const text = (t: string) => [{ type: "text" as const, text: t }];
/** What `pi --session` takes for a session file: its id, as getSessionId() derives it. */
export const sessionIdOf = (file: string) => path.basename(file, ".jsonl");
/** A tool result the agent carries on from. */
export const reply = (t: string) => ({ content: text(t), details: undefined });
/** The last few non-empty lines of a text being written, for a live view. */
export const tail = (t: string, n = 3) =>
  t
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim())
    .slice(-n);

/** A UI update from a callback that may outlive its session (you switched away): skipped instead of crashing Pi. */
export const safely = (f: () => void) => {
  try {
    f();
  } catch {
    // the session was replaced: there's nothing to draw on any more
  }
};

/** Whether a widget can be drawn here: hasUI, with a replaced session reading as none rather than a throw. */
export const watchable = (ctx: Pick<ExtensionContext, "hasUI">): boolean => {
  try {
    return !!ctx.hasUI;
  } catch {
    return false;
  }
};

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The context Pi hands over after a session switch (newSession/switchSession's withSession). */
export type ReplacedSessionContext = Parameters<NonNullable<Parameters<ExtensionCommandContext["newSession"]>[0]>["withSession"] & {}>[0];

/** The tools a review session's model gets: read-only, plus the one it reports with. */
export const REVIEW_SESSION_TOOLS = ["read", "grep", "find", "ls", "pb_report_findings"];

/**
 * The tools a repair lap may use: read the repo and spec, probe read-only through pb_try, ask the
 * human, and write only through the spec tools. No shell, no edit/write: a lap repairs a plan, it
 * must not change the project or another spec.
 */
export const REPAIR_SESSION_TOOLS = ["read", "grep", "find", "ls", "pb_write_spec", "pb_update_spec", "pb_try", "pb_ask", "pb_spec_fix_done"];

/** A tool result that ends the agent's run: the build paused or finished. */
export const stop = (t: string) => ({ content: text(t), details: undefined, terminate: true });

/**
 * Cross-module runtime flags: read by hooks, mutated by tools, the build and /pb:undo.
 * `undoSummary` is set by /pb:undo while it rewinds the conversation: the branch summary
 * pb supplies instead of an LLM's.
 */
export const runtime = { checking: 0, boundary: false, undoSummary: undefined as string | undefined };

let PI: ExtensionAPI | undefined;

/** Bind Pi once when the extension loads; post/instruct/appendEntry go through this holder. */
export const bindKit = (pi: ExtensionAPI): void => {
  PI = pi;
};

const send = (m: { customType: string; content: string; display: boolean }, o: { triggerTurn: boolean; deliverAs?: "followUp" }) => {
  if (!PI) throw new Error("pb kit used before bindKit(pi)");
  PI.sendMessage(m, o);
};

/** pi.appendEntry passthrough bound by bindKit: the pb-* entries the report keeps. */
export const appendEntry = (name: string, data: unknown): void => {
  if (!PI) throw new Error("pb kit used before bindKit(pi)");
  PI.appendEntry(name, data);
};

export const post = (content: string) => send({ customType: "pb", content, display: true }, { triggerTurn: false });
/** A short visible marker plus full instructions that start a turn. */

export const instruct = (marker: string, prompt: string) => {
  post(marker);
  send({ customType: "pb-instruction", content: prompt, display: false }, { triggerTurn: true, deliverAs: "followUp" });
};

export const commands = (cwd: string, store: Store) => {
  const cfg = store.config();
  return {
    cfg,
    testCmd: resolveVerify(cfg.verify, cwd),
    buildCmd: resolveBuild(cfg.build, cwd),
    lintCmd: resolveLint(cfg.lint, cwd),
    extraCmds: cfg.extraChecks.filter((c) => c.trim() && c !== "none"),
  };
};

/** Extra final-gate commands after the suite/compile: lint, then the project's own checks. */

export const finalExtras = (lintCmd: string | null, extraCmds: string[]): string[] => [...(lintCmd ? [lintCmd] : []), ...extraCmds];

/** " · 2m 3s" when a phase recorded its time, nothing when it didn't (older events carry none). */

export const timeSuffix = (ms?: number) => (ms !== undefined ? ` · ${duration(ms)}` : "");

/** Synthetic build steps that are not spec tasks. */

export const SYNTHETIC_TASKS = new Set(["final", COHERE_TASK_ID, "skeleton"]);

export const specTasks = (p: Progress) => p.tasks.filter((t) => !SYNTHETIC_TASKS.has(t.id));

/** A phase result's first line: marker, phase, spec, then the facts that summarize it. */

export const phaseHeader = (marker: string, phase: string, spec: string, ...facts: (string | false | undefined)[]) =>
  `**${marker} ${phase} — ${spec}**${facts.filter((f): f is string => !!f).map((f) => ` · ${f}`).join("")}`;

/** The one primary action a result hands to the human. */

export const nextLine = (action: string) => `**Next:** ${action}`;

/** The facts behind a result, on one line. */

export const evidenceLine = (...parts: (string | false | undefined)[]) => {
  const kept = parts.filter((p): p is string => !!p);
  return kept.length ? `**Evidence:** ${kept.join(" · ")}` : "";
};

/** How many extra attempts the build needed across its real tasks. */

export const retryCount = (p: Progress) => specTasks(p).reduce((n, t) => n + Math.max(0, t.attempts - 1), 0);

/** The latest time one of the spec's events recorded, if any. */

export const recordedMs = (store: Store, name: string, type: string): number | undefined => {
  const ms = [...readEvents(path.join(store.specDir(name), "events.jsonl"))].reverse().find((e) => e.type === type && typeof e.ms === "number")?.ms;
  return typeof ms === "number" ? ms : undefined;
};

/** When the current spec-writing step began, per session: the first ready write reports it. */

export const specStarted = new Map<string, number>();

export const loadSpec = (store: Store, name: string): { md: string; spec: ParsedSpec } | undefined => {
  const md = store.readSpec(name);
  const spec = md ? parseSpec(md).spec : undefined;
  return md && spec ? { md, spec } : undefined;
};

/**
 * The spec a running build is bound to: its approved snapshot, or the live file for a build
 * started before approvals existed. Design and Decisions live only in the live file; they are
 * the two sections a build may change, so readers that need them use the live text.
 */

export const loadBuildSpec = (store: Store, p: Progress): { md: string; spec: ParsedSpec } | undefined => {
  const md = p.approval ? store.readApprovedSpec(p.spec) : store.readSpec(p.spec);
  const spec = md ? parseSpec(md).spec : undefined;
  return md && spec ? { md, spec } : undefined;
};

type ApprovalDrift = "changed" | "missing";

/**
 * Whether the live spec still carries the contract the build was approved against. Design and
 * Decisions are outside it: the build writes those, and a resume re-approves a changed contract.
 */

export const approvalDrift = (store: Store, p: Progress): ApprovalDrift | undefined => {
  if (!p.approval) return undefined;
  const approved = store.readApprovedSpec(p.spec);
  if (!approved || contractHash(approved) !== p.approval.contractHash) return "missing";
  const live = store.readSpec(p.spec);
  if (!live) return "missing";
  return contractHash(live) !== p.approval.contractHash ? "changed" : undefined;
};

/**
 * Append one Decisions line to a spec, or refuse with the reason. The result must still parse: a
 * writer that doesn't recognise a heading its readers accept once produced a duplicate section.
 * The one write path for decisions, assumptions and /pb:build guidance.
 */

export const appendDecision = (store: Store, name: string, text: string, update: "decisions" | "guidance" = "decisions"): string | undefined => {
  const md = store.readSpec(name);
  if (!md) return `no spec "${name}"`;
  const updated = addDecision(md, text);
  const errors = parseSpec(updated).errors;
  if (errors.length) return `the spec wouldn't parse afterwards: ${errors.join("; ")}`;
  store.writeSpec(name, updated);
  store.event(name, { type: "spec", update });
  return undefined;
};

/** Put back what a fresh run changed, and say so: the same window can hold your own edit. */

export const revertFreshRun = (cwd: string, warn: (message: string) => void, what: string, before: Snapshot | undefined, after: Snapshot | undefined) => {
  if (!before || !after || before.tree === after.tree) return;
  const r = restore(cwd, after.commit, before.commit);
  if (r.guardFailed) {
    warn(`Couldn't check what ${what} changed (the guard snapshot failed), so nothing was put back: check the working tree yourself.`);
    return;
  }
  if (!r.restored.length) return;
  // The run is supposed to be read-only, but an edit of yours made meanwhile is in the same
  // window and got put back too. Name the paths and keep the recovery command in the message.
  const shown = r.restored.slice(0, 5);
  const more = r.restored.length > shown.length ? ` (+${r.restored.length - shown.length} more)` : "";
  warn(
    `Files changed while ${what} ran were put back: ${shown.join(", ")}${more}. If one was your own edit, the post-run tree is in ${after.commit}: git show ${after.commit}:<path> for its content, git diff ${before.commit} ${after.commit} for the change.`,
  );
};

/** A warning from a flow whose session may have been replaced meanwhile: with no live UI there is nobody to tell. */

export const warnLater = (ctx: Pick<ExtensionContext, "ui">, message: string) => safely(() => ctx.ui.notify(message, "warning"));

/** Keep task statuses by id when a spec is (re)written; new tasks start as todo. */

export const syncTasks = (spec: ParsedSpec, old: TaskProgress[] = []): TaskProgress[] => {
  const byId = new Map(old.map((o) => [o.id, o]));
  return spec.tasks.map((t) => {
    const prev = byId.get(t.id);
    // A proof belongs to the exact Test: command: a rewritten command re-requires it.
    const redCommand = prev?.redCommand !== undefined && prev.redCommand === t.test ? prev.redCommand : undefined;
    return { id: t.id, title: t.title, status: prev?.status ?? "todo", attempts: prev?.attempts ?? 0, summary: prev?.summary, changed: prev?.changed, caveat: prev?.caveat, rejected: prev?.rejected, open: prev?.open, redCommand };
  });
};

/**
 * Record what a build is approved against: the snapshot the build may not rewrite, its hashes,
 * and the ledger event. Returns whether an earlier contract was replaced, so the human hears it.
 */

export const approveSpec = (store: Store, p: Progress, md: string, spec: ParsedSpec): boolean => {
  const contract = contractHash(md);
  const reapproved = !!p.approval && p.approval.contractHash !== contract;
  p.approval = { at: now(), hash: specHash(md), contractHash: contract };
  p.tasks = syncTasks(spec, p.tasks);
  if (reapproved) p.edited = true;
  store.writeApprovedSpec(p.spec, md);
  store.event(p.spec, { type: "spec-approved", hash: p.approval.hash, contractHash: contract, reapproved: reapproved || undefined });
  return reapproved;
};

/**
 * Per-task changed files for the final surfaces (the completion summary and the final-failure
 * brief): what each task changed, from its checkpoint, not the model's report. Empty outside git
 * or without checkpoints.
 */

export const changedFilesSection = (store: Store, p: Progress): string => {
  if (!store.config().checkpoints) return "";
  let cps: ReturnType<Store["checkpoints"]> = [];
  try {
    cps = store.checkpoints(p.spec);
  } catch {
    return "";
  }
  const lines: string[] = [];
  for (const t of p.tasks) {
    if (t.id === "final") continue;
    const files = cps.find((c) => c.id === t.id)?.files ?? [];
    if (!files.length) continue;
    lines.push(`- ${t.id}: ${files.slice(0, 12).join(", ")}${files.length > 12 ? `, +${files.length - 12} more` : ""}`);
  }
  return lines.length ? `\nChanged files, by task (from checkpoints, not the model's report):\n${lines.join("\n")}` : "";
};

/**
 * The pointer a later task gets to the code the finished tasks left: their ids and changed files,
 * from checkpoints, plus the requirement to inspect what it depends on before editing. The code
 * is evidence, not approval: Design remains the shared-shape contract for later tasks.
 */

export const doneHandoff = (store: Store, p: Progress, current: string): string => {
  const done = p.tasks.filter((t) => t.status === "done" && t.id !== current && t.id !== "final" && t.id !== COHERE_TASK_ID);
  if (!done.length) return "";
  let cps: Checkpoint[] = [];
  try {
    cps = store.checkpoints(p.spec);
  } catch {}
  const described = done.map((t) => {
    const row = cps.find((c) => c.id === t.id);
    const files = row?.files ?? [];
    if (!files.length) return t.id;
    const shown = files.slice(0, 8).map((f) => {
      const names = (row?.declarations ?? []).filter((d) => d.file === f).map((d) => d.name);
      return names.length ? `${f} [${names.slice(0, 10).join(", ")}${names.length > 10 ? `, +${names.length - 10} more` : ""}]` : f;
    });
    return `${t.id} (${shown.join(", ")}${files.length > shown.length ? `, +${files.length - shown.length} more` : ""})`;
  });
  return `Already done: ${described.join("; ")}. This is a pointer, not the truth: before editing, inspect the earlier tasks' code this task depends on (contracts, types, migrations, error handling and tests first; use pb_explore if you don't know where to start). If it conflicts with the spec, don't build on it silently: make the conflict explicit, and stop with blocked and the evidence if the Goal or a Contract cannot be built as written. If it matches, extend it rather than duplicating it: reuse a name in brackets (what that file gained) before writing another that does the same. Design is the shared-shape contract: record any shape this task settles for later tasks there before you finish.`;
};

/** What the agent is told for a step: the task, the check it will run, and the spec to read. */

export const stepPrompt = (ctx: ExtensionContext, store: Store, spec: ParsedSpec, p: Progress, task: SpecTask, attempts: number) => {
  const { cfg, testCmd, buildCmd, lintCmd } = commands(ctx.cwd, store);
  const tp = p.tasks.find((t) => t.id === task.id);
  const red = needsRed(spec, task);
  return taskPrompt(task, attempts, cfg.maxAttempts, checkCommand(spec, task, testCmd, buildCmd, false, cfg.taskChecks === "each"), red && !tp?.redCommand, specReference(p.spec), doneHandoff(store, p, task.id), lintsEachStep(p) ? lintCmd : null);
};

/**
 * The tasks whose new tests carry no proof, with why — for the reviewer and the build's end. A task
 * whose command an earlier finished task already proved cannot fail again; that is derived, not stored.
 */

export const redNotes = (spec: ParsedSpec, p: Progress): string[] =>
  spec.tasks.flatMap((t) => {
    const tp = p.tasks.find((x) => x.id === t.id);
    if (tp?.redCommand) return [];
    const earlier = earlierProof(spec, p.tasks, t);
    if (earlier) return [`${t.id}: \`${t.test}\` was already proved by ${earlier.id}, so no run can fail it now`];
    return [`${t.id}: ${redExemption(spec, t) ?? "its new tests were never seen failing"}`];
  });

export const mark = (t: TaskProgress) => (t.status === "done" ? "✓" : t.status === "doing" ? "▸" : t.status === "blocked" ? "✗" : "·");

export const taskLine = (t: TaskProgress) => `${mark(t)} ${t.id} ${t.title}${t.attempts > 1 ? ` (${t.attempts} attempts)` : ""}`;

/** The standards to put in a message: none when this session already loaded them from AGENTS.md. */

export const standardsFor = (ctx: ExtensionContext): string => {
  const found = findStandards(ctx.cwd);
  if (!found) return "";
  const opts = (ctx as Partial<ExtensionCommandContext>).getSystemPromptOptions?.();
  return opts && standardsLoaded(opts.contextFiles) ? "" : found.text;
};

export const sessionModel = (ctx: ExtensionContext) => (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);

export const findModel = (ctx: ExtensionContext, spec: string) => {
  const slash = spec.indexOf("/");
  return (ctx as { modelRegistry?: { find(p: string, id: string): unknown } }).modelRegistry?.find(spec.slice(0, slash), spec.slice(slash + 1));
};

export const specOfSession = (ctx: ExtensionContext) => {
  const store = new Store(ctx.cwd);
  const name = store.specForSession(ctx.sessionManager.getSessionFile());
  return { store, name, progress: name ? store.progress(name) : undefined };
};

/** The spec this session is building, while its build is live: its contract is frozen. */

export const liveBuildOfSession = (ctx: ExtensionContext, store: Store): Progress | undefined => {
  const name = store.specForSession(ctx.sessionManager.getSessionFile());
  const p = name ? store.progress(name) : undefined;
  return p?.phase === "building" ? p : undefined;
};

/**
 * Stop a live build whose live spec no longer matches what it was approved against: a build
 * never runs past a contract the human didn't approve.
 */

export const driftStop = (ctx: ExtensionContext, store: Store, p: Progress, drift: ApprovalDrift) => {
  const why = drift === "missing" ? "its approved copy is missing or no longer matches its approval" : "its contract was edited after it was approved";
  pauseBuild(
    ctx,
    store,
    p,
    `${p.spec}: ${why}; the build stopped rather than run past what was approved. Revise the spec if it should change, then /${cmd("build")} ${p.spec} re-approves it.`,
    "build.paused",
    "spec",
  );
  return stop("The spec's contract no longer matches its approval: the build is paused. Stop here.");
};

/**
 * The build these tools can record into, or why there is none: no build in this session,
 * or one that is paused, finished or not started. Both tools refuse before touching state.
 */

export const buildOfSession = (ctx: ExtensionContext) => {
  const { store, progress } = specOfSession(ctx);
  if (!progress) throw new Error("No pb build is running in this session.");
  if (progress.phase === "building") return { store, progress };
  const name = progress.spec;
  if (progress.phase === "paused")
    throw new Error(
      `The build of ${name} is paused${progress.current ? ` at ${progress.current}` : ""}: the human decides how to go on. To resume it, run /${cmd("build")} ${name}.`,
    );
  if (progress.phase === "built") throw new Error(`The build of ${name} is finished, so there is nothing to record. To review it, run /${cmd("review")} ${name}.`);
  if (progress.phase === "reviewed") throw new Error(`The build of ${name} is finished and reviewed, so there is nothing left to record.`);
  throw new Error(`The build of ${name} has not started. Run /${cmd("build")} ${name} to start it.`);
};

/** The build's task list above the editor while it runs. */

export const showProgress = (ctx: ExtensionContext, p: Progress | undefined, note?: string) => {
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

export const patiently = async <T>(ctx: ExtensionContext, ms: number, run: (opts: { signal?: AbortSignal; timeout?: number } | undefined) => Promise<T>): Promise<{ result: T; timedOut: boolean }> => {
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

export const choose = async (ctx: ExtensionContext, store: Store, title: string, options: string[], fallback: string, notes?: string[]): Promise<string | undefined> => {
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

export const agree = async (ctx: ExtensionContext, store: Store, title: string, notes?: string[]) => {
  const GO = "Yes, go on";
  return (await choose(ctx, store, title, [GO, "No, stop here"], GO, notes)) === GO;
};

/**
 * Where to rewind the conversation to for an entry: navigating to a user or custom message would
 * move its text into the editor, so step back to the entry before it. keepUser: stop at your own
 * message (going back to a branch, its text returns to the editor instead of being lost).
 */

export const rewindPoint = (ctx: ExtensionContext, from: string | undefined, keepUser = false): string | undefined => {
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

export const checkCommand = (spec: ParsedSpec, task: SpecTask | undefined, testCmd: string | null, buildCmd: string | null, final: boolean, each: boolean) => {
  if (spec.gate === "none") return null;
  if (final) return spec.gate === "tests" ? testCmd : buildCmd;
  // Without per-task checks the harness still compiles each task (when a compile command
  // exists): type drift then fails fast at the task, inside the same pb_task_done call.
  if (!each) return buildCmd;
  return spec.gate === "tests" ? (task?.test ?? buildCmd) : buildCmd;
};

// Checks running right now: the prompt cache is certain to be needed afterwards.

export const withChecking = async <T>(fn: () => Promise<T>): Promise<T> => {
  runtime.checking += 1;
  try {
    return await fn();
  } finally {
    runtime.checking -= 1;
  }
};
/**
 * Mid-task compactions with no forward progress in a row, by session: the thrash guard's memory.
 * In-memory (a crash just delays it); a task boundary is progress by construction, so only the
 * Pi-compaction path reads it. `findings` and `checks` count what a review pass has reported, so
 * findings and acceptance results written between two compactions count as progress even when
 * nothing new was read.
 */

export const compactStalls = new Map<string, { task?: string; changed: string[]; read: string[]; tokens: number; strikes: number; findings?: number; checks?: number }>();
/** How many sessions' stall state is kept; older ones are dropped so a long-lived process doesn't grow. */

export const STALL_MEMORY = 64;
/** Compacting this often with nothing changed, read, shrunk or reported means stuck, not long: pause instead of looping. */

export const COMPACT_STALL_LIMIT = 3;

export const rememberStall = (session: string, stall: { task?: string; changed: string[]; read: string[]; tokens: number; strikes: number; findings?: number; checks?: number }) => {
  compactStalls.set(session, stall);
  for (const k of compactStalls.keys()) {
    if (compactStalls.size <= STALL_MEMORY) break;
    if (k !== session) compactStalls.delete(k);
  }
};
export const baselineSessions = new Set<string>();

export const commitBlock = (message: string | undefined) => (message ? `**Commit message**, to paste:\n\n\`\`\`text\n${message}\n\`\`\`` : "");

/** A hung task command must not stall approval: the dry-run caps each well below a real check. */

export const specWriting = new Set<string>();

export const checkpointing = new Map<string, { since: string; percent: number; manual?: boolean; last: { human?: string; answer?: string } }>();
// Don't ask again until the session has grown another 5% of its window (after a failed or undone checkpoint).

export const checkpointQuiet = new Map<string, number>();

/** The last planning-write set posted per session, so a note is not repeated every settle. */

export const planningWriteNotes = new Map<string, string>();

/**
 * Drop everything this process keyed by a session: keys are session file paths, so a
 * replaced session (quit, reload, new, resume, fork) would otherwise hold its entries for
 * the life of the process. A crash needs no such sweep — the maps die with the process.
 */

export const pruneSession = (session: string) => {
  specStarted.delete(session);
  compactStalls.delete(session);
  baselineSessions.delete(session);
  specWriting.delete(session);
  checkpointing.delete(session);
  checkpointQuiet.delete(session);
  planningWriteNotes.delete(session);
};

/** The human's last message and the reply to it, for the reset summary: the thread you were in stays word for word. */

export const noSnapshotWarning = (checkpoints: boolean) =>
  checkpoints
    ? "Could not snapshot the working tree, so pb can't list what changed while planning; review the working tree yourself."
    : "Checkpoints are off, so pb can't list what changed while planning; review the working tree yourself.";

/** The project map may have rotted since it was written: name the paths that no longer resolve. */

export const reviewPlanningChanges = async (ctx: ExtensionContext, store: Store, notes?: string[]): Promise<boolean> => {
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
  } else if (choice !== KEEP) {
    // Cancel (or a dismissed dialog) leaves planning as it was: say so, or the command looks dead.
    ctx.ui.notify("Planning is still on: the files changed while planning were neither kept nor restored. Run /" + cmd("plan") + " off again and choose Keep or Restore.", "info");
    return false;
  } else if (!ctx.hasUI) ctx.ui.notify(`Kept files changed while planning: ${list}`, "warning");
  store.setPlanning(session, store.planningSessions().includes(session), (choice === RESTORE ? undefined : cur.commit) ?? snap);
  return true;
};

/**
 * Standards live in AGENTS.md (Pi loads it everywhere); offer pb's section once per project, at the
 * first /pb:plan, /pb:deps or /pb:build. A stack's own section (Java, Vue) goes only in the project's AGENTS.md,
 * so the shared one stays free of stack rules. A Vue project that only finds a shared section (a
 * parent's or the agent directory's, e.g. the backend's) is offered its frontend one next to it.
 */

/**
 * What planning sets in a session that runs on `before`: the planner's thinking floor (default "high") when
 * the session thinks less, and the planner's model when one is configured. Pure: callers apply it.
 */
export const plannerSettings = (before: { thinking?: string; model?: string }, planner: { thinking?: ThinkingLevel; model?: string }): PlannerSettings => {
  const floor = planner.thinking ?? "high";
  const rank = (level?: string) => THINKING_LEVELS.indexOf(level as ThinkingLevel);
  return {
    ...(before.thinking ? { thinking: before.thinking } : {}),
    ...(before.model ? { model: before.model } : {}),
    ...(rank(floor) > rank(before.thinking) ? { appliedThinking: floor } : {}),
    ...(planner.model && planner.model !== before.model ? { appliedModel: planner.model } : {}),
  };
};

/** Planning started in this session: run it on the planner's settings, once per planning run, and record what changed. */
export const applyPlanner = async (ctx: ExtensionContext, store: Store): Promise<void> => {
  const session = ctx.sessionManager.getSessionFile();
  if (!session || !PI || store.planning(session)?.planner) return;
  const settings = plannerSettings({ thinking: PI.getThinkingLevel() as string | undefined, model: sessionModel(ctx) }, store.config().planner);
  if (settings.appliedModel) {
    const model = findModel(ctx, settings.appliedModel);
    if (!model || !(await PI.setModel(model as Parameters<ExtensionAPI["setModel"]>[0]))) {
      ctx.ui.notify(`planner.model ${settings.appliedModel} isn't available here: planning stays on ${settings.model ?? "this session's model"}.`, "warning");
      delete settings.appliedModel;
    }
  }
  if (settings.appliedThinking) {
    PI.setThinkingLevel(settings.appliedThinking as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
    settings.appliedThinking = PI.getThinkingLevel() as string; // Pi clamps the level to the model
  }
  store.setPlannerSettings(session, settings);
};

/** Planning ends: put back what it changed, unless you changed it yourself since. */
const restorePlanner = async (ctx: ExtensionContext, store: Store, session: string): Promise<void> => {
  const settings = store.planning(session)?.planner;
  if (!settings || !PI) return;
  if (settings.appliedModel && settings.model && sessionModel(ctx) === settings.appliedModel) {
    const model = findModel(ctx, settings.model);
    if (model) await PI.setModel(model as Parameters<ExtensionAPI["setModel"]>[0]);
  }
  if (settings.appliedThinking && settings.thinking && PI.getThinkingLevel() === settings.appliedThinking) {
    PI.setThinkingLevel(settings.thinking as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
  }
};

export const liftPlanning = async (ctx: ExtensionContext, store: Store): Promise<boolean> => {
  const session = ctx.sessionManager.getSessionFile();
  if (!session || !store.planningSessions().includes(session)) return true;
  if (!(await reviewPlanningChanges(ctx, store))) return false;
  await restorePlanner(ctx, store, session);
  store.setPlanning(session, false);
  ctx.ui.setWidget("pb-plan", undefined);
  return true;
};

/** Record trailing /pb:build words as a Decisions line, so nothing the human typed is dropped. False = nothing was written (no spec, or it wouldn't parse); the callers warn. */

/** The four priorities, lowest-blocking first — the reviewers' ordering. */
export const P_ORDER = ["P0", "P1", "P2", "P3"] as const;

/** Which standards a stack gets, in words. */

const BUILT_IN_STACK_LABELS: Record<string, string> = {
  java: "the backend ones, with Java 25",
  vue: "the frontend ones, for a Vue project",
  rust: "the backend ones, with Rust",
};

export const stackLabel = (stack?: Stack) =>
  stack && isUserTemplate(stack) ? `your ${stack} template` : !stack || stack === "plain" ? "the plain ones" : (BUILT_IN_STACK_LABELS[stack] ?? stack);

export const pauseBuild = (ctx: ExtensionContext, store: Store, p: Progress, reason: string, tipKey: string, why: string, vars: Record<string, string | number> = {}, say = post) => {
  pauseAt(p, reason);
  store.saveProgress(p);
  store.event(p.spec, { type: "pause", why, task: p.current });
  const cfg = store.config();
  const timing = buildTiming(readEvents(path.join(store.specDir(p.spec), "events.jsonl")));
  const tasks = specTasks(p);
  const done = tasks.filter((t) => t.status === "done").length;
  const current = p.current && !SYNTHETIC_TASKS.has(p.current) ? p.tasks.find((t) => t.id === p.current) : undefined;
  const step = p.current === "final" ? "final check" : current ? `${current.id} · attempt ${current.attempts}/${cfg.maxAttempts}` : "";
  const saved = cfg.checkpoints ? "progress and checkpoints saved" : "progress saved";
  const next = tipKey === "build.contract"
    ? `revise \`${store.rel("specs", p.spec, "spec.md")}\` if it should change, then \`/${cmd("build")} ${p.spec}\` re-approves it and resumes.`
    : tipKey === "build.paused-attempts"
      ? `\`/${cmd("build")}\` to retry with fresh attempts, or \`/${cmd("undo")} ${p.current ?? "start"}\` to throw this attempt away.`
      : `\`/${cmd("build")}\` to continue (plain chat won't re-attach the harness).`;
  showProgress(ctx, p);
  say([
    phaseHeader("⏸", "Build paused", p.spec, tasks.length ? `${done}/${tasks.length} tasks` : "", step, timing.activeMs || timing.wallMs ? buildTimeLabel(timing) : ""),
    "",
    nextLine(next),
    evidenceLine(timing.activeMs || timing.wallMs ? `build time so far: ${buildTimeLabel(timing)}` : "", done ? `${done} task${done === 1 ? "" : "s"} done, kept` : "", saved),
    "",
    reason,
    "",
    tip(tipKey, { spec: p.spec, ...vars }),
  ].join("\n"));
  // A pause is exactly the moment the human has walked away: the post alone goes unseen.
  if (cfg.notify) notifyDesktop("pb: build paused", `${p.spec}: ${reason}`);
};
