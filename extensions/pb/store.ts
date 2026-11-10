/**
 * On-disk state: .pi/pb/config.json, one folder per spec under .pi/pb/specs/<name>/
 * (spec.md, approved.md, progress.json, checkpoints.json, events.jsonl), and finished
 * specs under .pi/pb-archive/, which ignores itself in git.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { safeLine } from "./markdown.ts";
import { KEBAB_NAME } from "./names.ts";
import { agentDir } from "./standards.ts";
import type { Declaration } from "./declarations.ts";

export const PREFIX = "pb";
export const PB_DIR = path.join(".pi", "pb");
export const ARCHIVE_DIR = path.join(".pi", "pb-archive");

export type Gate = "tests" | "build" | "none";

export interface Config {
  /** Test command: "auto" detects mvn/gradle/npm/cargo/go/pytest; null disables. */
  verify: string | null;
  /** Compile/typecheck command: the check for a task without its own Test: line, and the "build" gate. "auto" detects; null disables. */
  build: string | null;
  /**
   * Lint command: "auto" uses package.json's lint script, else clippy for a Cargo project (other stacks set
   * it explicitly); null disables. Gates every task's check when set explicitly, or when auto-detected and the
   * planning baseline ran it clean on this commit; otherwise only the final check (see Progress.lintGate).
   */
  lint: string | null;
  /** Extra project commands (e.g. standards scripts): explicit commands only, run at the final gate after the suite. */
  extraChecks: string[];
  verifyTimeoutSec: number;
  /** How long one shell command the agent runs may take before Pi kills it (seconds; 0 = no limit). */
  commandTimeoutSec: number;
  /** How long one `pb_try` probe may run before pb stops it (seconds; 0 = no limit). */
  probeTimeoutSec: number;
  /** Fix attempts per task (or for the final check) before the build pauses for you. */
  maxAttempts: number;
  /**
   * Cap on concurrent fresh runs (explorer, try, spec-review, cartographer, verifier): they all
   * land on the same engine, and every admitted run holds KV memory for its whole life. Extra
   * runs queue FIFO. Unset or 0 = uncapped. A value in ~/.pi/agent/pb/config.json caps every
   * project until the project sets its own; the PI_PB_MAX_CONCURRENT env var outranks all.
   */
  maxConcurrent?: number;
  /** "end": one check after the last task; "each": every task's own check (its Test: line, else a compile), then the final one. */
  taskChecks: "end" | "each";
  /** How long a pb_ask dialog in a build waits before the build goes on with the recommendation (seconds; 0 = forever). */
  askTimeoutSec: number;
  /** How long /pb:build waits for the spec before yielding to the pending offer (seconds; 0 = wait as long as it takes). */
  specWaitSec: number;
  /** Chars of test output shown to the agent and the reviewer. */
  testOutputCap: number;
  /** Shadow snapshots per task: real diffs, changed-test checks, /pb:undo. */
  checkpoints: boolean;
  /**
   * The fresh reviewer: model and thinking level (unset = your session's), whether a second call double-checks
   * P0/P1 findings, and when an abuse pass tries to break the change ("auto", the default: on ground that
   * looks sensitive; "always"; "off").
   */
  reviewer: { model?: string; thinking?: string; verify?: boolean; security?: "auto" | "always" | "off"; idleSec?: number };
  /**
   * The fresh spec reviewer before T1: model and thinking level (unset model = your session's;
   * unset thinking = Pi's default for that model). Point it at the build model when you want the
   * plan checked by the model that will implement it. Every ready spec gets one pass.
   */
  specReviewer: { model?: string; thinking?: string };
  /**
   * The spec fixer: the model for the claim check (unset = your session's — the question is narrow, so
   * it does not need the reviewer's model), and the budget one `/pb:spec-harden` run may spend: repair
   * laps (`maxLaps`, default 3) and spec reviews (`maxReviews`, default 2 — the pass that finds the work
   * and the one that confirms the repair). A harden run spends no more than that on either: a third pass
   * over a plan is a decision you make by hand, not a step an unattended run takes.
   */
  specFix: { model?: string; thinking?: string; maxLaps?: number; maxReviews?: number };
  /** Above this share of the context window (%), /pb:build offers a fresh session instead of this one. */
  freshAbove: number;
  /** /pb:plan runs the test suite in the background, so planning knows whether it passes today. */
  baseline: boolean;
  /** Model and thinking level of pb_explore and the project map; unset model = your session's, unset thinking = max (Pi clamps it to the model). */
  explorer: { model?: string; thinking?: string };
  /**
   * The planning conversation's model and least thinking level, applied when planning starts and put back
   * when it ends: unset model = your session's; thinking is a floor (default "high"), never lowered.
   */
  planner: { model?: string; thinking?: ThinkingLevel };
  /** Build on this model ("provider/id") instead of the planning session's; unset = the same model. */
  buildModel?: string;
  /**
   * Past this share of the context window (%), and always early enough to stay clear of Pi's own compaction:
   * a planning session writes the plan to its spec and is reset to it. A build uses it only when
   * `buildReset` is "threshold"; 0 turns off the planning checkpoint and the threshold reset.
   */
  checkpointAt: number;
  /**
   * What a build does between tasks. "task" (the default): reset at every task boundary, so each
   * later task reads the spec and the code instead of inheriting the finished tasks' conversation.
   * "threshold": reset only past `checkpointAt`. "never": leave compaction to Pi (pb still writes the summary).
   */
  buildReset: "task" | "threshold" | "never";
  /** /pb:archive updates the project map in AGENTS.md from the finished feature. */
  mapOnArchive: boolean;
  /** A desktop notification when pb asks you something (a question, or a dialog that goes on without you). */
  notify: boolean;
  /**
   * Your own instructions, added to a role's prompt (never replacing pb's, which the harness relies on).
   * Also read from ~/.pi/agent/pb/config.json for every project; both apply, the global ones first.
   */
  extra?: Partial<Record<Role, string>>;
}

/** The roles whose prompts take extra instructions. */
export const ROLES = ["plan", "spec", "build", "review", "adversarial", "map", "spec-fix", "spec-check"] as const;
export type Role = (typeof ROLES)[number];

export const DEFAULT_CONFIG: Config = {
  verify: "auto",
  build: "auto",
  lint: "auto",
  extraChecks: [],
  verifyTimeoutSec: 900,
  commandTimeoutSec: 1800,
  probeTimeoutSec: 900,
  maxAttempts: 3,
  taskChecks: "end",
  askTimeoutSec: 300,
  specWaitSec: 0,
  testOutputCap: 4000,
  checkpoints: true,
  reviewer: { verify: true, security: "auto" },
  specReviewer: {},
  specFix: { maxLaps: 3, maxReviews: 2 },
  freshAbove: 50,
  baseline: true,
  explorer: {},
  planner: {},
  checkpointAt: 75,
  buildReset: "task",
  mapOnArchive: true,
  notify: true,
};

