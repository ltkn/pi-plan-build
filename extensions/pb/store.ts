/**
 * On-disk state: .pi/pb/config.json, one folder per spec under .pi/pb/specs/<name>/
 * (spec.md, progress.json, checkpoints.json, events.jsonl), and finished specs
 * under .pi/pb-archive/, which ignores itself in git.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { agentDir } from "./standards.ts";

export const PREFIX = "pb";
export const PB_DIR = path.join(".pi", "pb");
export const ARCHIVE_DIR = path.join(".pi", "pb-archive");

export type Gate = "tests" | "build" | "none";

export interface Config {
  /** Test command: "auto" detects mvn/gradle/npm/cargo/go/pytest; null disables. */
  verify: string | null;
  /** Compile/typecheck command: the check for a task without its own Test: line, and the "build" gate. "auto" detects; null disables. */
  build: string | null;
  verifyTimeoutSec: number;
  /** Fix attempts per task (or for the final check) before the build pauses for you. */
  maxAttempts: number;
  /** "end": one check after the last task; "each": every task's own check (its Test: line, else a compile), then the final one. */
  taskChecks: "end" | "each";
  /** How long a pb_ask dialog in a build waits before the build goes on with the recommendation (seconds; 0 = forever). */
  askTimeoutSec: number;
  /** Chars of test output shown to the agent and the reviewer. */
  testOutputCap: number;
  /** Shadow snapshots per task: real diffs, changed-test checks, /pb:undo. */
  checkpoints: boolean;
  /**
   * The fresh reviewer: model and thinking level (unset = your session's), whether a second call double-checks
   * P0/P1 findings, and when an abuse pass tries to break the change ("always"; "auto": on ground that looks
   * sensitive; "off").
   */
  reviewer: { model?: string; thinking?: string; verify?: boolean; security?: "auto" | "always" | "off"; idleSec?: number };
  /** Above this share of the context window (%), /pb:build offers a fresh session instead of this one. */
  freshAbove: number;
  /** /pb:plan runs the test suite in the background, so planning knows whether it passes today. */
  baseline: boolean;
  /** Model and thinking level of pb_explore and the project map; unset model = your session's, unset thinking = max (Pi clamps it to the model). */
  explorer: { model?: string; thinking?: string };
  /** Build on this model ("provider/id") instead of the planning session's; unset = the same model. */
  buildModel?: string;
  /**
   * Past this share of the context window (%), and always early enough to stay clear of Pi's own compaction:
   * a planning session writes the plan to its spec and is reset to it; a build session is reset to the
   * build's state at the next task boundary. 0 = never (Pi compacts; pb still writes the summary).
   */
  checkpointAt: number;
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
export const ROLES = ["plan", "spec", "build", "review", "adversarial", "map"] as const;
export type Role = (typeof ROLES)[number];

export const DEFAULT_CONFIG: Config = {
  verify: "auto",
  build: "auto",
  verifyTimeoutSec: 900,
  maxAttempts: 3,
  taskChecks: "end",
  askTimeoutSec: 300,
  testOutputCap: 4000,
  checkpoints: true,
  reviewer: { verify: true, security: "always" },
  freshAbove: 50,
  baseline: true,
  explorer: {},
  checkpointAt: 75,
  mapOnArchive: true,
  notify: true,
};

