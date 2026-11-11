/** Builds: tasks and their checks, the red proof, resets and compaction, checkpoints and /pb:undo. */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { type Result, type Script, briefOf, contractHash, diligent, parseSpec, PLANNING, repairLap, setup, SPEC, specRel, taskOf, TASKS_PLAIN, TASKS_WITH_A_REFACTOR, THREE_TASKS, until, withCohere, written } from "./harness.mts";

test("snapshot: works when .pi is gitignored wholesale (the recommended setup)", async () => {
  const t = setup();
  const { snapshot, changedPaths } = await import("../extensions/pb/checkpoint.ts");
  fs.writeFileSync(path.join(t.repo, ".gitignore"), ".pi/\n");
  fs.writeFileSync(path.join(t.repo, ".pi/pb/ledger.json"), "{}");
  fs.writeFileSync(path.join(t.repo, "a.txt"), "v1");
  const before = snapshot(t.repo, "before");
  assert.ok(before, "snapshot must not fail on the ignored ledger path");
  fs.writeFileSync(path.join(t.repo, "a.txt"), "v2");
  fs.writeFileSync(path.join(t.repo, ".pi/pb/ledger.json"), `{"n":1}`);
  const after = snapshot(t.repo, "after")!;
  assert.deepEqual(changedPaths(t.repo, before!.commit, after.commit), ["a.txt"]); // ledger never captured
});

test("restore: files changed since the snapshot are left alone, not clobbered", async () => {
  const t = setup();
  const { snapshot, restore } = await import("../extensions/pb/checkpoint.ts");
  // A: v1 → s1; A: v2 → s2 (the recorded state); then both A and B drift without a new snapshot.
  fs.writeFileSync(path.join(t.repo, "a.txt"), "v1");
  const s1 = snapshot(t.repo, "s1")!;
  fs.writeFileSync(path.join(t.repo, "a.txt"), "v2");
  fs.writeFileSync(path.join(t.repo, "b.txt"), "v2");
  const s2 = snapshot(t.repo, "s2")!;
  fs.writeFileSync(path.join(t.repo, "a.txt"), "drift");
  const restored = restore(t.repo, s2.commit, s1.commit, ["a.txt", "b.txt"]);
  assert.equal(fs.readFileSync(path.join(t.repo, "a.txt"), "utf8"), "drift"); // kept: it changed again
  assert.deepEqual(restored, { restored: ["b.txt"], guardFailed: false }); // B matches s2, so it was removed back to its s1 state (absent)
  assert.ok(!fs.existsSync(path.join(t.repo, "b.txt")));
});

test("restore: a guard that can't be taken leaves the worktree alone instead of clobbering", async () => {
  const t = setup();
  const { snapshot, restore, snapshotIndex } = await import("../extensions/pb/checkpoint.ts");
  fs.writeFileSync(path.join(t.repo, "a.txt"), "v1");
  const s1 = snapshot(t.repo, "s1")!;
  fs.rmSync(path.join(t.repo, "a.txt"));
  const s2 = snapshot(t.repo, "s2")!;
  fs.writeFileSync(path.join(t.repo, "a.txt"), "changed again after s2");
  // The guard's index can't be written (a directory sits where the file belongs): the snapshot it
  // needs fails. Without a guard there is no way to tell the drift above from a clean tree.
  const index = snapshotIndex(t.repo);
  fs.rmSync(index, { force: true });
  fs.mkdirSync(index, { recursive: true });
  const r = restore(t.repo, s2.commit, s1.commit, ["a.txt"]);
  assert.equal(r.guardFailed, true);
  assert.deepEqual(r.restored, []);
  assert.equal(fs.readFileSync(path.join(t.repo, "a.txt"), "utf8"), "changed again after s2"); // not clobbered with v1
  fs.rmSync(index, { recursive: true, force: true });
});

test("restore: outside git it fails closed too, rather than pretending nothing was wrong", async () => {
  const { restore } = await import("../extensions/pb/checkpoint.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pb-nogit-"));
  fs.writeFileSync(path.join(dir, "a.txt"), "mine");
  try {
    const r = restore(dir, "1111111", "2222222", ["a.txt"]);
    assert.equal(r.guardFailed, true);
    assert.deepEqual(r.restored, []);
    assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "mine");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("snapshot: an unusable shared index from an older pb never breaks this process's checkpoints", async () => {
  const t = setup();
  const { snapshot } = await import("../extensions/pb/checkpoint.ts");
  // Older versions kept one index per repo; here something nefarious left a directory in its place.
  fs.mkdirSync(path.join(t.repo, ".git", "pb-index"), { recursive: true });
  fs.writeFileSync(path.join(t.repo, "a.txt"), "x");
  assert.ok(snapshot(t.repo, "after")); // the snapshot never touches that path
});

test("checkpoints: this process's index files are cleaned up when the session shuts down", async () => {
  const t = setup();
  const { snapshot, snapshotIndex } = await import("../extensions/pb/checkpoint.ts");
  fs.writeFileSync(path.join(t.repo, "a.txt"), "x");
  assert.ok(snapshot(t.repo, "after"));
  assert.ok(fs.existsSync(snapshotIndex(t.repo)));
  await t.fire("session_shutdown", { reason: "quit" });
  assert.ok(!fs.existsSync(snapshotIndex(t.repo)));
});

test("a shell call in a pb session is capped by commandTimeoutSec", async () => {
  const { Store } = await import("../extensions/pb/store.ts");
  assert.equal(new Store(setup({ verify: "true" }).repo).config().commandTimeoutSec, 1800); // 30 minutes by default
  const t = setup({ verify: "true", commandTimeoutSec: 5 });
  process.chdir(t.repo);
  await t.run("plan", "cancel orders");
  const silent = { command: "echo ok" };
  await t.callTool("bash", silent);
  assert.equal((silent as { timeout?: number }).timeout, 5); // no timeout: pb sets the cap
  const shorter = { command: "echo ok", timeout: 2 };
  await t.callTool("bash", shorter);
  assert.equal(shorter.timeout, 2); // the model's stricter bound stays
  const longer = { command: "echo ok", timeout: 60 };
  await t.callTool("bash", longer);
  assert.equal(longer.timeout, 5); // a longer one is clamped, not trusted
  // The project's own suite ("true" here) is a genuine long command: it gets the long limit, never the shell's.
  const suite = { command: "true" };
  await t.callTool("bash", suite);
  assert.equal((suite as { timeout?: number }).timeout, 900, "max(commandTimeoutSec, verifyTimeoutSec)");
  const suiteWithArgs = { command: "cd sub && true --grep orders" };
  await t.callTool("bash", suiteWithArgs);
  assert.equal((suiteWithArgs as { timeout?: number }).timeout, 900);
  const off = setup({ verify: "true", commandTimeoutSec: 0 });
  process.chdir(off.repo);
  await off.run("plan", "cancel orders");
  const unlimited = { command: "true", timeout: 60 };
  await off.callTool("bash", unlimited);
  assert.equal(unlimited.timeout, 60); // 0 turns the cap off
});

test("build --fresh: a new session seeded with the spec, tasks behind their tests, then the full suite", async () => {
  const t = setup({ taskChecks: "each",  verify: "test -f T1.txt && test -f T2.txt" });
  await written(t);
  t.agent.script = diligent;
  await t.run("build", "--fresh");
  const p = t.progress("order-cancellation");
  assert.equal(p.phase, "built");
  assert.match(p.session, /build-session-1\.jsonl$/);
  assert.equal(t.names.get(p.session), "build: order-cancellation");
  assert.ok(t.posts.some((x) => /This session: "build: order-cancellation" · back to it with \/resume, or `pi --session build-session-1`/.test(x)));
  assert.deepEqual(p.tasks.map((x: any) => [x.id, x.status]), [["T1", "done"], ["T2", "done"]]);
  assert.match(t.instructions[0], /\[pb:build order-cancellation\] Build \.pi\/pb\/specs\/order-cancellation\/spec\.md\.[\s\S]*\[pb:build\] Task T1\. Do only this task/);
  assert.match(t.results[0], /^✓ T1 passed[\s\S]*Task T2\. Do only this task/); // T1 was behind its own failing test first
  assert.match(t.posts.at(-1)!, /Build complete — order-cancellation[\s\S]*PASS/);
  assert.match(t.posts.at(-1)!, /\*\*Next:\*\* `\/pb:review` here in this session/);
  assert.match(t.posts.at(-1)!, /\*\*Evidence:\*\* suite PASS/);
  assert.match(t.read(".pi/pb/specs/order-cancellation/events.jsonl"), /"type":"check","task":"final"/); // full suite after the task tests
});

test("build complete: the other specs from the same plan are listed as still to build", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  await t.callTool("pb_write_spec", { name: "refunds", content: SPEC() });
  t.agent.script = diligent;
  await t.run("build", "order-cancellation");
  assert.match(t.posts.at(-1)!, /Build complete — order-cancellation[\s\S]*Still to build, from the same plan:\n- refunds: `\/pb:build refunds`/);
});