/** Config with wrong types falls back to defaults field by field, so one typo can't break the build. */
function sanitizeConfig(raw: Partial<Config>): Config {
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : d);
  const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
  const oneOf = <T extends string>(v: unknown, allowed: readonly T[], d: T): T => (allowed.includes(v as T) ? (v as T) : d);
  const strOrNull = (v: unknown, d: string | null) => (v === null || v === undefined ? d : typeof v === "string" ? v : d);
  const reviewerRaw = typeof raw.reviewer === "object" && raw.reviewer !== null ? raw.reviewer : {};
  const specReviewerRaw = typeof raw.specReviewer === "object" && raw.specReviewer !== null ? raw.specReviewer : {};
  const specFixRaw = typeof raw.specFix === "object" && raw.specFix !== null ? raw.specFix : {};
  const explorerRaw = typeof raw.explorer === "object" && raw.explorer !== null ? raw.explorer : {};
  const plannerRaw = typeof raw.planner === "object" && raw.planner !== null ? raw.planner : {};
  const security = (reviewerRaw as { security?: unknown }).security;
  return {
    verify: strOrNull((raw as { verify?: unknown }).verify, DEFAULT_CONFIG.verify),
    build: strOrNull((raw as { build?: unknown }).build, DEFAULT_CONFIG.build),
    lint: strOrNull((raw as { lint?: unknown }).lint, DEFAULT_CONFIG.lint),
    extraChecks: Array.isArray((raw as { extraChecks?: unknown }).extraChecks)
      ? ((raw as { extraChecks: unknown[] }).extraChecks.filter((x): x is string => typeof x === "string").slice(0, 10))
      : [],
    verifyTimeoutSec: num((raw as { verifyTimeoutSec?: unknown }).verifyTimeoutSec, DEFAULT_CONFIG.verifyTimeoutSec),
    commandTimeoutSec: num((raw as { commandTimeoutSec?: unknown }).commandTimeoutSec, DEFAULT_CONFIG.commandTimeoutSec),
    probeTimeoutSec: num((raw as { probeTimeoutSec?: unknown }).probeTimeoutSec, DEFAULT_CONFIG.probeTimeoutSec),
    maxAttempts: Math.max(1, Math.floor(num((raw as { maxAttempts?: unknown }).maxAttempts, DEFAULT_CONFIG.maxAttempts))),
    maxConcurrent: num((raw as { maxConcurrent?: unknown }).maxConcurrent, 0), // unset or 0 = uncapped; the runner still floors non-integers
    taskChecks: (raw as { taskChecks?: unknown }).taskChecks === "each" ? "each" : "end",
    askTimeoutSec: num((raw as { askTimeoutSec?: unknown }).askTimeoutSec, DEFAULT_CONFIG.askTimeoutSec),
    specWaitSec: num((raw as { specWaitSec?: unknown }).specWaitSec, DEFAULT_CONFIG.specWaitSec),
    testOutputCap: num((raw as { testOutputCap?: unknown }).testOutputCap, DEFAULT_CONFIG.testOutputCap),
    checkpoints: bool((raw as { checkpoints?: unknown }).checkpoints, true),
    reviewer: {
      model: typeof (reviewerRaw as { model?: unknown }).model === "string" ? (reviewerRaw as { model: string }).model : undefined,
      thinking: typeof (reviewerRaw as { thinking?: unknown }).thinking === "string" ? (reviewerRaw as { thinking: string }).thinking : undefined,
      verify: bool((reviewerRaw as { verify?: unknown }).verify, true),
      security: security === "auto" || security === "always" || security === "off" ? security : "auto",
      idleSec: typeof (reviewerRaw as { idleSec?: unknown }).idleSec === "number" ? (reviewerRaw as { idleSec: number }).idleSec : undefined,
    },
    specReviewer: {
      model: typeof (specReviewerRaw as { model?: unknown }).model === "string" ? (specReviewerRaw as { model: string }).model : undefined,
      thinking: typeof (specReviewerRaw as { thinking?: unknown }).thinking === "string" ? (specReviewerRaw as { thinking: string }).thinking : undefined,
    },
    specFix: {
      model: typeof (specFixRaw as { model?: unknown }).model === "string" ? (specFixRaw as { model: string }).model : undefined,
      thinking: typeof (specFixRaw as { thinking?: unknown }).thinking === "string" ? (specFixRaw as { thinking: string }).thinking : undefined,
      // A repair lap is the model rewriting its own plan: three of them is already a long unattended run.
      maxLaps: Math.max(1, Math.floor(num((specFixRaw as { maxLaps?: unknown }).maxLaps, DEFAULT_CONFIG.specFix.maxLaps!))),
      // Two passes, no more: the one that finds the work and the one that confirms the repair.
      maxReviews: Math.max(0, Math.floor(num((specFixRaw as { maxReviews?: unknown }).maxReviews, DEFAULT_CONFIG.specFix.maxReviews!))),
    },
    freshAbove: num((raw as { freshAbove?: unknown }).freshAbove, DEFAULT_CONFIG.freshAbove),
    baseline: bool((raw as { baseline?: unknown }).baseline, true),
    planner: {
      model: typeof (plannerRaw as { model?: unknown }).model === "string" ? (plannerRaw as { model: string }).model : undefined,
      thinking: THINKING_LEVELS.find((l) => l === (plannerRaw as { thinking?: unknown }).thinking),
    },
    explorer: {
      model: typeof (explorerRaw as { model?: unknown }).model === "string" ? (explorerRaw as { model: string }).model : undefined,
      thinking: typeof (explorerRaw as { thinking?: unknown }).thinking === "string" ? (explorerRaw as { thinking: string }).thinking : undefined,
    },
    buildModel: typeof (raw as { buildModel?: unknown }).buildModel === "string" ? (raw as { buildModel: string }).buildModel : undefined,
    checkpointAt: num((raw as { checkpointAt?: unknown }).checkpointAt, DEFAULT_CONFIG.checkpointAt),
    buildReset: oneOf((raw as { buildReset?: unknown }).buildReset, ["task", "threshold", "never"] as const, DEFAULT_CONFIG.buildReset),
    mapOnArchive: bool((raw as { mapOnArchive?: unknown }).mapOnArchive, true),
    notify: bool((raw as { notify?: unknown }).notify, true),
    extra: typeof raw.extra === "object" && raw.extra !== null ? raw.extra : undefined,
  };
}

export interface VerifyResult {
  ok: boolean | null; // null = nothing to run
  command: string | null;
  summary: string;
  at: string;
}

export type TaskStatus = "todo" | "doing" | "done" | "blocked";

/** Synthetic build step between the last task and the final check (not a spec task): re-read the whole
 * diff and consolidate what task slicing split apart. Mirrored with "final" everywhere progress tasks appear. */
export const COHERE_TASK_ID = "cohere";

export interface TaskProgress {
  id: string;
  title: string;
  status: TaskStatus;
  attempts: number;
  /** why it can't be done (blocked only; the pause message carries it) */
  summary?: string;
  /** what the task changed (done only; required by pb_task_done) */
  changed?: string;
  /** what the next task must respect (done only; required, "none" when nothing) */
  caveat?: string;
  /** what was tried and discarded (done only; required, "none" when nothing) */
  rejected?: string;
  /** what is still unchecked (done only; required, "none" when nothing) */
  open?: string;
  /** the Test: command seen failing for this task before the change, so a rewritten command re-requires proof */
  redCommand?: string;
}

export type Phase = "written" | "building" | "paused" | "built" | "reviewed";

export type Priority = "P0" | "P1" | "P2" | "P3";

export interface Finding {
  priority: Priority;
  file?: string;
  line?: number;
  title: string;
  fix?: string;
  /** in a spec review: the check the finding fails, one of SPEC_CHECK_NAMES (prompts.ts) */
  check?: string;
  /** a pre-existing problem outside the change under review: still reported and pickable; the P2 cap is the reviewer's rule, and a serious one keeps its priority */
  outside?: boolean;
}

/** One acceptance criterion's review result. A criterion left out is never `met`. */
export type AcceptanceStatus = "met" | "not met" | "not verified";

/** A checklist item derived from a task's acceptance line; tasks are the only acceptance form. */
export interface AcceptanceCriterion {
  /** review-only id: T1.1 for a task's first acceptance line, T1.2 for its second */
  id: string;
  text: string;
  /** the task id the line belongs to */
  task?: string;
}

/** What a pass reported for one criterion. `met` always carries evidence; otherwise it degrades to not verified. */
export interface AcceptanceCheck {
  criterion: string;
  status: AcceptanceStatus;
  evidence: string;
}

export interface ReviewState {
  at: string;
  /** snapshot of the tree the review saw: the next review looks only at what changed since */
  snapshot?: string;
  verdict: string;
  /** confirmed findings, to check again next time */
  findings: Finding[];
  /** acceptance statuses to carry into a follow-up */
  acceptance?: AcceptanceCheck[];
}

/** The text a build may not rewrite: recorded when the build starts and re-recorded only on re-approval. */
export interface SpecApproval {
  at: string;
  /** hash of the whole approved text, for provenance */
  hash: string;
  /** hash of the contract only: the text that binds the build, minus Design and Decisions */
  contractHash: string;
}