/** Config with wrong types falls back to defaults field by field, so one typo can't break the build. */
function sanitizeConfig(raw: Partial<Config>): Config {
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : d);
  const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
  const strOrNull = (v: unknown, d: string | null) => (v === null || v === undefined ? d : typeof v === "string" ? v : d);
  const reviewerRaw = typeof raw.reviewer === "object" && raw.reviewer !== null ? raw.reviewer : {};
  const explorerRaw = typeof raw.explorer === "object" && raw.explorer !== null ? raw.explorer : {};
  const security = (reviewerRaw as { security?: unknown }).security;
  return {
    verify: strOrNull((raw as { verify?: unknown }).verify, DEFAULT_CONFIG.verify),
    build: strOrNull((raw as { build?: unknown }).build, DEFAULT_CONFIG.build),
    verifyTimeoutSec: num((raw as { verifyTimeoutSec?: unknown }).verifyTimeoutSec, DEFAULT_CONFIG.verifyTimeoutSec),
    maxAttempts: Math.max(1, Math.floor(num((raw as { maxAttempts?: unknown }).maxAttempts, DEFAULT_CONFIG.maxAttempts))),
    taskChecks: (raw as { taskChecks?: unknown }).taskChecks === "each" ? "each" : "end",
    askTimeoutSec: num((raw as { askTimeoutSec?: unknown }).askTimeoutSec, DEFAULT_CONFIG.askTimeoutSec),
    testOutputCap: num((raw as { testOutputCap?: unknown }).testOutputCap, DEFAULT_CONFIG.testOutputCap),
    checkpoints: bool((raw as { checkpoints?: unknown }).checkpoints, true),
    reviewer: {
      model: typeof (reviewerRaw as { model?: unknown }).model === "string" ? (reviewerRaw as { model: string }).model : undefined,
      thinking: typeof (reviewerRaw as { thinking?: unknown }).thinking === "string" ? (reviewerRaw as { thinking: string }).thinking : undefined,
      verify: bool((reviewerRaw as { verify?: unknown }).verify, true),
      security: security === "auto" || security === "always" || security === "off" ? security : "always",
      idleSec: typeof (reviewerRaw as { idleSec?: unknown }).idleSec === "number" ? (reviewerRaw as { idleSec: number }).idleSec : undefined,
    },
    freshAbove: num((raw as { freshAbove?: unknown }).freshAbove, DEFAULT_CONFIG.freshAbove),
    baseline: bool((raw as { baseline?: unknown }).baseline, true),
    explorer: {
      model: typeof (explorerRaw as { model?: unknown }).model === "string" ? (explorerRaw as { model: string }).model : undefined,
      thinking: typeof (explorerRaw as { thinking?: unknown }).thinking === "string" ? (explorerRaw as { thinking: string }).thinking : undefined,
    },
    buildModel: typeof (raw as { buildModel?: unknown }).buildModel === "string" ? (raw as { buildModel: string }).buildModel : undefined,
    checkpointAt: num((raw as { checkpointAt?: unknown }).checkpointAt, DEFAULT_CONFIG.checkpointAt),
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
  /** what the agent reported when it finished the task */
  summary?: string;
  /** the task's new tests, seen failing before the change (pb_tests_red): its first line */
  red?: string;
  /** the Test: command that was seen failing for red, so a rewritten command re-requires proof */
  redCommand?: string;
  /** tasks needing red that run the very same Test: command: one run doesn't prove each task's own tests */
  redShared?: string;
  /** pre-green: the command already passed, proven by the done earlier task named here — red was impossible */
  preGreen?: string;
}

export type Phase = "written" | "building" | "paused" | "built" | "reviewed";

export type Priority = "P0" | "P1" | "P2" | "P3";

export interface Finding {
  priority: Priority;
  file?: string;
  line?: number;
  title: string;
  fix?: string;
}

export interface ReviewState {
  at: string;
  /** snapshot of the tree the review saw: the next review looks only at what changed since */
  snapshot?: string;
  verdict: string;
  /** confirmed findings, to check again next time */
  findings: Finding[];
}

export interface Progress {
  spec: string;
  phase: Phase;
  /** the session the build runs in, once /pb:build started it */
  session?: string;
  /** the session whose conversation wrote the spec (a build there needs no copy of it) */
  writtenIn?: string;
  /** you edited the spec since the session wrote it: that session's copy is stale */
  edited?: boolean;
  /** the session that wrote it was compacted since, without the spec in the summary: its copy is gone */
  compacted?: boolean;
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
  pause?: string;
  /** the conversation was rewound to before the build's first message: a resume sends it again */
  needsIntro?: boolean;
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
  summary?: string;
  /** session entry to rewind the conversation to; set at the end of the turn when the task started mid-run */
  entry?: string;
  pendingEntry?: boolean;
  /** the task was handed out right before a reset: its rewind point becomes that reset, at the next turn */
  pendingReset?: boolean;
  /** the build's first message comes after `entry`: rewinding here drops it */
  intro?: boolean;
}

export interface Baseline extends VerifyResult {
  head?: string;
}

export interface ReviewSessionState {
  role: "review" | "abuse";
  /** the spec under review, if any */
  spec?: string;
  /** what the pass reported with pb_report_findings */
  findings?: Finding[];
  /** /pb:review done: finish now */
  done?: boolean;
}