test("build: with taskChecks each, the check runs inside pb_task_done: one agent run from the first task to the end", async () => {
  const t = setup({ taskChecks: "each",  verify: "true" });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  assert.equal(t.stat.runs, 1); // no stop and restart between tasks
  const next = t.instructions.find((i) => i.startsWith("✓ T1 passed"))!;
  assert.match(next, /✓ T1 passed \(`test -f T1\.txt`\)\n\n\[pb:build\] Task T2\. Do only this task[\s\S]*it runs `test -f T2\.txt` itself, so don't run that just before/);
  assert.equal(t.instructions.length, 2); // the first message (with T1's prompt), then T1's tool result; T2's ends the run
  assert.match(t.results.at(-1)!, /✓ T2 passed[\s\S]*Running `true`…[\s\S]*Build complete: every check passed\. Stop here/);
});

test("build: with taskChecks each, a task without a Test: line is compiled, not run against the full suite", async () => {
  const t = setup({ taskChecks: "each",  verify: "true", build: "echo compiled" });
  await written(t, SPEC({ tasks: "### T1: first file\nCreate T1.txt.\n- Acceptance: T1.txt exists (non-testable: the task has no Test: command)\n\n### T2: second file\nCreate T2.txt.\n- Acceptance: T2.txt exists (non-testable: the task has no Test: command)" }));
  t.agent.script = diligent;
  await t.run("build");
  const checks = t.events("order-cancellation").filter((e) => e.type === "check");
  assert.deepEqual(checks.map((c) => [c.task, c.command]), [["T1", "echo compiled"], ["T2", "echo compiled"], ["final", "true"]]);
});

test("the build: the first task that fixes a shape records it in the spec's Design, without naming the spec", async () => {
  const t = setup({ verify: "true" });
  await written(t, SPEC().replace("## Tasks", "## Contracts\n- `cancel(orderId)` returns the cancelled order.\n## Tasks"));
  let recorded = 0;
  t.agent.script = async (text, tool) => {
    if (taskOf(text) === "T1" && !recorded) {
      recorded++;
      await tool("pb_update_spec", { section: "Design", content: "- One `Order` aggregate per file." });
    }
    return diligent(text, tool);
  };
  await t.run("build");
  assert.match(t.read(".pi/pb/specs/order-cancellation/spec.md"), /## Design\n- One `Order` aggregate per file\.\n/);
  assert.ok(t.selectTitles.every((x) => !/The design of/.test(x))); // the design dialog is gone with the skeleton
  const p = t.progress("order-cancellation");
  assert.equal(p.phase, "built");
  assert.deepEqual(p.tasks.map((x: any) => [x.id, x.status]), [["T1", "done"], ["T2", "done"]]);
  await t.run("review");
  assert.match(t.instructions.filter((i) => i.startsWith("[pb:review]")).at(-1)!, /## Design provenance\n\nDesign provenance: recorded once, first (during the build|before any task proof)\./); // one build write (ties read as during)
});

test("red then green: a task's new tests are seen failing first; refactors and no-new-tests specs are exempt", async () => {
  const t = setup({ verify: "true" });
  await written(t, SPEC({ tasks: TASKS_WITH_A_REFACTOR }));
  const said: string[] = [];
  t.agent.script = async (text, tool) => {
    const task = taskOf(text) ?? (text.includes("Continue task T1") ? "T1" : undefined);
    if (task === "T1" && !said.length) {
      fs.writeFileSync("T1.txt", "x"); // the change first
      said.push((await tool("pb_task_done", { task, status: "done", changed: "done", caveat: "none", rejected: "none", open: "none" })).content![0].text);
      said.push((await tool("pb_tests_red", { task })).content![0].text);
      fs.rmSync("T1.txt"); // set aside, as told
      said.push((await tool("pb_tests_red", { task })).content![0].text);
      said.push((await tool("pb_tests_red", { task })).content![0].text);
      fs.writeFileSync("T1.txt", "x");
      return void (await tool("pb_task_done", { task, status: "done", changed: "done", caveat: "none", rejected: "none", open: "none" }));
    }
    if (task === "T2") said.push((await tool("pb_tests_red", { task })).content![0].text);
    return diligent(text, tool);
  };
  await t.run("build");
  assert.match(said[0], /T1's new tests were never seen failing[\s\S]*set it aside first/);
  assert.match(said[1], /^`test -f T1\.txt` passes without the change, so these tests don't check it/);
  assert.match(said[2], /^Seen failing: `test -f T1\.txt`[\s\S]*fails for the reason you expect/);
  assert.match(said[3], /^Seen failing: `test -f T1\.txt`[\s\S]*only the latest failed run counts/);
  assert.match(said[4], /^T2 doesn't need this/); // a refactor adds no behaviour
  const p = t.progress("order-cancellation");
  assert.equal(p.phase, "built");
  assert.deepEqual(p.tasks.map((x: any) => x.id), ["T1", "T2"]);

  const u = setup({ verify: "true" });
  await written(u, SPEC({ newTests: "no — a docs-only change", tasks: TASKS_PLAIN }));
  u.agent.script = async (text, tool) => {
    const task = taskOf(text);
    if (task && task !== "final") fs.writeFileSync(`${task}.txt`, "x");
    if (task) await tool("pb_task_done", { task, status: "done", changed: "done", caveat: "none", rejected: "none", open: "none" });
  };
  await u.run("build");
  assert.equal(u.progress("order-cancellation").phase, "built"); // no new tests: nothing to see failing
  assert.deepEqual(u.progress("order-cancellation").tasks.map((x: any) => x.id), ["T1", "T2"]);
  assert.doesNotMatch(u.instructions[0], /Skeleton/);
});

test("red proof belongs to its command: edited tests do not re-require it, a rewritten command does", async () => {
  const t = setup({ verify: "true" });
  await written(t, SPEC({ tasks: TASKS_WITH_A_REFACTOR }));
  const said: string[] = [];
  t.agent.script = async (text, tool) => {
    const task = taskOf(text) ?? (text.includes("Continue task T1") ? "T1" : undefined);
    if (task === "T1" && !said.length) {
      fs.writeFileSync("T1.test.mjs", "assert equal(a, 1)\n");
      said.push((await tool("pb_tests_red", { task })).content![0].text);
      // The tests change after the proof: the command was seen failing, and a second run is not
      // demanded. A model that does re-run replaces the proof (see the red-gate tests).
      fs.writeFileSync("T1.test.mjs", "assert equal(a, 1) // tightened\n");
      fs.writeFileSync("T1.txt", "x");
      said.push((await tool("pb_task_done", { task, status: "done", changed: "done", caveat: "none", rejected: "none", open: "none" })).content![0].text);
    }
    return diligent(text, tool);
  };
  await t.run("build");
  assert.match(said[0], /^Seen failing: `test -f T1\.txt`/);
  assert.doesNotMatch(said[1], /tests changed since they were seen failing/);
  const p = t.progress("order-cancellation");
  assert.equal(p.phase, "built");
  assert.equal(p.tasks.find((x: any) => x.id === "T1").redCommand, "test -f T1.txt");
});

test("undo: a repair lap is taken back whole, spec text and all, and a later run's lap gets its own row", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  const original = t.read(specRel);
  const rows = () => JSON.parse(t.read(".pi/pb/specs/order-cancellation/checkpoints.json"));
  const lapRows = () => rows().filter((c: any) => c.kind === "lap");
  process.env.MOCK_SPEC_REVIEW = "advisory";
  try {
    await t.run("spec-review", "order-cancellation");
  } finally {
    delete process.env.MOCK_SPEC_REVIEW;
  }
  t.agent.script = repairLap(t, { applied: [1, 2], rebutted: [], parked: [], assumed: [], summary: "settled both" });
  await t.run("spec-fix", "order-cancellation");
  const afterLap = t.read(specRel);
  assert.notEqual(afterLap, original, "the lap changed the spec");
  assert.equal(t.progress("order-cancellation").session, undefined, "the spec was never built: its repair session is the only one that can undo the lap");
  assert.deepEqual(lapRows().map((c: any) => c.id), ["lap1"]);
  assert.equal(lapRows()[0].spec, original, "the row holds the text before the lap");
  assert.equal(lapRows()[0].phase, "written");
  // A second run starts at lap 1 again; its row must not take the first run's id.
  process.env.MOCK_SPEC_REVIEW = "advisory";
  try {
    await t.run("spec-review", "order-cancellation");
  } finally {
    delete process.env.MOCK_SPEC_REVIEW;
  }
  t.agent.script = repairLap(t, { applied: [1, 2], rebutted: [], parked: [], assumed: [], summary: "settled both again" });
  await t.run("spec-fix", "order-cancellation");
  const afterSecond = t.read(specRel);
  assert.deepEqual(lapRows().map((c: any) => c.id), ["lap1", "lap1-2"]);
  assert.equal(lapRows()[1].spec, afterLap, "the later row restores the text the second lap started from");
  // /pb:undo in the repair session: no build session, no open lap — the spec it wrote names it.
  await t.run("undo", "lap1-2");
  assert.equal(t.read(specRel), afterLap, "the second lap's text change is gone");
  assert.notEqual(t.read(specRel), afterSecond);
  assert.equal(t.progress("order-cancellation").phase, "written", "the phase the lap opened in comes back");
  assert.equal(t.progress("order-cancellation").fix, undefined);
  assert.match(t.posts.at(-1)!, /Undone to before lap1-2[\s\S]*1 file\(s\) restored/);
  assert.deepEqual(lapRows().map((c: any) => c.id), ["lap1"], "the undo drops its target and what came after it, not the earlier run's row");
});

test("build: with taskChecks end, each task is still compiled when a build command exists", async () => {
  const t = setup({ verify: "true", build: "false" });
  await written(t);
  const said: string[] = [];
  let done = false;
  t.agent.script = async (text, tool) => {
    const task = taskOf(text);
    if (task === "T1" && !done) {
      done = true;
      said.push((await tool("pb_tests_red", { task })).content![0].text);
      fs.writeFileSync("T1.txt", "x");
      said.push((await tool("pb_task_done", { task, status: "done", changed: "done", caveat: "none", rejected: "none", open: "none" })).content![0].text);
    }
  };
  await t.run("build");
  assert.match(said[0], /^Seen failing/);
  assert.match(said[1], /The check for T1 failed[\s\S]*`false`/); // the per-task compile, not the suite
});

test("task gate: lint runs after each task's check and fails that task like any check", async () => {
  const t = setup({ verify: "true", build: null, lint: "false" });
  await written(t);
  const said: string[] = [];
  t.agent.script = async (text, tool) => {
    const task = taskOf(text);
    if (!task) return;
    if (task !== "final") {
      await tool("pb_tests_red", { task, tests: `${task}.txt exists` });
      fs.writeFileSync(`${task}.txt`, "x");
    }
    said.push((await tool("pb_task_done", { task, status: "done", changed: `did ${task}`, caveat: "none", rejected: "none", open: "none" })).content![0].text);
  };
  await t.run("build");
  assert.match(said[0], /The check for T1 failed[\s\S]*`false`/); // at the task that caused it, not at the end
  assert.ok(!said.some((s) => /Task T2/.test(s))); // a red lint never hands out the next task
  assert.match(t.instructions.find((i) => /Task T1/.test(i))!, /it runs `test -f T1\.txt` then `false` itself/); // the handout names the task's own test and the lint it will run
  assert.ok(t.events("order-cancellation").some((e: any) => e.type === "check" && e.task === "T1" && e.lint === false && e.ok === false));
  assert.equal(t.progress("order-cancellation").phase, "paused");
});

test("final gate: lint still runs when the final check is retried after a failure", async () => {
  const lint = "sh -c 'echo lint >> lint.txt'";
  const t = setup({ verify: "test -f fixed.txt", build: null, lint });
  await written(t, SPEC({ tasks: "### T1: only file\nCreate T1.txt.\n- Acceptance: T1.txt exists (tests: T1)\n- Test: `test -f T1.txt`" }));
  t.agent.script = async (text, tool) => {
    const task = taskOf(text);
    if (!task) return;
    if (task === "T1") {
      await tool("pb_tests_red", { task });
      fs.writeFileSync("T1.txt", "x");
    } else fs.writeFileSync("fixed.txt", "x"); // the final suite failed once: fix it
    await tool("pb_task_done", { task, status: "done", changed: `did ${task}`, caveat: "none", rejected: "none", open: "none" });
  };
  await t.run("build");
  assert.equal(t.progress("order-cancellation").phase, "built");
  // Once after T1, skipped on entering the final step right after it, again on the final retry.
  assert.equal(fs.readFileSync(path.join(t.repo, "lint.txt"), "utf8").split("\n").filter(Boolean).length, 2);
  assert.ok(t.events("order-cancellation").some((e: any) => e.type === "check" && e.task === "final" && e.command === lint && e.ok === true));
});

test("final gate: extraChecks run after lint; the summary lists changed files by task", async () => {
  const t = setup({ verify: "true", build: null, lint: "true", extraChecks: ["false"] });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  assert.equal(t.progress("order-cancellation").phase, "paused"); // suite and lint passed, the project check failed
  const u = setup({ verify: "true", build: null, lint: "true" });
  await written(u);
  u.agent.script = diligent;
  await u.run("build");
  assert.equal(u.progress("order-cancellation").phase, "built");
  assert.match(u.posts.at(-1)!, /Changed files, by task[\s\S]*T1: T1\.txt/);
});

test("final gate: when the last task already ran the suite and lint, neither re-runs at the end", async () => {
  const suite = "sh -c 'echo run >> count.txt; test -f T1.txt'";
  const lint = "sh -c 'echo lint >> lint.txt'";
  const t = setup({ verify: suite, taskChecks: "each", lint });
  await written(t, SPEC({ tasks: "### T1: only file\nCreate T1.txt.\n- Acceptance: T1.txt exists (tests: T1)\n- Test: `" + suite + "`" }));
  t.agent.script = diligent;
  await t.run("build");
  assert.equal(t.progress("order-cancellation").phase, "built");
  // Red proof plus the task's own check ran the suite; lint ran once, after the task's check.
  assert.equal(fs.readFileSync(path.join(t.repo, "count.txt"), "utf8").split("\n").filter(Boolean).length, 2);
  assert.equal(fs.readFileSync(path.join(t.repo, "lint.txt"), "utf8").split("\n").filter(Boolean).length, 1);
  assert.match(t.posts.find((p) => p.includes("Build complete"))!, /lint PASS/); // the task's lint is the build's lint gate
});

test("build: a task is told to follow the codebase, build only what the spec needs in the cleanest way, and re-read its diff before reporting", async () => {
  const { taskPrompt } = await import("../extensions/pb/prompts.ts");
  const prompt = taskPrompt(parseSpec(SPEC()).spec!.tasks[0], 1, 3, ["npx tsc --noEmit"], false, "", "", "npm run lint --silent");
  assert.match(prompt, /find where the project solves the same kind of problem \(the spec's Findings name the code to imitate\), match its conventions/);
  assert.match(prompt, /Where that code falls short of the engineering standards \(outdated, insecure, a workaround\), don't copy the flaw: write the new code to the standards and name the old pattern under open/);
  assert.match(prompt, /extend an existing helper rather than adding a near-copy/);
  assert.match(prompt, /Meet the Acceptance lines with the cleanest change, not the smallest: Build for the needs this change has, not ones it might have/);
  assert.match(prompt, /Before reporting, re-read your diff and fix what it shows: duplicated or dead code, debug output/);
  assert.match(prompt, /it runs `npx tsc --noEmit` then `npm run lint --silent` itself, so don't run those just before/);
  assert.ok(prompt.indexOf("Before reporting") < prompt.indexOf("call pb_task_done")); // the look comes before the report
});

test("handoff: a later task is told which names the earlier tasks declared, file by file", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  t.agent.script = async (text, tool) => {
    const task = taskOf(text);
    if (!task) return;
    if (task !== "final") await tool("pb_tests_red", { task, tests: `${task}.txt exists` });
    if (task === "T1") {
      fs.mkdirSync("src", { recursive: true });
      fs.writeFileSync("src/orders.ts", "export function cancelOrder(id: string) {}\nexport type OrderState = 'pending';\n");
      fs.mkdirSync("test", { recursive: true });
      fs.writeFileSync("test/orders.test.ts", "export function fixtureOrder() {}\n");
    }
    if (task !== "final") fs.writeFileSync(`${task}.txt`, "x");
    await tool("pb_task_done", { task, status: "done", changed: `did ${task}`, caveat: "none", rejected: "none", open: "none" });
  };
  await t.run("build");
  const handoff = t.resets[0].summary;
  assert.match(handoff, /Already done: T1 \([^)]*src\/orders\.ts \[cancelOrder, OrderState\]/);
  assert.doesNotMatch(handoff, /fixtureOrder/); // test helpers are not reuse candidates
  assert.match(handoff, /reuse a name in brackets \(what that file gained\) before writing another that does the same/);
});

test("declarations: the names a diff adds, per language, from added lines only", async () => {
  const { declarationsIn } = await import("../extensions/pb/declarations.ts");
  const file = (name: string, ...added: string[]) => [`diff --git a/${name} b/${name}`, `--- a/${name}`, `+++ b/${name}`, "@@ -0,0 +1 @@", ...added.map((l) => `+${l}`)].join("\n");
  const diff = [
    file("src/a.ts", "export async function load() {", "  const inner = 1;", "export class Store {}", "interface Row {}", "export const LIMIT = 5;", "export function load() {"),
    file("src/lib.rs", "pub fn parse(s: &str) {}", "    pub(crate) async fn fetch() {}", "pub struct Config {", "impl Config {", "macro_rules! check {", "        let x = 1;"),
    file("main.go", "func Serve() {}", "func (s *Server) Stop() {}", "type Server struct {}"),
    file("app.py", "class Repo:", "    def save(self):", "        def nested(): pass", "async def main():"),
    file("Order.java", "public class Order {", "    public static Order of(String id) {", "    return foo(x);", "    private final Map<String, List<Order>> byId(int n) {"),
    file("Svc.kt", "data class Line(val n: Int)", "    suspend fun refund(id: String) {", "fun <T> List<T>.second(): T {"),
    file("README.md", "export function notCode() {}"),
    "--- a/src/old.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-export function gone() {}",
    file("src/b.ts", `export const ${"x".repeat(400)} = 1;`),
  ].join("\n");
  const names = declarationsIn(diff).map((d) => `${d.file}:${d.name}`);
  assert.deepEqual(names, [
    "src/a.ts:load",
    "src/a.ts:Store",
    "src/a.ts:Row",
    "src/a.ts:LIMIT",
    "src/lib.rs:parse",
    "src/lib.rs:fetch",
    "src/lib.rs:Config",
    "src/lib.rs:check",
    "main.go:Serve",
    "main.go:Stop",
    "main.go:Server",
    "app.py:Repo",
    "app.py:save",
    "app.py:main",
    "Order.java:Order",
    "Order.java:of",
    "Order.java:byId",
    "Svc.kt:Line",
    "Svc.kt:refund",
    "Svc.kt:second",
  ]);
  assert.deepEqual(declarationsIn(file("src/a.test.ts", "export function helper() {}"), (f) => /\.test\./.test(f)), []);
});

test("lint: a Cargo project is linted with clippy unless package.json names its own lint", async () => {
  const { detectLint } = await import("../extensions/pb/verify.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pb-clippy-"));
  fs.writeFileSync(path.join(dir, "Cargo.toml"), '[package]\nname = "x"\n');
  assert.equal(detectLint(dir), "cargo clippy -q --all-targets -- -D warnings");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { lint: "eslint ." } }));
  assert.equal(detectLint(dir), "npm run lint --silent");
});

/** A project whose auto-detected lint counts its runs and fails while bad.txt is committed. */
const autoLintProject = (config: object, bad: boolean) => {
  const t = setup({ verify: "true", ...config });
  fs.writeFileSync(path.join(t.repo, "package.json"), JSON.stringify({ scripts: { lint: "echo lint >> lint.log && test ! -f bad.txt" } }));
  if (bad) fs.writeFileSync(path.join(t.repo, "bad.txt"), "debt");
  execSync("git add -A && git commit -qm project", { cwd: t.repo }); // the baseline runs on the commit
  return t;
};
const lintRuns = (t: ReturnType<typeof setup>) => (fs.existsSync(path.join(t.repo, "lint.log")) ? fs.readFileSync(path.join(t.repo, "lint.log"), "utf8").split("\n").filter(Boolean).length : 0);

test("lint gate: an auto-detected lint the baseline ran clean gates every task", async () => {
  const t = autoLintProject({ baseline: true }, false);
  process.chdir(t.repo);
  await t.run("plan", "cancel orders");
  await until(() => t.posts.some((p) => p.startsWith("**Baseline**")));
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  const p = t.progress("order-cancellation");
  assert.equal(p.lintGate, "task");
  assert.equal(p.phase, "built");
  assert.ok(t.events("order-cancellation").some((e: any) => e.type === "check" && e.task === "T1" && e.lint === true));
  assert.match(t.instructions.find((i) => /Task T1/.test(i))!, /it runs `test -f T1\.txt` then `npm run lint --silent` itself/);
  assert.ok(!t.notes.some((n) => /gates only the final check/.test(n)));
});

test("lint gate: an auto-detected lint already red at baseline leaves the tasks alone and fails only the final check", async () => {
  const t = autoLintProject({ baseline: true }, true);
  process.chdir(t.repo);
  await t.run("plan", "cancel orders");
  await until(() => t.posts.some((p) => p.startsWith("**Baseline**")));
  await written(t);
  const said: string[] = [];
  t.agent.script = async (text, tool) => {
    const task = taskOf(text);
    if (!task) return;
    if (task !== "final") {
      await tool("pb_tests_red", { task });
      fs.writeFileSync(`${task}.txt`, "x");
    }
    said.push((await tool("pb_task_done", { task, status: "done", changed: `did ${task}`, caveat: "none", rejected: "none", open: "none" })).content![0].text);
  };
  await t.run("build");
  const p = t.progress("order-cancellation");
  assert.equal(p.lintGate, "final");
  assert.ok(t.notes.some((n) => /Lint `npm run lint --silent` gates only the final check of this build: it already failed when planning began/.test(n)));
  assert.match(said[0], /✓ T1/); // the debt does not fail the first task
  assert.doesNotMatch(t.instructions.find((i) => /Task T1/.test(i))!, /npm run lint/);
  assert.ok(!t.events("order-cancellation").some((e: any) => e.type === "check" && e.task === "T1" && "lint" in e));
  assert.ok(said.some((s) => /The final check failed[\s\S]*`npm run lint --silent`/.test(s)));
  assert.equal(p.phase, "paused");
});

test("lint gate: without a baseline on this commit an auto-detected lint waits for the final check; a configured one never does", async () => {
  const t = autoLintProject({}, false);
  process.chdir(t.repo);
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  assert.equal(t.progress("order-cancellation").lintGate, "final");
  assert.ok(t.notes.some((n) => /gates only the final check of this build: no planning baseline ran it on this commit/.test(n)));
  assert.equal(t.progress("order-cancellation").phase, "built");
  assert.equal(lintRuns(t), 1); // once, at the end
  assert.match(t.posts.find((p) => p.includes("Build complete"))!, /lint PASS/);

  const u = autoLintProject({ lint: "npm run lint --silent" }, false); // the same command, configured
  process.chdir(u.repo);
  await written(u);
  u.agent.script = diligent;
  await u.run("build");
  assert.equal(u.progress("order-cancellation").lintGate, "task");
  assert.equal(lintRuns(u), 2); // after T1 and after T2, not again at the end
});

test("lint: auto-detects package.json's lint script; explicit and none resolve", async () => {
  const { detectLint, resolveLint } = await import("../extensions/pb/verify.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pb-lint-"));
  assert.equal(detectLint(dir), null);
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { lint: "eslint ." } }));
  assert.equal(detectLint(dir), "npm run lint --silent");
  assert.equal(resolveLint("auto", dir), "npm run lint --silent");
  assert.equal(resolveLint("none", dir), null);
  assert.equal(resolveLint(null, dir), null);
  assert.equal(resolveLint("./mvnw checkstyle:check", dir), "./mvnw checkstyle:check");
});