/**
 * Where an open spec repair stands (Progress.fix). A repair lap is a turn in the session that asked for
 * it, so the model can probe, ask and write through pb_write_spec; `stage` says who has the ball.
 */
export interface SpecFixState {
  /** the session whose turn repairs the spec: only it may report a lap */
  session: string;
  /** true while /pb:spec-harden sequences the laps; false for one manual /pb:spec-fix lap */
  driver: boolean;
  /** "lap": the model has the turn and owes a report; "advance": it reported, the harness owes the next step */
  stage: "lap" | "advance";
  /** when the lap opened: a lap left by a session that has since died is dead, not blocking */
  startedAt: number;
  /** the spec text the worklist was taken from: what the lap's report is bound to */
  hash: string;
  /** what the worklist was: a review's findings, or the claim check's un-evidenced claims */
  work: "findings" | "claims";
  /** the numbers this lap was handed, so its report cannot name a finding it was not shown */
  ids: number[];
  /** this run's stamp, written on every event it adds so a digest counts its own laps and nothing older */
  run: string;
  laps: number;
  reviews: number;
  applied: number;
  rebutted: number;
  assumed: number;
  /** questions a lap refused to answer, each with its recommendation; the driver puts them to the human */
  parked: { id: number; question: string; recommendation: string }[];
  /** a harden run's one claim check: what it found that no lap took; empty when a lap took them all, absent until it ran */
  claimCheck?: Finding[];
  /** how many claims that check handed to a lap: pb does not re-check them, so the digest never calls them cleared */
  claimsTaken?: number;
}

export interface Progress {
  spec: string;
  phase: Phase;
  /** the session the build runs in, once /pb:build started it */
  session?: string;
  /** the session whose conversation wrote the spec (a build there needs no copy of it) */
  writtenIn?: string;
  /**
   * What the build was approved against: the hash of the whole spec and of its contract, with the
   * approved text kept beside it in approved.md. Design and Decisions are outside the contract.
   */
  approval?: SpecApproval;
  /** you edited the spec since the session wrote it: that session's copy is stale */
  edited?: boolean;
  /** a new plan started in the build's session: its later turns aren't this spec's any more */
  detached?: boolean;
  baseCommit?: string;
  tasks: TaskProgress[];
  /** task being worked on; "final" = the full check after the last task */
  current?: string;
  /** choices the builder made where the spec was ambiguous or didn't match the code */
  assumptions?: string[];
  /** choices pb made because nobody answered a dialog in time (askTimeoutSec) */
  unattended?: string[];
  /** the last review's result was written to review.md while you were elsewhere: shown by the next /pb:review */
  reviewUnshown?: boolean;
  /** existing tests the build deleted, cut down or skipped, per task: for the reviewer to judge */
  testChanges?: string[];
  /**
   * An open spec repair: the laps run in the session that asked for them, and only that session may
   * report one. `stage` says who has the ball: "lap" = the model has the turn and owes a report,
   * "advance" = it reported and the harness owes the next step. `ids` are the finding numbers that
   * lap was handed, so its report cannot name a finding it was not shown.
   */
  fix?: SpecFixState;
  pause?: string;
  /** the conversation was rewound to before the build's first message: a resume sends it again */
  needsIntro?: boolean;
  /**
   * Where lint gates this build, decided once at its start: "task" after every step, "final" only at
   * the end (an auto-detected lint the planning baseline did not show clean on this commit). Absent
   * on builds started before the choice existed: they keep the per-task gate.
   */
  lintGate?: "task" | "final";
  /** the task and attempt the agent was already reminded to finish (once each) */
  nudged?: string;
  lastVerify?: VerifyResult;
  review?: ReviewState;
  updatedAt: string;
}

/** One entry of /pb:undo's list: the working tree and task list before a task's first attempt. */
export interface Checkpoint {
  id: string;
  at: string;
  commit: string;
  tree: string;
  head?: string;
  tasks: TaskProgress[];
  task?: string;
  files?: string[];
  /** the names the step's change declared (functions, types, constants): the next task's handoff names them */
  declarations?: Declaration[];
  summary?: string;
  /** session entry to rewind the conversation to; set at the end of the turn when the task started mid-run */
  entry?: string;
  pendingEntry?: boolean;
  /** the task was handed out right before a reset: its rewind point becomes that reset, at the next turn */
  pendingReset?: boolean;
  /** the build's first message comes after `entry`: rewinding here drops it */
  intro?: boolean;
  /** a spec repair lap: its row restores `spec`, and its task list is not a build task list */
  kind?: "lap";
  /** the spec text at this point; /pb:undo restores it for a lap row */
  spec?: string;
  /** the progress phase at this point, restored with the row */
  phase?: Phase;
}

/**
 * Append a /pb:undo row only when it adds information. A row is what undo restores — the
 * commit, the conversation point, the task list — so a row matching the last stored one in
 * all of that says nothing new about the same step. The step's identity (id/task) is part
 * of the comparison because downstream lookups find rows by id (task summaries, undo
 * targets): a different step's row is never dropped, which structurally exempts the
 * freshly-numbered `uN` rows. Fields refined after the fact (`at`, `summary`, `files`) are
 * not information at append time.
 */
export const appendCheckpoint = (list: Checkpoint[], row: Checkpoint): boolean => {
  const last = list.length ? list[list.length - 1] : undefined;
  if (last && sameCheckpointState(last, row)) return false;
  list.push(row);
  return true;
};

const VOLATILE_CHECKPOINT_FIELDS = new Set<string>(["at", "summary", "files", "declarations"]);
const sameCheckpointState = (a: Checkpoint, b: Checkpoint) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof Checkpoint>;
  for (const key of keys) {
    if (VOLATILE_CHECKPOINT_FIELDS.has(key)) continue;
    const av = key === "tasks" ? JSON.stringify(a[key]) : a[key];
    const bv = key === "tasks" ? JSON.stringify(b[key]) : b[key];
    if (av !== bv) return false;
  }
  return true;
};

/** Pi's thinking levels, lowest first: the planner's floor is compared by this order. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/**
 * What planning changed in a session: what it ran on before (`thinking`, `model`) and what planning set
 * (`appliedThinking`, `appliedModel`). The end of planning puts back only what is still as planning set it.
 */
export interface PlannerSettings {
  thinking?: string;
  model?: string;
  appliedThinking?: string;
  appliedModel?: string;
}

/** One session's planning record. */
export interface PlanningRecord {
  snapshot?: string;
  request?: string;
  planner?: PlannerSettings;
}

const plannerSettingsOf = (raw: unknown): PlannerSettings | undefined => {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const out: PlannerSettings = {};
  for (const key of ["thinking", "model", "appliedThinking", "appliedModel"] as const) if (typeof r[key] === "string") out[key] = r[key] as string;
  return out;
};

export interface Baseline extends VerifyResult {
  head?: string;
  /** lint's result when the baseline ran it (null = no lint command): red warns, never blocks alone */
  lint?: VerifyResult | null;
  /** project checks' results, in config order */
  extra?: VerifyResult[];
}

export interface ReviewSessionState {
  role: "review" | "abuse";
  /** the spec under review, if any */
  spec?: string;
  /** the review run this pass belongs to (its state file lives in review-runs/) */
  run?: string;
  /** what the pass reported with pb_report_findings */
  findings?: Finding[];
  /** the acceptance checklist this spec pass reported, if any */
  acceptance?: AcceptanceCheck[];
  /** /pb:review done: finish now */
  done?: boolean;
}