/** A review in progress, kept on disk so it can be continued after an interruption. */
export interface ReviewRun {
  cwd: string;
  name?: string;
  label: string;
  brief: string;
  base?: string;
  /** why an abuse pass runs, if it does */
  security?: string;
  followUp: boolean;
  /** the session to come back to */
  home?: string;
  /** the tree the review saw: anything changed during it is put back to this */
  before?: { commit: string; tree: string };
  model?: string;
  thinking?: string;
  passes: { role: "review" | "abuse"; findings: Finding[]; prose: string; session: string; left: boolean; unparsed: boolean }[];
  /** you chose to skip the abuse pass when the review was done */
  abuseSkipped?: boolean;
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

function writeFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, file);
}

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
    if (!fs.existsSync(file)) writeFile(file, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
    return sanitizeConfig(readJson<Partial<Config>>(file) ?? {});
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
    writeFile(file, `${JSON.stringify(patch(readJson<Partial<Config>>(file) ?? {}), null, 2)}\n`);
  }

  /* --------------------------------- specs --------------------------------- */

  specDir(name: string): string {
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
    writeFile(path.join(this.specDir(name), "spec.md"), markdown.endsWith("\n") ? markdown : `${markdown}\n`);
  }

  progress(name: string): Progress | undefined {
    const p = readJson<Progress>(path.join(this.specDir(name), "progress.json"));
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
    writeFile(path.join(this.specDir(p.spec), "progress.json"), `${JSON.stringify(p, null, 2)}\n`);
  }

  checkpoints(name: string): Checkpoint[] {
    return readJson<Checkpoint[]>(path.join(this.specDir(name), "checkpoints.json")) ?? [];
  }
  saveCheckpoints(name: string, list: Checkpoint[]): void {
    writeFile(path.join(this.specDir(name), "checkpoints.json"), `${JSON.stringify(list, null, 2)}\n`);
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
   * planning began and the entry the last checkpoint reset from (what /pb:compact undo goes back to).
   */
  private planningMap(): Record<string, { snapshot?: string; checkpointFrom?: string }> {
    const raw = readJson<string[] | Record<string, unknown>>(path.join(this.root, "planning.json"));
    if (Array.isArray(raw)) return Object.fromEntries(raw.filter((s) => typeof s === "string").map((s) => [s, {}]));
    if (!raw || typeof raw !== "object") return {};
    const out: Record<string, { snapshot?: string; checkpointFrom?: string }> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof k !== "string" || !k || typeof v !== "object" || v === null) continue;
      const rec = v as { snapshot?: unknown; checkpointFrom?: unknown };
      out[k] = {
        ...(typeof rec.snapshot === "string" ? { snapshot: rec.snapshot } : {}),
        ...(typeof rec.checkpointFrom === "string" ? { checkpointFrom: rec.checkpointFrom } : {}),
      };
    }
    return out;
  }
  planningSessions(): string[] {
    return Object.keys(this.planningMap());
  }
  planning(sessionFile: string): { snapshot?: string; checkpointFrom?: string } | undefined {
    return this.planningMap()[sessionFile];
  }
  setPlanning(sessionFile: string, on: boolean, snapshot?: string): void {
    const map = this.planningMap();
    if (on) map[sessionFile] = { ...map[sessionFile], snapshot: snapshot ?? map[sessionFile]?.snapshot };
    else delete map[sessionFile];
    writeFile(path.join(this.root, "planning.json"), `${JSON.stringify(map, null, 2)}\n`);
  }
  setCheckpointFrom(sessionFile: string, entry: string | undefined): void {
    const map = this.planningMap();
    if (!map[sessionFile]) return;
    map[sessionFile] = { ...map[sessionFile], checkpointFrom: entry };
    writeFile(path.join(this.root, "planning.json"), `${JSON.stringify(map, null, 2)}\n`);
  }

  /**
   * Review sessions: a real Pi session per pass (reviewer, abuse pass), read-only for the model. The file
   * records which session plays which role for which spec, and what its pass reported.
   */
  reviewSession(sessionFile: string | undefined): ReviewSessionState | undefined {
    if (!sessionFile) return undefined;
    const rec = readJson<Record<string, ReviewSessionState>>(path.join(this.root, "review-sessions.json"))?.[sessionFile];
    if (!rec || (rec.role !== "review" && rec.role !== "abuse")) return undefined;
    return rec;
  }
  saveReviewSession(sessionFile: string, state: ReviewSessionState): void {
    const file = path.join(this.root, "review-sessions.json");
    const all = readJson<Record<string, ReviewSessionState>>(file) ?? {};
    all[sessionFile] = state;
    writeFile(file, `${JSON.stringify(all, null, 2)}\n`);
  }

  reviewRun(): ReviewRun | undefined {
    return readJson<ReviewRun>(path.join(this.root, "review-run.json"));
  }
  saveReviewRun(run: ReviewRun | undefined): void {
    const file = path.join(this.root, "review-run.json");
    if (run) writeFile(file, `${JSON.stringify(run, null, 2)}\n`);
    else fs.rmSync(file, { force: true });
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
      if (changed) writeFile(file, `${JSON.stringify(all, null, 2)}\n`);
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
    writeFile(path.join(this.root, "map-previous.md"), body);
  }

  /** The test suite's result when planning began. */
  baseline(): Baseline | undefined {
    return readJson<Baseline>(path.join(this.root, "baseline.json"));
  }
  saveBaseline(b: Baseline): void {
    writeFile(path.join(this.root, "baseline.json"), `${JSON.stringify(b, null, 2)}\n`);
  }

  /**
   * Hand-over to the next build session: the planning session's model and thinking level,
   * applied by pb's fresh instance at session_start (the old pi is stale by then).
   * Scoped by parent session so an unrelated new session can't steal it; 60min TTL for slow approvals.
   */
  setCarry(c: { model?: string; thinking?: string; spec: string; review?: ReviewSessionState; parent?: string }): void {
    writeFile(path.join(this.root, "carry.json"), `${JSON.stringify({ ...c, at: Date.now() })}\n`);
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

  /** One-time questions already asked in this project (e.g. adding the standards to AGENTS.md). */
  asked(key: string): boolean {
    return (readJson<string[]>(path.join(this.root, "asked.json")) ?? []).includes(key);
  }
  markAsked(key: string): void {
    const list = new Set(readJson<string[]>(path.join(this.root, "asked.json")) ?? []);
    list.add(key);
    writeFile(path.join(this.root, "asked.json"), `${JSON.stringify([...list])}\n`);
  }

  /**
   * The spec being built in this session: the unfinished one (most recent when several claim it),
   * else the most recent that a new plan hasn't detached (one session can build several in turn).
   * Session paths are compared by realpath: /tmp vs /private/tmp must not orphan a paused build.
   */
  specForSession(sessionFile: string | undefined): string | undefined {
    if (!sessionFile) return undefined;
    const same = (a: string, b: string) => {
      if (a === b) return true;
      try {
        return fs.realpathSync(a) === fs.realpathSync(b);
      } catch {
        return false;
      }
    };
    const mine = this.specNames()
      .map((n) => ({ n, p: this.progress(n) }))
      .filter((x) => typeof x.p?.session === "string" && same(x.p.session as string, sessionFile));
    const active = mine
      .filter((x) => ["building", "paused"].includes(x.p!.phase))
      .sort((a, b) => (b.p!.updatedAt ?? "").localeCompare(a.p!.updatedAt ?? ""))[0];
    if (active) return active.n;
    return mine.filter((x) => !x.p!.detached).sort((a, b) => (b.p!.updatedAt ?? "").localeCompare(a.p!.updatedAt ?? ""))[0]?.n;
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
  setPendingBuild(sessionFile: string | undefined): void {
    const file = path.join(this.root, "pending-build.json");
    if (!sessionFile) {
      fs.rmSync(file, { force: true });
      return;
    }
    const all = readJson<Record<string, { at: number }>>(file) ?? {};
    // Migrate single-global format: {session, at} → {sessionFile: {at}}.
    const migrated: Record<string, { at: number }> = Array.isArray(all)
      ? {}
      : typeof (all as { session?: unknown }).session === "string"
        ? { [(all as unknown as { session: string }).session]: { at: (all as unknown as { at: number }).at ?? Date.now() } }
        : (all as Record<string, { at: number }>);
    migrated[sessionFile] = { at: Date.now() };
    writeFile(file, `${JSON.stringify(migrated, null, 2)}\n`);
  }
  pendingBuild(sessionFile: string | undefined): boolean {
    const raw = readJson<Record<string, { at: number }> | { session: string; at: number }>(path.join(this.root, "pending-build.json"));
    if (!raw || !sessionFile) return false;
    const rec = (raw as Record<string, { at: number }>)[sessionFile] ?? ((raw as { session?: string }).session === sessionFile ? (raw as { at: number }) : undefined);
    return !!rec && typeof rec.at === "number" && Date.now() - rec.at < 60 * 60_000;
  }
  clearPendingBuild(sessionFile: string): void {
    const file = path.join(this.root, "pending-build.json");
    const raw = readJson<Record<string, { at: number }>>(file);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    if (raw[sessionFile]) {
      delete raw[sessionFile];
      writeFile(file, `${JSON.stringify(raw, null, 2)}\n`);
    }
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
    for (let i = 2; fs.existsSync(dest) && i < 100; i++) dest = path.join(this.archiveRoot, `${stamp}-${name}-${i}`);
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
