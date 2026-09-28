/**
 * On-disk state: .pi/pb/config.json, one folder per spec under .pi/pb/specs/<name>/
 * (spec.md, progress.json, checkpoints.json, events.jsonl), and finished specs
 * under .pi/pb-archive/, which ignores itself in git.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

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
}

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
};

export interface VerifyResult {
  ok: boolean | null; // null = nothing to run
  command: string | null;
  summary: string;
  at: string;
}

export type TaskStatus = "todo" | "doing" | "done" | "blocked";

export interface TaskProgress {
  id: string;
  title: string;
  status: TaskStatus;
  attempts: number;
  /** what the agent reported when it finished the task */
  summary?: string;
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
  passes: { role: "review" | "abuse"; findings: Finding[]; prose: string; session: string; left: boolean }[];
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
  fs.writeFileSync(file, content, "utf8");
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
  constructor(readonly cwd: string) {
    this.root = path.join(cwd, PB_DIR);
    this.archiveRoot = path.join(cwd, ARCHIVE_DIR);
  }

  rel(...parts: string[]): string {
    return path.join(PB_DIR, ...parts);
  }

  config(): Config {
    const file = path.join(this.root, "config.json");
    if (!fs.existsSync(file)) writeFile(file, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
    const raw = readJson<Partial<Config>>(file) ?? {};
    return { ...DEFAULT_CONFIG, ...raw, reviewer: { ...DEFAULT_CONFIG.reviewer, ...(raw.reviewer ?? {}) }, explorer: { ...(raw.explorer ?? {}) } };
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
    const raw = readJson<string[] | Record<string, { snapshot?: string; checkpointFrom?: string }>>(path.join(this.root, "planning.json"));
    if (Array.isArray(raw)) return Object.fromEntries(raw.map((s) => [s, {}]));
    return raw ?? {};
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
    return readJson<Record<string, ReviewSessionState>>(path.join(this.root, "review-sessions.json"))?.[sessionFile];
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
   */
  setCarry(c: { model?: string; thinking?: string; spec: string; review?: ReviewSessionState }): void {
    writeFile(path.join(this.root, "carry.json"), `${JSON.stringify({ ...c, at: Date.now() })}\n`);
  }
  takeCarry(): { model?: string; thinking?: string; spec: string; review?: ReviewSessionState } | undefined {
    const file = path.join(this.root, "carry.json");
    const c = readJson<{ model?: string; thinking?: string; spec: string; review?: ReviewSessionState; at: number }>(file);
    fs.rmSync(file, { force: true });
    return c && Date.now() - c.at < 5 * 60_000 ? c : undefined;
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
   * The spec being built in this session: the unfinished one, else the most recent that a new
   * plan hasn't detached (one session can build several in turn).
   */
  specForSession(sessionFile: string | undefined): string | undefined {
    if (!sessionFile) return undefined;
    const mine = this.specNames()
      .map((n) => ({ n, p: this.progress(n) }))
      .filter((x) => x.p?.session === sessionFile);
    const active = mine.find((x) => ["building", "paused"].includes(x.p!.phase));
    if (active) return active.n;
    return mine.filter((x) => !x.p!.detached).sort((a, b) => b.p!.updatedAt.localeCompare(a.p!.updatedAt))[0]?.n;
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

  /** A /pb:build that first asked for the spec: build it once it is written (in this session). */
  setPendingBuild(sessionFile: string | undefined): void {
    const file = path.join(this.root, "pending-build.json");
    if (sessionFile) writeFile(file, `${JSON.stringify({ session: sessionFile, at: Date.now() })}\n`);
    else fs.rmSync(file, { force: true });
  }
  pendingBuild(sessionFile: string | undefined): boolean {
    const p = readJson<{ session: string; at: number }>(path.join(this.root, "pending-build.json"));
    return !!p && !!sessionFile && p.session === sessionFile && Date.now() - p.at < 60 * 60_000;
  }

  /** Move a finished spec out of .pi/pb/ so later sessions only see live specs. */
  archive(name: string): string {
    fs.mkdirSync(this.archiveRoot, { recursive: true });
    const ignore = path.join(this.archiveRoot, ".gitignore");
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "*\n");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const dest = path.join(this.archiveRoot, `${stamp}-${name}`);
    fs.renameSync(this.specDir(name), dest);
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

/** Files changed since a commit (tracked + untracked), pb state excluded. */
export function changedSince(cwd: string, base?: string): string[] {
  const tracked = git(cwd, ["diff", "--name-only", base ?? "HEAD", "--", ".", ":(exclude).pi/pb"]) ?? "";
  const untracked = git(cwd, ["ls-files", "--others", "--exclude-standard", "--", ".", ":(exclude).pi/pb"]) ?? "";
  return [...new Set(`${tracked}\n${untracked}`.split("\n").filter(Boolean))];
}

/** The change's diff against a commit (pb state excluded), capped: for spotting sensitive ground. */
export const gitDiff = (cwd: string, base?: string) => (git(cwd, ["diff", "--no-color", "-U0", base ?? "HEAD", "--", ".", ":(exclude).pi"]) ?? "").slice(0, 2_000_000);

/** New, untracked files as added diff lines (capped), so a brand-new file counts too. */
export function untrackedText(cwd: string, files: string[]): string {
  const untracked = new Set((git(cwd, ["ls-files", "--others", "--exclude-standard", "--", ".", ":(exclude).pi"]) ?? "").split("\n").filter(Boolean));
  let out = "";
  for (const f of files.filter((x) => untracked.has(x))) {
    try {
      out += `\n${fs.readFileSync(path.join(cwd, f), "utf8").slice(0, 200_000).split("\n").map((l) => `+${l}`).join("\n")}`;
    } catch {
      // unreadable: skip
    }
  }
  return out;
}

export const diffStat = (cwd: string, base?: string) => git(cwd, ["diff", "--stat", base ?? "HEAD", "--", ".", ":(exclude).pi/pb"])?.trim() ?? "";