/** A review in progress, kept on disk so it can be continued after an interruption. */
export interface ReviewRun {
  cwd: string;
  /** Identifies this run in the spec's compact events, so a stall in one review never marks the next. */
  id?: string;
  name?: string;
  label: string;
  brief: string;
  base?: string;
  /** the frozen diff (base to the tree the review started on): the review reads it, having no shell */
  diff?: string;
  /** why an abuse pass runs, if it does */
  security?: string;
  followUp: boolean;
  /** the session to come back to */
  home?: string;
  /** the tree the review saw: the delta base for the next review, and what changed during this one is reported against it */
  before?: { commit: string; tree: string };
  /** untracked files over the snapshot cap, which no diff can show: the reviewer is told to read them */
  largeFiles?: string[];
  model?: string;
  thinking?: string;
  /** active time of the review: the reviewer pass plus the adversarial and verifier passes */
  ms?: number;
  /** the spec's task acceptance checklist for this review: T1.1, T2.1, ... */
  acceptance?: AcceptanceCriterion[];
  passes: { role: "review" | "abuse"; findings: Finding[]; acceptance?: AcceptanceCheck[]; prose: string; session: string; left: boolean; unparsed: boolean; error?: string; ms?: number }[];
  /** the pass you left before it finished */
  interrupted?: { role: "review" | "abuse"; session: string };
}

export const now = () => new Date().toISOString().replace("T", " ").slice(0, 19);

/** Truncate to n chars with a marker; n <= 0 means no cap. */
export function cap(text: string, n: number): string {
  if (!text || n <= 0 || text.length <= n) return text ?? "";
  return `${text.slice(0, n)}\n…[truncated ${text.length - n} chars]`;
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export function writeFileAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, file);
}

/** Whether a path pb recorded earlier is still there: a repair lap whose session file is gone can never be reported. */

export const pathExists = (p: string): boolean => {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
};

export function readEvents(file: string): Record<string, unknown>[] {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l)];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

/**
 * A review finding kept for later features: a lead the project map may use, never evidence.
 * `count` is how many completed reviews reported the same place and title.
 */
export interface ReviewLedgerEntry {
  priority: Priority;
  file?: string;
  line?: number;
  title: string;
  fix?: string;
  outside?: boolean;
  count: number;
  /** the last review that reported it, for ordering */
  last: string;
}

/** Findings kept per review log: the rest stay in review.md, which the ledger never replaces. */
export const REVIEW_FINDINGS_CAP = 40;

/** The ledger's own field limits: a lead's words are the point, so they are generous and never move. */
export const LEDGER_FILE_CHARS = 300;
export const LEDGER_TITLE_CHARS = 300;
export const LEDGER_FIX_CHARS = 500;

/** A finding whose title is nothing but markup is still a lead: it keeps this instead of vanishing. */
export const UNTITLED_FINDING = "(untitled finding)";

/** One ledger field as it is stored and as it is read back: one line, no control character, no comment marker. */
const ledgerField = (text: string, max: number): string => cap(safeLine(text), max);

const ledgerTitle = (title: string): string => ledgerField(title, LEDGER_TITLE_CHARS) || UNTITLED_FINDING;

/** One finding as a `review-findings` event holds it: a ledger entry without what dedupe adds to it. */
export type StoredReviewFinding = Omit<ReviewLedgerEntry, "count" | "last">;

/**
 * What a completed review keeps for later features: its P0–P2 findings in the order reported, each
 * field already safe to store here and in the project map, which is built from these lines.
 */
export function ledgerFindings(findings: Finding[]): StoredReviewFinding[] {
  return findings
    .filter((f) => f.priority !== "P3")
    .slice(0, REVIEW_FINDINGS_CAP)
    .map((f) => ({
      priority: f.priority,
      ...(f.file ? { file: ledgerField(f.file, LEDGER_FILE_CHARS) } : {}),
      ...(f.line ? { line: f.line } : {}),
      title: ledgerTitle(f.title),
      ...(f.fix ? { fix: ledgerField(f.fix, LEDGER_FIX_CHARS) } : {}),
      ...(f.outside ? { outside: true } : {}),
    }));
}

const PRIORITY_RANK: Record<Priority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

/**
 * The P0–P2 findings of completed reviews, deduped by place and title, highest priority first.
 * Append-only events, so a finding that recurs across reviews keeps one entry with a count.
 * Events already on disk are not re-written, so every field is sanitised here as well as on the way in.
 */
export function reviewLedger(events: Record<string, unknown>[]): ReviewLedgerEntry[] {
  const found = new Map<string, ReviewLedgerEntry>();
  for (const event of events) {
    if (event.type !== "review-findings" || !Array.isArray(event.findings)) continue;
    const at = typeof event.at === "string" ? event.at : "";
    for (const raw of event.findings) {
      if (!raw || typeof raw !== "object") continue;
      const f = raw as Record<string, unknown>;
      if (f.priority !== "P0" && f.priority !== "P1" && f.priority !== "P2") continue;
      const title = typeof f.title === "string" ? ledgerTitle(f.title) : "";
      if (!title) continue;
      const file = typeof f.file === "string" && f.file.trim() ? ledgerField(f.file, LEDGER_FILE_CHARS) : undefined;
      const line = typeof f.line === "number" && Number.isInteger(f.line) && f.line > 0 ? f.line : undefined;
      const fix = typeof f.fix === "string" && f.fix.trim() ? ledgerField(f.fix, LEDGER_FIX_CHARS) : undefined;
      const outside = f.outside === true || undefined;
      const key = `${file ?? ""}\u0000${line ?? ""}\u0000${title.toLowerCase()}`;
      const entry = found.get(key);
      if (!entry) {
        found.set(key, { priority: f.priority, file, line, title, fix, outside, count: 1, last: at });
        continue;
      }
      entry.count += 1;
      if (PRIORITY_RANK[f.priority] < PRIORITY_RANK[entry.priority]) entry.priority = f.priority;
      if (fix) entry.fix = fix;
      // A defect the change is responsible for is not outside it, whichever review saw it first.
      if (!outside) delete entry.outside;
      if (at > entry.last) entry.last = at;
    }
  }
  return [...found.values()]
    .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || (a.last < b.last ? 1 : a.last > b.last ? -1 : 0) || a.title.localeCompare(b.title))
    .slice(0, REVIEW_FINDINGS_CAP);
}

/** Session paths compare by realpath: /tmp vs /private/tmp must not orphan a lap or a build. */
const samePath = (a: string, b: string): boolean => {
  if (a === b) return true;
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return false;
  }
};

export class Store {
  readonly root: string;
  readonly archiveRoot: string;
  readonly cwd: string;
  constructor(cwd: string) {
    this.cwd = cwd;
    this.root = path.join(cwd, PB_DIR);
    this.archiveRoot = path.join(cwd, ARCHIVE_DIR);
  }

  rel(...parts: string[]): string {
    return path.join(PB_DIR, ...parts);
  }

  config(): Config {
    const file = path.join(this.root, "config.json");
    if (!fs.existsSync(file)) writeFileAtomic(file, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
    const raw = readJson<Partial<Config>>(file) ?? {};
    // maxConcurrent merges from the global pb config too (~/.pi/agent/pb/config.json), like extra:
    // a machine-wide cap that every project runs under until the project sets its own.
    if (raw.maxConcurrent === undefined) raw.maxConcurrent = readJson<Partial<Config>>(path.join(agentDir(), "pb", "config.json"))?.maxConcurrent;
    return sanitizeConfig(raw);
  }
  /** Your extra instructions for a role: the global ones, then this project's. Read-only: never creates files. */
  extra(role: Role): string {
    const global = readJson<Partial<Config>>(path.join(agentDir(), "pb", "config.json"))?.extra?.[role];
    const raw = readJson<Partial<Config>>(path.join(this.root, "config.json"));
    const mine = raw?.extra?.[role];
    return [global, mine].filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim()).join("\n");
  }
  /** Change settings in config.json, keeping everything else in it as written. */
  updateConfig(patch: (raw: Partial<Config>) => Partial<Config>): void {
    const file = path.join(this.root, "config.json");
    this.config(); // created with the defaults if missing
    writeFileAtomic(file, `${JSON.stringify(patch(readJson<Partial<Config>>(file) ?? {}), null, 2)}\n`);
  }

  /* --------------------------------- specs --------------------------------- */

