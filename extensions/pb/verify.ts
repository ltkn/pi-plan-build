/**
 * The check: harness logic, no model call. Its verdict is ground truth: a failing
 * run overrides the agent's "done".
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { type VerifyResult, cap, now } from "./store.ts";

export function detectVerify(cwd: string): string | null {
  const has = (f: string) => fs.existsSync(path.join(cwd, f));
  const win = process.platform === "win32";
  if (has("pom.xml")) return has(win ? "mvnw.cmd" : "mvnw") ? (win ? "mvnw.cmd -B -q test" : "./mvnw -B -q test") : "mvn -B -q test";
  if (has("build.gradle") || has("build.gradle.kts"))
    return has(win ? "gradlew.bat" : "gradlew") ? (win ? "gradlew.bat test -q" : "./gradlew test -q") : "gradle test -q";
  if (has("package.json")) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
      if (pkg.scripts?.test && !/no test specified/.test(pkg.scripts.test)) return "npm test --silent";
    } catch {
      /* ignore */
    }
  }
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

const SIGNAL = /(\[ERROR\]|FAIL|Tests run:.*(Failures|Errors): [1-9]|BUILD FAILURE|COMPILATION ERROR|Exception|AssertionError|expected|panicked|error\[|error:)/i;

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
  const started = Date.now();
  let out = "";
  let timedOut = false;
  const code = await new Promise<number>((resolve) => {
    const posix = process.platform !== "win32";
    const proc = spawn(command, { cwd, shell: true, detached: posix, stdio: ["ignore", "pipe", "pipe"] });
    const kill = () => {
      try {
        if (posix && proc.pid) process.kill(-proc.pid, "SIGKILL");
        else proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutSec * 1000);
    signal?.addEventListener("abort", kill, { once: true });
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.stderr.on("data", (d) => (out += d.toString()));
    proc.on("close", (c) => {
      clearTimeout(timer);
      resolve(c ?? 1);
    });
    proc.on("error", (e) => {
      out += `\n${e.message}`;
      clearTimeout(timer);
      resolve(1);
    });
  });
  const secs = Math.round((Date.now() - started) / 1000);
  const ok = code === 0 && !timedOut;
  const head = `\`${command}\` → ${ok ? "PASS" : timedOut ? `TIMEOUT after ${timeoutSec}s` : `FAIL (exit ${code})`} in ${secs}s`;
  return { ok, command, summary: ok ? head : `${head}\n\n${summarize(out, limit)}`, at: now() };
}