test("build: a task with no Test: command gets no red proof, and that is recorded and handed to the reviewer", async () => {
  const t = setup({ verify: "true" });
  await written(
    t,
    SPEC({
      tasks: `### T1: first file
Create T1.txt.
- Acceptance: T1.txt exists
- Test: \`test -f T1.txt\`

### T2: second file
Create T2.txt.
- Acceptance: T2.txt exists`,
    }),
  );
  const said: string[] = [];
  t.agent.script = async (text, tool) => {
    const task = taskOf(text);
    if (task && task !== "final") {
      if (task === "T1") said.push((await tool("pb_tests_red", { task })).content![0].text);
      fs.writeFileSync(`${task}.txt`, "x");
    }
    if (task) return void (await tool("pb_task_done", { task, status: "done", changed: `did ${task}`, caveat: "none", rejected: "none", open: "none" }));
  };
  await t.run("build");
  assert.match(said[0], /^Seen failing: `test -f T1\.txt`/);
  const p = t.progress("order-cancellation");
  assert.equal(p.phase, "built");
  assert.deepEqual(p.tasks.map((x: any) => [x.id, !!x.redCommand]), [["T1", true], ["T2", false]]); // T2 has no command to run
  // T2's proof isn't there, and nothing pretends it is: the build says so, and so does the reviewer.
  assert.match(t.posts.at(-1)!, /Build complete[\s\S]*New tests never seen failing[\s\S]*- T2: no Test: command, so nothing proves its new tests fail without the change/);
  await t.run("review");
  const brief = t.instructions.filter((i) => i.startsWith("[pb:review]")).at(-1)!;
  assert.match(brief, /## New tests never seen failing[\s\S]*Judge each: does its acceptance still have a test that checks it\?/);
  assert.match(brief, /- T2: no Test: command, so nothing proves its new tests fail without the change/);
  assert.doesNotMatch(brief, /- T1: no Test: command/); // its own test proved it, so it isn't listed
});

test("red proof: a task seen failing stores its command, and a proven task is not listed as unproven", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  const p = t.progress("order-cancellation");
  assert.equal(p.phase, "built");
  const [t1, t2] = p.tasks;
  assert.equal(t1.redCommand, "test -f T1.txt");
  assert.equal(t2.redCommand, "test -f T2.txt");
  await t.run("review");
  const brief = briefOf(t);
  assert.doesNotMatch(brief, /## Red proof/); // no claim is stored or judged: the diff shows the tests themselves
  assert.doesNotMatch(brief, /## New tests never seen failing/); // both tasks were proven
});

test("build: a command an earlier task already proved records that no run could prove the later task's tests", async () => {
  const t = setup({ verify: "test -f T1.txt && test -f T2.txt" });
  await written(
    t,
    SPEC({
      tasks: `### T1: first file
Create T1.txt.
- Acceptance: T1.txt exists
- Test: \`test -f both.txt\`

### T2: second file
Create T2.txt.
- Acceptance: T2.txt exists
- Test: \`test -f both.txt\``,
    }),
  );
  const said: string[] = [];
  t.agent.script = async (text, tool) => {
    const task = taskOf(text);
    if (task && task !== "final") {
      said.push((await tool("pb_tests_red", { task, tests: `${task}.txt exists` })).content![0].text);
      fs.writeFileSync(`${task}.txt`, "x");
      if (task === "T1") fs.writeFileSync("both.txt", "x"); // more than its slice: T2's command now passes
    }
    if (task) return void (await tool("pb_task_done", { task, status: "done", changed: `did ${task}`, caveat: "none", rejected: "none", open: "none" }));
  };
  await t.run("build");
  assert.match(said[0], /^Seen failing: `test -f both\.txt`/); // T1 proved it
  assert.match(said[1], /`test -f both\.txt` cannot fail again: T1 \(done\) proved this command[\s\S]*reviewer is told/);
  const p = t.progress("order-cancellation");
  assert.equal(p.phase, "built");
  assert.deepEqual(p.tasks.map((x: any) => [x.id, !!x.redCommand]), [["T1", true], ["T2", false]]);
  // Named, not blurred: the reviewer knows exactly whose run satisfies T2.
  assert.match(t.posts.at(-1)!, /New tests never seen failing[\s\S]*- T2: `test -f both\.txt` was already proved by T1/);
  await t.run("review");
  assert.match(t.instructions.filter((i) => i.startsWith("[pb:review]")).at(-1)!, /- T2: `test -f both\.txt` was already proved by T1/);
});

test("build: coherence pass runs on 3+ task builds and is skipped on smaller ones", async () => {
  const t = setup({ verify: "true" });
  await written(t, SPEC({ tasks: THREE_TASKS }));
  const seen: string[] = [];
  t.agent.script = withCohere(seen, async (_text, tool) => {
    await tool("pb_task_done", { task: "cohere", status: "done", changed: "nothing to consolidate", caveat: "none", rejected: "none", open: "none" });
  });
  await t.run("build");
  const p = t.progress("order-cancellation");
  assert.equal(p.phase, "built");
  assert.equal(seen.length, 1);
  assert.deepEqual(p.tasks.map((x: any) => [x.id, x.status]), [["T1", "done"], ["T2", "done"], ["T3", "done"], ["cohere", "done"]]);
  assert.match(t.posts.at(-1)!, /cohere/); // the completed build lists the pass

  const u = setup({ verify: "true" });
  await written(u);
  u.agent.script = diligent;
  await u.run("build");
  assert.equal(u.progress("order-cancellation").phase, "built");
  assert.ok(!u.progress("order-cancellation").tasks.some((x: any) => x.id === "cohere"));
});

test("build: pausing mid-coherence resumes the pass instead of stranding the build", async () => {
  const t = setup({ verify: "true" });
  await written(t, SPEC({ tasks: THREE_TASKS }));
  let coheres = 0;
  t.agent.script = withCohere([], async (_text, tool) => {
    coheres++;
    if (coheres === 1) return; // stop without finishing: nudge, then pause
    await tool("pb_task_done", { task: "cohere", status: "done", changed: "consolidated on retry", caveat: "none", rejected: "none", open: "none" });
  });
  await t.run("build");
  assert.equal(t.progress("order-cancellation").phase, "paused");
  await t.run("build");
  const p = t.progress("order-cancellation");
  assert.equal(p.phase, "built");
  assert.equal(coheres, 2);
  assert.deepEqual(p.tasks.find((x: any) => x.id === "cohere").status, "done");
});

test("build: undoing the coherence pass restores files and the pass re-runs", async () => {
  const t = setup({ verify: "true" });
  await written(t, SPEC({ tasks: THREE_TASKS }));
  let coheres = 0;
  t.agent.script = withCohere([], async (_text, tool) => {
    coheres++;
    if (coheres === 1) fs.appendFileSync("T1.txt", "# consolidated\n");
    await tool("pb_task_done", { task: "cohere", status: "done", changed: coheres === 1 ? "consolidated" : "nothing left", caveat: "none", rejected: "none", open: "none" });
  });
  await t.run("build");
  assert.equal(t.progress("order-cancellation").phase, "built");
  assert.match(t.read("T1.txt"), /consolidated/);
  await t.run("undo", "cohere");
  assert.equal(t.progress("order-cancellation").phase, "paused");
  assert.ok(!t.progress("order-cancellation").tasks.some((x: any) => x.id === "cohere"));
  assert.doesNotMatch(t.read("T1.txt"), /consolidated/);
  await t.run("build");
  assert.equal(t.progress("order-cancellation").phase, "built");
  assert.equal(coheres, 2);
});

test("build: without a shared proven command, a passing task still wedges honestly — blocked, for the human", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  const said: string[] = [];
  t.agent.script = async (text, tool) => {
    const task = taskOf(text) ?? (text.includes("Continue task T1") ? "T1" : undefined);
    if (task === "T1" && !said.length) {
      said.push((await tool("pb_tests_red", { task })).content![0].text);
      fs.writeFileSync("T1.txt", "x");
      fs.writeFileSync("T2.txt", "x"); // more than its slice, under a different command
      return void (await tool("pb_task_done", { task, status: "done", changed: "did T1 and T2's bit", caveat: "none", rejected: "none", open: "none" }));
    }
    if (task === "T2") {
      said.push((await tool("pb_tests_red", { task })).content![0].text);
      said.push((await tool("pb_task_done", { task, status: "done", changed: "nothing left", caveat: "none", rejected: "none", open: "none" })).content![0].text);
      return void (await tool("pb_task_done", { task, status: "blocked", summary: "T1 already did it; my command passes and no earlier task proved it" }));
    }
    return diligent(text, tool);
  };
  await t.run("build");
  assert.match(said[1], /`test -f T2\.txt` passes without the change/); // not pre-green: no earlier task proved this command
  assert.doesNotMatch(said[1], /already passes/);
  assert.match(said[2], /T2's new tests were never seen failing/); // the refusal: no legitimate move but blocked
  assert.equal(t.progress("order-cancellation").phase, "paused");
});

test("build: a spec edited while the placement dialog is open is not approved on the reviewed text", async () => {
  const t = setup({ verify: "true", freshAbove: 0 });
  process.chdir(t.repo);
  await written(t);
  process.env.MOCK_SELECT_TOUCH = path.join(t.repo, ".pi/pb/specs/order-cancellation/spec.md"); // saved while the dialog is open
  t.selects.push("Build here anyway");
  try {
    await t.run("build");
  } finally {
    delete process.env.MOCK_SELECT_TOUCH;
  }
  assert.match(t.notes.at(-1)!, /The spec changed while it was under review/);
  assert.equal(t.progress("order-cancellation").phase, "written"); // nothing started on the stale text
  assert.ok(!t.instructions.some((i) => i.startsWith("[pb:build"))); // no task was handed out
});

test("build: a failing check goes back to the agent, and passes on the next attempt", async () => {
  const t = setup({ taskChecks: "each",  verify: "true" });
  await written(t);
  let lazy = true;
  t.agent.script = async (text, tool) => {
    if (text.includes("Task T1") && lazy) {
      lazy = false; // first attempt forgets the file
      await tool("pb_tests_red", { task: "T1" });
      return void (await tool("pb_task_done", { task: "T1", status: "done", changed: "claimed", caveat: "none", rejected: "none", open: "none" }));
    }
    return diligent(text, tool);
  };
  await t.run("build");
  assert.ok(t.instructions.some((i) => /The check for T1 failed \(attempt 2 of 2\)[\s\S]*test -f T1\.txt[\s\S]*call pb_task_done again/.test(i)));
  assert.equal(t.progress("order-cancellation").phase, "built");
});

test("build: after the last attempt it pauses; /pb:build resumes with a fresh set", async () => {
  const t = setup({ taskChecks: "each",  verify: "true" });
  await written(t);
  let give = false;
  t.agent.script = async (text, tool) => {
    const task = text.match(/(?:Task|check for) (T\d+)/)?.[1];
    if (task === "T1" && !give) {
      await tool("pb_tests_red", { task });
      return void (await tool("pb_task_done", { task, status: "done", changed: "claimed", caveat: "none", rejected: "none", open: "none" }));
    }
    return diligent(text, tool);
  };
  await t.run("build");
  const p = t.progress("order-cancellation");
  assert.equal(p.phase, "paused");
  assert.match(t.posts.at(-1)!, /Build paused — order-cancellation\*\*[\s\S]*T1 still fails after 2 attempts/);
  assert.match(t.posts.at(-1)!, /build time so far: (?:<1s|\d+s)/);
  assert.match(t.results.at(-1)!, /That was the last attempt: the build is paused\. Stop here/);
  give = true;
  await t.run("build", "create the file in the repo root");
  assert.equal(t.progress("order-cancellation").phase, "built");
  assert.match(t.read(".pi/pb/specs/order-cancellation/spec.md"), /- create the file in the repo root/); // guidance recorded as a decision
  assert.match(t.instructions.find((i) => /From the human: create the file/.test(i))!, /Task T1 \(attempt 1 of 2\)|Task T1\. Do only/);
});

test("build: a resume approves a contract changed while paused only after showing the diff", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  let stopped = false;
  t.agent.script = async (text, tool) => {
    if (text.includes("Task T2") && !text.includes("You stopped") && !stopped) {
      stopped = true; // the first handout only: T2 stops, is reminded, stops again — the build pauses
      return undefined;
    }
    if (text.includes("You stopped without finishing T2")) return undefined; // the reminder: stop again, so the build pauses
    if (text.includes("Continue task T2")) return diligent("Task T2", tool); // the approved resume hands T2 back: finish it
    return diligent(text, tool);
  };
  await t.run("build"); // T2 stops, is reminded, stops again: the build pauses
  assert.equal(t.progress("order-cancellation").phase, "paused");
  const { setSection } = await import("../extensions/pb/spec.ts");
  const specPath = path.join(t.repo, ".pi/pb/specs/order-cancellation/spec.md");
  fs.writeFileSync(specPath, setSection(t.read(".pi/pb/specs/order-cancellation/spec.md"), "Contracts", "- T1 owns T1.txt; T2 owns T2.txt; deletes are forbidden."));
  t.confirmAnswers.push(false); // the human reads the diff and declines
  await t.run("build");
  assert.match(t.notes.at(-1)!, /Not re-approved: the build stays paused/);
  assert.equal(t.progress("order-cancellation").phase, "paused");
  await t.run("build"); // then approves it
  assert.match(t.confirms.at(-1)!, /contract changed while the build was paused/);
  assert.match(t.confirmBodies.at(-1)!, /deletes are forbidden/); // what the contract now says
  assert.match(t.confirmBodies.at(-1)!, /no shared seams beyond the file list/); // what it was approved at
  assert.equal(t.progress("order-cancellation").phase, "built");
});

test("build: the build never asks; ambiguity is a reading recorded as an assumption", async () => {
  const t = setup({ verify: "true", askTimeoutSec: 0.001 });
  await written(t);
  let answer: Result | undefined;
  t.agent.script = async (text, tool) => {
    if (text.includes("Task T1")) await tool("pb_record_decision", { decision: "Follow the layout rules over the mockup: the rules are marked exact.", assumption: true });
    if (text.includes("Task T2")) answer = await tool("pb_ask", { question: "Which file name?", options: ["t2.txt", "T2.txt"], recommended: "T2.txt" });
    return diligent(text, tool);
  };
  await t.run("build");
  assert.equal(t.selects.length, 0); // no dialog was opened, and nothing counted down
  assert.equal(t.dialogTimeouts.length, 0);
  assert.match(answer!.content![0].text, /This build is autonomous: don't ask\. Take the sensible reading and record it with pb_record_decision/);
  assert.equal(t.stat.runs, 1); // no pause, no resume
  const spec = t.read(".pi/pb/specs/order-cancellation/spec.md");
  assert.match(spec, /- Assumption \(build, T1\): Follow the layout rules over the mockup/);
  assert.doesNotMatch(spec, /Which file name/);
  assert.match(t.posts.at(-1)!, /Build complete[\s\S]*Choices the build made where the spec was unclear[\s\S]*Assumption \(build, T1\): Follow the layout rules/);
});

test("build: a colon Decisions heading takes decisions and guidance without wrecking the spec", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  const { Store } = await import("../extensions/pb/store.ts");
  new Store(t.repo).markAsked("standards");
  await t.callTool("pb_write_spec", { name: "order-cancellation", content: SPEC().replace("## Decisions\n", "## Decisions:\n") });
  t.agent.script = async (text, tool) => {
    if (text.includes("Task T1")) await tool("pb_record_decision", { decision: "Follow the layout rules over the mockup: the rules are marked exact.", assumption: true });
    return diligent(text, tool);
  };
  await t.run("build", "order-cancellation use a helper for the email");
  const spec = t.read(".pi/pb/specs/order-cancellation/spec.md");
  assert.equal((spec.match(/^##\s+Decisions\s*:?\s*$/gim) ?? []).length, 1); // no duplicate heading appeared
  assert.match(spec, /- Assumption \(build, T1\): Follow the layout rules/);
  assert.match(spec, /- use a helper for the email/);
  assert.deepEqual(parseSpec(spec).errors, []);
  assert.match(t.posts.at(-1)!, /Choices the build made where the spec was unclear[\s\S]*Assumption \(build, T1\): Follow the layout rules/);
});

test("build: a question asked during a build never opens a dialog, even when a timeout is configured", async () => {
  const t = setup({ verify: "true", askTimeoutSec: 0.001 });
  await written(t);
  let answer: Result | undefined;
  t.agent.script = async (text, tool) => {
    if (text.includes("Task T2")) answer = await tool("pb_ask", { question: "Which file name?", options: ["t2.txt", "T2.txt"], recommended: "T2.txt" });
    return diligent(text, tool);
  };
  t.selects.push("T2.txt (recommended)", "<timeout>");
  await t.run("build");
  assert.equal(t.dialogTimeouts.length, 0); // the refusal never reaches a dialog or its timeout
  assert.match(answer!.content![0].text, /This build is autonomous/);
  assert.equal(t.progress("order-cancellation").phase, "built");
  assert.doesNotMatch(t.read(".pi/pb/specs/order-cancellation/spec.md"), /Assumption \(build, T2, no answer/);
});

test("build: without a UI a question is refused too; the build carries on and the task keeps its attempt", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  t.runtime().hasUI = false;
  let answer: Result | undefined;
  t.agent.script = async (text, tool) => {
    if (text.includes("Task T2") && !answer) answer = await tool("pb_ask", { question: "Which file name?" });
    return diligent(text, tool);
  };
  await t.run("build");
  assert.match(answer!.content![0].text, /This build is autonomous: don't ask/);
  assert.ok(!t.posts.some((x) => /Build paused/.test(x)));
  const p = t.progress("order-cancellation");
  assert.equal(p.phase, "built");
  assert.equal(p.tasks.find((x: any) => x.id === "T2").attempts, 1);
});

test("build: an agent that stops mid-task is reminded once, like a stop hook, before the build pauses", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  let idle = true;
  t.agent.script = async (text, tool) => {
    if (text.includes("Task T2") && idle) {
      idle = false; // stops with a prose summary instead of pb_task_done
      return;
    }
    if (text.includes("You stopped without finishing T2")) return diligent("Task T2", tool);
    return diligent(text, tool);
  };
  await t.run("build");
  assert.equal(t.progress("order-cancellation").phase, "built");
  assert.equal(t.events("order-cancellation").filter((e) => e.type === "nudge").length, 1);
});

test("build: a surviving pending-build record doesn't silence the stopped-agent pause", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  const { Store } = await import("../extensions/pb/store.ts");
  // A record the pending offer never consumed (the session was replaced at its dialog, say):
  // the explicit build consumes it, or agent_settled keeps "still waiting" instead of pausing.
  new Store(t.repo).setPendingBuild(t.runtime().ctx.sessionManager.getSessionFile());
  t.agent.script = async (text, tool) => (text.includes("Task T1") && !text.includes("You stopped") ? undefined : diligent(text, tool));
  await t.run("build");
  assert.equal(t.progress("order-cancellation").phase, "paused");
  assert.match(t.posts.at(-1)!, /Build paused/);
});

test("build: pb_task_done must name the current task", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  let err: string | undefined;
  t.agent.script = async (text, tool) => {
    if (text.includes("Task T1")) err ??= (await tool("pb_task_done", { task: "T2", status: "done", summary: "" })).error;
    return diligent(text, tool);
  };
  await t.run("build");
  assert.equal(err, "The current task is T1, not T2.");
});

test("build tools say why they cannot run: no build, paused, finished or not started", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  const { Store } = await import("../extensions/pb/store.ts");
  const store = new Store(t.repo);
  const session = t.runtime().ctx.sessionManager.getSessionFile();
  const done = () => t.callTool("pb_task_done", { task: "T1", status: "done", changed: "x", caveat: "none", rejected: "none", open: "none" });
  const red = () => t.callTool("pb_tests_red", { task: "T1" });

  // The spec is written, but not built in this session.
  assert.equal((await done()).error, "No pb build is running in this session.");
  assert.equal((await red()).error, "No pb build is running in this session.");

  const base = t.progress("order-cancellation");
  store.saveProgress({
    ...base,
    phase: "paused",
    session,
    current: "T1",
    pause: "T1 blocked: waiting for a decision",
    tasks: base.tasks.map((task: any) => ({ ...task, status: task.id === "T1" ? "doing" : task.status })),
  });
  const pausedDone = (await done()).error!;
  const pausedRed = (await red()).error!;
  assert.match(pausedDone, /The build of order-cancellation is paused at T1: the human decides how to go on\. To resume it, run \/pb:build order-cancellation\./);
  assert.match(pausedRed, /The build of order-cancellation is paused at T1/);
  assert.doesNotMatch(pausedDone, /No pb build/);

  store.saveProgress({ ...t.progress("order-cancellation"), phase: "built", pause: undefined });
  const builtDone = (await done()).error!;
  const builtRed = (await red()).error!;
  assert.match(builtDone, /The build of order-cancellation is finished, so there is nothing to record\. To review it, run \/pb:review order-cancellation\./);
  assert.match(builtRed, /The build of order-cancellation is finished/);
  assert.doesNotMatch(builtRed, /No pb build/);

  store.saveProgress({ ...t.progress("order-cancellation"), phase: "reviewed" });
  const reviewedDone = (await done()).error!;
  assert.match(reviewedDone, /The build of order-cancellation is finished and reviewed, so there is nothing left to record\./);
  assert.doesNotMatch(reviewedDone, /No pb build/);

  store.saveProgress({ ...t.progress("order-cancellation"), phase: "written", current: undefined });
  const notStarted = (await done()).error!;
  assert.match(notStarted, /The build of order-cancellation has not started\. Run \/pb:build order-cancellation to start it\./);
  assert.doesNotMatch(notStarted, /No pb build/);
});

test("build: pb_task_done reports changed/caveat/rejected/open; missing hooks are rejected", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  let hooksErr: string | undefined;
  let blockedErr: string | undefined;
  t.agent.script = async (text, tool) => {
    if (text.includes("Task T1")) {
      hooksErr ??= (await tool("pb_task_done", { task: "T1", status: "done", changed: "x" })).error;
      blockedErr ??= (await tool("pb_task_done", { task: "T1", status: "blocked" })).error;
    }
    return diligent(text, tool);
  };
  await t.run("build");
  assert.match(hooksErr!, /needs caveat, rejected, open/);
  assert.match(blockedErr!, /needs summary/);
  assert.equal(t.progress("order-cancellation").phase, "built");
});