  /**
   * A spec's directory, and the one place a spec name becomes a path (every spec file goes
   * through here). The name must be a valid spec name, or one already on disk: older specs
   * whose folder name today's rule rejects stay readable. Anything else — ".", "..", a path
   * separator — throws instead of reaching path.join.
   */
  specDir(name: string): string {
    if (!KEBAB_NAME.test(name) && !this.specNames().includes(name)) throw new Error(`"${name}" is not a valid spec name: use short kebab-case, e.g. order-cancellation`);
    return path.join(this.root, "specs", name);
  }
  specNames(): string[] {
    const dir = path.join(this.root, "specs");
    return fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort() : [];
  }
  readSpec(name: string): string | undefined {
    try {
      return fs.readFileSync(path.join(this.specDir(name), "spec.md"), "utf8");
    } catch {
      return undefined;
    }
  }
  writeSpec(name: string, markdown: string): void {
    writeFileAtomic(path.join(this.specDir(name), "spec.md"), markdown.endsWith("\n") ? markdown : `${markdown}\n`);
  }

  /** The text a build was approved against: the build may add Design and Decisions, never rewrite this. */
  readApprovedSpec(name: string): string | undefined {
    try {
      return fs.readFileSync(path.join(this.specDir(name), "approved.md"), "utf8");
    } catch {
      return undefined;
    }
  }
  writeApprovedSpec(name: string, markdown: string): void {
    writeFileAtomic(path.join(this.specDir(name), "approved.md"), markdown.endsWith("\n") ? markdown : `${markdown}\n`);
  }

  progress(name: string): Progress | undefined {
    // A read, not a write: an invalid name (e.g. prose a parser took verbatim) sees no progress,
    // it doesn't throw. Writes (saveProgress) keep specDir's refusal.
    let file: string;
    try {
      file = path.join(this.specDir(name), "progress.json");
    } catch {
      return undefined;
    }
    const p = readJson<Progress>(file);
    if (p && (p.phase as string) === "checking") p.phase = "paused"; // the gap check of earlier versions
    // The skeleton step is gone: a build caught mid-skeleton resumes at its first unfinished task.
    if (p && (p.tasks ?? []).some((t) => t.id === "skeleton")) {
      p.tasks = p.tasks.filter((t) => t.id !== "skeleton");
      if (p.current === "skeleton") p.current = p.tasks.find((t) => t.status === "doing" || t.status === "todo")?.id;
    }
    return p;
  }
  saveProgress(p: Progress): void {
    p.updatedAt = now();
    writeFileAtomic(path.join(this.specDir(p.spec), "progress.json"), `${JSON.stringify(p, null, 2)}\n`);
  }

  /**
   * Whether a dependency counts as finished: live first, then the archive. Archiving renames a
   * built spec out of .pi/pb/specs/, so store.progress alone would stop seeing it and every
   * dependent would warn "isn't built yet" after a correct archive. A live progress record wins:
   * rewriting a name after archiving starts that spec over, it doesn't inherit the archived phase.
   * Archived folders match on the progress record's own spec, not the stamped folder name.
   */
  finishedPhase(name: string): "built" | "reviewed" | undefined {
    const live = this.progress(name);
    if (live) return live.phase === "built" || live.phase === "reviewed" ? live.phase : undefined;
    if (!fs.existsSync(this.archiveRoot)) return undefined;
    let dirs: string[];
    try {
      dirs = fs.readdirSync(this.archiveRoot);
    } catch {
      return undefined;
    }
    for (const d of dirs) {
      const p = readJson<Progress>(path.join(this.archiveRoot, d, "progress.json"));
      if (p?.spec === name && (p.phase === "built" || p.phase === "reviewed")) return p.phase;
    }
    return undefined;
  }

  checkpoints(name: string): Checkpoint[] {
    let file: string;
    try {
      file = path.join(this.specDir(name), "checkpoints.json");
    } catch {
      return [];
    }
    return readJson<Checkpoint[]>(file) ?? [];
  }
  saveCheckpoints(name: string, list: Checkpoint[]): void {
    writeFileAtomic(path.join(this.specDir(name), "checkpoints.json"), `${JSON.stringify(list, null, 2)}\n`);
  }

  /** Append a stats event for a spec. */
  event(name: string, e: Record<string, unknown>): void {
    fs.mkdirSync(this.specDir(name), { recursive: true });
    fs.appendFileSync(path.join(this.specDir(name), "events.jsonl"), `${JSON.stringify({ at: now(), ...e })}\n`);
  }

  /** pb_explore calls, per session: counted in the stats of the specs that session writes or builds. */
  exploreEvent(e: { session?: string; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; ms: number }): void {
    fs.mkdirSync(this.root, { recursive: true });
    fs.appendFileSync(path.join(this.root, "explore.jsonl"), `${JSON.stringify({ at: now(), ...e })}\n`);
  }
  exploreEvents(): Record<string, unknown>[] {
    return readEvents(path.join(this.root, "explore.jsonl"));
  }

  /* ------------------------------- planning ------------------------------- */

