#!/usr/bin/env node
/**
 * verify-test: prove that named tests actually ran and passed.
 *
 * `node --test --test-name-pattern=<no match>` exits 0 — a filtered command whose
 * pattern drifts is indistinguishable from a green run. This script runs the suite
 * with the names as a pattern and reads the TAP report: exit 0 only when every name
 * appears as a passing `ok` line (a `# SKIP` or `# TODO` is not a proof) and the run
 * reports `# fail 0`. The runner itself must have finished cleanly — killed, timed
 * out (10 min) or truncated output proves nothing even when the TAP looks green.
 * Spawned with an args array, never a shell; names are regex-escaped, so
 * metacharacters in a test name match literally.
 *
 * Usage: node scripts/verify-test.mjs [--file <test-file>] "<exact test name>" ...
 * The test file (default test/pb.test.mts) resolves against the repo root.
 */
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

let testFile = "test/pb.test.mts";
const names = [];
for (let i = 0; i < process.argv.length - 2; i++) {
  const arg = process.argv[2 + i];
  if (arg === "--file") {
    const next = process.argv[3 + i];
    if (!next) {
      console.error("verify-test: --file needs a path");
      process.exit(1);
    }
    testFile = next;
    i++;
  } else if (arg !== "") {
    names.push(arg);
  }
}

if (!names.length) {
  console.error('verify-test: usage: verify-test.mjs [--file <test-file>] "<exact test name>" ...');
  process.exit(1);
}

const unique = [...new Set(names)];
// NODE_TEST_CONTEXT inherited from a test process makes `node --test` run as a runner
// child with no TAP summary; the proof must always see the real report.
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;
// A hung runner must fail the proof, not hang the loop that called it.
const run = spawnSync(
  process.execPath,
  ["--test", "--test-reporter=tap", "--test-name-pattern", unique.map(escapeRe).join("|"), path.resolve(ROOT, testFile)],
  { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60_000, env }
);
const out = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
const lines = out.split("\n").map((l) => l.replace(/\r$/, ""));

// A passing TAP line is `ok <n> - <name>`, optionally followed by a `# time=` comment;
// `# SKIP` and `# TODO` never count (a bodyless todo test prints ok with `# fail 0`),
// and `not ok` never matches the `ok` prefix anchored at line start.
const passed = (name) => lines.some((l) => new RegExp(`^\\s*ok \\d+ - ${escapeRe(name)}(?: # (?!SKIP|TODO).*)?$`).test(l));
const failCount = lines.map((l) => /^# fail (\d+)$/.exec(l)).filter(Boolean).at(-1);

const missing = unique.filter((n) => !passed(n));
const problems = [];
if (missing.length) problems.push(`not proven (missing, skipped, todo or failing): ${missing.join("; ")}`);
if (failCount && Number(failCount[1]) > 0) problems.push(`the run reports ${failCount[1]} failing test(s)`);
if (!failCount) problems.push(`the TAP report has no "# fail" summary; the run itself proves nothing`);
// The TAP text is the proof of the tests; the process result is the proof that the run
// finished as a run at all: killed, timed out or truncated output proves nothing.
if (run.error) problems.push(`the runner failed (${run.error.message ?? run.error})`);
if (run.signal) problems.push(`the runner was killed by ${run.signal}`);
if (typeof run.status === "number" && run.status !== 0 && !(failCount && Number(failCount[1]) > 0)) {
  problems.push(`the runner exited ${run.status} while the TAP report looks green`);
}

if (problems.length) {
  console.error(`verify-test: NOT PROVEN — ${problems.join(". ")}`);
  console.error(out.trimEnd().split("\n").slice(-40).join("\n"));
  process.exit(1);
}
console.log(`verify-test: proven — ${unique.join("; ")}`);
