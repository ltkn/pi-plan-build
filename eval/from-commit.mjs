#!/usr/bin/env node
/**
 * Turn a real commit into an eval task: its parent is the starting point, its test files are the
 * hidden tests, its message is a first draft of the prompt. Rewrite the prompt the way you'd ask
 * for the feature, without describing the tests.
 *
 *   node eval/from-commit.mjs --repo /path/to/repo --commit <sha> --name order-cancellation \
 *        --test-command "./mvnw -B -q -Dtest='OrderCancellationTest' test" [--tests path,path]
 *
 * Without --tests, the commit's changed test files are used (by name: *Test.java, test_*.py, *.test.ts, …).
 * The hidden tests are copied over the agent's versions of the same files after the run: prefer
 * commits whose tests are new files.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const TEST_FILE =
  /(^|\/)(tests?|__tests__|specs?)\/|(^|\/)test_[^/]*\.py$|[._-](test|spec)\.[cm]?[jt]sx?$|_test\.(go|py|rb|exs?)$|Tests?\.(java|kt|kts|scala|cs|groovy|swift)$|Spec\.(scala|groovy|kt)$/i;

const { values: opt } = parseArgs({
  options: {
    repo: { type: "string" },
    commit: { type: "string" },
    name: { type: "string" },
    "test-command": { type: "string" },
    tests: { type: "string" },
  },
});
if (!opt.repo || !opt.commit || !opt.name || !opt["test-command"]) {
  console.error("usage: node eval/from-commit.mjs --repo <path|url> --commit <sha> --name <task-name> --test-command <cmd> [--tests a,b]");
  process.exit(2);
}
const repo = fs.existsSync(opt.repo) ? path.resolve(opt.repo) : opt.repo;
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });

const parent = git("rev-parse", `${opt.commit}^`).trim();
const message = git("log", "-1", "--format=%B", opt.commit).trim();
const changed = git("diff", "--name-only", "--diff-filter=AM", parent, opt.commit).split("\n").filter(Boolean);
const tests = opt.tests ? opt.tests.split(",").map((t) => t.trim()) : changed.filter((f) => TEST_FILE.test(f));
if (!tests.length) {
  console.error(`No test files in ${opt.commit}: pass --tests.`);
  process.exit(1);
}

const hidden = path.join(HERE, "hidden", opt.name);
for (const f of tests) {
  const dest = path.join(hidden, f);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, git("show", `${opt.commit}:${f}`));
}
const task = {
  name: opt.name,
  repo,
  commit: parent,
  prompt: `TODO: rewrite as you would ask for it, without describing the tests. The commit said: ${message}`,
  answers: ["Go with your recommendation."],
  hidden: { dir: `hidden/${opt.name}`, to: ".", command: opt["test-command"] },
};
const file = path.join(HERE, "tasks", `${opt.name}.json`);
fs.writeFileSync(file, `${JSON.stringify(task, null, 2)}\n`);
console.log(`Wrote ${path.relative(process.cwd(), file)} with ${tests.length} hidden test file(s):\n${tests.map((t) => `  ${t}`).join("\n")}\nEdit its prompt before running.`);