test("build: every task handout names the spec and its binding sections", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  const reference = /The spec that binds this work is \.pi\/pb\/specs\/order-cancellation\/spec\.md: read "Goal", "Out of scope", "Decisions", "Design", "Contracts", "Migration and rollback", "Threats and abuse", "Threats" before you change anything/;
  assert.match(t.results[0], reference);
  assert.doesNotMatch(t.results[0], /## Goal\nCancel orders\./); // the spec is named, never pasted
  const next = t.instructions.find((i) => i.startsWith("✓ T1"))!;
  assert.match(next, reference);
});

test("build state summaries show hooks and hide nones", async () => {
  const { buildStateSummary } = await import("../extensions/pb/prompts.ts");
  const p = {
    spec: "x",
    phase: "building",
    current: "T2",
    tasks: [
      { id: "T1", title: "first", status: "done", attempts: 1, changed: "did T1", caveat: "T2 must keep the hook", rejected: "none", open: "none" },
      { id: "T2", title: "second", status: "doing", attempts: 1 },
    ],
  } as any;
  const s = buildStateSummary({ p, mechanics: "m", current: "next", reason: "reset" });
  assert.match(s, /- T1 first: done — did T1 · caveat: T2 must keep the hook/);
  assert.doesNotMatch(s, /rejected: none/);
});

test("build state summaries name the spec, keep hooks, and never carry the spec text", async () => {
  const { buildStateSummary } = await import("../extensions/pb/prompts.ts");
  const long = "detail ".repeat(80);
  const p = {
    spec: "order-cancellation",
    phase: "building",
    current: "T2",
    assumptions: ["Only PENDING orders can be cancelled, because the state machine only allows that transition.", "Assumption (build, T1): the spec refused this one"],
    tasks: [
      { id: "T1", title: "first", status: "done", attempts: 1, changed: "did T1", caveat: long, rejected: "none", open: "none" },
      { id: "T2", title: "second", status: "doing", attempts: 1 },
    ],
  } as any;
  const s = buildStateSummary({ p, markdown: SPEC(), mechanics: "m", current: "next", reason: "reset" });
  assert.match(s, /spec is the source of truth \(\.pi\/pb\/specs\/order-cancellation\/spec\.md/);
  assert.doesNotMatch(s, /--- spec ---|--- spec:|# Order cancellation/); // the spec is a path, never a copy
  assert.doesNotMatch(s, /Only PENDING orders/); // already in the spec's Decisions: not repeated
  assert.match(s, /Assumptions made so far, not in the spec's Decisions:\n- Assumption \(build, T1\): the spec refused this one/);
  assert.match(s, /caveat: detail[^\n]*…/); // the hook keeps its per-line bound
  const hook = s.split("\n").find((l) => l.includes("caveat:"))!;
  assert.ok(hook.length < 230);
});

test("prompts: task, retry and coherence messages name the spec instead of pasting it", async () => {
  const { specReference, coherePrompt, fixText, taskPrompt } = await import("../extensions/pb/prompts.ts");
  const reference = specReference("order-cancellation");
  assert.match(reference, /^The spec that binds this work is \.pi\/pb\/specs\/order-cancellation\/spec\.md: read "Goal"/);
  const task = parseSpec(SPEC()).spec!.tasks[0];
  assert.match(taskPrompt(task, 1, 3, [], false, reference), /Do only this task:[\s\S]*The spec that binds this work[\s\S]*before you change anything/);
  assert.doesNotMatch(taskPrompt(task, 1, 3, [], false, reference), /## Goal|## Contracts/); // no copy
  assert.match(fixText("T1", "`true` failed", "output", 1, 3, false, reference), /output\n\nThe spec that binds this work[\s\S]*Fix the cause/);
  assert.match(coherePrompt("abc", 1, 3, reference), /never weaken an existing test\.[\s\S]*The spec that binds this work/);
  assert.doesNotMatch(taskPrompt(task, 1, 3, [], false), /The spec that binds/);
});

test("build: verification none runs no checks; no new tests reaches the agent", async () => {
  const t = setup({ verify: "false" }); // would fail if it ran
  await written(t, SPEC({ verification: "none — docs only", newTests: "no — the human said so", tasks: TASKS_PLAIN }));
  t.agent.script = diligent;
  await t.run("build");
  assert.equal(t.progress("order-cancellation").phase, "built");
  assert.match(t.instructions[0], /Tests: add none for this feature \(the human said so\)[\s\S]*no checks run \(docs only\)/);
});

test("build: existing tests cut down or skipped don't fail a task: they are listed and handed to the reviewer", async () => {
  const t = setup({ verify: "true" });
  fs.mkdirSync(path.join(t.repo, "tests"));
  fs.writeFileSync(path.join(t.repo, "tests/test_a.py"), "def test_a():\n    pass\ndef test_b():\n    pass\n");
  execSync("git add . && git commit -qm tests", { cwd: t.repo });
  await written(t);
  t.agent.script = async (text, tool) => {
    if (text.includes("Task T1")) fs.writeFileSync("tests/test_a.py", "def test_parametrized():\n    pass\n"); // a refactor merged them
    return diligent(text, tool);
  };
  await t.run("build");
  const p = t.progress("order-cancellation");
  assert.equal(p.phase, "built");
  assert.equal(t.stat.runs, 1);
  assert.deepEqual(p.testChanges, ["T1: tests/test_a.py: 2 → 1 test cases"]);
  assert.match(t.results[0], /⚠ existing tests changed \(the review checks them\): tests\/test_a\.py: 2 → 1 test cases/); // T1's
  assert.match(t.posts.at(-1)!, /Build complete[\s\S]*Existing tests the build changed[\s\S]*- T1: tests\/test_a\.py: 2 → 1 test cases/);
  await t.run("review");
  assert.match(t.instructions.filter((i) => i.startsWith("[pb:review]")).at(-1)!, /## Existing tests the build changed[\s\S]*judge whether each was justified:\n- T1: tests\/test_a\.py: 2 → 1 test cases/);
});

test("build: by default, a task runs only its own red-proven Test:, never the suite; the full suite runs after the last, and a failure goes back", async () => {
  const t = setup({ verify: "test -f T1.txt && test -f T2.txt && test -f fixed.txt" });
  await written(t);
  t.agent.script = async (text, tool) => {
    if (text.includes('task "final"')) fs.writeFileSync("fixed.txt", "x");
    return diligent(text, tool);
  };
  await t.run("build");
  const checks = t.events("order-cancellation").filter((e) => e.type === "check");
  assert.deepEqual(checks.map((c) => [c.task, c.command, c.ok]), [
    ["T1", "test -f T1.txt", true], // the green half of T1's red proof, run by pb
    ["T2", "test -f T2.txt", true],
    ["final", "test -f T1.txt && test -f T2.txt && test -f fixed.txt", false],
    ["final", "test -f T1.txt && test -f T2.txt && test -f fixed.txt", true],
  ]);
  assert.match(t.instructions[0], /after the last task the harness runs the full suite, and a task that proved its tests red has its own Test: run when it reports done/);
  assert.match(t.instructions[0], /When done, call pb_task_done with task "T1": it runs `test -f T1\.txt` itself, so don't run that just before/);
  assert.match(t.results[0], /✓ T1 passed \(`test -f T1\.txt`\)/);
  assert.match(t.results[1], /The final check failed \(attempt 2 of 2\)/); // the last task's done runs the whole suite
  assert.equal(t.progress("order-cancellation").phase, "built");
  assert.equal(t.stat.runs, 1);
});

test("build: a compaction in the middle of a task: pb's summary carries the rules, the task, and what it changed so far", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  t.agent.script = async (text, tool) => {
    if (text.includes("Task T2")) {
      await tool("pb_tests_red", { task: "T2" });
      fs.writeFileSync("T2.txt", "halfway");
      const prep = { firstKeptEntryId: "e9", tokensBefore: 90000, previousSummary: "We discussed audit.", fileOps: { read: new Set(["src/order.ts", "T2.txt"]), edited: new Set(), written: new Set() } };
      const [r] = (await t.fire("session_before_compact", { preparation: prep, reason: "threshold" })) as any[];
      assert.equal(r.compaction.firstKeptEntryId, "e9");
      assert.match(
        r.compaction.summary,
        /^\[pb build state: order-cancellation\] This conversation was compacted in the middle of T2\. Carry on[\s\S]*How this build works:\n- This build is autonomous[^\n]*Where the spec is unclear[\s\S]*Finish each task with pb_task_done[\s\S]*- T1 first file: done — did T1[\s\S]*- T2 second file: doing \(current\)[\s\S]*Files T2 has changed so far:\n- T2\.txt[\s\S]*Files read before this point \(read again what you need\):\n- src\/order\.ts\n[\s\S]*We discussed audit\.[\s\S]*--- current ---\n\[pb:build\] Task T2\. Do only this task[\s\S]*The spec that binds this work is \.pi\/pb\/specs\/order-cancellation\/spec\.md/,
      );
      assert.doesNotMatch(r.compaction.summary, /# Order cancellation/); // the summary names the spec, never copies it
      // A planning checkpoint as the previous summary isn't repeated: the spec is there already.
      const [again] = (await t.fire("session_before_compact", { preparation: { ...prep, previousSummary: "[pb plan checkpoint] … the whole spec …" }, reason: "threshold" })) as any[];
      assert.doesNotMatch(again.compaction.summary, /the whole spec/);
    }
    const task = taskOf(text);
    if (task === "T1") return diligent(text, tool); // its red has not run yet
    if (task) await tool("pb_task_done", { task, status: "done", changed: `did ${task}`, caveat: "none", rejected: "none", open: "none" });
  };
  await t.run("build");
  assert.equal(t.progress("order-cancellation").phase, "built");
  assert.ok(t.events("order-cancellation").some((e) => e.type === "compact" && e.task === "T2"));
});

test("build: past checkpointAt, the session is reset at the next task boundary; undo works on both sides of it", async () => {
  /** T1 fills the context to 76%: past checkpointAt (75%). */
  const filling = (x: ReturnType<typeof setup>): Script => async (text, tool) => {
    if (text.includes("Task T1")) x.runtime().usage = 76;
    if (text.includes("Task T2")) x.runtime().usage = 5;
    return diligent(text, tool);
  };
  const t = setup({ verify: "true", buildReset: "threshold" });
  await written(t);
  t.agent.script = filling(t);
  await t.run("build");
  assert.equal(t.resets.length, 1);
  assert.equal(t.resets[0].firstKeptEntryId, null);
  assert.match(t.resets[0].summary, /^\[pb build state: order-cancellation\] The build session was reset between two tasks[\s\S]*How this build works:[\s\S]*- T1 first file: done — did T1[\s\S]*--- next ---\n\[pb:build\] Task T2\. Do only this task[\s\S]*The spec that binds this work is \.pi\/pb\/specs\/order-cancellation\/spec\.md/);
  assert.doesNotMatch(t.resets[0].summary, /# Order cancellation/);
  assert.ok(t.posts.some((p) => /\*\*Context reset\*\* before T2 \(it was 76% full\)/.test(p)));
  assert.doesNotMatch(t.context(), /\[pb:build order-cancellation\] Build the spec/); // T1's conversation is gone
  assert.equal(t.progress("order-cancellation").phase, "built");
  const cps = JSON.parse(t.read(".pi/pb/specs/order-cancellation/checkpoints.json"));
  const t2 = cps.find((c: any) => c.id === "T2");
  assert.equal(t.entry(t2.entry)!.type, "compaction"); // T2 starts at the reset
  assert.ok(t.events("order-cancellation").some((e) => e.type === "reset" && e.task === "T2" && e.percent === 76));

  await t.run("undo", "T2"); // back to the reset: the summary with T2 to do
  assert.equal(t.navigations.at(-1)!.target, t2.entry);
  const n = t.navigations.length;
  await t.run("undo", "T1"); // before the reset: files only, with a note
  assert.equal(t.navigations.length, n);
  assert.ok(!fs.existsSync(path.join(t.repo, "T1.txt")));
  assert.match(t.posts.at(-1)!, /The conversation wasn't rewound \(that point is before a context reset or compaction\)/);

  const u = setup({ verify: "true", buildReset: "never" }); // Pi compacts when full, with pb's summary
  await written(u);
  u.agent.script = filling(u);
  await u.run("build");
  assert.equal(u.resets.length, 0);
});

test("build: every task starts from a fresh context by default, with the done tasks' files and a pointer to the code", async () => {
  const t = setup({ verify: "true" }); // usage stays low, far below checkpointAt
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  assert.equal(t.resets.length, 1); // T1 -> T2
  assert.equal(t.resets[0].firstKeptEntryId, null);
  assert.match(t.resets[0].summary, /^\[pb build state: order-cancellation\] The build session was reset between two tasks/);
  assert.match(t.resets[0].summary, /Already done: T1 \(T1\.txt\)\. This is a pointer, not the truth: before editing, inspect the earlier tasks' code this task depends on/); // harness-computed, not the model's report
  assert.match(t.resets[0].summary, /If it matches, extend it rather than duplicating it/); // not a mandate to copy it
  assert.match(t.resets[0].summary, /--- next ---\n\[pb:build\] Task T2\./);
  assert.doesNotMatch(t.context(), /\[pb:build order-cancellation\] Build/); // T1's conversation is gone
  assert.ok(t.events("order-cancellation").some((e) => e.type === "reset" && e.task === "T2" && e.percent === 10));
  assert.equal(t.progress("order-cancellation").phase, "built");
});

test("reset: buildReset threshold uses checkpointAt, and never leaves compaction to Pi", async () => {
  /** The context is this full by the time T1 finishes. */
  const filledTo = (x: ReturnType<typeof setup>, percent: number): Script => async (text, tool) => {
    if (text.includes("Task T1")) x.runtime().usage = percent;
    return diligent(text, tool);
  };
  const build = async (percent: number, config = {}) => {
    const x = setup({ verify: "true", buildReset: "threshold", ...config });
    await written(x);
    x.agent.script = filledTo(x, percent);
    await x.run("build");
    return x;
  };

  // Under checkpointAt: no reset, and the build goes straight on to the next task.
  const early = await build(40);
  assert.equal(early.resets.length, 0);
  assert.match(early.context(), /\[pb:build order-cancellation\] Build \.pi\/pb\/specs\/order-cancellation\/spec\.md\./);
  assert.match(early.context(), /\[pb:build\] Task T2\./);
  assert.equal(early.progress("order-cancellation").phase, "built");

  // Past checkpointAt: the session is reset at the task boundary.
  const late = await build(76);
  assert.equal(late.resets.length, 1);
  assert.ok(late.events("order-cancellation").some((e) => e.type === "reset" && e.task === "T2" && e.percent === 76));

  // Where checkpointAt is the tighter bound, it governs.
  const under = await build(55, { checkpointAt: 60 });
  assert.equal(under.resets.length, 0);
  const at = await build(62, { checkpointAt: 60 });
  assert.equal(at.resets.length, 1);
  assert.ok(at.events("order-cancellation").some((e) => e.type === "reset" && e.task === "T2" && e.percent === 62));

  // Never: even a full context is left to Pi.
  const never = await build(90, { buildReset: "never" });
  assert.equal(never.resets.length, 0);
});

test("undo restores the files and tasks to before a task, rewinds the conversation, and can be undone", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  t.say("name files in lower case from now on");
  const leafBefore = t.runtime().ctx.sessionManager.getLeafId();
  t.agent.script = undefined;
  await t.run("undo", "T2");
  assert.ok(!fs.existsSync(path.join(t.repo, "T2.txt")) && fs.existsSync(path.join(t.repo, "T1.txt")));
  assert.deepEqual(t.progress("order-cancellation").tasks.map((x: any) => [x.id, x.status]), [["T1", "done"], ["T2", "todo"]]);
  assert.match(t.posts.at(-1)!, /Undone to before T2\*\* — 1 file\(s\) restored, the conversation rewound/);
  // Back to where T2 was handed out: the reset that starts it, with pb's own summary of what was undone.
  const nav = t.navigations.at(-1)!;
  assert.equal(t.entry(nav.target)!.type, "compaction");
  assert.match(t.text(nav.target), /- T1 first file: done[\s\S]*Task T2\. Do only this task/);
  assert.match(nav.summary!, /The human undid the work from T2 on[\s\S]*T2 ✓ · 1 files · did T2[\s\S]*What the human said meanwhile, still valid unless they say otherwise: "name files in lower case from now on"/);

  await t.run("undo", "u1");
  assert.ok(fs.existsSync(path.join(t.repo, "T2.txt")));
  assert.equal(t.navigations.at(-1)!.target, leafBefore);
  assert.equal(t.navigations.at(-1)!.summary, undefined);
});

test("undo: a file that changed again while the dialog was open is named, not counted as restored", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  process.env.MOCK_CONFIRM_TOUCH = path.join(t.repo, "T2.txt"); // saved while the confirm was open
  try {
    await t.run("undo", "T2");
  } finally {
    delete process.env.MOCK_CONFIRM_TOUCH;
  }
  assert.match(t.posts.at(-1)!, /0 file\(s\) restored/); // the diff said 1; the guard left it alone
  assert.match(t.posts.at(-1)!, /Left alone because they changed again since the diff was taken: T2\.txt/);
  assert.match(fs.readFileSync(path.join(t.repo, "T2.txt"), "utf8"), /edited/); // the drifted content survives
  assert.deepEqual(t.progress("order-cancellation").tasks.map((x: any) => [x.id, x.status]), [["T1", "done"], ["T2", "todo"]]); // the task state still rolled back
});

test("undo: row ids stay unique across undo, revert and rebuild cycles", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  // u2 must be created while T2 is still todo, so its task clone carries the todo state and
  // reverting it makes T2 todo again: undo T2, then undo T1 (its clone holds T2 todo).
  await t.run("undo", "T2");
  await t.run("undo", "T1");
  await t.run("build"); // T1 and T2 rebuild
  await t.run("undo", "T2"); // u3: its task clone holds T2 todo
  await t.run("undo", "u3"); // revert u3: u3 is dropped, T2 is todo again
  await t.run("build"); // T2 finishes again
  await t.run("undo", "T2");
  // The old numbering counted u rows in the pre-undo list (u2, u3) and issued u3 again while
  // the kept rows still held the reverted cycle's u3 — /pb:undo u3 would resolve to the older row.
  const cps = JSON.parse(t.read(".pi/pb/specs/order-cancellation/checkpoints.json"));
  const ids = cps.map((c: any) => c.id);
  assert.deepEqual(new Set(ids).size, ids.length, `duplicate checkpoint ids: ${ids.join(", ")}`);
  assert.match(t.posts.at(-1)!, /Undone to before T2\*\*[\s\S]*\/pb:undo (u\d+)/);
  const printed = t.posts.at(-1)!.match(/\/pb:undo (u\d+)/)![1];
  assert.ok(!ids.slice(0, -1).includes(printed), `the tip printed ${printed}, which already named a row`);
});

test("undo to the start of the build: a resume sends the build's instructions again", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  await t.run("undo", "start");
  assert.equal(t.progress("order-cancellation").needsIntro, true);
  const n = t.instructions.length;
  await t.run("build");
  assert.match(t.instructions[n], /^\[pb:build order-cancellation\] Build \.pi\/pb\/specs\/order-cancellation\/spec\.md\.[\s\S]*\[pb:build\] Task T1\. Do only this task/); // from the start, T1 all over again
  assert.equal(t.progress("order-cancellation").phase, "built");
});

test("status: a build running elsewhere is shown by session id, not file path", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  await t.callTool("pb_write_spec", { name: "order-cancellation", content: SPEC() });
  const p = t.progress("order-cancellation");
  fs.writeFileSync(
    path.join(t.repo, ".pi/pb/specs/order-cancellation/progress.json"),
    JSON.stringify({ ...p, session: path.join(t.repo, "build-session-9.jsonl"), phase: "paused" }),
  );
  await t.run("status");
  assert.match(t.notes.at(-1)!, /session: pi --session build-session-9 /);
  assert.doesNotMatch(t.notes.at(-1)!, /\.jsonl/);
});

test("stats: the Time line carries each phase that recorded a time, and old events still show the build's", async () => {
  const { renderCard } = await import("../extensions/pb/stats.ts");
  const spec = (events: unknown[]) =>
    ({
      name: "demo",
      phase: "reviewed",
      events,
      explore: [],
      progress: { spec: "demo", phase: "reviewed", session: "s", tasks: [], updatedAt: "2026-10-01 10:08:00" },
    }) as any;
  const full = renderCard(
    spec([
      { type: "spec", at: "2026-10-01 09:57:00", ms: 120_000 },
      { type: "spec-review", at: "2026-10-01 09:58:00", ms: 42_000 },
      { type: "build-start", at: "2026-10-01 10:00:00" },
      { type: "built", at: "2026-10-01 10:07:00" },
      { type: "review", verdict: "pass", p: [0, 0, 0, 0], ms: 90_000, at: "2026-10-01 10:08:00" },
    ]),
  );
  assert.match(full, /Time +spec 2m · spec review 42s · build 7m · review 1m 30s/);
  const old = renderCard(
    spec([
      { type: "build-start", at: "2026-10-01 10:00:00" },
      { type: "built", at: "2026-10-01 10:07:00" },
    ]),
  );
  assert.match(old, /Time +build 7m/);
  assert.doesNotMatch(old, /spec review|review 1m/);
  assert.doesNotMatch(renderCard(spec([])), /\nTime /);
});

test("/pb:commit: no phase writes a commit message any more; the command commits the change you confirm, with a message for the moment", async () => {
  const log = (repo: string) => execSync("git log --format=%B%x00 -n 1", { cwd: repo, encoding: "utf8" }).split("\0")[0].trim();
  const filesOf = (repo: string) => execSync("git show --name-only --format= HEAD", { cwd: repo, encoding: "utf8" }).trim().split("\n").sort();
  // The paths the mock cartographer's map names, so the map is written without asking.
  const project = (repo: string) => {
    fs.mkdirSync(path.join(repo, "src/auth"), { recursive: true });
    fs.writeFileSync(path.join(repo, "src/order.ts"), "export {}\n");
    fs.writeFileSync(path.join(repo, "src/auth/Login.java"), "class Login {}\n");
    execSync("git add . && git commit -qm src", { cwd: repo });
  };
  const t = setup({ verify: "true" });
  project(t.repo);
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  assert.doesNotMatch(t.posts.at(-1)!, /Commit message|```text/, "the build no longer posts a message to paste");
  assert.match(t.posts.at(-1)!, /Then `\/pb:commit`/);
  await t.run("review");
  assert.doesNotMatch(t.posts.at(-1)!, /Commit message|```text/, "nor does the review");
  // Your own unrelated edit is offered too: you leave it out in the editor, as in git's own template.
  fs.writeFileSync(path.join(t.repo, "notes.txt"), "mine\n");
  let offered = "";
  t.editors.push((prefill) => {
    offered = prefill;
    return prefill.replace("- notes.txt\n", "");
  });
  await t.run("commit");
  assert.match(offered, /^Order cancellation\n\nCancel orders\.\n\n- first file\n- second file\n\n# Files to commit — delete a line to leave that file out\. Clear the message to cancel\.\n- T1\.txt\n- T2\.txt\n- notes\.txt\n$/);
  assert.equal(log(t.repo), "Order cancellation\n\nCancel orders.\n\n- first file\n- second file", "the editor's comment lines are not the message");
  assert.deepEqual(filesOf(t.repo), ["T1.txt", "T2.txt"], "only the files left in the editor; pb's state and the spec never");
  assert.match(t.posts.at(-1)!, /^\*\*✅ Committed\*\* `[0-9a-f]{7}` — Order cancellation · 2 files · left out, still uncommitted: notes\.txt/);
  assert.ok(fs.existsSync(path.join(t.repo, "notes.txt")), "a file left out is untouched");
  // Nothing of the change left: it says so and stops.
  fs.rmSync(path.join(t.repo, "notes.txt"));
  const asked = t.editors.length;
  await t.run("commit");
  assert.equal(t.notes.at(-1), "Nothing to commit for order-cancellation: no change since the last commit.");
  assert.equal(t.editors.length, asked, "no editor opened");
  // After fixes, the next commit says what they fixed, not the whole feature again.
  new (await import("../extensions/pb/store.ts")).Store(t.repo).event("order-cancellation", { type: "fix", fixed: ["name the constant"], skipped: [] });
  fs.writeFileSync(path.join(t.repo, "T1.txt"), "fixed\n");
  t.editors.push((prefill) => prefill);
  await t.run("commit");
  assert.equal(log(t.repo), "Order cancellation: review fixes\n\n- name the constant");
  // Archived, with the map updated: the map commit names what the map gained.
  await t.run("archive");
  assert.match(t.posts.at(-1)!, /\*\*Next:\*\* `\/pb:commit order-cancellation` commits what's left \(the feature and the map update\), then `\/pb:plan <feature>`/);
  t.editors.push((prefill) => prefill);
  await t.run("commit", "order-cancellation");
  assert.equal(log(t.repo), "Update the project map after Order cancellation\n\n- added Orders\n- noted transactions");
  assert.deepEqual(filesOf(t.repo), ["AGENTS.md"]);
  // Clearing the message cancels.
  const v = setup({ verify: "true" });
  await written(v);
  v.agent.script = diligent;
  await v.run("build");
  const head = execSync("git rev-parse HEAD", { cwd: v.repo, encoding: "utf8" });
  v.editors.push(() => "\n# Files to commit — delete a line to leave that file out. Clear the message to cancel.\n- T1.txt\n");
  await v.run("commit");
  assert.equal(v.notes.at(-1), "Not committed.");
  assert.equal(execSync("git rev-parse HEAD", { cwd: v.repo, encoding: "utf8" }), head);
});

test("/pb:commit: refused while a build is still writing files, and never without someone to confirm", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  const progressFile = path.join(t.repo, ".pi/pb/specs/order-cancellation/progress.json");
  fs.writeFileSync(progressFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(progressFile, "utf8")), phase: "building", current: "T1" }));
  await t.run("commit", "order-cancellation");
  assert.match(t.notes.at(-1)!, /order-cancellation is being built: commit when the build is done/);
  fs.writeFileSync(progressFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(progressFile, "utf8")), phase: "built" }));
  fs.writeFileSync(path.join(t.repo, "T1.txt"), "x\n");
  const head = execSync("git rev-parse HEAD", { cwd: t.repo, encoding: "utf8" });
  t.runtime().hasUI = false;
  try {
    await t.run("commit", "order-cancellation");
  } finally {
    t.runtime().hasUI = true;
  }
  assert.match(t.posts.at(-1)!, /^\*\*Not committed\*\* — nobody here to confirm\./);
  assert.equal(execSync("git rev-parse HEAD", { cwd: t.repo, encoding: "utf8" }), head);
});