  /**
   * Planning sessions (project files read-only, see the tool_call guard), with a snapshot of the tree when
   * planning began and the verbatim request that started it (so the checkpoint summary keeps what was
   * asked even after a long discussion).
   *
   * One file per session under planning/ (atomic single-file writes via writeFile, no read-modify-write),
   * so parallel planners can't clobber each other. The legacy planning.json map (array or object form) is
   * still read and is migrated to per-session files on the first write, never written.
   */
  private planningDir(): string {
    return path.join(this.root, "planning");
  }
  private planningFile(sessionFile: string): string {
    return path.join(this.planningDir(), `${createHash("sha1").update(sessionFile).digest("hex")}.json`);
  }
  /** Legacy planning.json entries (array or map form), frozen: migrated on first write, never written. */
  private legacyPlanningMap(): Record<string, { snapshot?: string; request?: string }> {
    const raw = readJson<string[] | Record<string, unknown>>(path.join(this.root, "planning.json"));
    if (Array.isArray(raw)) return Object.fromEntries(raw.filter((s) => typeof s === "string").map((s) => [s, {}]));
    if (!raw || typeof raw !== "object") return {};
    const out: Record<string, { snapshot?: string; request?: string }> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof k !== "string" || !k || typeof v !== "object" || v === null) continue;
      const rec = v as { snapshot?: unknown; request?: unknown };
      out[k] = {
        ...(typeof rec.snapshot === "string" ? { snapshot: rec.snapshot } : {}),
        ...(typeof rec.request === "string" ? { request: rec.request } : {}),
      };
    }
    return out;
  }
  /** One-time move of the legacy map to per-session files; afterwards the legacy file is gone. Idempotent, so concurrent migrators converge. */
  private migratePlanning(): void {
    const legacy = path.join(this.root, "planning.json");
    let exists = false;
    try {
      exists = fs.statSync(legacy).isFile();
    } catch {
      return;
    }
    if (!exists) return;
    for (const [sessionFile, rec] of Object.entries(this.legacyPlanningMap())) {
      writeFileAtomic(this.planningFile(sessionFile), `${JSON.stringify({ session: sessionFile, ...rec }, null, 2)}\n`);
    }
    fs.rmSync(legacy, { force: true });
  }
  private planningMap(): Record<string, PlanningRecord> {
    const out = this.legacyPlanningMap();
    let files: string[] = [];
    try {
      files = fs.readdirSync(this.planningDir());
    } catch {
      return out; // no per-session files yet
    }
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const rec = readJson<{ session?: unknown; snapshot?: unknown; request?: unknown; planner?: unknown }>(path.join(this.planningDir(), f));
      if (typeof rec?.session !== "string" || !rec.session) continue;
      const planner = plannerSettingsOf(rec.planner);
      out[rec.session] = {
        ...(typeof rec.snapshot === "string" ? { snapshot: rec.snapshot } : {}),
        ...(typeof rec.request === "string" ? { request: rec.request } : {}),
        ...(planner ? { planner } : {}),
      };
    }
    return out;
  }
  planningSessions(): string[] {
    return Object.keys(this.planningMap());
  }
  planning(sessionFile: string): PlanningRecord | undefined {
    return this.planningMap()[sessionFile];
  }
  setPlanning(sessionFile: string, on: boolean, snapshot?: string, request?: string): void {
    this.migratePlanning();
    const file = this.planningFile(sessionFile);
    if (!on) {
      fs.rmSync(file, { force: true });
      return;
    }
    const prev = readJson<{ snapshot?: unknown; request?: unknown; planner?: unknown }>(file) ?? {};
    const rec: Record<string, unknown> = { session: sessionFile };
    const planner = plannerSettingsOf(prev.planner);
    if (planner) rec.planner = planner;
    const snap = snapshot ?? (typeof prev.snapshot === "string" ? prev.snapshot : undefined);
    if (snap !== undefined) rec.snapshot = snap;
    const req = request ?? (typeof prev.request === "string" ? prev.request : undefined);
    if (req !== undefined) rec.request = req;
    writeFileAtomic(file, `${JSON.stringify(rec, null, 2)}\n`);
  }

  /** Record what planning changed in this session's model and thinking, so its end can put them back. */
  setPlannerSettings(sessionFile: string, planner: PlannerSettings): void {
    const file = this.planningFile(sessionFile);
    const prev = readJson<Record<string, unknown>>(file);
    if (!prev) return; // planning is off: nothing to restore later
    writeFileAtomic(file, `${JSON.stringify({ ...prev, planner }, null, 2)}\n`);
  }

  /**
   * Review sessions: the reviewer's real Pi session, read-only for the model. The file records which
   * session reviews which spec and what its pass reported (the adversarial pass is a background process).
   * One file per session under reviews/ (atomic single-file writes, no read-modify-write).
   * The legacy review-sessions.json map is still read and is migrated on the first write.
   */
  private reviewSessionsDir(): string {
    return path.join(this.root, "reviews");
  }
  private reviewSessionFile(sessionFile: string): string {
    return path.join(this.reviewSessionsDir(), `${createHash("sha1").update(sessionFile).digest("hex")}.json`);
  }
  /** Legacy review-sessions.json map, frozen: migrated on first write, never written. */
  private legacyReviewSessions(): Record<string, ReviewSessionState> {
    const all = readJson<Record<string, ReviewSessionState>>(path.join(this.root, "review-sessions.json"));
    if (!all || typeof all !== "object" || Array.isArray(all)) return {};
    return all;
  }
  /** One-time move of the legacy map to per-session files; afterwards the legacy file is gone. Idempotent. */
  private migrateReviewSessions(): void {
    const legacy = path.join(this.root, "review-sessions.json");
    try {
      if (!fs.statSync(legacy).isFile()) return;
    } catch {
      return;
    }
    for (const [sessionFile, state] of Object.entries(this.legacyReviewSessions())) {
      if (!state || (state.role !== "review" && state.role !== "abuse")) continue;
      writeFileAtomic(this.reviewSessionFile(sessionFile), `${JSON.stringify({ session: sessionFile, ...state }, null, 2)}\n`);
    }
    fs.rmSync(legacy, { force: true });
  }
  private validReviewState(rec: unknown): ReviewSessionState | undefined {
    const r = rec as { role?: unknown } & Record<string, unknown>;
    if (!r || (r.role !== "review" && r.role !== "abuse")) return undefined;
    const { session: _drop, ...state } = r;
    return state as ReviewSessionState;
  }
  reviewSession(sessionFile: string | undefined): ReviewSessionState | undefined {
    if (!sessionFile) return undefined;
    return this.validReviewState(readJson(path.join(this.reviewSessionFile(sessionFile)))) ?? this.validReviewState(this.legacyReviewSessions()[sessionFile]);
  }
  saveReviewSession(sessionFile: string, state: ReviewSessionState): void {
    this.migrateReviewSessions();
    writeFileAtomic(this.reviewSessionFile(sessionFile), `${JSON.stringify({ session: sessionFile, ...state }, null, 2)}\n`);
  }

  /**
   * Reviews in progress, one file per run (keyed by run id): two reviews in parallel must not
   * overwrite each other's resume state, and finishing one must not delete the other's.
   * The legacy single review-run.json is migrated on first access, then removed.
   */
  private reviewRunsDir(): string {
    return path.join(this.root, "review-runs");
  }
  private reviewRunFile(id: string): string {
    return path.join(this.reviewRunsDir(), `${createHash("sha1").update(id).digest("hex")}.json`);
  }
  private migrateReviewRuns(): void {
    const legacy = path.join(this.root, "review-run.json");
    try {
      if (!fs.statSync(legacy).isFile()) return;
    } catch {
      return;
    }
    const run = readJson<ReviewRun>(legacy);
    // A legacy run without an id can't be keyed: leave it for an older pb rather than drop it.
    if (!run?.id) return;
    writeFileAtomic(this.reviewRunFile(run.id), `${JSON.stringify(run, null, 2)}\n`);
    fs.rmSync(legacy, { force: true });
  }
  reviewRun(id: string | undefined): ReviewRun | undefined {
    if (!id) return undefined;
    this.migrateReviewRuns();
    const run = readJson<ReviewRun>(this.reviewRunFile(id));
    return run?.id === id ? run : undefined;
  }
  /** Every kept run, newest file first. */
  private reviewRuns(): ReviewRun[] {
    this.migrateReviewRuns();
    let files: string[];
    try {
      files = fs.readdirSync(this.reviewRunsDir()).filter((f) => f.endsWith(".json"));
    } catch {
      return [];
    }
    const runs: Array<{ run: ReviewRun; at: number }> = [];
    for (const f of files) {
      const full = path.join(this.reviewRunsDir(), f);
      const run = readJson<ReviewRun>(full);
      if (!run?.id) continue;
      try {
        runs.push({ run, at: fs.statSync(full).mtimeMs });
      } catch {
        // removed between readdir and stat: gone, nothing to offer
      }
    }
    return runs.sort((a, b) => b.at - a.at).map((x) => x.run);
  }
  /** The newest interrupted review started from this session (what /pb:review offers to continue). */
  interruptedReview(home: string | undefined): ReviewRun | undefined {
    if (!home) return undefined;
    return this.reviewRuns().find((r) => r.home === home && r.interrupted);
  }
  /** The run whose review session is this one: a pass being driven, or the pass it was interrupted in. */
  reviewRunForSession(session: string | undefined): ReviewRun | undefined {
    if (!session) return undefined;
    const own = this.reviewSession(session)?.run;
    const run = this.reviewRun(own);
    if (run) return run;
    return this.reviewRuns().find((r) => r.interrupted?.session === session || r.passes.some((p) => p.session === session));
  }
  saveReviewRun(run: ReviewRun): void {
    if (!run.id) throw new Error("a review run needs an id");
    this.migrateReviewRuns();
    writeFileAtomic(this.reviewRunFile(run.id), `${JSON.stringify(run, null, 2)}\n`);
  }
  clearReviewRun(id: string | undefined): void {
    if (!id) return;
    this.migrateReviewRuns();
    fs.rmSync(this.reviewRunFile(id), { force: true });
  }
  /** Starting a review from `home` supersedes older runs from it, including crashes that left no interrupted marker. */
  clearReviewRunsForHome(home: string | undefined): void {
    if (!home) return;
    for (const run of this.reviewRuns()) {
      if (run.home === home) this.clearReviewRun(run.id);
    }
  }

  /** The last review's result, kept with the spec (or in .pi/pb/ without one) so it's never lost. */
  reviewFile(name: string | undefined): string {
    return name ? path.join(this.specDir(name), "review.md") : path.join(this.root, "review.md");
  }

  /** Where the fresh calls (reviewer, abuse pass, verifier, explorer, cartographer) save their sessions. */
  sessionsDir(role: string): string {
    const dir = path.join(this.root, "sessions", role);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Where a spec's review passes save their sessions: with the spec, removed when it's archived. */
  specSessionsDir(name: string, role: string): string {
    const dir = path.join(this.specDir(name), "sessions", role);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** At /pb:archive: the archived spec's review runs, and the explorer and map runs so far. */
  dropSessions(name: string): void {
    fs.rmSync(path.join(this.specDir(name), "sessions"), { recursive: true, force: true });
    fs.rmSync(path.join(this.root, "sessions"), { recursive: true, force: true });
    // GC per-session review files for this spec.
    try {
      for (const f of fs.readdirSync(path.join(this.root, "reviews"))) {
        if (!f.endsWith(".json")) continue;
        const full = path.join(this.root, "reviews", f);
        const rec = readJson<{ session?: unknown; spec?: unknown }>(full);
        if (rec && typeof rec.session === "string" && rec.spec === name) fs.rmSync(full, { force: true });
      }
    } catch {
      // no per-session review files yet
    }
    // GC review runs for this spec (a dead run must not be offered to continue later).
    try {
      for (const f of fs.readdirSync(this.reviewRunsDir())) {
        if (!f.endsWith(".json")) continue;
        const full = path.join(this.reviewRunsDir(), f);
        if (readJson<ReviewRun>(full)?.name === name) fs.rmSync(full, { force: true });
      }
    } catch {
      // no review runs yet
    }
    // GC review-sessions.json entries for this spec; the file otherwise grows without bound.
    const file = path.join(this.root, "review-sessions.json");
    const all = readJson<Record<string, ReviewSessionState>>(file);
    if (all) {
      let changed = false;
      for (const [k, v] of Object.entries(all)) {
        if (v?.spec === name) {
          delete all[k];
          changed = true;
        }
      }
      if (changed) writeFileAtomic(file, `${JSON.stringify(all, null, 2)}\n`);
    }
  }

  /** The project map before its last update, for /pb:map undo. */
  mapPrevious(): string | undefined {
    try {
      return fs.readFileSync(path.join(this.root, "map-previous.md"), "utf8");
    } catch {
      return undefined;
    }
  }
  saveMapPrevious(body: string): void {
    writeFileAtomic(path.join(this.root, "map-previous.md"), body);
  }

  /** The test suite's result when planning began. Per session when known, global last otherwise. */
  baseline(sessionFile?: string): Baseline | undefined {
    if (sessionFile) {
      const per = readJson<Baseline>(this.sessionBaselineFile(sessionFile));
      if (per) return per;
    }
    return readJson<Baseline>(path.join(this.root, "baseline.json"));
  }
  saveBaseline(b: Baseline, sessionFile?: string): void {
    writeFileAtomic(path.join(this.root, "baseline.json"), `${JSON.stringify(b, null, 2)}\n`);
    if (sessionFile) writeFileAtomic(this.sessionBaselineFile(sessionFile), `${JSON.stringify(b, null, 2)}\n`);
  }
  private sessionBaselineFile(sessionFile: string): string {
    const safe = Buffer.from(sessionFile).toString("base64url");
    return path.join(this.root, "baselines", `${safe}.json`);
  }

  /**
   * Hand-over to the next build session: the planning session's model and thinking level,
   * applied by pb's fresh instance at session_start (the old pi is stale by then).
   * Scoped by parent session so an unrelated new session can't steal it; 60min TTL for slow approvals.
   */
  setCarry(c: { model?: string; thinking?: string; spec: string; review?: ReviewSessionState; parent?: string }): void {
    writeFileAtomic(path.join(this.root, "carry.json"), `${JSON.stringify({ ...c, at: Date.now() })}\n`);
  }
  takeCarry(previousSessionFile?: string): { model?: string; thinking?: string; spec: string; review?: ReviewSessionState; parent?: string } | undefined {
    const file = path.join(this.root, "carry.json");
    const c = readJson<{ model?: string; thinking?: string; spec: string; review?: ReviewSessionState; parent?: string; at: number }>(file);
    if (!c) return undefined;
    if (typeof c.at !== "number" || Date.now() - c.at >= 60 * 60_000) {
      fs.rmSync(file, { force: true });
      return undefined;
    }
    // An unrelated new session must not consume another session's handover; leave it for its target.
    // previousSessionFile is provided by Pi for new/resume/fork; without it (tests, older Pi) fall back to consuming.
    if (c.parent && previousSessionFile && c.parent !== previousSessionFile) return undefined;
    fs.rmSync(file, { force: true });
    return c;
  }

  /** Drop a handover (e.g. its session was cancelled): no later session must inherit it. */
  clearCarry(): void {
    fs.rmSync(path.join(this.root, "carry.json"), { force: true });
  }

  /** One-time questions already asked in this project (e.g. adding the standards to AGENTS.md). Append-only: concurrent writers add lines, never rewrite, so nothing is lost. */
  private askedKeys(): string[] {
    let text: string;
    try {
      text = fs.readFileSync(path.join(this.root, "asked.json"), "utf8");
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const v: unknown = JSON.parse(t);
        if (typeof v === "string") {
          if (!out.includes(v)) out.push(v);
        } else if (Array.isArray(v)) {
          // Legacy whole-file form: ["a", "b"]. Still read; new marks append lines.
          for (const k of v) if (typeof k === "string" && !out.includes(k)) out.push(k);
        }
      } catch {
        // A torn line from a concurrent append: ignored, the key is asked again.
      }
    }
    return out;
  }
  asked(key: string): boolean {
    return this.askedKeys().includes(key);
  }
  markAsked(key: string): void {
    if (this.askedKeys().includes(key)) return;
    fs.mkdirSync(this.root, { recursive: true });
    fs.appendFileSync(path.join(this.root, "asked.json"), `${JSON.stringify(key)}\n`, "utf8");
  }

  /**
   * Open fixes sessions (/pb:fix): which spec and findings each was opened for. One file per
   * session (the extension object itself is per-session, so only the store crosses the boundary).
   */
  private fixSessionFile(sessionFile: string): string {
    return path.join(this.root, "fixes", `${createHash("sha1").update(sessionFile).digest("hex")}.json`);
  }
  saveFixSession(sessionFile: string, rec: { spec: string; findings: Finding[] }): void {
    writeFileAtomic(this.fixSessionFile(sessionFile), `${JSON.stringify({ session: sessionFile, ...rec }, null, 2)}\n`);
  }
  fixSession(sessionFile: string | undefined): { spec: string; findings: Finding[] } | undefined {
    if (!sessionFile) return undefined;
    const rec = readJson<{ session?: unknown; spec?: unknown; findings?: unknown }>(this.fixSessionFile(sessionFile));
    if (typeof rec?.session !== "string" || typeof rec?.spec !== "string" || !Array.isArray(rec?.findings)) return undefined;
    return { spec: rec.spec, findings: rec.findings as Finding[] };
  }
  clearFixSession(sessionFile: string): void {
    fs.rmSync(this.fixSessionFile(sessionFile), { force: true });
  }

  /**
   * The spec being built in this session: the unfinished one (most recent when several claim it),
   * else the most recent that a new plan hasn't detached (one session can build several in turn).
   * Session paths are compared by realpath: /tmp vs /private/tmp must not orphan a paused build.
   */
  specForSession(sessionFile: string | undefined): string | undefined {
    if (!sessionFile) return undefined;
    const mine = this.specNames()
      .map((n) => ({ n, p: this.progress(n) }))
      .filter((x) => typeof x.p?.session === "string" && samePath(x.p.session as string, sessionFile));
    const active = mine
      .filter((x) => ["building", "paused"].includes(x.p!.phase))
      .sort((a, b) => (b.p!.updatedAt ?? "").localeCompare(a.p!.updatedAt ?? ""))[0];
    if (active) return active.n;
    return mine.filter((x) => !x.p!.detached).sort((a, b) => (b.p!.updatedAt ?? "").localeCompare(a.p!.updatedAt ?? ""))[0]?.n;
  }

  /** The spec whose open repair lap this session owns, newest first: usually one. */
  fixesOfSession(sessionFile: string | undefined): { name: string; p: Progress }[] {
    if (!sessionFile) return [];
    return this.specNames()
      .map((n) => ({ name: n, p: this.progress(n) }))
      .filter((x): x is { name: string; p: Progress } => typeof x.p?.fix?.session === "string" && samePath(x.p.fix.session, sessionFile))
      .sort((a, b) => (b.p.updatedAt ?? "").localeCompare(a.p.updatedAt ?? ""));
  }

  /** The spec whose open repair lap this session owns: the lap record, not the conversation. */
  fixOfSession(sessionFile: string | undefined): { name: string; p: Progress } | undefined {
    return this.fixesOfSession(sessionFile)[0];
  }

  /**
   * The spec this session wrote, newest first. A repair lap writes the spec it is fixing, so a session
   * that owns no build (or open lap) can still be the one whose `/pb:undo` takes a lap back.
   */
  writtenSpec(sessionFile: string | undefined): { name: string; p: Progress } | undefined {
    if (!sessionFile) return undefined;
    return this.specNames()
      .map((n) => ({ name: n, p: this.progress(n) }))
      .filter((x): x is { name: string; p: Progress } => typeof x.p?.writtenIn === "string" && samePath(x.p.writtenIn, sessionFile) && !x.p.detached)
      .sort((a, b) => (b.p.updatedAt ?? "").localeCompare(a.p.updatedAt ?? ""))[0];
  }

  /** Specs this session wrote that aren't built yet: what a planning session is working on. */
  specsOfPlanning(sessionFile: string): string[] {
    return this.specNames().filter((n) => {
      const p = this.progress(n);
      return p?.writtenIn === sessionFile && p.phase === "written";
    });
  }

  /** A new plan in this session: the specs it finished building stop claiming its turns. */
  detachSession(sessionFile: string): void {
    for (const n of this.specNames()) {
      const p = this.progress(n);
      if (p?.session === sessionFile && !p.detached && !["building", "paused"].includes(p.phase)) {
        p.detached = true;
        this.saveProgress(p);
      }
    }
  }

  /** A /pb:build that first asked for the spec: build it once it is written (in this session). Per-session, so parallel planners don't clobber each other. */
  private pendingBuildsDir(): string {
    return path.join(this.root, "pending-build");
  }
  private pendingBuildFile(sessionFile: string): string {
    return path.join(this.pendingBuildsDir(), `${createHash("sha1").update(sessionFile).digest("hex")}.json`);
  }
  /** Legacy pending-build.json entries (map or single-global form), frozen: migrated on first write, never written. */
  private legacyPendingBuilds(): Record<string, { at: number }> {
    const raw = readJson<Record<string, { at: number }> | { session: string; at: number }>(path.join(this.root, "pending-build.json"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    if (typeof (raw as { session?: unknown }).session === "string") {
      const single = raw as unknown as { session: string; at: number };
      return typeof single.at === "number" ? { [single.session]: { at: single.at } } : {};
    }
    const out: Record<string, { at: number }> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (v && typeof v.at === "number") out[k] = { at: v.at };
    }
    return out;
  }
  /** One-time move of the legacy map to per-session files; afterwards the legacy file is gone. Idempotent. */
  private migratePendingBuilds(): void {
    const legacy = path.join(this.root, "pending-build.json");
    try {
      if (!fs.statSync(legacy).isFile()) return;
    } catch {
      return;
    }
    for (const [sessionFile, rec] of Object.entries(this.legacyPendingBuilds())) {
      writeFileAtomic(this.pendingBuildFile(sessionFile), `${JSON.stringify({ session: sessionFile, at: rec.at }, null, 2)}\n`);
    }
    fs.rmSync(legacy, { force: true });
  }
  private pendingBuildTTL = 60 * 60_000;
  setPendingBuild(sessionFile: string | undefined): void {
    this.migratePendingBuilds();
    if (!sessionFile) {
      fs.rmSync(this.pendingBuildsDir(), { recursive: true, force: true });
      return;
    }
    writeFileAtomic(this.pendingBuildFile(sessionFile), `${JSON.stringify({ session: sessionFile, at: Date.now() }, null, 2)}\n`);
  }
  pendingBuild(sessionFile: string | undefined): boolean {
    if (!sessionFile) return false;
    const rec =
      readJson<{ session?: unknown; at?: unknown }>(this.pendingBuildFile(sessionFile)) ??
      this.legacyPendingBuilds()[sessionFile];
    if (!rec || typeof rec.at !== "number") return false;
    if (Date.now() - rec.at >= this.pendingBuildTTL) {
      fs.rmSync(this.pendingBuildFile(sessionFile), { force: true });
      return false;
    }
    return true;
  }
  clearPendingBuild(sessionFile: string): void {
    this.migratePendingBuilds();
    fs.rmSync(this.pendingBuildFile(sessionFile), { force: true });
  }

  /** Move a finished spec out of .pi/pb/ so later sessions only see live specs. Unique dest; throws clearly when missing. */
  archive(name: string): string {
    const src = this.specDir(name);
    if (!fs.existsSync(src)) throw new Error(`No spec "${name}" to archive.`);
    fs.mkdirSync(this.archiveRoot, { recursive: true });
    const ignore = path.join(this.archiveRoot, ".gitignore");
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "*\n");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    let dest = path.join(this.archiveRoot, `${stamp}-${name}`);
    for (let i = 2; fs.existsSync(dest); i++) dest = path.join(this.archiveRoot, `${stamp}-${name}-${i}`);
    fs.renameSync(src, dest);
    return dest;
  }
}

