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
  /** Compile/typecheck command for the "build" gate: "auto" detects; null disables. */
  build: string | null;
  verifyTimeoutSec: number;
  /** Fix attempts per task before the build pauses for you. */
  maxAttempts: number;
  /** Chars of test output shown to the agent and the reviewer. */
  testOutputCap: number;
  /** Shadow snapshots per task: real diffs, changed-test checks, /pb:undo. */
  checkpoints: boolean;
  /** Model and thinking level of the fresh reviewer; unset = your session's. */
  reviewer: { model?: string; thinking?: string };
}

export const DEFAULT_CONFIG: Config = {
  verify: "auto",
  build: "auto",
  verifyTimeoutSec: 900,
  maxAttempts: 3,
  testOutputCap: 4000,
  checkpoints: true,
  reviewer: {},
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
}

/** "checking" only appears in progress files from before the gap check was removed. */
export type Phase = "written" | "checking" | "building" | "paused" | "built" | "reviewed";

/** What the agent reported through pb_task_done in the current run. */
export interface Report {
  task: string;
  status: "done" | "blocked" | "question";
  summary: string;
  question?: string;
}

export interface Progress {
  spec: string;
  phase: Phase;
  /** the build session's file, once /pb:build opened it */
  session?: string;
  baseCommit?: string;
  tasks: TaskProgress[];
  /** task being worked on; "final" = the full check after the last task */
  current?: string;
  report?: Report;
  /** choices the builder made where the spec was ambiguous or didn't match the code */
  assumptions?: string[];
  pause?: string;
  lastVerify?: VerifyResult;
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
    return { ...DEFAULT_CONFIG, ...raw, reviewer: { ...(raw.reviewer ?? {}) } };
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
    return readJson<Progress>(path.join(this.specDir(name), "progress.json"));
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

  /** Planning sessions: their project files are read-only (see the tool_call guard). */
  planningSessions(): string[] {
    return readJson<string[]>(path.join(this.root, "planning.json")) ?? [];
  }
  setPlanning(sessionFile: string, on: boolean): void {
    const list = new Set(this.planningSessions());
    if (on) list.add(sessionFile);
    else list.delete(sessionFile);
    writeFile(path.join(this.root, "planning.json"), `${JSON.stringify([...list], null, 2)}\n`);
  }

  /**
   * Hand-over to the next build session: the planning session's model and thinking level,
   * applied by pb's fresh instance at session_start (the old pi is stale by then).
   */
  setCarry(c: { model?: string; thinking?: string; spec: string }): void {
    writeFile(path.join(this.root, "carry.json"), `${JSON.stringify({ ...c, at: Date.now() })}\n`);
  }
  takeCarry(): { model?: string; thinking?: string; spec: string } | undefined {
    const file = path.join(this.root, "carry.json");
    const c = readJson<{ model?: string; thinking?: string; spec: string; at: number }>(file);
    fs.rmSync(file, { force: true });
    return c && Date.now() - c.at < 5 * 60_000 ? c : undefined;
  }

  /** The spec whose build runs in this session file, if any. */
  specForSession(sessionFile: string | undefined): string | undefined {
    if (!sessionFile) return undefined;
    return this.specNames().find((n) => this.progress(n)?.session === sessionFile);
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

export const diffStat = (cwd: string, base?: string) => git(cwd, ["diff", "--stat", base ?? "HEAD", "--", ".", ":(exclude).pi/pb"])?.trim() ?? "";