test("an unfinished build (e.g. after a crash) can be restarted in a new session; finished tasks stay done", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  let stop = true;
  t.agent.script = async (text, tool) => {
    if (stop && (text.includes("Task T2") || text.includes("finishing T2"))) return; // the session "dies" before T2 finishes
    return diligent(text, tool);
  };
  await t.run("build");
  assert.equal(t.progress("order-cancellation").phase, "paused");
  stop = false;
  process.chdir(t.repo);
  // Back in some other session: the spec is offered for a restart.
  const r = t.runtime();
  r.ctx.sessionManager.getSessionFile = () => path.join(t.repo, "elsewhere.jsonl");
  t.selects.push("order-cancellation (restart the build, finished tasks stay done)");
  await t.run("build");
  const p = t.progress("order-cancellation");
  assert.equal(p.phase, "built");
  assert.match(p.session, /elsewhere\.jsonl$/); // restarted here, in the session that ran /pb:build
  assert.ok(t.instructions.some((i) => /Build \.pi\/pb\/specs\/order-cancellation\/spec\.md\./.test(i))); // the restart names the spec it builds
  assert.equal(t.instructions.filter((i) => /Task T1/.test(i)).length, 1); // T1 wasn't redone
});

test("prompts: short mechanics plus your standards; a minimal spec is enough", async () => {
  const { buildMechanics } = await import("../extensions/pb/prompts.ts");
  const mech = buildMechanics(parseSpec(SPEC()).spec!, null, true);
  assert.match(mech, /This build is autonomous: never ask\.[\s\S]*take the sensible reading and record it with pb_record_decision \(assumption: true\)/);
  assert.doesNotMatch(mech, /pb_ask/);
  assert.match(mech, /leave \.pi\/ alone/);
  assert.match(mech, /Goal, Decisions, Contracts, Threats and Acceptance bind you/);
  assert.match(mech, /Tests quiet, full log to a temp file/);
  assert.match(mech, /Finish each task with pb_task_done \(changed\/caveat\/rejected\/open\): it runs the task's Test: command \(a compile when there is none\)/);
  assert.match(mech, /Change or remove an existing test only when what it covers changes; never skip or weaken one/);

  const t = setup({ taskChecks: "each", verify: "true" });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  const first = t.instructions[0];
  assert.match(first, /Build \.pi\/pb\/specs\/order-cancellation\/spec\.md\. The planning is done: implement it as written/);
  assert.doesNotMatch(first, /Engineering standards/); // none in this project's AGENTS.md: nothing to add
  assert.match(t.instructions.find((i) => /Task T2/.test(i))!, /comments that restate the code or tell its history \(dates, decisions, task ids\)/);

  await t.run("spec");
  assert.match(t.instructions.at(-1)!, /Each decision with its reason, as it stands now: no dates, no history/);

  const minimal = "# Tiny\nVerification: tests\n\n## Goal\ng\n## Decisions\n- d\n## Tasks\n### T1: a\nx\n- Acceptance: y\n";
  assert.deepEqual(parseSpec(minimal).errors, []);
});

test("the build session runs on the model and thinking level you planned with, not Pi's defaults", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  const planning = t.runtime();
  planning.model = { provider: "p", id: "big", contextWindow: 262000 };
  planning.thinking = "high";
  t.agent.script = diligent;
  await t.run("build", "--fresh");
  const build = t.runtime();
  assert.notEqual(build, planning);
  assert.deepEqual([build.model.id, build.thinking], ["big", "high"]);
  assert.ok(t.posts.some((x) => /Building \*\*order-cancellation\*\*[^\n]*, on p\/big, thinking high\./.test(x)));
  assert.ok(!fs.existsSync(path.join(t.repo, ".pi/pb/carry.json"))); // handed over once
});

test("build: by default in this session: the planning protection lifts, the spec isn't repeated", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  await t.run("plan", "cancel orders");
  await written(t);
  t.agent.script = async (text, tool) => {
    if (text.includes("Task T1")) assert.equal((await tool("write", { path: "Order.java", content: "x" })).error, undefined); // editing allowed now
    return diligent(text, tool);
  };
  const planning = t.runtime();
  await t.run("build");
  assert.equal(t.runtime(), planning); // no new session
  const p = t.progress("order-cancellation");
  assert.equal(p.phase, "built");
  assert.match(p.session, /planning-session\.jsonl$/);
  assert.doesNotMatch(t.instructions.find((i) => /\[pb:build order-cancellation\]/.test(i))!, /# Order cancellation/); // it wrote it: no copy
  assert.match(t.posts.find((x) => /Building \*\*order-cancellation\*\* here/.test(x))!, /▶ T1: first file/);
});

test("build: when the session is getting full, it offers a fresh session", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  t.runtime().usage = 72;
  t.agent.script = diligent;
  await t.run("build");
  assert.match(t.selectTitles[0], /Build order-cancellation: this session is 72% full/);
  assert.match(t.progress("order-cancellation").session, /build-session-1\.jsonl$/);
  assert.equal(t.progress("order-cancellation").phase, "built");
});

test("build without a spec: it asks first, then writes the spec and builds it with no dialog after", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  await t.run("plan", "cancel orders");
  t.agent.script = async (text, tool) => {
    if (/pb_write_spec tool/.test(text)) return void (await tool("pb_write_spec", { name: "order-cancellation", content: SPEC() }));
    return diligent(text, tool);
  };
  await t.run("build");
  assert.equal(t.selectTitles.at(-1), "Pi writes the spec first. Then?"); // asked before the spec, while you're here
  assert.match(t.instructions.find((i) => /pb_write_spec tool/.test(i))!, /After writing it, stop: the build starts by itself/);
  assert.ok(t.posts.some((x) => /\*\*✅ Spec written — order-cancellation\*\*[\s\S]*- T1: first file · `test -f T1\.txt`/.test(x)));
  assert.deepEqual(t.views.map((v) => [v.customType, v.data.name]), [["pb-spec", "order-cancellation"]]); // the whole spec, shown, not sent to the model
  assert.equal(t.progress("order-cancellation").phase, "built"); // built here, with no dialog after the spec
  assert.match(t.progress("order-cancellation").session, /planning-session\.jsonl$/);
});

test("build: a different buildModel builds in a fresh session, since switching here would re-send everything uncached", async () => {
  const t = setup({ verify: "true", buildModel: "p/big" });
  await written(t);
  t.agent.script = diligent;
  const planning = t.runtime();
  await t.run("build");
  assert.match(t.selectTitles[0], /building on p\/big here sends this whole conversation to it again, uncached/);
  assert.notEqual(t.runtime(), planning);
  assert.equal(t.runtime().model.id, "big");
  assert.ok(t.posts.some((x) => /Building \*\*order-cancellation\*\* from [^\n]*, on p\/big/.test(x)));

  const u = setup({ verify: "true", buildModel: "p/big" });
  await written(u);
  u.agent.script = diligent;
  u.selects.push("Build here anyway");
  await u.run("build");
  assert.equal(u.runtime().model.id, "big");
  assert.ok(u.posts.some((x) => /Building \*\*order-cancellation\*\* here on p\/big/.test(x)));
});

test("checkpoint: a planning session past checkpointAt writes its spec, then is reset to it without a compaction call", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  t.selects.push("No thanks");
  await t.run("plan", "cancel orders");
  let checkpointAsked = "";
  t.agent.script = async (text, tool) => {
    if (text.startsWith("[pb:compact]")) {
      checkpointAsked = text;
      await tool("pb_write_spec", { name: "order-cancellation", content: PLANNING });
    }
  };
  t.runtime().usage = 70; // below the cap (100k window: min(checkpointAt 75k, 100k - 16k reserve))
  t.runtime().pi.sendUserMessage("what about notifications?");
  await t.settle();
  assert.equal(t.resets.length, 0);

  t.runtime().usage = 76;
  t.runtime().pi.sendUserMessage("and refunds are out of scope");
  await t.settle();
  assert.match(checkpointAsked, /at 76% of its context[\s\S]*pb_write_spec, Status: planning[\s\S]*the dead ends[\s\S]*each option still being weighed, with what was found for and against it/);
  assert.equal(t.resets.length, 1);
  assert.equal(t.resets[0].firstKeptEntryId, null); // nothing kept but the spec
  assert.match(t.resets[0].summary, /^\[pb plan checkpoint\][\s\S]*Planning mode is still on[\s\S]*--- \.pi\/pb\/specs\/order-cancellation\/spec\.md ---[\s\S]*## Open questions[\s\S]*--- the last exchange before the checkpoint, word for word ---\n\nHuman: and refunds are out of scope\n\nAssistant: ok$/);
  assert.match(t.posts.at(-1)!, /\*\*Plan checkpointed\*\* to \.pi\/pb\/specs\/order-cancellation\/spec\.md: the conversation was reset to it \(it was 76% full\)/);
  assert.doesNotMatch(t.context(), /\[pb:plan\]|what about notifications/); // the discussion is gone from the context: the spec and the last exchange are there
  assert.equal(t.context().match(/and refunds are out of scope/g)?.length, 1);
  assert.match(t.context(), /Only PENDING orders can be cancelled/);
  assert.ok(t.events("order-cancellation").some((e) => e.type === "checkpoint" && e.percent === 76));

  // The next checkpoint updates the existing spec instead of writing a new one.
  checkpointAsked = "";
  t.runtime().pi.sendUserMessage("more");
  await t.settle();
  assert.match(checkpointAsked, /Update \.pi\/pb\/specs\/order-cancellation\/spec\.md with pb_update_spec/);
});

test("checkpoint: when the plan isn't written, the conversation goes on as it is, without asking every turn", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  t.selects.push("No thanks");
  await t.run("plan", "cancel orders");
  t.agent.script = async () => {};
  t.runtime().usage = 80;
  t.runtime().pi.sendUserMessage("go on");
  await t.settle();
  assert.equal(t.resets.length, 0);
  assert.match(t.posts.at(-1)!, /the plan wasn't written to a spec, so the conversation goes on as it is/);
  const asked = t.instructions.filter((i) => i.startsWith("[pb:compact]")).length;
  t.runtime().pi.sendUserMessage("again");
  await t.settle();
  assert.equal(t.instructions.filter((i) => i.startsWith("[pb:compact]")).length, asked);
});

