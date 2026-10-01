/**
 * Checkpoints: shadow snapshots of the working tree around every task.
 * They live in git's object store (a private index plus refs/pb/checkpoints), so
 * HEAD, your index, your branch and your files are never touched by taking one.
 * Used for lost-work and test-tampering detection, /pb:undo, the review's delta,
 * and spotting files changed while they should have stayed untouched.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REF = "refs/pb/checkpoints";
const LEDGER_EXCLUDE = ":(exclude).pi/pb";
const MAX_UNTRACKED_BYTES = 20 * 1024 * 1024;
const IDENT = { GIT_AUTHOR_NAME: "pb", GIT_AUTHOR_EMAIL: "pb@localhost", GIT_COMMITTER_NAME: "pb", GIT_COMMITTER_EMAIL: "pb@localhost" };

export interface Snapshot {
  commit: string;
  tree: string;
}

function run(cwd: string, args: string[], env: Record<string, string> = {}, input?: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    input,
    stdio: ["pipe", "pipe", "ignore"],
    maxBuffer: 256 * 1024 * 1024,
  });
}

function tryRun(cwd: string, args: string[], env?: Record<string, string>): string | undefined {
  try {
    return run(cwd, args, env);
  } catch {
    return undefined;
  }
}

function gitPath(cwd: string, name: string): string {
  return path.resolve(cwd, run(cwd, ["rev-parse", "--git-path", name]).trim());
}

const split0 = (s: string | undefined) => (s ?? "").split("\0").filter(Boolean);

/** Snapshot the working tree (ledger and huge untracked files excluded). undefined outside git or on failure. */
export function snapshot(cwd: string, message: string): Snapshot | undefined {
  if (tryRun(cwd, ["rev-parse", "--is-inside-work-tree"])?.trim() !== "true") return;
  try {
    const env = { GIT_INDEX_FILE: gitPath(cwd, "pb-index") };
    if (!fs.existsSync(env.GIT_INDEX_FILE)) tryRun(cwd, ["read-tree", "HEAD"], env); // seed for speed; fails harmlessly without commits
    const huge = split0(tryRun(cwd, ["ls-files", "-z", "--others", "--exclude-standard", "--", ".", LEDGER_EXCLUDE], env)).filter((f) => {
      try {
        return fs.statSync(path.join(cwd, f)).size > MAX_UNTRACKED_BYTES;
      } catch {
        return false;
      }
    });
    run(cwd, ["add", "-A", "--", ".", LEDGER_EXCLUDE, ...huge.map((f) => `:(exclude,literal)${f}`)], env);
    const tree = run(cwd, ["write-tree"], env).trim();
    const parent = tryRun(cwd, ["rev-parse", "--verify", "-q", REF])?.trim();
    const commit = run(cwd, ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message], IDENT).trim();
    run(cwd, ["update-ref", REF, commit]);
    return { commit, tree };
  } catch {
    return undefined;
  }
}

/** Untracked dependency folders a worktree borrows from the working copy, so the project builds there too. */
const SHARED_DIRS = ["node_modules", ".venv", "venv"];

/**
 * Run `fn` in a temporary git worktree at HEAD (or `ref`), so a long build or test run doesn't collide with
 * one in the working copy (Maven's target/, Gradle's build/). Outside git, `fn` runs in `cwd`.
 * Dependency dirs are borrowed via symlink best-effort (junction on Windows); a failed link falls back
 * to the worktree without it rather than failing the baseline. Cleanup is best-effort: stale worktrees
 * are pruned on the next success path, since a kill between add and remove can't run `finally`.
 */
export async function inWorktree<T>(cwd: string, fn: (dir: string) => Promise<T>, ref = "HEAD"): Promise<T> {
  if (!tryRun(cwd, ["rev-parse", "--verify", "-q", ref])) return fn(cwd);
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "pb-worktree-"));
  const dir = path.join(parent, "tree");
  if (tryRun(cwd, ["worktree", "add", "--detach", "-q", dir, ref]) === undefined) {
    fs.rmSync(parent, { recursive: true, force: true });
    tryRun(cwd, ["worktree", "prune"]);
    return fn(cwd);
  }
  try {
    for (const d of SHARED_DIRS) {
      try {
        if (fs.existsSync(path.join(cwd, d)) && !fs.existsSync(path.join(dir, d))) {
          const type = process.platform === "win32" ? "junction" : undefined;
          fs.symlinkSync(path.join(cwd, d), path.join(dir, d), type);
        }
      } catch {
        // Best-effort: the worktree still builds, just without the borrowed dir.
      }
    }
    return await fn(dir);
  } finally {
    tryRun(cwd, ["worktree", "remove", "--force", dir]);
    tryRun(cwd, ["worktree", "prune"]);
    fs.rmSync(parent, { recursive: true, force: true });
  }
}

/** Forget pb's checkpoints; git garbage-collects the objects later. */
export function dropCheckpoints(cwd: string): void {
  tryRun(cwd, ["update-ref", "-d", REF]);
}

