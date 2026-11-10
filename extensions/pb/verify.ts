/**
 * The check: harness logic, no model call. Its verdict is ground truth: a failing
 * run overrides the agent's "done".
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { packageScript } from "./manifest.ts";
import { type VerifyResult, cap, now } from "./store.ts";

/**
 * The read-only commands that answer "what is outdated" and "what is known to be vulnerable", for every ecosystem
 * the project's manifests show (a repository can hold several). Each is the ecosystem's own tool; one that needs
 * a plugin or an extra install says so, and none of them changes the project. Empty when no manifest is known.
 */
export interface DependencyCommands {
  ecosystem: string;
  outdated: string;
  /** the vulnerability check, when the ecosystem has a command for one */
  audit?: string;
  /** what the commands need (a plugin, a tool to install outside the project) or cost */
  note?: string;
}

export function dependencyCommands(cwd: string): DependencyCommands[] {
  const has = (f: string) => fs.existsSync(path.join(cwd, f));
  const out: DependencyCommands[] = [];
  if (has("package.json")) {
    const pm = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lockb") || has("bun.lock") ? "bun" : "npm";
    out.push(pm === "bun" ? { ecosystem: "Node (bun)", outdated: "bun outdated", note: "no built-in audit: check advisories on osv.dev" } : { ecosystem: `Node (${pm})`, outdated: `${pm} outdated`, audit: `${pm} audit` });
  }
  if (has("Cargo.toml")) out.push({ ecosystem: "Rust", outdated: "cargo outdated", audit: "cargo audit", note: "the cargo-outdated and cargo-audit tools" });
  if (has("pom.xml")) {
    const mvn = has("mvnw") ? "./mvnw" : "mvn";
    out.push({ ecosystem: "Java (Maven)", outdated: `${mvn} -q versions:display-dependency-updates versions:display-plugin-updates`, audit: `${mvn} -q org.owasp:dependency-check-maven:check`, note: "the audit downloads its vulnerability database: slow the first time" });
  }
  if (has("build.gradle") || has("build.gradle.kts")) out.push({ ecosystem: "Java/Kotlin (Gradle)", outdated: `${has("gradlew") ? "./gradlew" : "gradle"} dependencyUpdates`, note: "needs the gradle-versions plugin; for vulnerabilities, the OWASP dependency-check plugin or osv.dev" });
  if (has("go.mod")) out.push({ ecosystem: "Go", outdated: "go list -u -m all", audit: "govulncheck ./...", note: "the govulncheck tool" });
  if (has("pyproject.toml") || has("requirements.txt") || has("setup.cfg")) out.push({ ecosystem: "Python", outdated: "pip list --outdated", audit: "pip-audit", note: "in the project's environment; pip-audit is a separate tool" });
  return out;
}

export function detectVerify(cwd: string): string | null {
  const has = (f: string) => fs.existsSync(path.join(cwd, f));
  const win = process.platform === "win32";
  if (has("pom.xml")) return has(win ? "mvnw.cmd" : "mvnw") ? (win ? "mvnw.cmd -B -q test" : "./mvnw -B -q test") : "mvn -B -q test";
  if (has("build.gradle") || has("build.gradle.kts"))
    return has(win ? "gradlew.bat" : "gradlew") ? (win ? "gradlew.bat test -q" : "./gradlew test -q") : "gradle test -q";
  if (packageScript(cwd, "test")) return "npm test --silent";
  if (has("Cargo.toml")) return "cargo test -q";
  if (has("go.mod")) return "go test ./...";
  if (has("pyproject.toml") || has("pytest.ini") || has("setup.cfg")) return "pytest -q";
  return null;
}

/** Compile/typecheck only, for the "build" gate (tests compile but don't run). */
export function detectBuild(cwd: string): string | null {
  const has = (f: string) => fs.existsSync(path.join(cwd, f));
  const win = process.platform === "win32";
  if (has("pom.xml")) return `${has(win ? "mvnw.cmd" : "mvnw") ? (win ? "mvnw.cmd" : "./mvnw") : "mvn"} -B -q -DskipTests test-compile`;
  if (has("build.gradle") || has("build.gradle.kts")) return `${has(win ? "gradlew.bat" : "gradlew") ? (win ? "gradlew.bat" : "./gradlew") : "gradle"} testClasses -q`;
  if (has("tsconfig.json")) return "npx tsc --noEmit";
  if (has("Cargo.toml")) return "cargo check -q --all-targets";
  if (has("go.mod")) return "go build ./... && go vet ./...";
  return null;
}