test("checkpoint: /pb:compact resets to a spec that is already current instead of reporting it unwritten", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  t.selects.push("No thanks");
  await t.run("plan", "cancel orders");
  await t.callTool("pb_write_spec", { name: "order-cancellation", content: PLANNING });
  await new Promise((r) => setTimeout(r, 1100)); // the write lands in an earlier second than the request's `since`: no write happened "since"
  t.agent.script = async () => {}; // the spec is current: nothing left to write, so no pb write happens
  await t.run("compact");
  assert.equal(t.resets.length, 1); // the reset the command asked for
  assert.match(t.resets[0].summary, /^\[pb plan checkpoint\]/);
  assert.match(t.posts.at(-1)!, /\*\*Plan checkpointed\*\*/);
});

test("checkpoint: sessions that aren't planning are left to Pi; checkpointAt 0 turns it off", async () => {
  const t = setup({ verify: "true", checkpointAt: 0 });
  process.chdir(t.repo);
  t.selects.push("No thanks");
  await t.run("plan", "cancel orders");
  t.runtime().usage = 90;
  t.runtime().pi.sendUserMessage("go on");
  await t.settle();
  assert.ok(!t.instructions.some((i) => i.startsWith("[pb:compact]")));
});

test("compaction: a planning session's summary is its spec; a build names the spec file, so its summary is Pi's", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  t.selects.push("No thanks");
  await t.run("plan", "cancel orders");
  await t.callTool("pb_write_spec", { name: "order-cancellation", content: PLANNING });
  const [r] = (await t.fire("session_before_compact", { preparation: { firstKeptEntryId: "e3", tokensBefore: 90000 }, reason: "overflow" })) as any[];
  assert.equal(r.compaction.firstKeptEntryId, "e3");
  assert.match(r.compaction.summary, /^\[pb plan checkpoint\][\s\S]*Not doing soft delete/);

  const u = setup({ verify: "true" });
  await written(u); // written in a session that isn't planning
  const [none] = (await u.fire("session_before_compact", { preparation: { firstKeptEntryId: "e3", tokensBefore: 90000 }, reason: "threshold" })) as any[];
  assert.equal(none, undefined); // Pi summarizes

  u.agent.script = diligent;
  await u.run("build");
  assert.match(u.instructions[0], /Build \.pi\/pb\/specs\/order-cancellation\/spec\.md\./);
});

test("compaction: a review session is reset to its role, the brief, and the findings so far", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  const { Store } = await import("../extensions/pb/store.ts");
  const store = new Store(t.repo);
  const session = path.join(t.repo, "review-session.jsonl");
  store.saveReviewSession(session, { role: "review", spec: "order-cancellation", run: "run-2", findings: [{ priority: "P1", title: "missing test", file: "x.ts", line: 1 }] });
  store.saveReviewRun({ id: "run-2", cwd: t.repo, label: "order-cancellation", brief: "# The brief", followUp: false, passes: [], home: t.repo });
  const ctx = { ...t.runtime().ctx, sessionManager: { getSessionFile: () => session } };
  const [r] = (await t.fire("session_before_compact", { preparation: { firstKeptEntryId: "e3", tokensBefore: 90000 }, reason: "threshold" }, ctx)) as any[];
  assert.equal(r.compaction.firstKeptEntryId, "e3"); // Pi's boundary kept; only the summary is pb's
  assert.match(r.compaction.summary, /^\[pb review state: order-cancellation\] This review session was compacted[\s\S]*--- brief ---\n\n# The brief[\s\S]*--- findings so far ---\n\n1\. \[P1\] x\.ts:1 — missing test/);
});

test("compaction: compacting the same task over and over with no progress pauses instead of looping", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  const prep = { firstKeptEntryId: "e3", tokensBefore: 90000 };
  let fourth: any;
  t.agent.script = async (text, tool) => {
    if (text.includes("Task T1")) {
      for (let i = 0; i < 4; i++) fourth = await t.fire("session_before_compact", { preparation: prep, reason: "threshold" });
      return; // the build paused underneath: nothing more to do this run
    }
    return diligent(text, tool);
  };
  await t.run("build");
  const p = t.progress("order-cancellation");
  assert.equal(p.phase, "paused");
  assert.match(t.posts.at(-1)!, /\*\*⏸ Build paused — order-cancellation\*\*[\s\S]*compacted 3 times during T1 without getting anywhere[\s\S]*What now/);
  assert.deepEqual(t.events("order-cancellation").filter((e) => e.type === "pause").map((e) => e.why), ["thrash"]);
  // No compaction either: its summary would hand the model a step for a build the harness refuses.
  assert.deepEqual(fourth, [{ cancel: true }]);
  // And it resumes where it paused: the guard counts forward progress, not compactions.
  t.agent.script = async (text, tool) => diligent(text.includes("Continue task") ? text.replace("Continue task", "Task") : text, tool);
  await t.run("build");
  assert.equal(t.progress("order-cancellation").phase, "built");
});

test("/pb:build on a planning spec finishes it first, then offers the build", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  t.selects.push("No thanks");
  await t.run("plan", "cancel orders");
  await t.callTool("pb_write_spec", { name: "order-cancellation", content: PLANNING });
  t.agent.script = async (text, tool) => {
    if (text.startsWith("[pb:spec order-cancellation] Finish the spec")) return void (await tool("pb_write_spec", { name: "order-cancellation", content: SPEC() }));
    return diligent(text, tool);
  };
  await t.run("build");
  assert.match(t.posts.find((p) => p.startsWith("▶ /pb:build"))!, /finishing the spec order-cancellation first/);
  assert.match(t.instructions.find((i) => i.startsWith("[pb:spec order-cancellation]"))!, /add the Tasks and the Verification line, leave no Open questions, and set Status: ready/);
  assert.equal(t.progress("order-cancellation").phase, "built");
});

test("pending builds are per-session files: two sessions don't clobber, expiry clears", async () => {
  const t = setup();
  process.chdir(t.repo);
  const { Store } = await import("../extensions/pb/store.ts");
  const s = new Store(t.repo);
  s.setPendingBuild("/s/a.jsonl");
  s.setPendingBuild("/s/b.jsonl"); // second writer must not drop the first flag
  assert.ok(s.pendingBuild("/s/a.jsonl") && s.pendingBuild("/s/b.jsonl"));
  assert.ok(!fs.existsSync(path.join(t.repo, ".pi/pb/pending-build.json"))); // no shared file to race on
  s.clearPendingBuild("/s/a.jsonl");
  assert.ok(!s.pendingBuild("/s/a.jsonl") && s.pendingBuild("/s/b.jsonl"));
  s.setPendingBuild(undefined); // clears all sessions' flags, as before
  assert.ok(!s.pendingBuild("/s/b.jsonl"));
});

test("legacy pending-build.json (map and single-global forms) migrates on write", async () => {
  const t = setup();
  process.chdir(t.repo);
  const { Store } = await import("../extensions/pb/store.ts");
  const s = new Store(t.repo);
  fs.writeFileSync(path.join(t.repo, ".pi/pb/pending-build.json"), JSON.stringify({ "/s/old.jsonl": { at: Date.now() } }));
  assert.ok(s.pendingBuild("/s/old.jsonl")); // legacy still read
  s.setPendingBuild("/s/new.jsonl");
  assert.ok(s.pendingBuild("/s/old.jsonl") && s.pendingBuild("/s/new.jsonl"));
  assert.ok(!fs.existsSync(path.join(t.repo, ".pi/pb/pending-build.json"))); // migrated away
  fs.writeFileSync(path.join(t.repo, ".pi/pb/pending-build.json"), JSON.stringify({ session: "/s/g.jsonl", at: Date.now() }));
  assert.ok(s.pendingBuild("/s/g.jsonl")); // single-global form still read
  assert.ok(!s.pendingBuild("/s/other.jsonl"));
  assert.ok(!s.pendingBuild(undefined));
});

test("/pb:build rejects a readable file under an invalid spec name instead of building it", async () => {
  const t = setup();
  process.chdir(t.repo);
  const { Store } = await import("../extensions/pb/store.ts");
  new Store(t.repo).markAsked("standards");
  fs.mkdirSync(path.join(t.repo, ".pi/docs/foo"), { recursive: true });
  fs.writeFileSync(path.join(t.repo, ".pi/docs/foo/spec.md"), SPEC());
  const before = t.instructions.length;
  await t.run("build", "../../docs/foo");
  assert.match(t.notes.at(-1)!, /isn't a valid spec name/);
  assert.ok(!fs.existsSync(path.join(t.repo, ".pi/docs/foo/progress.json"))); // no state written outside .pi/pb/
  assert.equal(t.instructions.length, before); // nothing started
});

test("/pb:build reads a Depends on note as the spec name, not the whole line", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  const { Store } = await import("../extensions/pb/store.ts");
  new Store(t.repo).markAsked("standards");
  await t.callTool("pb_write_spec", { name: "tempo-gtfs-live-trains", content: SPEC() });
  const dependent = SPEC().replace("Depends on: none", "Depends on: tempo-gtfs-live-trains — implemented and on HEAD; this spec consumes its endpoints unchanged");
  assert.equal((await t.callTool("pb_write_spec", { name: "live-trains", content: dependent })).error, undefined);
  t.selects.push("Stop here"); // the dependency has no build yet: the human can decline
  await t.run("build", "live-trains");
  assert.match(t.selectTitles.at(-1)!, /^Build live-trains\?\n- ⚠ live-trains depends on tempo-gtfs-live-trains, which isn't built yet$/);
  assert.equal(t.instructions.length, 0);
});

test("/pb:build asks nothing about an archived dependency", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  const { Store } = await import("../extensions/pb/store.ts");
  new Store(t.repo).markAsked("standards");
  const store = new Store(t.repo);
  await t.callTool("pb_write_spec", { name: "platform-core", content: SPEC() });
  store.saveProgress({ ...store.progress("platform-core")!, phase: "built" });
  store.archive("platform-core");
  await t.callTool("pb_write_spec", { name: "platform-feature", content: SPEC().replace("Depends on: none", "Depends on: platform-core") });
  t.agent.script = diligent;
  await t.run("build", "platform-feature");
  assert.ok(!t.selectTitles.some((s) => /depends on platform-core/.test(s)), `no dependency prompt, got ${JSON.stringify(t.selectTitles)}`);
  assert.ok(t.instructions.length > 0, "the build started");
});

test("/pb:build near-miss spec names redirect instead of building the wrong spec", async () => {
  const t = setup();
  process.chdir(t.repo);
  const { Store } = await import("../extensions/pb/store.ts");
  new Store(t.repo).markAsked("standards");
  await t.callTool("pb_write_spec", { name: "order-cancellation", content: PLANNING });
  const session = t.runtime().ctx.sessionManager.getSessionFile();
  for (const miss of ["order_cancellation", "Order-Cancellation", "order-cancellation."]) {
    await t.run("build", miss);
    assert.match(t.notes.at(-1)!, /Did you mean `order-cancellation`\? `\/pb:build order-cancellation`/);
  }
  assert.equal(t.instructions.length, 0); // nothing started
  assert.equal(t.names.get(session), undefined); // no session renamed
});

test("/pb:build records trailing words as guidance when starting a named spec", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  const { Store } = await import("../extensions/pb/store.ts");
  new Store(t.repo).markAsked("standards");
  await t.callTool("pb_write_spec", { name: "order-cancellation", content: SPEC() });
  await t.run("build", "order-cancellation use a helper for the email");
  assert.match(t.read(".pi/pb/specs/order-cancellation/spec.md"), /use a helper for the email/);
});

test("/pb:build --fresh on a paused build warns and continues here", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  const { Store } = await import("../extensions/pb/store.ts");
  new Store(t.repo).markAsked("standards");
  await t.callTool("pb_write_spec", { name: "order-cancellation", content: SPEC() });
  const session = t.runtime().ctx.sessionManager.getSessionFile();
  fs.writeFileSync(
    path.join(t.repo, ".pi/pb/specs/order-cancellation/progress.json"),
    JSON.stringify({
      spec: "order-cancellation",
      phase: "paused",
      session,
      tasks: [
        { id: "T1", title: "first file", status: "done", attempts: 1 },
        { id: "T2", title: "second file", status: "todo", attempts: 0 },
      ],
      current: "T2",
      pause: "stopped",
      updatedAt: "2026-10-01 10:00:00",
    }),
  );
  await t.run("build", "--fresh");
  assert.match(t.notes.at(-1)!, /`--fresh` only applies when starting a build: continuing here instead/);
  assert.ok(t.instructions.some((x) => /Task T2/.test(x))); // resumed here, not in a fresh session
});

test("/pb:build resume reviews planning leftovers and clears the widget", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  const { Store } = await import("../extensions/pb/store.ts");
  new Store(t.repo).markAsked("standards");
  await t.callTool("pb_write_spec", { name: "order-cancellation", content: SPEC() });
  const session = t.runtime().ctx.sessionManager.getSessionFile();
  fs.writeFileSync(
    path.join(t.repo, ".pi/pb/specs/order-cancellation/progress.json"),
    JSON.stringify({
      spec: "order-cancellation",
      phase: "paused",
      session,
      tasks: [
        { id: "T1", title: "first file", status: "done", attempts: 1 },
        { id: "T2", title: "second file", status: "todo", attempts: 0 },
      ],
      current: "T2",
      pause: "stopped",
      updatedAt: "2026-10-01 10:00:00",
    }),
  );
  await t.run("plan", "a new idea");
  fs.writeFileSync(path.join(t.repo, "stray.txt"), "written by a shell command");
  t.selects.push("Keep them");
  await t.run("build");
  assert.ok(t.selectTitles.some((x) => /These project files changed while planning/.test(x)));
  assert.equal(t.widgets.get("pb-plan"), undefined);
  assert.equal(fs.readFileSync(path.join(t.repo, "stray.txt"), "utf8"), "written by a shell command");
  assert.ok(t.instructions.some((x) => /Task T2/.test(x)));
});

test("/pb:build confirms before restarting a build that is live in another session", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  const { Store } = await import("../extensions/pb/store.ts");
  new Store(t.repo).markAsked("standards");
  await t.callTool("pb_write_spec", { name: "other-feature", content: SPEC() });
  const session = t.runtime().ctx.sessionManager.getSessionFile();
  fs.writeFileSync(
    path.join(t.repo, ".pi/pb/specs/other-feature/progress.json"),
    JSON.stringify({
      spec: "other-feature",
      phase: "building",
      session: "/elsewhere/other.jsonl",
      tasks: [
        { id: "T1", title: "first file", status: "doing", attempts: 1 },
        { id: "T2", title: "second file", status: "todo", attempts: 0 },
      ],
      current: "T1",
      updatedAt: "2020-01-01 00:00:00",
    }),
  );
  t.selects.push("Yes, go on");
  await t.run("build", "other-feature");
  assert.ok(t.selectTitles.some((x) => /building in another session/.test(x)));
  assert.equal(t.progress("other-feature").session, session); // adopted here after confirming
});

test("build: naming another spec builds it instead of resuming the paused one as guidance", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  await t.callTool("pb_write_spec", { name: "order-cancellation", content: SPEC() });
  await t.callTool("pb_write_spec", { name: "other-feature", content: SPEC() });
  const session = t.runtime().ctx.sessionManager.getSessionFile();
  fs.writeFileSync(
    path.join(t.repo, ".pi/pb/specs/order-cancellation/progress.json"),
    JSON.stringify({
      spec: "order-cancellation",
      phase: "paused",
      session,
      tasks: [
        { id: "T1", title: "first file", status: "done", attempts: 1 },
        { id: "T2", title: "second file", status: "todo", attempts: 0 },
      ],
      current: "T2",
      pause: "stopped",
      updatedAt: "2026-10-01 10:00:00",
    }),
  );
  t.agent.script = diligent;
  await t.run("build", "other-feature");
  assert.equal(t.progress("order-cancellation").phase, "paused"); // untouched, not resumed
  assert.doesNotMatch(t.read(".pi/pb/specs/order-cancellation/spec.md"), /other-feature/); // no guidance junk
  assert.equal(t.progress("other-feature").phase, "built");
});

test("build: resuming with guidance strips the spec name and records it as a spec event", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  await t.callTool("pb_write_spec", { name: "order-cancellation", content: SPEC() });
  const session = t.runtime().ctx.sessionManager.getSessionFile();
  fs.writeFileSync(
    path.join(t.repo, ".pi/pb/specs/order-cancellation/progress.json"),
    JSON.stringify({
      spec: "order-cancellation",
      phase: "paused",
      session,
      tasks: [
        { id: "T1", title: "first file", status: "done", attempts: 1 },
        { id: "T2", title: "second file", status: "todo", attempts: 0 },
      ],
      current: "T2",
      pause: "stopped",
      updatedAt: "2026-10-01 10:00:00",
    }),
  );
  t.agent.script = diligent;
  await t.run("build", "order-cancellation fix the flake");
  assert.match(t.read(".pi/pb/specs/order-cancellation/spec.md"), /- fix the flake/);
  assert.doesNotMatch(t.read(".pi/pb/specs/order-cancellation/spec.md"), /- order-cancellation fix the flake/);
  assert.ok(t.events("order-cancellation").some((e) => e.type === "spec" && e.update === "guidance"));
  assert.equal(t.progress("order-cancellation").phase, "built");
});

test("build: cancelling a fresh session drops its handover instead of leaking it", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  await written(t);
  t.agent.script = diligent;
  process.env.MOCK_NEW_SESSION_CANCEL = "1";
  try {
    await t.run("build", "order-cancellation --fresh");
  } finally {
    delete process.env.MOCK_NEW_SESSION_CANCEL;
  }
  assert.match(t.notes.at(-1)!, /Build cancelled\./);
  assert.ok(!fs.existsSync(path.join(t.repo, ".pi/pb/carry.json")));
});

test("build: a slow spec yields to the pending offer, which picks it up once written", async () => {
  const t = setup({ verify: "true", specWaitSec: 0.2 });
  process.chdir(t.repo);
  const { Store } = await import("../extensions/pb/store.ts");
  new Store(t.repo).markAsked("standards");
  t.agent.script = async (text, tool) => {
    if (/pb_write_spec tool/.test(text)) {
      await new Promise((r) => setTimeout(r, 1000)); // slower than the wait cap
      await tool("pb_write_spec", { name: "order-cancellation", content: SPEC() });
      return;
    }
    return diligent(text, tool);
  };
  await t.run("build", "cancel orders");
  assert.ok(t.posts.some((p) => p.startsWith("No spec ready to build yet."))); // yielded, didn't hang
  assert.equal(t.progress("order-cancellation").phase, "built"); // pending picked it up and built it
});