export function changedPaths(cwd: string, a: string, b: string, paths: string[] = []): string[] {
  return split0(tryRun(cwd, ["diff", "-z", "--name-only", "--no-renames", a, b, "--", ...paths]));
}

/** Blob id of a path in a snapshot, or undefined if the path doesn't exist there. */
function blob(cwd: string, commit: string, p: string): string | undefined {
  return tryRun(cwd, ["rev-parse", "-q", "--verify", `${commit}:${p}`])?.trim() || undefined;
}

function content(cwd: string, commit: string, p: string): string | undefined {
  return tryRun(cwd, ["show", `${commit}:${p}`]);
}

/**
 * Make the working tree match `to` (optionally only for `paths`), given that it currently matches `from`.
 * Only the differing files are written or deleted; HEAD and your index are left alone. Returns the paths changed.
 */
export function restore(cwd: string, from: string, to: string, paths: string[] = []): string[] {
  const entries = split0(tryRun(cwd, ["diff", "-z", "--name-status", "--no-renames", from, to, "--", ...paths]));
  const write: string[] = [];
  const remove: string[] = [];
  for (let i = 0; i + 1 < entries.length; i += 2) (entries[i] === "D" ? remove : write).push(entries[i + 1]);
  for (const f of remove) fs.rmSync(path.join(cwd, f), { force: true });
  if (write.length) {
    const env = { GIT_INDEX_FILE: gitPath(cwd, "pb-restore-index") };
    try {
      run(cwd, ["read-tree", to], env);
      run(cwd, ["checkout-index", "-f", "-z", "--stdin"], env, write.join("\0"));
    } finally {
      fs.rmSync(env.GIT_INDEX_FILE, { force: true });
    }
  }
  return [...write, ...remove];
}

/* ------------------------------- detection ------------------------------- */

export const TEST_FILE =
  /(^|\/)(tests?|__tests__|specs?)\/|(^|\/)test_[^/]*\.py$|[^/]*_test\.py$|[._-](test|spec)\.[cm]?[jt]sx?$|_test\.(go|py|rb|exs?)$|[^/]*(Test|TestCase|Tests|IT|Spec)\.(java|kt|kts|scala|cs|groovy|swift)$|Spec\.(scala|groovy|kt)$/i;
const TEST_CASE =
  /@Test\b|@ParameterizedTest\b|@RepeatedTest\b|@TestFactory\b|^\s*(?:async\s+)?def\s+test_|#\[test\]|#\[(?:tokio::)?test\]|^func\s+Test\w*\s*\(|^\s*(?:it|test|describe\.skip|it\.skip|test\.skip)(?:\.each\([^)]*\))?\s*\(/gm;
const SKIP = /@Disabled\b|@Ignore\b|\.skip\s*\(|\b(?:xit|xdescribe|xtest|describe\.skip|it\.skip|test\.skip)\s*\(|pytest\.mark\.skip(?:if)?|@unittest\.skip|\bt\.Skip(?:Now|f)?\(|#\[ignore\]|\.todo\s*\(|\bAssume\b/g;

const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

export interface Flag {
  kind: "lost-work" | "tampering";
  detail: string;
  files: string[];
}

/**
 * Look at what a task changed (pre → post) for signs of trouble:
 * - lost work: files an earlier task changed that this task put back to their start-of-build content
 *   (the usual trace of a stray git checkout/stash/reset);
 * - tampering: existing test files deleted, fewer test cases, or new skip markers.
 */
export function inspectChanges(
  cwd: string,
  pre: Snapshot,
  post: Snapshot,
  start: Snapshot,
  otherTasksFiles: Set<string>,
): Flag[] {
  const changed = changedPaths(cwd, pre.commit, post.commit);
  const flags: Flag[] = [];

  const reverted = changed.filter((f) => otherTasksFiles.has(f) && blob(cwd, start.commit, f) === blob(cwd, post.commit, f));
  if (reverted.length) flags.push({ kind: "lost-work", detail: `reverted earlier tasks' work in ${reverted.join(", ")}`, files: reverted });

  const tampered: string[] = [];
  for (const f of changed.filter((p) => TEST_FILE.test(p))) {
    const before = content(cwd, pre.commit, f);
    if (before === undefined) continue; // a new test file is fine
    const after = content(cwd, post.commit, f);
    if (after === undefined) {
      tampered.push(`${f} deleted`);
      continue;
    }
    const [c0, c1] = [count(before, TEST_CASE), count(after, TEST_CASE)];
    const [s0, s1] = [count(before, SKIP), count(after, SKIP)];
    if (c1 < c0) tampered.push(`${f}: ${c0} → ${c1} test cases`);
    if (s1 > s0) tampered.push(`${f}: ${s1 - s0} skip/disable marker(s) added`);
  }
  if (tampered.length) flags.push({ kind: "tampering", detail: tampered.join("; "), files: tampered.map((t) => t.split(/[: ]/)[0]) });
  return flags;
}