export function resolveVerify(setting: string | null, cwd: string): string | null {
  if (setting === null || setting === "" || setting === "none") return null;
  if (setting === "auto") return detectVerify(cwd);
  return setting;
}

export function resolveBuild(setting: string | null, cwd: string): string | null {
  if (setting === null || setting === "" || setting === "none") return null;
  if (setting === "auto") return detectBuild(cwd);
  return setting;
}

/** Lint command: package.json's lint script, else clippy for a Cargo project (explicit `lint` covers every other stack). */
export function detectLint(cwd: string): string | null {
  if (packageScript(cwd, "lint")) return "npm run lint --silent";
  if (fs.existsSync(path.join(cwd, "Cargo.toml"))) return "cargo clippy -q --all-targets -- -D warnings";
  return null;
}

export function resolveLint(setting: string | null, cwd: string): string | null {
  if (setting === null || setting === "" || setting === "none") return null;
  if (setting === "auto") return detectLint(cwd);
  return setting;
}

const SIGNAL = /(\[ERROR\]|FAIL|Tests run:.*(Failures|Errors): [1-9]|BUILD FAILURE|COMPILATION ERROR|Exception|AssertionError|expected|panicked|error\[|error:|timeout|timed out|killed|OOM|out of memory)/i;

function summarize(output: string, limit: number): string {
  const lines = output.split(/\r?\n/);
  const hits = [...new Set(lines.filter((l) => SIGNAL.test(l)).map((l) => l.trimEnd()))].slice(0, 30);
  const tail = lines.slice(-40).join("\n");
  const body = hits.length ? `Key lines:\n${hits.join("\n")}\n\nTail:\n${tail}` : `Tail:\n${tail}`;
  return cap(body, limit);
}

export async function runVerify(
  command: string,
  cwd: string,
  timeoutSec: number,
  limit: number,
  signal?: AbortSignal,
): Promise<VerifyResult> {
  // shell:true is intentional: Test: lines are shell commands (`test -f`, `npm test --silent`,
  // `go build ./... && go vet ./...`). They come from the spec you approved, and the build's
  // agent can already run bash — this grants it no new privilege. Suspicious chaining (`;`, `|`,
  // `&&`, `&`, `$`, backticks, curl/wget) is flagged in specWarnings and skipped by the pre-approval dry-run.
  const started = Date.now();
  const effectiveTimeoutSec = Math.max(1, Math.floor(timeoutSec || 0) || 1);
  let out = "";
  const push = (d: string) => {
    out += d;
    if (out.length > 1_000_000) {
      const dropped = out.length - 1_000_000;
      out = `${out.slice(0, 200_000)}\n…[truncated ${dropped} chars while running]…\n${out.slice(-800_000)}`;
    }
  };
  let timedOut = false;
  const code = await new Promise<number>((resolve) => {
    const posix = process.platform !== "win32";
    const proc = spawn(command, { cwd, shell: true, detached: posix, stdio: ["ignore", "pipe", "pipe"] });
    let closed = false;
    const kill = (graceful = false) => {
      if (closed) return;
      try {
        if (graceful) {
          if (posix && proc.pid) process.kill(-proc.pid, "SIGTERM");
          else proc.kill("SIGTERM");
          setTimeout(() => {
            if (!closed) {
              try {
                if (posix && proc.pid) process.kill(-proc.pid, "SIGKILL");
                else proc.kill("SIGKILL");
              } catch {
                /* ignore */
              }
            }
          }, 5000);
        } else if (posix && proc.pid) process.kill(-proc.pid, "SIGKILL");
        else proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    };
    const onAbort = () => kill();
    const timer = setTimeout(() => {
      timedOut = true;
      kill(true);
    }, effectiveTimeoutSec * 1000);
    signal?.addEventListener("abort", onAbort, { once: true });
    proc.stdout.on("data", (d) => push(d.toString()));
    proc.stderr.on("data", (d) => push(d.toString()));
    proc.on("close", (c) => {
      closed = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(c ?? 1);
    });
    proc.on("error", (e) => {
      closed = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      push(`\n${e.message}`);
      resolve(1);
    });
  });
  const secs = Math.round((Date.now() - started) / 1000);
  const ok = code === 0 && !timedOut;
  const head = `\`${command}\` → ${ok ? "PASS" : timedOut ? `TIMEOUT after ${effectiveTimeoutSec}s` : `FAIL (exit ${code})`} in ${secs}s`;
  return { ok, command, summary: ok ? head : `${head}\n\n${summarize(out, limit)}`, at: now() };
}