test("build: with only a finished spec around, the wait message names it instead of puzzling", async () => {
  const t = setup({ verify: "true", specWaitSec: 0.2 });
  process.chdir(t.repo);
  await t.callTool("pb_write_spec", { name: "order-cancellation", content: SPEC() });
  const session = t.runtime().ctx.sessionManager.getSessionFile();
  fs.writeFileSync(
    path.join(t.repo, ".pi/pb/specs/order-cancellation/progress.json"),
    JSON.stringify({
      spec: "order-cancellation",
      phase: "reviewed",
      writtenIn: session,
      session,
      tasks: [{ id: "T1", title: "first file", status: "done", attempts: 1 }],
      updatedAt: "2026-10-01 10:00:00",
    }),
  );
  await t.run("build");
  assert.match(t.posts.at(-1)!, /`order-cancellation` is already reviewed.*write a new spec/);
});

test("build: with checkpoints off, the build says so up front", async () => {
  const t = setup({ verify: "true", checkpoints: false });
  process.chdir(t.repo);
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  assert.ok(t.notes.some((n) => /Checkpoints are off: this build runs without undo points/.test(n)));
  assert.equal(t.progress("order-cancellation").phase, "built");
});

test("build: specs from another session are labelled when choosing", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  await t.callTool("pb_write_spec", { name: "billing-export", content: SPEC() });
  await t.callTool("pb_write_spec", { name: "order-cancellation", content: SPEC() });
  for (const n of ["billing-export", "order-cancellation"]) {
    const p = t.progress(n);
    fs.writeFileSync(path.join(t.repo, ".pi/pb/specs", n, "progress.json"), JSON.stringify({ ...p, writtenIn: "/elsewhere/planning.jsonl" }));
  }
  t.agent.script = diligent;
  await t.run("build");
  const options = t.selectOptions[t.selectTitles.indexOf("Build which spec?")];
  assert.ok(options.every((o) => /from another session/.test(o)));
  assert.equal(t.progress("billing-export").phase, "built");
});

test("build: resuming after a re-plan lifts planning protection instead of wedging on it", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  const { Store } = await import("../extensions/pb/store.ts");
  new Store(t.repo).markAsked("standards");
  await t.callTool("pb_write_spec", { name: "order-cancellation", content: SPEC() });
  const session = t.runtime().ctx.sessionManager.getSessionFile();
  fs.writeFileSync(
    path.join(t.repo, ".pi/pb/specs/order-cancellation/progress.json"),
    JSON.stringify({
      spec: "order-cancellation",
      phase: "paused",
      session,
      tasks: [
        { id: "T1", title: "first file", status: "done", attempts: 1 },
        { id: "T2", title: "second file", status: "todo", attempts: 0 },
      ],
      current: "T2",
      pause: "stopped",
      updatedAt: "2026-10-01 10:00:00",
    }),
  );
  t.agent.script = diligent;
  await t.run("plan", "a new idea"); // planning back on after the pause
  await t.run("build"); // resume
  assert.equal(t.progress("order-cancellation").phase, "built");
  assert.deepEqual(new Store(t.repo).planningSessions(), []);
  assert.equal((await t.callTool("write", { path: "src/x.ts", content: "x" })).error, undefined);
});

test("/pb:compact writes and resets on demand (e.g. before quitting)", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  t.selects.push("No thanks");
  await t.run("plan", "cancel orders");
  t.agent.script = async (text, tool) => {
    if (text.startsWith("[pb:compact]")) await tool("pb_write_spec", { name: "order-cancellation", content: PLANNING });
  };
  t.runtime().pi.sendUserMessage("refunds are out of scope");
  await t.settle();
  assert.equal(t.resets.length, 0); // 10%: far below the checkpoint
  await t.run("compact");
  assert.equal(t.resets.length, 1);
  assert.match(t.context(), /^\[pb plan checkpoint\][\s\S]*Only PENDING orders[\s\S]*Human: refunds are out of scope/);
  assert.doesNotMatch(t.context(), /\[pb:plan\] cancel orders/);

  const u = setup();
  process.chdir(u.repo);
  await u.run("compact");
  assert.match(u.notes.at(-1)!, /\/pb:compact is for planning and build sessions; elsewhere, Pi's \/compact/);
});

test("build tool rows: the verdict line collapsed, the handout or failure detail one expand away", async () => {
  const { buildToolResultLines, renderBuildToolCall } = await import("../extensions/pb/render.ts");
  const handout = "✓ T1 passed (`npm test`)\n\n[pb:build] Task T2. Do only this task:\nread the spec, write tests";
  assert.deepEqual(buildToolResultLines(handout, false), [
    { text: "✓ T1 passed (`npm test`)", color: "success" },
    { text: "… 2 more lines (expand)", color: "dim" },
  ]);
  const expanded = buildToolResultLines(handout, true);
  assert.deepEqual(expanded.map((l) => l.color), ["success", "text"]);
  assert.match(expanded[1].text, /Task T2/);
  // a failed attempt: the head names the failure, the retry instruction hides behind the expand
  assert.deepEqual(buildToolResultLines("The check for T1 failed (attempt 2 of 2): `npm test` failed\n\nFix the cause, then call pb_task_done again.", false)[0], {
    text: "The check for T1 failed (attempt 2 of 2): `npm test` failed",
    color: "warning",
  });
  assert.deepEqual(buildToolResultLines("The build stopped.", false).length, 1); // one line: no expand hint
  assert.deepEqual(buildToolResultLines("", false), []);
  const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
  assert.match(renderBuildToolCall("pb_tests_red", { task: "T2" }, theme).render(200).join("\n"), /pb_tests_red T2 · running its tests, expecting them to fail/);
  assert.match(renderBuildToolCall("pb_task_done", { task: "T1", status: "blocked" }, theme).render(200).join("\n"), /pb_task_done T1 · blocked — the human decides/);
});

test("build: asked up front for a fresh session, the command waits for the spec and opens it itself", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  t.selects.push("No thanks");
  await t.run("plan", "cancel orders");
  t.agent.script = async (text, tool) => {
    if (/pb_write_spec tool/.test(text)) return void (await tool("pb_write_spec", { name: "order-cancellation", content: SPEC() }));
    return diligent(text, tool);
  };
  const planning = t.runtime();
  t.selects.push("Build in a fresh session as soon as the spec is written (lean context)");
  await t.run("build");
  assert.notEqual(t.runtime(), planning);
  const p = t.progress("order-cancellation");
  assert.match(p.session, /build-session-1\.jsonl$/);
  assert.equal(p.phase, "built");
});

test("build: nobody answers: after askTimeoutSec every dialog goes on with pb's choice, and the summary says so", async () => {
  const t = setup({ verify: "true", askTimeoutSec: 0.001 });
  process.chdir(t.repo);
  t.selects.push("No thanks");
  await t.run("plan", "cancel orders");
  t.agent.script = async (text, tool) => {
    if (/pb_write_spec tool/.test(text)) return void (await tool("pb_write_spec", { name: "order-cancellation", content: SPEC() }));
    return diligent(text, tool);
  };
  t.selects.push("Show me the spec first", "<timeout>"); // you asked to see it, then went to bed
  await t.run("build");
  assert.match(t.selectTitles.at(-1)!, /Build order-cancellation now\? 2 tasks/);
  assert.equal(t.progress("order-cancellation").phase, "built");
  assert.match(t.posts.at(-1)!, /Build complete[\s\S]*Decided without you \(no answer in time\):\n- Build order-cancellation now\? 2 tasks → Build here/);
});

test("build: Esc on the first dialog cancels; a spec that isn't written yet is offered once it is", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  t.selects.push("No thanks");
  await t.run("plan", "cancel orders");
  t.selects.push("<timeout>"); // with the default timeout, an immediate undefined is Esc
  await t.run("build");
  assert.ok(!t.instructions.some((i) => /pb_write_spec tool/.test(i)));

  let asked = false;
  t.agent.script = async (text, tool) => {
    if (/pb_write_spec tool/.test(text) && !asked) {
      asked = true; // a question in chat first
      return;
    }
    if (/refunds/.test(text)) return void (await tool("pb_write_spec", { name: "order-cancellation", content: SPEC() }));
    return diligent(text, tool);
  };
  await t.run("build");
  assert.match(t.posts.at(-1)!, /No spec ready to build yet/);
  t.runtime().pi.sendUserMessage("refunds are out of scope");
  await t.settle();
  assert.match(t.selectTitles.at(-1)!, /Build order-cancellation now\? 2 tasks/);
  assert.equal(t.progress("order-cancellation").phase, "built");
});

test("map: the cartographer reads and preserves; no builds, snapshots, routes-as-paths or secrets", async () => {
  const { CARTOGRAPHER_SYSTEM, cartographerBrief } = await import("../extensions/pb/map.ts");
  assert.match(CARTOGRAPHER_SYSTEM, /bash only to read/);
  assert.match(CARTOGRAPHER_SYSTEM, /Never run the build, the tests, the package manager, an install, a server, a network call or a script/);
  assert.match(CARTOGRAPHER_SYSTEM, /snapshots \(current version ranges, counts, inventories, pass\/fail or measured results\)/);
  assert.ok(CARTOGRAPHER_SYSTEM.includes("write an HTTP route with its verb (`GET /api/orders/{id}`) or as prose"));
  assert.match(CARTOGRAPHER_SYSTEM, /name a repo or file outside this project in prose, never as a backticked path/);
  assert.match(CARTOGRAPHER_SYSTEM, /Never put a secret, credential, token, key, connection string or personal data in the map/);
  assert.match(CARTOGRAPHER_SYSTEM, /keep every line that is still true exactly as it is/);
  assert.match(CARTOGRAPHER_SYSTEM, /If nothing changed, report the map as it is with an empty changes list/);
  assert.match(CARTOGRAPHER_SYSTEM, /Read the project's engineering standards[\s\S]*don't restate the standards/);
  assert.match(CARTOGRAPHER_SYSTEM, /A test proves an invariant only after you have read its assertion, not from its name/);
  const brief = cartographerBrief({ current: "- `README`: readme", proposed: "### Layout\n- `GET /api/orders`: the orders route", unresolved: [{ path: "../ui/src/App.vue", line: "- `../ui/src/App.vue`: the UI" }] });
  assert.match(brief, /If it is an HTTP route or something outside this project[\s\S]*give a route its verb, name an outside repo in prose/);
});

test("notify: the build pings when it completes and when it pauses, and not when notify is off", async () => {
  const sent: string[][] = [];
  const { setNotifySink } = await import("../extensions/pb/notify.ts");
  setNotifySink((title, body) => sent.push([title, body]));
  try {
    const t = setup({ verify: "true", notify: true });
    await written(t);
    t.agent.script = diligent;
    await t.run("build");
    assert.equal(t.progress("order-cancellation").phase, "built");
    assert.ok(sent.some(([title, body]) => title === "pb: build complete" && body.includes("order-cancellation") && /every check passed/.test(body)), JSON.stringify(sent));

    sent.length = 0;
    const u = setup({ taskChecks: "each", verify: "true", notify: true });
    await written(u);
    u.agent.script = async (text, tool) => {
      // never creates the task's file: every attempt's check fails, and the build pauses
      const task = text.match(/(?:Task|check for) (T\d+)/)?.[1];
      if (task) {
        await tool("pb_tests_red", { task });
        return void (await tool("pb_task_done", { task, status: "done", changed: "claimed", caveat: "none", rejected: "none", open: "none" }));
      }
      return diligent(text, tool);
    };
    await u.run("build");
    assert.equal(u.progress("order-cancellation").phase, "paused");
    assert.ok(sent.some(([title, body]) => title === "pb: build paused" && body.includes("order-cancellation")), JSON.stringify(sent));

    sent.length = 0;
    const v = setup({ verify: "true" }); // notify off by default
    await written(v);
    v.agent.script = diligent;
    await v.run("build");
    assert.deepEqual(sent, []);
  } finally {
    setNotifySink(undefined);
  }
});

test("/pb:compact in a build session compacts to the build's state (Pi's compaction, pb's summary)", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  let compacted: unknown;
  t.agent.script = async (text, tool) => {
    if (text.includes("Task T2")) return; // stops mid-build: paused
    return diligent(text, tool);
  };
  await t.run("build");
  t.runtime().ctx.compact = (o: any) => {
    compacted = o;
    o.onComplete?.({});
  };
  await t.run("compact");
  assert.ok(compacted);
  assert.match(t.notes.at(-1)!, /Compacted to the build's state/);
});

test("build: a spec rewrite that renumbers a task doesn't strand the resume at 'nothing left'", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  // T1 gets built; the build rests at T2 (the script does nothing more).
  t.agent.script = async (text, tool) => {
    if (!text.includes("Task T1")) return;
    // The Tasks section is the contract: a mid-build rewrite through the tool is refused.
    const edited = await tool("pb_update_spec", {
      name: "order-cancellation",
      section: "Tasks",
      content:
        "### T1: first file\nCreate T1.txt.\n- Acceptance: T1.txt exists (tests: T1)\n- Test: `test -f T1.txt`\n\n### T3: second file\nCreate T3.txt.\n- Acceptance: T3.txt exists (tests: T3)\n- Test: `test -f T3.txt`",
    });
    assert.match(edited.error!, /only its Design and Decisions may change/);
    await tool("pb_tests_red", { task: "T1" });
    fs.writeFileSync(path.join(t.repo, "T1.txt"), "x");
    await tool("pb_task_done", { task: "T1", status: "done", changed: "T1", caveat: "none", rejected: "none", open: "none" });
  };
  await t.run("build");
  assert.equal(t.progress("order-cancellation").current, "T2");
  // The human edits the file and re-approves with /pb:build: the pending second task is renamed T3.
  const specFile = path.join(t.repo, ".pi/pb/specs/order-cancellation/spec.md");
  fs.writeFileSync(
    specFile,
    fs
      .readFileSync(specFile, "utf8")
      .replace(
        "### T2: second file\nCreate T2.txt.\n- Acceptance: T2.txt exists\n- Test: `test -f T2.txt`",
        "### T3: second file\nCreate T3.txt.\n- Acceptance: T3.txt exists\n- Test: `test -f T3.txt`",
      ),
  );
  // Resume must build the renamed task, not read the stale current id as "build finished".
  t.agent.script = async (text, tool) => {
    if (!text.includes("Task T3")) return;
    await tool("pb_tests_red", { task: "T3" });
    fs.writeFileSync(path.join(t.repo, "T3.txt"), "x");
    await tool("pb_task_done", { task: "T3", status: "done", changed: "T3", caveat: "none", rejected: "none", open: "none" });
  };
  await t.run("build");
  assert.ok(t.posts.some((x) => /Spec re-approved/.test(x)));
  assert.ok(!t.notes.some((n) => /Nothing left to build here/.test(n)));
  assert.ok(t.instructions.some((x) => /Task T3/.test(x)));
  assert.equal(t.progress("order-cancellation").phase, "built"); // T1 + T3 done, the suite checked
});

test("build: the approved contract is frozen while the build runs", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  // Another name for the specs folder: a symlink under .pi, so it stays out of snapshots.
  fs.symlinkSync(path.join(t.repo, ".pi", "pb", "specs"), path.join(t.repo, ".pi", "specs-link"), "dir");
  t.agent.script = async (text, tool) => {
    if (!text.includes("Task T1")) return;
    // The whole spec can't be rewritten, and only Design and Decisions may change.
    assert.match((await tool("pb_write_spec", { name: "order-cancellation", content: SPEC() })).error!, /approved spec can't be rewritten/);
    assert.match((await tool("pb_update_spec", { name: "order-cancellation", section: "Tasks", content: TASKS_PLAIN })).error!, /only its Design and Decisions may change/);
    assert.match((await tool("pb_update_spec", { name: "order-cancellation", section: "Goal", content: "Cancel orders fast." })).error!, /only its Design and Decisions may change/);
    assert.equal((await tool("pb_update_spec", { name: "order-cancellation", section: "Design", content: "- One `Order` aggregate per file." })).error, undefined);
    assert.equal((await tool("pb_update_spec", { name: "order-cancellation", section: "Decisions", content: "- A build-time assumption.", mode: "append" })).error, undefined);
    // A direct write into the spec's folder is blocked like the tool: the snapshot can't be touched either.
    assert.match((await tool("write", { path: ".pi/pb/specs/order-cancellation/spec.md", content: "# rewritten" })).error!, /approved spec is read-only/);
    assert.match((await tool("write", { path: ".pi/pb/specs/order-cancellation/approved.md", content: "# rewritten" })).error!, /approved spec is read-only/);
    // The same folder spelled through the symlink is the spec too, not an unrelated path.
    const before = t.read(".pi/pb/specs/order-cancellation/spec.md");
    assert.match((await tool("write", { path: ".pi/specs-link/order-cancellation/spec.md", content: "# rewritten" })).error!, /approved spec is read-only/);
    assert.match((await tool("write", { path: ".pi/specs-link/order-cancellation/approved.md", content: "# rewritten" })).error!, /approved spec is read-only/);
    assert.equal(t.read(".pi/pb/specs/order-cancellation/spec.md"), before);
    await tool("pb_tests_red", { task: "T1" });
    fs.writeFileSync(path.join(t.repo, "T1.txt"), "x");
    await tool("pb_task_done", { task: "T1", status: "done", changed: "T1", caveat: "none", rejected: "none", open: "none" });
  };
  await t.run("build");
  const p = t.progress("order-cancellation");
  assert.equal(p.current, "T2"); // T1 done, the build rests mid-run
  const live = t.read(".pi/pb/specs/order-cancellation/spec.md");
  assert.match(live, /## Design\n- One `Order` aggregate per file\./);
  // Design and Decisions are outside the contract: the approval still covers the spec as it stands.
  assert.equal(p.approval.contractHash, contractHash(live));
  // The approved snapshot is the text the build may not rewrite: the build's Design isn't in it.
  assert.doesNotMatch(t.read(".pi/pb/specs/order-cancellation/approved.md"), /One `Order` aggregate per file/);
});

test("build: a contract edited outside the build pauses it; /pb:build re-approves and resumes", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  const specFile = path.join(t.repo, ".pi/pb/specs/order-cancellation/spec.md");
  let stopped = "";
  t.agent.script = async (text, tool) => {
    if (text.includes("Task T1")) {
      await tool("pb_tests_red", { task: "T1" });
      fs.writeFileSync(path.join(t.repo, "T1.txt"), "x");
      await tool("pb_task_done", { task: "T1", status: "done", changed: "T1", caveat: "none", rejected: "none", open: "none" });
      return;
    }
    if (text.includes("Task T2")) {
      // The human edits the contract while T2 runs, past every write gate.
      fs.writeFileSync(specFile, fs.readFileSync(specFile, "utf8").replace("Cancel orders.", "Cancel orders before they ship."));
      const done = await tool("pb_task_done", { task: "T2", status: "done", changed: "T2", caveat: "none", rejected: "none", open: "none" });
      stopped = done.content?.[0].text ?? "";
    }
  };
  await t.run("build");
  assert.match(stopped, /contract no longer matches its approval/);
  const paused = t.progress("order-cancellation");
  assert.equal(paused.phase, "paused");
  assert.match(paused.pause, /contract was edited after it was approved/);
  assert.ok(t.posts.some((x) => /Build paused/.test(x)));
  // The revision is approved by /pb:build, and the build carries on from where it stopped.
  t.agent.script = async (text, tool) => {
    if (!/Continue task T2/.test(text)) return;
    await tool("pb_tests_red", { task: "T2" });
    fs.writeFileSync(path.join(t.repo, "T2.txt"), "x");
    await tool("pb_task_done", { task: "T2", status: "done", changed: "T2", caveat: "none", rejected: "none", open: "none" });
  };
  await t.run("build");
  assert.ok(t.posts.some((x) => /Spec re-approved/.test(x)));
  const built = t.progress("order-cancellation");
  assert.equal(built.phase, "built");
  assert.equal(built.edited, true); // the reviewer is told the write gates were bypassed
  assert.equal(built.approval.contractHash, contractHash(fs.readFileSync(specFile, "utf8")));
  assert.match(t.read(".pi/pb/specs/order-cancellation/approved.md"), /Cancel orders before they ship/);
});