/* ------------------------------ git helpers ------------------------------ */

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return undefined;
  }
}

export const gitHead = (cwd: string) => git(cwd, ["rev-parse", "HEAD"])?.trim() || undefined;

/** Whether cwd is inside a git working tree (a missing repo is worth saying, not silently diffing nothing). */
export const gitRepo = (cwd: string) => git(cwd, ["rev-parse", "--is-inside-work-tree"])?.trim() === "true";

/** Whether a revision resolves here: a recorded base that no longer does must be said, not diffed as nothing. */
export const resolvesRevision = (cwd: string, rev: string) => git(cwd, ["rev-parse", "--verify", "-q", `${rev}^{commit}`]) !== undefined;

/** Files changed since a commit (tracked + untracked), pb state excluded (all of .pi, including the archive). */
export function changedSince(cwd: string, base?: string): string[] {
  const tracked = git(cwd, ["diff", "--name-only", base ?? "HEAD", "--", ".", ":(exclude).pi"]) ?? "";
  const untracked = git(cwd, ["ls-files", "--others", "--exclude-standard", "--", ".", ":(exclude).pi"]) ?? "";
  return [...new Set(`${tracked}\n${untracked}`.split("\n").filter(Boolean))];
}

/** The change's diff against a commit (pb state excluded), capped: for spotting sensitive ground. */
export const gitDiff = (cwd: string, base?: string) => (git(cwd, ["diff", "--no-color", "-U0", base ?? "HEAD", "--", ".", ":(exclude).pi"]) ?? "").slice(0, 2_000_000);

/** New, untracked files as added diff lines (capped without reading huge files), so a brand-new file counts too. */
export function untrackedText(cwd: string, files: string[]): string {
  const untracked = new Set((git(cwd, ["ls-files", "--others", "--exclude-standard", "--", ".", ":(exclude).pi"]) ?? "").split("\n").filter(Boolean));
  let out = "";
  for (const f of files.filter((x) => untracked.has(x))) {
    try {
      const full = path.join(cwd, f);
      const size = fs.statSync(full).size;
      if (size > 500_000) continue; // huge dumps rely on the file list, not content, for sensitiveGround
      const buf = fs.readFileSync(full);
      if (buf.includes(0)) continue; // binary
      out += `\n${buf.toString("utf8").slice(0, 200_000).split("\n").map((l) => `+${l}`).join("\n")}`;
    } catch {
      // unreadable: skip
    }
    if (out.length > 500_000) break;
  }
  return out;
}

export const diffStat = (cwd: string, base?: string) => git(cwd, ["diff", "--stat", base ?? "HEAD", "--", ".", ":(exclude).pi"])?.trim() ?? "";