test("build: a rename that orphans a prose citation is flagged at completion", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  const { execSync } = await import("node:child_process");
  fs.writeFileSync(path.join(t.repo, "src-helper.ts"), "export function oldHelperName() { return 1; }\n");
  fs.writeFileSync(path.join(t.repo, "REF.md"), "call `oldHelperName` first\n");
  execSync("git add -A && git commit -qm base", { cwd: t.repo });
  await t.callTool("pb_write_spec", {
    name: "order-cancellation",
    content: SPEC({ tasks: "### T1: first file\nCreate T1.txt.\n- Acceptance: T1.txt exists (tests: T1)\n- Test: `test -f T1.txt`" }),
  });
  t.agent.script = async (text, tool) => {
    const task = taskOf(text);
    if (task === "T1") {
      await tool("pb_tests_red", { task });
      fs.writeFileSync("src-helper.ts", "export function newHelperName() { return 1; }\n");
      fs.writeFileSync("T1.txt", "x");
    }
    if (task && task !== "final") await tool("pb_task_done", { task, status: "done", changed: "did it", caveat: "none", rejected: "none", open: "none" });
  };
  await t.run("build", "order-cancellation");
  assert.match(t.posts.at(-1)!, /oldHelperName: REF\.md:1/);
});

test("build: a task stays narrow, edits structured files literally, and leaves the full suite to the harness", async () => {
  const { taskPrompt, specPrompt, finishSpecPrompt } = await import("../extensions/pb/prompts.ts");
  const spec = parseSpec(SPEC()).spec!;
  const prompt = taskPrompt(spec.tasks[0], 1, 3, []);
  assert.match(prompt, /Keep the change to this task/);
  assert.match(prompt, /finish the smallest coherent part and report the rest as open/);
  assert.match(prompt, /Don't run the full suite/);
  assert.match(prompt, /Edit structured files \(XML, JSON, YAML\) by exact literal replacement or line-based edits, never a backtracking regex\./);
  for (const p of [specPrompt("", []), finishSpecPrompt("x")]) {
    assert.match(p, /Keep each task narrow/);
    assert.match(p, /full-suite run/);
  }
  assert.match(specPrompt("", []), /Split work that bundles several independent changes/);
});

test("checkpoints: an unchanged tree reuses the tip commit without moving the ref", async () => {
  const t = setup();
  const { snapshot } = await import("../extensions/pb/checkpoint.ts");
  const count = () => Number(execSync("git rev-list --count refs/pb/checkpoints", { cwd: t.repo, encoding: "utf8" }).trim());
  fs.writeFileSync(path.join(t.repo, "a.txt"), "one");
  const first = snapshot(t.repo, "pb: first")!;
  assert.equal(count(), 1);
  const again = snapshot(t.repo, "pb: second")!; // nothing changed between the two calls
  assert.equal(again.commit, first.commit);
  assert.equal(again.tree, first.tree);
  assert.equal(count(), 1); // no new commit object; the ref still stands where the first put it
  fs.writeFileSync(path.join(t.repo, "a.txt"), "two");
  const moved = snapshot(t.repo, "pb: third")!;
  assert.notEqual(moved.commit, first.commit);
  assert.equal(count(), 2);
});

test("checkpoints: concurrent snapshot processes never orphan a commit the ref once named", async () => {
  const t = setup();
  // Six processes snapshot the same repo at once: each reads the tip, commits against it and
  // moves the ref. With a blind update-ref the later writer rewinds the tip past the earlier
  // commit (the window spans the commit-tree exec), orphaning it; compare-and-swap chains
  // every commit, so each one a process got back stays an ancestor of the final tip.
  const moduleUrl = new URL("../extensions/pb/checkpoint.ts", import.meta.url).href;
  const script = `
    const { snapshot } = await import(process.argv[1]);
    const fs = await import("node:fs");
    const path = await import("node:path");
    const [cwd, id] = [process.argv[2], process.argv[3]];
    const commits = [];
    for (let k = 0; k < 12; k++) {
      fs.writeFileSync(path.join(cwd, id + ".txt"), id + "-" + k);
      const s = snapshot(cwd, "storm " + id + " " + k);
      if (s) commits.push(s.commit);
    }
    console.log(commits.join(" "));
  `;
  const { spawn } = await import("node:child_process");
  // All children run at once (spawn, not spawnSync): the race needs overlapping writers.
  const children = [1, 2, 3, 4, 5, 6].map((n) => new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, moduleUrl, t.repo, `w${n}`], { cwd: t.repo, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
  }));
  const done = await Promise.all(children);
  const commits = done.flatMap((c) => c.out.trim().split(/\s+/).filter(Boolean));
  assert.equal(done.filter((c) => c.code === 0).length, done.length, done.map((c) => c.err).join("\n"));
  assert.ok(commits.length >= 60, `the storm produced only ${commits.length} snapshots`);
  const tip = execSync("git rev-parse refs/pb/checkpoints", { cwd: t.repo, encoding: "utf8" }).trim();
  const lost = commits.filter((c) => {
    try {
      execSync(`git merge-base --is-ancestor ${c} ${tip}`, { cwd: t.repo, stdio: "ignore" });
      return false;
    } catch {
      return true;
    }
  });
  assert.deepEqual(lost, [], `${lost.length} of ${commits.length} commits the storm recorded are unreachable from the tip`);
  for (const f of fs.readdirSync(path.join(t.repo, ".git")).filter((f) => f.startsWith("pb-index-"))) fs.rmSync(path.join(t.repo, ".git", f), { force: true });
});

test("checkpoints: a checkpoint row that adds no information over the last row is not stored", async () => {
  const { appendCheckpoint } = await import("../extensions/pb/store.ts");
  const list: any[] = [];
  const row = (over: object = {}): any => ({
    id: "T1", task: "T1", at: "2026-01-01 00:00:00", commit: "c1", tree: "t1", head: "h1", entry: "e1",
    tasks: [{ id: "T1", title: "one", status: "todo", attempts: 1 }], ...over,
  });
  assert.equal(appendCheckpoint(list, row()), true);
  // Same step, same commit, conversation point and task list: the row would say nothing new.
  assert.equal(appendCheckpoint(list, row({ at: "2026-01-01 00:05:00", summary: "done later", files: ["a.ts"] })), false);
  assert.equal(list.length, 1);
  assert.equal(appendCheckpoint(list, row({ commit: "c2", tree: "t2" })), true); // the files moved
  assert.equal(appendCheckpoint(list, row({ commit: "c2", tree: "t2", entry: "e2" })), true); // the conversation moved
  assert.equal(appendCheckpoint(list, row({ commit: "c2", tree: "t2", entry: "e2", tasks: [] })), true); // the task list moved
  // A row is found by its id (undo targets, task summaries): another step's row is never dropped.
  assert.equal(appendCheckpoint(list, row({ commit: "c3", tree: "t3", entry: "e3", id: "T2", task: "T2" })), true);
  assert.equal(list.length, 5);
});

test("sibling repositories: a spec that also changes ../<repo> gets undo points, a review diff and a commit there too", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  const sibling = fs.mkdtempSync(path.join(path.dirname(fs.realpathSync(t.repo)), "pb-front-"));
  const name = `../${path.basename(sibling)}`;
  try {
    execSync("git init -q && git config user.email t@t && git config user.name t && echo base > README && git add . && git commit -qm base", { cwd: sibling, shell: "/bin/sh" });
    // The header is checked: a sibling that is not a repository beside the project is refused at a ready write.
    const { Store } = await import("../extensions/pb/store.ts");
    new Store(t.repo).markAsked("standards");
    const missing = await t.callTool("pb_write_spec", { name: "order-cancellation", content: SPEC().replace("Depends on: none", "Depends on: none\nAlso changes: ../no-such-repo") });
    assert.match(missing.error!, /"Also changes: \.\.\/no-such-repo" is no git repository there/);
    assert.match((await t.callTool("pb_write_spec", { name: "x", content: SPEC().replace("Depends on: none", "Depends on: none\nAlso changes: ../../far") })).error!, /must name sibling repositories as \.\.\/<name>/);
    await written(t, SPEC().replace("Depends on: none", `Depends on: none\nAlso changes: ${name}`));
    // T1 also changes the frontend beside the project.
    t.agent.script = async (text, tool) => {
      if (taskOf(text) === "T1") fs.writeFileSync(path.join(sibling, "front.txt"), "cancel button\n");
      return diligent(text, tool);
    };
    await t.run("build");
    const rows = JSON.parse(t.read(".pi/pb/specs/order-cancellation/checkpoints.json"));
    assert.ok(rows.find((c: any) => c.id === "T1").repos?.[0]?.name === name, "the undo point covers the sibling too");
    await t.run("review");
    const brief = briefOf(t);
    assert.match(brief, new RegExp(`# The change in ${name.replace(/[.]/g, "\\.")} \\(the paths in this diff are inside`));
    assert.match(brief, /\+cancel button/);
    assert.match(brief, new RegExp(`## Changed files\\n[\\s\\S]*${name.replace(/[.]/g, "\\.")}/front\\.txt`));
    // One commit per repository, the same message in each; the sibling's file is offered by its ../ path.
    let offered = "";
    t.editors.push((prefill) => ((offered = prefill), prefill));
    await t.run("commit");
    assert.match(offered, new RegExp(`\\n- ${name.replace(/[.]/g, "\\.")}/front\\.txt\\n`));
    assert.equal(execSync("git log -1 --format=%s", { cwd: sibling, encoding: "utf8" }).trim(), "Order cancellation");
    assert.equal(execSync("git show --name-only --format= HEAD", { cwd: sibling, encoding: "utf8" }).trim(), "front.txt");
    assert.match(t.posts.at(-1)!, new RegExp(`^\\*\\*✅ Committed\\*\\* \`[0-9a-f]{7}\` · ${name.replace(/[.]/g, "\\.")} \`[0-9a-f]{7}\` — Order cancellation · 3 files`));
  } finally {
    fs.rmSync(sibling, { recursive: true, force: true });
  }
});

test("sibling repositories: /pb:undo puts the sibling back with the project", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  const sibling = fs.mkdtempSync(path.join(path.dirname(fs.realpathSync(t.repo)), "pb-front-"));
  const name = `../${path.basename(sibling)}`;
  try {
    execSync("git init -q && git config user.email t@t && git config user.name t && echo base > README && git add . && git commit -qm base", { cwd: sibling, shell: "/bin/sh" });
    await written(t, SPEC().replace("Depends on: none", `Depends on: none\nAlso changes: ${name}`));
    t.agent.script = async (text, tool) => {
      if (taskOf(text) === "T1") fs.writeFileSync(path.join(sibling, "front.txt"), "cancel button\n");
      return diligent(text, tool);
    };
    await t.run("build");
    assert.ok(fs.existsSync(path.join(sibling, "front.txt")));
    await t.run("undo", "T1");
    assert.ok(!fs.existsSync(path.join(sibling, "front.txt")), "the sibling's change went back with the project's");
    assert.match(t.posts.at(-1)!, /Undone to before T1/);
  } finally {
    fs.rmSync(sibling, { recursive: true, force: true });
  }
});

test("one build per working tree: a build running in another session refuses a second; one that left uncommitted files is named on the build-start screen", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  const { Store, gitHead } = await import("../extensions/pb/store.ts");
  const store = new Store(t.repo);
  store.markAsked("standards");
  await written(t);
  assert.equal((await t.callTool("pb_write_spec", { name: "refund-flow", content: SPEC() })).error, undefined);
  // refund-flow is building in another session: its session file was written a moment ago.
  const other = path.join(t.repo, "..", `other-session-${process.pid}.jsonl`);
  fs.writeFileSync(other, "{}\n");
  const p = store.progress("refund-flow")!;
  store.saveProgress({ ...p, phase: "building", session: other, baseCommit: gitHead(t.repo) });
  fs.writeFileSync(path.join(t.repo, "refund.txt"), "half done\n");
  await t.run("build", "order-cancellation");
  assert.match(t.notes.at(-1)!, /^refund-flow is building in another session right now \(.+\)\. Two builds in one working tree mix their files: each one's undo points, review, checks and commit would see both\. Let it finish or pause, then \/pb:build order-cancellation\.$/);
  assert.equal(t.progress("order-cancellation").phase, "written", "refused: nothing approved");
  // Its session went quiet long ago (a crash, a closed terminal): not running, but its files are still here.
  const old = Date.now() / 1000 - 3 * 24 * 3600;
  fs.utimesSync(other, old, old);
  t.selects.push("Stop here");
  await t.run("build", "order-cancellation");
  assert.match(t.selectTitles.at(-1)!, /- ⚠ refund-flow's build stopped without finishing and 1 file changed since it began is uncommitted \(refund\.txt\): this build's undo points, review and commit would include it — \/pb:commit refund-flow first, unless they belong to this one/);
  // Committed: nothing left to mix, and the build goes ahead without asking.
  execSync("git add refund.txt && git commit -qm refund", { cwd: t.repo });
  t.agent.script = diligent;
  const screens = t.selectTitles.length;
  await t.run("build", "order-cancellation");
  assert.equal(t.selectTitles.length, screens);
  assert.equal(t.progress("order-cancellation").phase, "built");
  fs.rmSync(other, { force: true });
});

test("build: a task whose own Test: still fails is sent back, even without per-task checks: pb runs the green half of the red proof", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  const said: string[] = [];
  t.agent.script = async (text, tool) => {
    const task = taskOf(text);
    if (!task) return;
    await tool("pb_tests_red", { task });
    // The model claims done without creating the file its Test: checks for.
    said.push((await tool("pb_task_done", { task, status: "done", changed: `did ${task}`, caveat: "none", rejected: "none", open: "none" })).content![0].text);
  };
  await t.run("build");
  assert.match(said[0], /The check for T1 failed[\s\S]*`test -f T1\.txt`/);
  assert.ok(!said.some((s) => /Task T2/.test(s)));
});

test("undo: files no finished step changed are named, and you can keep them", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  // After the build: an edit of yours, which no step of the build made.
  fs.writeFileSync(path.join(t.repo, "notes.md"), "mine\n");
  t.selects.push("Restore only the 1 file finished steps changed; keep the other 1");
  await t.run("undo", "T2");
  assert.match(t.selectTitles.at(-1)!, /^Undo to before T2\?\n[\s\S]*No finished step changed these \(your edits, or the step in progress\): notes\.md$/);
  assert.ok(!fs.existsSync(path.join(t.repo, "T2.txt")), "the step's file went back");
  assert.equal(t.read("notes.md"), "mine\n", "yours stayed");
  assert.match(t.posts.at(-1)!, /Kept as you asked: notes\.md\./);
  // Redo, then undo everything: your file goes too, because you said so.
  await t.run("undo", "u1");
  assert.ok(fs.existsSync(path.join(t.repo, "T2.txt")), "redone");
  t.selects.push("Restore all 3 files");
  await t.run("undo", "T1");
  assert.ok(!fs.existsSync(path.join(t.repo, "notes.md")));
  assert.ok(!fs.existsSync(path.join(t.repo, "T1.txt")));
});

test("sibling repositories: a follow-up review isn't skipped when only the sibling changed since the last one", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  const sibling = fs.mkdtempSync(path.join(path.dirname(fs.realpathSync(t.repo)), "pb-front-"));
  const name = `../${path.basename(sibling)}`;
  try {
    execSync("git init -q && git config user.email t@t && git config user.name t && echo base > README && git add . && git commit -qm base", { cwd: sibling, shell: "/bin/sh" });
    await written(t, SPEC().replace("Depends on: none", `Depends on: none\nAlso changes: ${name}`));
    t.agent.script = diligent;
    await t.run("build");
    t.reviewer.review = [{ priority: "P2", file: "T1.txt", line: 1, title: "name the file" }] as any;
    await t.run("review");
    const reviews = () => t.instructions.filter((i) => i.startsWith("[pb:review]")).length;
    const first = reviews();
    // Nothing anywhere: the follow-up is skipped, as before.
    await t.run("review");
    assert.match(t.notes.at(-1)!, /^Nothing changed since the last review/);
    assert.equal(reviews(), first);
    // A fix made only in the sibling is a change: it gets its follow-up, naming the sibling's file.
    fs.writeFileSync(path.join(sibling, "front.txt"), "fixed\n");
    await t.run("review");
    assert.equal(reviews(), first + 1);
    assert.match(briefOf(t), new RegExp(`${name.replace(/[.]/g, "\\.")}/front\\.txt`));
  } finally {
    fs.rmSync(sibling, { recursive: true, force: true });
  }
});
