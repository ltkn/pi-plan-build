/** Specs: the write tools and their gates, and the spec review. */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { type Result, citedPage, citingSpec, diligent, needsRed, parseSpec, PLANNING, redExemption, reviewEvents, reviewRuns, setup, SPEC, specHash, specRel, taskOf, TASKS_PLAIN, until, written } from "./harness.mts";

test("pb_write_spec rejects a spec that doesn't parse, and a bad name", async () => {
  const t = setup();
  process.chdir(t.repo);
  assert.match((await t.callTool("pb_write_spec", { name: "x", content: "# only a title" })).error!, /doesn't parse[\s\S]*Verification/);
  assert.match((await t.callTool("pb_write_spec", { name: "Bad Name", content: SPEC() })).error!, /not a valid name/);
  await written(t);
  assert.deepEqual(t.progress("order-cancellation").tasks.map((x: any) => [x.id, x.status]), [["T1", "todo"], ["T2", "todo"]]); // the spec's tasks, and nothing else
});

test("spec review leaves the project untouched: stray writes are put back", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  const planted = path.join(t.repo, "REVIEW_WAS_HERE");
  process.env.MOCK_SPEC_BRIEF_OUT = planted;
  try {
    t.agent.script = diligent;
    await t.run("build", "order-cancellation");
  } finally {
    delete process.env.MOCK_SPEC_BRIEF_OUT;
  }
  assert.ok(!fs.existsSync(planted));
  assert.equal(t.progress("order-cancellation").phase, "built");
});

test("spec review: the reviewer gets read-only tools, never a shell", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  const argsOut = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pb-args-")), "args.txt");
  process.env.MOCK_SPEC_ARGS_OUT = argsOut;
  t.agent.script = diligent;
  try {
    await t.run("build", "order-cancellation");
  } finally {
    delete process.env.MOCK_SPEC_ARGS_OUT;
  }
  const argv = fs.readFileSync(argsOut, "utf8").split("\n");
  // --tools is the whole selection, extension tools included: the reporting tool must be named here,
  // or the reviewer runs its whole pass with no way to report and every pass fails closed.
  assert.equal(argv[argv.indexOf("--tools") + 1], "read,grep,find,ls,report_findings");
  assert.ok(!argv.includes("bash"));
});

test("spec review: one pass on the frozen draft, with the whole text in its brief", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  const briefOut = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pb-brief-")), "brief.md"); // outside the project: the run is reverted
  process.env.MOCK_SPEC_BRIEF_OUT = briefOut;
  t.agent.script = diligent;
  try {
    await t.run("build", "order-cancellation");
  } finally {
    delete process.env.MOCK_SPEC_BRIEF_OUT;
  }
  const brief = fs.readFileSync(briefOut, "utf8");
  assert.match(brief, /^# Spec to review: order-cancellation\n/);
  assert.ok(brief.includes(SPEC().trim()), "the brief does not carry the frozen draft");
  assert.match(brief, /# Your job[\s\S]*empty list is a pass; only a P0 blocks/);
  // one pass: one saved run for this build, however many times the start is repeated
  await t.run("build", "order-cancellation");
  assert.equal(fs.readdirSync(path.join(t.repo, ".pi/pb/specs/order-cancellation/sessions/spec-review")).length, 1);
});

test("spec review: a P0 stops the build before T1 and is recorded against the spec text", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  process.env.MOCK_SPEC_REVIEW = "block";
  try {
    await t.run("build", "order-cancellation");
  } finally {
    delete process.env.MOCK_SPEC_REVIEW;
  }
  assert.equal(t.progress("order-cancellation").phase, "written");
  assert.match(t.posts.join("\n"), /\*\*❌ Spec review — order-cancellation\*\* · FAIL[\s\S]*\*\*P0\*\*[\s\S]*unguarded transition/);
  assert.ok(!t.instructions.some((i) => /Task T1/.test(i)));
  const specFile = path.join(t.repo, ".pi/pb/specs/order-cancellation/spec.md");
  const event = t.events("order-cancellation").filter((e: any) => e.type === "spec-review").at(-1);
  assert.equal(event.verdict, "block");
  assert.equal(event.hash, specHash(fs.readFileSync(specFile, "utf8")));
  assert.equal(event.reported[0].priority, "P0");
});

test("spec review: P1 and P2 are advisory and the build proceeds", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  t.agent.script = diligent;
  process.env.MOCK_SPEC_REVIEW = "advisory";
  try {
    await t.run("build", "order-cancellation");
  } finally {
    delete process.env.MOCK_SPEC_REVIEW;
  }
  assert.equal(t.progress("order-cancellation").phase, "built");
  assert.match(t.posts.join("\n"), /\*\*✅ Spec review — order-cancellation\*\* · PASS[\s\S]*\[P1\][\s\S]*\[P2\]/);
  assert.match(t.posts.find((p) => p.startsWith("**✅ Spec review"))!, /\*\*Next:\*\* T1 starts next\./);
  const event = t.events("order-cancellation").filter((e: any) => e.type === "spec-review").at(-1);
  assert.equal(event.verdict, "pass");
  assert.equal(typeof event.ms, "number");
  assert.ok(event.ms >= 0);
  assert.deepEqual(event.reported.map((f: any) => f.priority), ["P1", "P2"]);
  assert.match(t.posts.find((p) => p.startsWith("**✅ Build complete"))!, / · (?:<1s|\d+s)/);
});

test("spec review: a P1 is information the build carries — never a question — and a reused pass posts it again", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  t.agent.script = diligent;
  process.env.MOCK_SPEC_REVIEW = "advisory";
  try {
    // A review on its own: the verdict is recorded, nothing is built.
    await t.run("spec-review", "order-cancellation");
    const posted = t.posts.length;
    // The build door reuses that pass silently, so its P1 is posted here — and the build goes on.
    await t.run("build", "order-cancellation");
    const shown = t.posts.slice(posted).join("\n");
    assert.match(shown, /\*\*The build carries 1 P1 finding from the spec review\*\* — not blocking; the code review judges the result:\n\n- 1\. \[P1\]/);
    assert.ok(!t.selectTitles.some((x) => x.startsWith("Build order-cancellation")), "no build-start screen for a P1");
    assert.equal(t.progress("order-cancellation").phase, "built");
  } finally {
    delete process.env.MOCK_SPEC_REVIEW;
  }
});

test("spec review: a spec is reviewed once — an edit after a pass builds unreviewed, an edit after a P0 is reviewed", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  t.agent.script = diligent;
  const edit = (marker: string) => fs.writeFileSync(path.join(t.repo, specRel), t.read(specRel).replace("Refunds.", `Refunds. ${marker}`));
  process.env.MOCK_SPEC_REVIEW = "block";
  try {
    await t.run("build", "order-cancellation");
    assert.equal(reviewEvents(t).length, 1);
    assert.equal(t.progress("order-cancellation").phase, "written", "the P0 holds the build");
    // The edit that settles the P0 is what a review must see: it is reviewed.
    edit("The P0 is settled.");
    process.env.MOCK_SPEC_REVIEW = "advisory";
    await t.run("build", "order-cancellation");
    assert.equal(reviewEvents(t).length, 2, "after a block, the edit is reviewed");
    assert.equal(t.progress("order-cancellation").phase, "built");
  } finally {
    delete process.env.MOCK_SPEC_REVIEW;
  }
  // A second spec: passed, then edited — the build takes the edit without another pass.
  const u = setup({ verify: "true" });
  await written(u);
  u.agent.script = diligent;
  process.env.MOCK_SPEC_REVIEW = "advisory";
  try {
    await u.run("spec-review", "order-cancellation");
    fs.writeFileSync(path.join(u.repo, specRel), u.read(specRel).replace("Refunds.", "Refunds. Settled with the planner."));
    await u.run("build", "order-cancellation");
    assert.equal(reviewEvents(u).length, 1, "a pass is not repeated for an edit");
    assert.match(u.posts.join("\n"), /order-cancellation changed since its review passed; pb reviews a spec once, so this text goes to the build as it is, and the code review judges the result against it\. `\/pb:spec-review order-cancellation` reviews it again if you want\./);
    assert.equal(u.progress("order-cancellation").phase, "built");
    assert.equal(u.progress("order-cancellation").approval?.hash, specHash(u.read(specRel)), "the build approved the edited text");
    // Asked for by name, a review of the edited text runs.
    fs.writeFileSync(path.join(u.repo, specRel), u.read(specRel).replace("Refunds.", "Refunds. Edited again."));
    await u.run("spec-review", "order-cancellation");
    assert.equal(reviewEvents(u).length, 2, "/pb:spec-review reviews the new text when you ask");
  } finally {
    delete process.env.MOCK_SPEC_REVIEW;
  }
});

test("spec review: P2 and P3 alone build without asking", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  t.agent.script = diligent;
  process.env.MOCK_SPEC_REVIEW = "minor";
  try {
    await t.run("build", "order-cancellation");
  } finally {
    delete process.env.MOCK_SPEC_REVIEW;
  }
  assert.ok(!t.selectTitles.some((x) => x.startsWith("Build order-cancellation")), "nothing to hold the build for: no screen");
  assert.equal(t.progress("order-cancellation").phase, "built");
});

test("spec review: an unchanged spec re-posts the block without a second run; an edit reviews again", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  const runs = () => fs.readdirSync(path.join(t.repo, ".pi/pb/specs/order-cancellation/sessions/spec-review")).length;
  process.env.MOCK_SPEC_REVIEW = "block";
  try {
    await t.run("build", "order-cancellation");
    const afterFirst = runs();
    await t.run("build", "order-cancellation");
    assert.equal(runs(), afterFirst); // the recorded block still covers this text
    assert.match(t.posts.at(-1)!, /the recorded pass covers this text/);
  } finally {
    delete process.env.MOCK_SPEC_REVIEW;
  }
  const specFile = path.join(t.repo, ".pi/pb/specs/order-cancellation/spec.md");
  fs.writeFileSync(specFile, fs.readFileSync(specFile, "utf8").replace("Cancel orders.", "Cancel orders before they ship."));
  t.agent.script = diligent;
  process.env.MOCK_SPEC_REVIEW = "pass";
  try {
    await t.run("build", "order-cancellation");
  } finally {
    delete process.env.MOCK_SPEC_REVIEW;
  }
  assert.equal(runs(), 2);
  assert.equal(t.progress("order-cancellation").phase, "built");
});

test("spec review: a run that reports no findings fails closed", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  process.env.MOCK_SPEC_REVIEW = "crash";
  try {
    await t.run("build", "order-cancellation");
  } finally {
    delete process.env.MOCK_SPEC_REVIEW;
  }
  assert.equal(t.progress("order-cancellation").phase, "written");
  assert.match(t.posts.at(-1)!, /the reviewer returned no findings through its tool[\s\S]*What it wrote instead:\n\nreviewer exploded/);
  assert.match(t.posts.at(-1)!, /\*\*Next:\*\*[^\n]*"specReviewer": \{"model": "provider\/id"\}/);
  assert.ok(!t.instructions.some((i) => /Task T1/.test(i)));
  const event = t.events("order-cancellation").filter((e: any) => e.type === "spec-review").at(-1);
  assert.equal(event.verdict, "error");

  // A reviewer that did the work and wrote it as prose: its words reach the human, not just the error.
  const u = setup({ verify: "true" });
  await written(u);
  process.env.MOCK_SPEC_REVIEW = "prose";
  try {
    await u.run("build", "order-cancellation");
  } finally {
    delete process.env.MOCK_SPEC_REVIEW;
  }
  assert.equal(u.progress("order-cancellation").phase, "written");
  assert.match(u.posts.at(-1)!, /What it wrote instead:[\s\S]*the reuse predicate can never match[\s\S]*pi --session/);
});

test("spec review: the configured model and thinking run the pass and are recorded", async () => {
  const t = setup({ verify: "true", specReviewer: { model: "other/model", thinking: "high" } });
  await written(t);
  t.agent.script = diligent;
  await t.run("build", "order-cancellation");
  const event = t.events("order-cancellation").filter((e: any) => e.type === "spec-review").at(-1);
  assert.equal(event.model, "other/model");
  assert.equal(event.thinking, "high");
});

test("spec-review command: the pre-build review on its own, with nothing built", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  process.env.MOCK_SPEC_REVIEW = "advisory";
  try {
    await t.run("spec-review", "order-cancellation");
  } finally {
    delete process.env.MOCK_SPEC_REVIEW;
  }
  // The verdict lands; nothing else follows from it: no approval, no task, no build session.
  assert.equal(t.progress("order-cancellation").phase, "written");
  assert.equal(t.instructions.length, 0, `a review must not instruct a build: ${t.instructions.join("\n")}`);
  const posted = t.posts.find((p) => p.startsWith("**\u2705 Spec review"))!;
  assert.match(posted, /· PASS · P0 0 · P1 1 · P2 1 · P3 0/);
  assert.match(posted, /\*\*Next:\*\* `\/pb:build order-cancellation` starts at T1 on this verdict/);
  assert.match(posted, /\*\*Advisory\*\*[\s\S]*\[P1\][\s\S]*\[P2\]/);
  const event = reviewEvents(t).at(-1);
  assert.equal(event.verdict, "pass");
  assert.equal(event.hash, specHash(t.read(specRel)));
  assert.equal(typeof event.head, "string", "the pass stamps the HEAD its citations were read in");
});

test("spec-review command: /pb:build rides on the pass it recorded instead of reviewing again", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  process.env.MOCK_SPEC_REVIEW = "advisory";
  try {
    await t.run("spec-review", "order-cancellation");
  } finally {
    delete process.env.MOCK_SPEC_REVIEW;
  }
  assert.equal(reviewRuns(t), 1);
  t.agent.script = diligent;
  await t.run("build", "order-cancellation");
  assert.equal(reviewRuns(t), 1, "the recorded pass covers this text: no second reviewer");
  assert.equal(t.progress("order-cancellation").phase, "built");
});

test("spec-review command: a verdict on record is shown, and says which commit it read the code in", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  process.env.MOCK_SPEC_REVIEW = "advisory";
  try {
    await t.run("spec-review", "order-cancellation");
    await t.run("spec-review", "order-cancellation");
  } finally {
    delete process.env.MOCK_SPEC_REVIEW;
  }
  assert.equal(reviewRuns(t), 1, "the stored pass is answered without a new run");
  const second = t.posts.at(-1)!;
  assert.match(second, /PASS \(already on record\)/);
  assert.match(second, /\*\*Advisory\*\*[\s\S]*\[P1\]/); // its findings come back with it
  assert.match(second, /the recorded verdict covers this text/);
  assert.ok(!second.includes("it read the code at"), "an unchanged HEAD has nothing to say");
  // A pass is bound to the spec bytes; the repository its citations were read in is not in that hash,
  // so a moved HEAD is said out loud rather than used to void the pass.
  execSync("git commit -qm moved --allow-empty", { cwd: t.repo });
  await t.run("spec-review", "order-cancellation");
  assert.match(t.posts.at(-1)!, /it read the code at [0-9a-f]{8}, HEAD is now [0-9a-f]{8}/);
  assert.equal(reviewRuns(t), 1);
});

test("spec-review command: a P0 is re-posted without a second run and still stops the build", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  process.env.MOCK_SPEC_REVIEW = "block";
  try {
    await t.run("spec-review", "order-cancellation");
    const first = t.posts.at(-1)!;
    assert.match(first, /\*\*\u274c Spec review \u2014 order-cancellation\*\* · FAIL · P0 1/);
    assert.match(first, /\*\*Next:\*\* fix the spec with `\/pb:spec order-cancellation`, then `\/pb:spec-review order-cancellation`\./);
    assert.match(first, /unguarded transition/);
    assert.equal(reviewEvents(t).at(-1)!.verdict, "block");
    await t.run("spec-review", "order-cancellation");
    assert.equal(reviewRuns(t), 1, "the standing P0 needs no second reviewer");
    // The build that follows meets the same verdict: a recorded block is not a suggestion.
    t.agent.script = diligent;
    await t.run("build", "order-cancellation");
  } finally {
    delete process.env.MOCK_SPEC_REVIEW;
  }
  assert.equal(reviewRuns(t), 1);
  assert.equal(t.progress("order-cancellation").phase, "written");
  assert.ok(!t.instructions.some((i) => /Task T1/.test(i)));
});

test("spec-review command: a run that reported nothing is never read as a pass", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  process.env.MOCK_SPEC_REVIEW = "crash";
  try {
    await t.run("spec-review", "order-cancellation");
  } finally {
    delete process.env.MOCK_SPEC_REVIEW;
  }
  assert.match(t.posts.at(-1)!, /the reviewer returned no findings through its tool/);
  assert.match(t.posts.at(-1)!, /\*\*Next:\*\* `\/pb:spec-review order-cancellation` to try again/);
  assert.equal(reviewEvents(t).at(-1)!.verdict, "error");
  assert.equal(reviewRuns(t), 1);
  // An error cannot carry a build: the build reviews the text itself.
  t.agent.script = diligent;
  await t.run("build", "order-cancellation");
  assert.equal(reviewRuns(t), 2);
  assert.equal(t.progress("order-cancellation").phase, "built");
});

test("spec-review command: a spec edited while the pass runs is left without a verdict for the new text", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  process.env.MOCK_SPEC_EDIT = path.join(t.repo, specRel); // the reviewer's run touches the draft
  try {
    await t.run("spec-review", "order-cancellation");
  } finally {
    delete process.env.MOCK_SPEC_EDIT;
  }
  assert.match(t.notes.at(-1)!, /changed while it was under review: run `\/pb:spec-review order-cancellation` again/);
  assert.equal(t.progress("order-cancellation").phase, "written");
  const event = reviewEvents(t).at(-1)!;
  assert.notEqual(event.hash, specHash(t.read(specRel)), "the pass covers the text it read, never the newer one");
});

test("spec-review command: an unusable name is refused before any path is read", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  for (const bad of ["../order-cancellation", "Order.Cancellation", "."]) {
    await t.run("spec-review", bad);
    assert.match(t.notes.at(-1)!, /isn't a valid spec name/, `"${bad}" was taken as a name`);
  }
  await t.run("spec-review", "no-such-spec");
  assert.match(t.notes.at(-1)!, /No spec `no-such-spec` here/);
  assert.equal(reviewEvents(t).length, 0);
  assert.ok(!t.posts.some((p) => p.includes("Spec review \u2014")));
});

test("spec-review command: a spec still being planned has no contract to review yet", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  const file = path.join(t.repo, specRel);
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("# Order cancellation\n", "# Order cancellation\nStatus: planning\n"));
  await t.run("spec-review", "order-cancellation");
  assert.match(t.notes.at(-1)!, /still being planned/);
  assert.equal(reviewEvents(t).length, 0);
});

test("spec-review command: a spec whose build is running gets the plan review as advice", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  let died = false;
  t.agent.script = async (text, tool) => {
    if (taskOf(text) === "T2" && !died) {
      died = true;
      return; // the session "dies" mid-build: the build is paused, not finished
    }
    return diligent(text, tool);
  };
  await t.run("build", "order-cancellation");
  assert.equal(t.progress("order-cancellation").phase, "paused");
  await t.run("spec-review", "order-cancellation");
  // The build's own pass already covers this text, so the answer is the stored verdict — and it says
  // plainly that a running build is not re-gated by a plan-level review.
  const posted = t.posts.at(-1)!;
  assert.match(posted, /PASS \(already on record\)/);
  assert.match(posted, /a build of order-cancellation is underway: this pass does not re-gate it/);
  assert.equal(t.progress("order-cancellation").phase, "paused", "a review leaves the paused build alone");
});

test("spec-review: no name and several ready specs refuse headless instead of judging an arbitrary one", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  const other = await t.callTool("pb_write_spec", { name: "other-spec", content: SPEC().replace("# Order cancellation", "# Other spec") });
  assert.equal(other.error, undefined, other.error ?? "");
  const reviews = () => (fs.existsSync(path.join(t.repo, ".pi/pb/specs/order-cancellation/sessions/spec-review")) ? fs.readdirSync(path.join(t.repo, ".pi/pb/specs/order-cancellation/sessions/spec-review")).length : 0);
  t.runtime().hasUI = false;
  try {
    await t.run("spec-review");
  } finally {
    t.runtime().hasUI = true;
  }
  assert.match(t.notes.at(-1)!, /Which spec\?[\s\S]*other-spec/);
  assert.equal(reviews(), 0, "no pass ran on a spec nobody picked");
});

test("spec-review: --fresh pays for another pass at the same text instead of reusing", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  const reviews = () => (fs.existsSync(path.join(t.repo, ".pi/pb/specs/order-cancellation/sessions/spec-review")) ? fs.readdirSync(path.join(t.repo, ".pi/pb/specs/order-cancellation/sessions/spec-review")).length : 0);
  process.env.MOCK_SPEC_REVIEW = "advisory";
  try {
    await t.run("spec-review", "order-cancellation");
    assert.equal(reviews(), 1);
    await t.run("spec-review", "order-cancellation");
    assert.equal(reviews(), 1, "the stored pass is reused on identical text");
    assert.match(t.posts.at(-1)!, /PASS \(already on record\)/);
    await t.run("spec-review", "order-cancellation --fresh");
    assert.equal(reviews(), 2, "--fresh forces another pass at the same bytes");
    assert.match(t.posts.at(-1)!, /\*\*✅ Spec review — order-cancellation\*\* · PASS/);
  } finally {
    delete process.env.MOCK_SPEC_REVIEW;
  }
});

test("spec-review: a PASS with advisory findings says they are information, and how to settle one first", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  process.env.MOCK_SPEC_REVIEW = "advisory";
  try {
    await t.run("spec-review", "order-cancellation");
    const hint = /these findings are information; only a P0 holds the build\n- `\/pb:build order-cancellation` — builds and carries them[\s\S]*- `\/pb:build order-cancellation --fresh`[\s\S]*- `\/pb:plan order-cancellation` — settle one first: tell the planner which and how/;
    assert.match(t.posts.at(-1)!, hint);
    await t.run("spec-review", "order-cancellation"); // the stored pass says so too
    assert.match(t.posts.at(-1)!, /PASS \(already on record\)/);
    assert.match(t.posts.at(-1)!, hint);
  } finally {
    delete process.env.MOCK_SPEC_REVIEW;
  }
});

test("spec: two tasks sharing one Test: command are warned, since one run cannot show each task's tests failing", async () => {
  const t = setup();
  process.chdir(t.repo);
  const r = await t.callTool("pb_write_spec", {
    name: "order-cancellation",
    content: SPEC({
      tasks: `### T1: first file
Create T1.txt.
- Acceptance: T1.txt exists
- Test: \`test -f both.txt\`

### T2: second file
Create T2.txt.
- Acceptance: T2.txt exists
- Test: \`test -f both.txt\``,
    }),
  });
  assert.equal(r.error, undefined);
  assert.match(r.content![0].text, /\`test -f both\.txt\` is the Test: of T1, T2: one run cannot show each task's own new tests failing — give each task its own command/);
});

test("spec: a task needs red exactly when no exemption explains it", () => {
  const { spec } = parseSpec(SPEC());
  assert.deepEqual(spec!.tasks.map((t) => needsRed(spec!, t)), [true, true]);
  // One definition both ways: no Test: line, a refactor, no new tests, no tests to run.
  const noTest = parseSpec(SPEC({ tasks: "### T1: a\n- Acceptance: it works\n" })).spec!;
  assert.equal(needsRed(noTest, noTest.tasks[0]), false);
  assert.match(redExemption(noTest, noTest.tasks[0])!, /no Test: command/);
  const refactor = parseSpec(SPEC({ tasks: "### T1: (refactor) rename\n- Acceptance: renamed\n- Test: `true`\n" })).spec!;
  assert.match(redExemption(refactor, refactor.tasks[0])!, /refactor keeps behaviour/);
  const none = parseSpec(SPEC({ newTests: "no — covered by T9" })).spec!;
  assert.match(redExemption(none, none.tasks[0])!, /asks for no new tests \(covered by T9\)/);
  const build = parseSpec(SPEC({ verification: "build — no suite here" })).spec!;
  assert.match(redExemption(build, build.tasks[0])!, /verification is "build", so no test runs/);
  assert.equal(redExemption(spec!, spec!.tasks[0]), undefined);
  assert.equal(redExemption(spec!, undefined), undefined);
});

test("spec: design provenance states where the Design comes from", async () => {
  const { designProvenance } = await import("../extensions/pb/prompts.ts");
  const md = "# T\n\n## Design\n- shape\n";
  assert.equal(designProvenance("# T\n\n## Goal\n", []), undefined); // no Design section: silent
  assert.equal(
    designProvenance(md, [{ at: "t0", type: "build-start" }]),
    "Design provenance: from the plan, untouched by the build.",
  );
  assert.equal(
    designProvenance("# T\n\n## Design:\n- shape\n", [{ at: "t0", type: "build-start" }]),
    "Design provenance: from the plan, untouched by the build.", // a colon heading is the same section
  );
  assert.equal(
    designProvenance(md, [
      { at: "t0", type: "spec", update: "Design" },
      { at: "t1", type: "build-start" },
    ]),
    "Design provenance: from the plan, untouched by the build.", // written before the build started
  );
  assert.equal(
    designProvenance(md, [
      { at: "t0", type: "build-start" },
      { at: "t1", type: "red", task: "T1" },
      { at: "t2", type: "spec", update: "Design" },
      { at: "t3", type: "red", task: "T2" },
    ]),
    "Design provenance: recorded once, first during the build.",
  );
  assert.equal(
    designProvenance(md, [
      { at: "t0", type: "build-start" },
      { at: "t1", type: "red", task: "T1" },
      { at: "t2", type: "spec", update: "design" },
      { at: "t3", type: "check", task: "final" },
      { at: "t4", type: "spec", update: "Design" },
    ]),
    "Design provenance: rewritten 2 times, first during the build, last after the last check — every change should be in Decisions.",
  );
});

test("spec: Status: ready can't have Open questions; planning can", async () => {
  const t = setup();
  process.chdir(t.repo);
  assert.match(parseSpec(`${SPEC()}## Open questions\n- undecided\n`).errors.join("; "), /can't have "## Open questions"/);
  assert.deepEqual(parseSpec(SPEC().replace("# Order cancellation\n", "# Order cancellation\nStatus: planning\n") + "## Open questions\n- undecided\n").errors, []);
  assert.match((await t.callTool("pb_write_spec", { name: "x", content: `${SPEC()}## Open questions\n- undecided\n` })).error!, /can't have "## Open questions"/);
  // An empty header carries no undecided questions: treated as absent, not rejected.
  assert.deepEqual(parseSpec(`${SPEC()}## Open questions\n`).errors, []);
  assert.deepEqual(parseSpec(`${SPEC()}## Open questions:\n   \n`).errors, []);
  assert.equal((await t.callTool("pb_write_spec", { name: "y", content: `${SPEC()}## Open questions\n` })).error, undefined);
});

test("spec: Depends on names a spec; a note after the name is not part of it", () => {
  const withDep = (line: string) => parseSpec(SPEC().replace("Depends on: none", `Depends on: ${line}`));
  assert.equal(withDep("order-cancellation").spec!.dependsOn, "order-cancellation");
  assert.equal(withDep("order-cancellation (built; its endpoints are unchanged)").spec!.dependsOn, "order-cancellation");
  assert.equal(withDep("order-cancellation — implemented and on HEAD; this spec consumes its endpoints unchanged").spec!.dependsOn, "order-cancellation");
  assert.equal(withDep("none (nothing to order before this)").spec!.dependsOn, undefined);
  assert.equal(withDep("none — nothing to order before this").spec!.dependsOn, undefined);
  const bad = withDep("the live trains spec — implemented and on HEAD");
  assert.equal(bad.spec, undefined);
  assert.match(bad.errors.join("; "), /"Depends on: the live trains spec — implemented and on HEAD" must name a spec \(short kebab-case, e\.g\. order-cancellation\) or none/);
});

test("spec: a behaviour task without Test:, or with a no-op one, warns — refactors stay quiet", async () => {
  const t = setup();
  process.chdir(t.repo);
  const tasks = "### T1: real file\nCreate T1.txt.\n- Acceptance: T1.txt exists\n\n### T2: (refactor) tidy\nNothing new.\n- Acceptance: behaviour unchanged (non-testable: a refactor adds no behaviour)\n- Test: `true`";
  const w = (await t.callTool("pb_write_spec", { name: "a", content: SPEC({ tasks }) })).content![0].text;
  assert.match(w, /Note: T1 adds behaviour but has no Test: line — add a targeted command, or leave it out/);
  assert.doesNotMatch(w, /T2/); // a refactor is exempt: nothing to warn
  const noop = (await t.callTool("pb_write_spec", { name: "b", content: SPEC({ tasks: "### T1: real file\nCreate T1.txt.\n- Acceptance: T1.txt exists (tests: T1)\n- Test: `true`" }) })).content![0].text;
  assert.match(noop, /Note: T1's Test: `true` always passes — the build will wedge demanding red/);
  const chained = (await t.callTool("pb_write_spec", { name: "c", content: SPEC({ tasks: "### T1: real file\nCreate T1.txt.\n- Acceptance: T1.txt exists (tests: T1)\n- Test: `test -f T1.txt && echo done`" }) })).content![0].text;
  assert.match(chained, /chains shells or reaches the network/); // && is chaining too, and skips the pre-approval dry-run
});

test("spec: shared seams without Contracts warn, never reject; shared Test: warns — advisory only", async () => {
  const t = setup();
  process.chdir(t.repo);
  const withContracts = (await t.callTool("pb_write_spec", { name: "a", content: SPEC() })).content![0].text;
  assert.doesNotMatch(withContracts, /no ## Contracts/);
  const stripped = SPEC().replace("## Contracts\n- T1 owns T1.txt; T2 owns T2.txt; no shared seams beyond the file list above.\n", "");
  const disjoint = (await t.callTool("pb_write_spec", { name: "b", content: stripped })).content![0].text;
  assert.match(disjoint, /no ## Contracts/); // disjoint tasks: advisory warning only
  const sharedNoContracts = SPEC({ tasks: "### T1: a\n- Acceptance: a (tests: T1)\n- Test: `test -f shared.txt`\n\n### T2: b\n- Acceptance: b (tests: T2)\n- Test: `test -f shared.txt`" }).replace("## Contracts\n- T1 owns T1.txt; T2 owns T2.txt; no shared seams beyond the file list above.\n", "");
  const sharedNo = await t.callTool("pb_write_spec", { name: "b2", content: sharedNoContracts });
  assert.equal(sharedNo.error, undefined, sharedNo.error ?? "");
  assert.match(sharedNo.content![0].text, /no ## Contracts/); // a warning, not a refusal
  const shared = (await t.callTool("pb_write_spec", {
    name: "c",
    content: SPEC({ tasks: "### T1: a\n- Acceptance: a (tests: T1)\n- Test: `true`\n\n### T2: b\n- Acceptance: b (tests: T2)\n- Test: `true`" }),
  })).content![0].text;
  assert.match(shared, /\nNote: `true` is the Test: of T1, T2: one run cannot show each task's own new tests failing — give each task its own command/);
  assert.doesNotMatch(withContracts, /is the Test: of/); // distinct commands: nothing shared
  // A Tasks edit re-warns on sharing; anything else stays quiet.
  const tasks = (await t.callTool("pb_update_spec", { name: "a", section: "Tasks", content: "### T1: a\n- Acceptance: a (tests: T1)\n- Test: `true`\n\n### T2: b\n- Acceptance: b (tests: T2)\n- Test: `true`\n\n### T3: c\n- Acceptance: c (tests: T3)\n- Test: `true`" })).content![0].text;
  assert.match(tasks, /Note: `true` is the Test: of T1, T2, T3/);
  const decisions = (await t.callTool("pb_update_spec", { name: "a", section: "Decisions", content: "- Only PENDING orders can be cancelled, because the state machine only allows that transition.\n- Not doing soft delete, because audit lives elsewhere.\n- d" })).content![0].text;
  assert.doesNotMatch(decisions, /Note:/);
});

test("spec format: a bound names its owner, and the citation grammar has one home", async () => {
  const { specPrompt, finishSpecPrompt } = await import("../extensions/pb/prompts.ts");
  for (const p of [specPrompt("", []), finishSpecPrompt("x")]) {
    const contracts = p.slice(p.indexOf("## Contracts"), p.indexOf("## Migration and rollback"));
    assert.match(contracts, /name the code that owns it/);
    assert.match(contracts, /path:line/);
    assert.match(contracts, /new: <path>/);
  }
  const here = path.dirname(new URL(import.meta.url).pathname);
  const specSrc = fs.readFileSync(path.join(here, "..", "extensions", "pb", "spec.ts"), "utf8");
  const indexSrc = fs.readFileSync(path.join(here, "..", "extensions", "pb", "kit.ts"), "utf8");
  for (const name of ["specPathRefs", "ROOT_FILE_REF"]) {
    assert.equal((specSrc.match(new RegExp(`const ${name}`, "g")) ?? []).length, 1, `spec.ts declares ${name} once`);
    assert.ok(!new RegExp(`const ${name}`).test(indexSrc), `kit.ts still declares ${name}`);
  }
  assert.match(indexSrc, /specPathRefs[^;\n]*from "\.\/spec\.ts"/);
});

test("spec citation: a stale path is refused on a ready spec, and a planning spec is exempt", async () => {
  const t = setup();
  process.chdir(t.repo);
  citedPage(t);
  const good = citingSpec("`src/page.ts:12` holds the model; baseline `npm test` green.");
  assert.equal((await t.callTool("pb_write_spec", { name: "good", content: good })).error, undefined);
  const badLine = good.replace("src/page.ts:12", "src/page.ts:999");
  assert.match((await t.callTool("pb_write_spec", { name: "bad-line", content: badLine })).error!, /has 30 lines/);
  const missingPath = good.replace("src/page.ts:12", "src/missing.ts:1");
  assert.match((await t.callTool("pb_write_spec", { name: "bad-path", content: missingPath })).error!, /not in the project/);
  const planningBad = missingPath.replace("# Slow page", "# Slow page\nStatus: planning");
  assert.equal((await t.callTool("pb_write_spec", { name: "planning-bad-path", content: planningBad })).error, undefined);
  const updated = await t.callTool("pb_update_spec", { name: "good", section: "Findings", content: "- `src/missing.ts:1` holds the model." });
  assert.match(updated.error!, /not in the project/);
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "TODO.md");
  assert.ok(!fs.existsSync(root), "TODO.md is removed; the spec is the source of truth");
});

test("spec citation: a gitignored file's cited line resolves, a past-the-end line and a dependency copy do not", async () => {
  const t = setup();
  process.chdir(t.repo);
  citedPage(t); // src/page.ts with 30 lines, visible to git
  fs.writeFileSync(path.join(t.repo, ".gitignore"), ".pi/\nsecrets/\nnode_modules/\n");
  fs.mkdirSync(path.join(t.repo, "secrets/deep"), { recursive: true });
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `// line ${i + 1}`).join("\n") + "\n";
  fs.writeFileSync(path.join(t.repo, "secrets/config.json"), lines(27)); // gitignored, and shallower than pb's own config
  fs.writeFileSync(path.join(t.repo, "secrets/deep/config.json"), lines(3));
  const write = (name: string, ref: string) => t.callTool("pb_write_spec", { name, content: citingSpec(`\`${ref}\` holds the local override.`) });

  // A name the visible listing misses is in the working tree, and a citation to it is checked by line
  // exactly like a tracked file's; a visible file keeps resolving as it did.
  assert.equal((await write("cite-ignored", "config.json:12")).error, undefined);
  assert.equal((await write("cite-ignored-deep", "deep/config.json:3")).error, undefined);
  assert.equal((await write("cite-visible", "src/page.ts:12")).error, undefined);

  // Past the end of the file the refusal is the one this gate already gives, and a dependency's copy of
  // a name is no answer at all. (`tokens.csv`: a name nothing else in this repo bears, unlike config.json,
  // which pb's own gitignored state bears.)
  assert.match((await write("cite-ignored-past", "config.json:9999")).error!, /`config\.json` has 27 lines/);
  assert.match((await write("cite-visible-past", "src/page.ts:9999")).error!, /has 30 lines/);
  fs.mkdirSync(path.join(t.repo, "node_modules/some/dep"), { recursive: true });
  fs.writeFileSync(path.join(t.repo, "node_modules/some/dep/tokens.csv"), "a,b\n");
  assert.match((await write("cite-vendored", "tokens.csv:1")).error!, /not in the project/);
  fs.rmSync(path.join(t.repo, "node_modules"), { recursive: true });
  assert.equal((await write("cite-ignored-again", "deep/config.json:3")).error, undefined);
});

test("spec citation: a hyphenated name is cited whole, and every line of a list is checked", async () => {
  const { specPathRefs } = await import("../extensions/pb/spec.ts");
  const refs = (text: string) => specPathRefs(text).map((r) => `${r.path}:${r.line}`);
  // A list after a backticked citation used to fail the backticked form and be read from inside the name.
  assert.deepEqual(refs("(`build-start.ts:47-57,65`; the window)"), ["build-start.ts:47", "build-start.ts:65"]);
  assert.deepEqual(refs("the rule at `build-start.ts:57, 65`"), ["build-start.ts:57", "build-start.ts:65"]);
  assert.deepEqual(refs("`a.b.ts:5,6`"), ["a.b.ts:5", "a.b.ts:6"]);
  assert.deepEqual(refs("(build-start.ts:47-57,65)"), ["build-start.ts:47", "build-start.ts:65"]);
  assert.deepEqual(refs("`build-start.ts:617-618`"), ["build-start.ts:617"]);
  assert.deepEqual(refs("see foo.ts:12, 14 tests pass"), ["foo.ts:12"], "in prose a number after a comma and space is not a line");

  const t = setup();
  process.chdir(t.repo);
  fs.mkdirSync(path.join(t.repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(t.repo, "src/build-start.ts"), Array.from({ length: 70 }, (_, i) => `// line ${i + 1}`).join("\n") + "\n");
  const write = (name: string, ref: string) => t.callTool("pb_write_spec", { name, content: citingSpec(`\`${ref}\` holds the window.`) });
  assert.equal((await write("cite-list", "src/build-start.ts:47-57,65")).error, undefined);
  const past = (await write("cite-list-past", "src/build-start.ts:47,99")).error!;
  assert.match(past, /`src\/build-start\.ts:99`, but `src\/build-start\.ts` has 70 lines/);
  assert.doesNotMatch(past, /not in the project/);
});

test("spec citation: nothing above the project root resolves, for the write gate or for the map", async () => {
  const { resolveProjectPath, unresolvedPaths } = await import("../extensions/pb/map.ts");

  // A project two levels under a directory this test owns, so `../../<name>` names a file that really exists.
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), "pb-above-"));
  const proj = path.join(outer, "a", "b");
  fs.mkdirSync(proj, { recursive: true });
  execSync("git init -q && git config user.email t@t && git config user.name t", { cwd: proj });
  fs.writeFileSync(path.join(outer, "secrets.json"), "// one\n// two\n// three\n"); // two levels above `proj`
  fs.writeFileSync(path.join(outer, "a", "keys.json"), "// one\n// two\n// three\n// four\n// five\n"); // and above the harness repo below
  fs.writeFileSync(path.join(proj, "known.ts"), "export {}\n");
  execSync("git add . && git commit -qm src", { cwd: proj });

  // The rule lives in the one function both readers use, and it runs before anything touches the disk.
  assert.equal(resolveProjectPath(proj, "../../secrets.json"), undefined);
  assert.ok(resolveProjectPath(proj, "known.ts"));
  assert.deepEqual(unresolvedPaths(proj, "- `../../secrets.json`: two levels up, and real").map((u) => u.path), ["../../secrets.json"]);

  // The write gate refuses the same citation, and says nothing about the file it names.
  const savedTmp = process.env.TMPDIR;
  process.env.TMPDIR = proj; // the harness repo lands under `a/b`, so `../../keys.json` is the real file above it
  try {
    const g = setup();
    process.chdir(g.repo);
    const outside = citingSpec("`../../keys.json:99` holds the model.");
    const error = (await g.callTool("pb_write_spec", { name: "cite-above", content: outside })).error!;
    assert.match(error, /that path is not in the project/);
    assert.doesNotMatch(error, /has \d+ line/);
  } finally {
    process.env.TMPDIR = savedTmp;
  }
});

test("citations: a sibling repository's file is cited from the project root and line-checked; nothing further out resolves", async () => {
  const { resolveSiblingFile } = await import("../extensions/pb/map.ts");
  const t = setup();
  process.chdir(t.repo);
  const workspace = path.dirname(fs.realpathSync(t.repo));
  const sibling = fs.mkdtempSync(path.join(workspace, "pb-sibling-ui-"));
  const name = path.basename(sibling);
  try {
    fs.mkdirSync(path.join(sibling, "src"), { recursive: true });
    fs.writeFileSync(path.join(sibling, "src/api.ts"), Array.from({ length: 20 }, (_, i) => `// line ${i + 1}`).join("\n") + "\n");
    fs.writeFileSync(path.join(sibling, ".env"), "SECRET=1\n");
    fs.symlinkSync("/etc/hosts", path.join(sibling, "src/hosts.ts"));
    const write = (ref: string) => t.callTool("pb_write_spec", { name: "cross-repo", content: citingSpec(`\`${ref}\` holds the client.`) });

    // A change that spans a backend and its frontend cites both: the sibling's line is checked like any other.
    assert.equal((await write(`../${name}/src/api.ts:12`)).error, undefined);
    assert.match((await write(`../${name}/src/api.ts:99`)).error!, /has 20 lines/);
    assert.match((await write(`../${name}/src/missing.ts:1`)).error!, /not in the project, nor a file in a sibling repository/);
    // Model-written paths: a dot-named file, a climb past the workspace and a link out of it never resolve.
    for (const ref of [`../${name}/.env:1`, "../../etc/hosts:1", `../${name}/src/hosts.ts:1`, `../${name}/src/../../${path.basename(t.repo)}/../../etc/hosts:1`]) {
      const error = (await write(ref)).error!;
      assert.match(error, /not in the project, nor a file in a sibling repository/, ref);
      assert.doesNotMatch(error, /has \d+ line/, `${ref}: says nothing about the file it names`);
    }
    assert.equal(resolveSiblingFile(t.repo, `../${path.basename(t.repo)}/src/x.ts`), undefined, "the project itself is not its own sibling");
  } finally {
    fs.rmSync(sibling, { recursive: true, force: true });
  }
});

test("map and citation grammar: dots alone name nothing, a walk above the root is still caught", async () => {
  const { mapPaths, unresolvedPaths } = await import("../extensions/pb/map.ts");

  // One convention for what both readers call a path name: the last segment must name something, which
  // means carrying a letter or a digit. So a bare `.` or `..`, which names no file anywhere, is prose —
  // prose pb's own map writes when it says a validator rejects "`.`, `..`, separators" — while a hidden
  // directory and a real name are still paths, checked as before.
  assert.deepEqual(mapPaths("- rejects `.`, `..` and separators, keeps `.pi/`, `.gitignore` and `src/a.ts`"), [".pi", ".gitignore", "src/a.ts"]);

  // The convention costs nothing in reach: a token that walks above the root is a name, and is reported.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pb-dots-"));
  execSync("git init -q", { cwd: dir });
  fs.writeFileSync(path.join(dir, "..", "keys.json"), "// one\n");
  assert.deepEqual(unresolvedPaths(dir, "- Both `..` and `.` are prose.\n- `../keys.json` is above the root.").map((u) => u.path), ["../keys.json"]);

  // The gate reads the same way: dots alone are no citation, so they raise no "not in the project".
  const t = setup();
  process.chdir(t.repo);
  assert.doesNotMatch((await t.callTool("pb_write_spec", { name: "cite-dots", content: citingSpec("`..:1` and `.:2` name nothing.") })).error ?? "", /not in the project/);
});

test("spec: semantic shape is the reviewer's, not a write gate", async () => {
  const t = setup();
  process.chdir(t.repo);
  const write = (name: string, content: string) => t.callTool("pb_write_spec", { name, content });
  // A security surface, a bare measurement, an external surface with no Contracts, stored data with no
  // Migration and rollback, and the shapes the old regex gates refused: all of them write.
  const specs: Array<[string, string]> = [
    ["sensitive", `# Admin login
Depends on: none
Verification: tests
New tests: yes

## Goal
Let admins log in with a password.
## Decisions
- Use password login, because the existing session store supports it.
## Contracts
- T1 owns the login form.
## Tasks
### T1: login works
- Acceptance: login succeeds
- Test: \`test -f login.txt\`
`],
    ["slow", `# Fast list
Depends on: none
Verification: tests
New tests: yes

## Goal
List orders.
## Decisions
- Paginate the list, because unbounded reads risk timeouts.
## Contracts
- T1 owns the list.
## Tasks
### T1: fast list
Responds within 200ms.
- Acceptance: responds fast
- Test: \`test -f fast.txt\`
`],
    ["api-missing", `# Order lookup
Depends on: none
Verification: tests
New tests: yes

## Goal
Expose GET /api/orders to the client.
## Decisions
- Reuse the existing handler, because it already returns the list.
## Tasks
### T1: list orders
- Acceptance: GET /api/orders returns the list
- Test: \`test -f T1.txt\`
`],
    ["data-missing", `# Stored orders
Depends on: none
Verification: tests
New tests: yes

## Goal
Store orders in the database.
## Decisions
- Use the existing table, because it already has the columns.
## Contracts
- The orders table gains a status column; reads and writes use it.
## Tasks
### T1: save orders
- Acceptance: the status is saved
- Test: \`test -f T1.txt\`
`],
    ["bare-words", `# Slow page
Depends on: none
Verification: tests
New tests: yes

## Goal
Speed up the page.
## Findings
- The baseline is green.
## Decisions
- Scope: the list.
- Allows 3 retries.
- Cache session tokens for a minute.
## Contracts
- T1 owns the list.
## Tasks
### T1: fast page
- Acceptance: loads fast
- Test: \`test -f fast.txt\`
`],
  ];
  for (const [name, content] of specs) {
    assert.deepEqual(parseSpec(content).errors, [], name);
    const r = await write(name, content);
    assert.equal(r.error, undefined, `${name}: ${r.error ?? ""}`);
  }
});

test("spec: a human edit saves on parse alone and the build adds no shape advisory", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  await t.run("plan", "cancel orders");
  t.agent.script = async (text, tool) => {
    if (/pb_write_spec tool/.test(text)) return void (await tool("pb_write_spec", { name: "order-cancellation", content: SPEC() }));
    return diligent(text, tool);
  };
  t.selects.push("Show me the spec first", "Edit the spec first", "Build here (keeps our discussion; the cache stays warm)");
  t.editors.push(SPEC().replace("- Only PENDING orders can be cancelled, because the state machine only allows that transition.", "- Only PENDING orders can be cancelled."));
  await t.run("build");
  assert.equal(t.progress("order-cancellation").phase, "built");
  assert.ok(!t.notes.some((n) => /human override|Spec-shape advisory/.test(n)));
  assert.ok(!t.events("order-cancellation").some((e: any) => e.override === true));
  assert.doesNotMatch(t.posts.at(-1)!, /Spec-shape advisory/);
});

test("spec: senior review carries the human-override note", async () => {
  const { reviewerBrief } = await import("../extensions/pb/prompts.ts");
  const withNote = reviewerBrief({ changed: [], stat: "", check: "ok", focus: "", humanOverride: "Hand-edited." });
  assert.match(withNote, /## Human override[\s\S]*Hand-edited\./);
  const without = reviewerBrief({ changed: [], stat: "", check: "ok", focus: "" });
  assert.doesNotMatch(without, /Human override/);
});

test("spec: showing it runs each red-eligible Test: once, for approval — small changes skip it", async () => {
  const t = setup({ verify: "true" });
  await written(t); // T1/T2 commands fail: nothing built yet
  const { Store } = await import("../extensions/pb/store.ts");
  new Store(t.repo).setPendingBuild(t.runtime().ctx.sessionManager.getSessionFile());
  t.selects.push("Not now");
  await t.fire("agent_settled", {});
  const shown = t.posts.find((p) => p.startsWith("**✅ Spec written")!)!;
  assert.match(shown, /- T1: first file · `test -f T1\.txt`[\s\S]*Test commands, run once before you approve \(took [^)]+\):\n- ✗ `test -f T1\.txt` fails \(expected: nothing built yet/);
  assert.match(shown, /- ✗ `test -f T2\.txt` fails \(expected/);

  const u = setup({ verify: "true" }); // docs-only: nothing red-eligible, nothing run
  await written(u, SPEC({ verification: "none — docs", newTests: "no — docs", tasks: TASKS_PLAIN }));
  new Store(u.repo).setPendingBuild(u.runtime().ctx.sessionManager.getSessionFile());
  u.selects.push("Not now");
  await u.fire("agent_settled", {});
  assert.doesNotMatch(u.posts.find((p) => p.startsWith("**✅ Spec written")!)!, /Test commands, run once/);
});

test("spec: a bare `&` chain is suspicious — the pre-approval dry-run refuses to run it", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  await written(t, SPEC({
    tasks: "### T1: first file\nCreate T1.txt.\n- Acceptance: T1.txt exists\n- Test: `test -f T1.txt&touch side-effect.txt`\n\n### T2: second file\nCreate T2.txt.\n- Acceptance: T2.txt exists\n- Test: `test -f T2.txt`",
  }));
  const { Store } = await import("../extensions/pb/store.ts");
  new Store(t.repo).setPendingBuild(t.runtime().ctx.sessionManager.getSessionFile());
  t.selects.push("Not now");
  await t.fire("agent_settled", {});
  const shown = t.posts.find((p) => p.startsWith("**✅ Spec written")!)!;
  assert.match(shown, /`test -f T1\.txt&touch side-effect\.txt` couldn't run here \(not run here: chains shells or reaches the network/);
  assert.ok(!fs.existsSync(path.join(t.repo, "side-effect.txt"))); // never executed before approval: `a&b` chains
  assert.match(shown, /- ✗ `test -f T2\.txt` fails \(expected/); // a command without the chain still runs
});

test("binding: one exported list binds the build and the spec review", async () => {
  const { BINDING_SECTIONS } = await import("../extensions/pb/spec.ts");
  const { specReference } = await import("../extensions/pb/prompts.ts");
  assert.deepEqual(
    [...BINDING_SECTIONS],
    ["Goal", "Out of scope", "Decisions", "Design", "Contracts", "Migration and rollback", "Threats and abuse", "Threats"],
  );
  // the one handout reference names every section on that list, so no reader has to guess what binds it
  const reference = specReference("order-cancellation");
  for (const section of [...BINDING_SECTIONS]) assert.ok(reference.includes(`"${section}"`), `the reference dropped ${section}`);
});

test("binding: the guide and README list the binding sections in the exported order", async () => {
  const { BINDING_SECTIONS } = await import("../extensions/pb/spec.ts");
  // "Threats" is the short form of "Threats and abuse": one section, two accepted headings, one name in prose
  const names = [...new Set(BINDING_SECTIONS)].filter((s) => s !== "Threats");
  for (const [file, rel] of [
    ["README.md", ["..", "README.md"]],
    ["guide.md", ["..", "extensions", "pb", "guide.md"]],
  ] as const) {
    const doc = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), ...rel), "utf8");
    // The prose that states which sections bind a step is the last passage naming both the first and
    // the last of them; the spec-format skeleton above it lists sections for a different purpose.
    const passages = doc
      .split(/\n\s*\n/)
      .filter((p) => p.includes("Out of scope") && p.includes("Threats and abuse"))
      .map((p) => p.replace(/\s+/g, " "));
    assert.ok(passages.length, `${file} never states which sections bind a step`);
    const flat = passages.at(-1)!;
    let last = -1;
    for (const name of names) {
      const found = flat.indexOf(name);
      assert.ok(found >= 0, `${file}'s binding list is missing ${name}`);
      assert.ok(found > last, `${file}'s binding list puts ${name} out of the exported order`);
      last = found;
    }
  }
});

test("status lists every spec with its state and tasks", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  await t.run("status");
  assert.match(t.notes.at(-1)!, /order-cancellation — spec ready · verification tests[\s\S]*\n    next: \/pb:build order-cancellation \(it reviews the spec first\), or \/pb:spec-review order-cancellation on its own/);
});

test("format: durations are human-readable and build time counts only the running segments", async () => {
  const { duration } = await import("../extensions/pb/format.ts");
  assert.equal(duration(0), "0s");
  assert.equal(duration(500), "<1s");
  assert.equal(duration(12_000), "12s");
  assert.equal(duration(184_000), "3m 4s");
  assert.equal(duration(3_600_000), "1h");
  assert.equal(duration(90_000_000), "1d 1h");
  const { buildTimeLabel, buildTiming } = await import("../extensions/pb/stats.ts");
  const paused = [
    { type: "build-start", at: "2026-10-01 10:00:00" },
    { type: "pause", at: "2026-10-01 10:10:00" },
    { type: "build-start", at: "2026-10-01 10:40:00" },
    { type: "built", at: "2026-10-01 10:55:00" },
  ];
  assert.deepEqual(buildTiming(paused), { activeMs: 25 * 60_000, wallMs: 55 * 60_000 });
  assert.equal(buildTimeLabel({ activeMs: 25 * 60_000, wallMs: 55 * 60_000 }), "25m (55m elapsed)");
  assert.equal(buildTimeLabel({ activeMs: 90_000, wallMs: 90_000 }), "1m 30s");
});

test("stats: after a new plan in the build's session, its turns stop counting for the finished spec", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  await t.run("plan", "cancel orders");
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  const usage = () => t.events("order-cancellation").filter((e) => e.type === "usage").length;
  const before = usage();
  await t.run("plan", "the next feature");
  assert.equal(usage(), before);
});

test("archive moves a finished spec out of .pi/pb/, and stats still see it", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  await t.run("archive");
  assert.ok(!fs.existsSync(path.join(t.repo, ".pi/pb/specs/order-cancellation")));
  const archived = fs.readdirSync(path.join(t.repo, ".pi/pb-archive")).filter((d) => d.endsWith("order-cancellation"));
  assert.equal(archived.length, 1);
  assert.doesNotMatch(execSync("git status --porcelain", { cwd: t.repo, encoding: "utf8" }), /pb-archive/);
  await t.run("stats", "all");
  assert.match(t.posts.at(-1)!, /order-cancellation +2\/2/);
});

test("archive: a name collision never moves the spec into a folder that already exists", async () => {
  const t = setup();
  const { Store } = await import("../extensions/pb/store.ts");
  const store = new Store(t.repo);
  store.writeSpec("collision", SPEC());
  const archiveRoot = path.join(t.repo, ".pi/pb-archive");
  // Fill every name this second's stamp could take (base, -2 … -99), and the neighbouring seconds'
  // too (a slow filesystem can tick the clock between stamping and archiving): the older loop
  // capped at -99, then renamed onto whatever already sat there.
  const stamp = (offsetSec: number) => new Date(Date.now() + offsetSec * 1000).toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const taken = new Set<string>();
  for (const offset of [-2, -1, 0, 1, 2]) {
    for (let i = 0; i < 99; i++) {
      const dir = path.join(archiveRoot, `${stamp(offset)}-collision${i === 0 ? "" : `-${i + 1}`}`);
      fs.mkdirSync(dir, { recursive: true });
      taken.add(dir);
    }
  }
  const dest = store.archive("collision");
  assert.ok(!taken.has(dest), `archived into ${dest}, a name that already existed`);
  assert.ok(fs.existsSync(path.join(dest, "spec.md")));
});

test("spec approval: edit the spec first; the build then gets your version", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  await t.run("plan", "cancel orders");
  t.agent.script = async (text, tool) => {
    if (/pb_write_spec tool/.test(text)) return void (await tool("pb_write_spec", { name: "order-cancellation", content: SPEC() }));
    return diligent(text, tool);
  };
  t.selects.push("Show me the spec first", "Edit the spec first", "Build here (keeps our discussion; the cache stays warm)");
  t.editors.push("# broken", SPEC().replace("### T2: second file", "### T2: the second file"));
  await t.run("build");
  assert.ok(t.notes.some((n) => /Not saved, the spec doesn't parse/.test(n)));
  assert.match(t.read(".pi/pb/specs/order-cancellation/spec.md"), /### T2: the second file/);
  assert.match(t.instructions.find((i) => /\[pb:build order-cancellation\]/.test(i))!, /Build \.pi\/pb\/specs\/order-cancellation\/spec\.md\./);
  assert.equal(t.progress("order-cancellation").phase, "built");
});

test("spec: a planning spec needs no tasks or verification yet; a ready one does", () => {
  const { spec, errors } = parseSpec(PLANNING);
  assert.deepEqual(errors, []);
  assert.equal(spec!.status, "planning");
  assert.ok(parseSpec(PLANNING.replace("Status: planning", "Status: ready")).errors.some((e) => /no tasks/.test(e)));
  assert.equal(parseSpec(SPEC()).spec!.status, "ready");
});

test("pb_update_spec changes one section or the status, and writes nothing that wouldn't parse", async () => {
  const t = setup();
  process.chdir(t.repo);
  assert.match((await t.callTool("pb_write_spec", { name: "order-cancellation", content: PLANNING })).content![0].text, /status planning; ~\d+ tokens\.$/);
  const r = await t.callTool("pb_update_spec", { name: "order-cancellation", section: "Decisions", content: "- Notify by event: mail belongs to the notification service.", mode: "append" });
  assert.match(r.content![0].text, /Updated .*spec\.md \(Decisions\): status planning/);
  assert.match(t.read(".pi/pb/specs/order-cancellation/spec.md"), /- Not doing soft delete, because audit lives elsewhere\.\n- Notify by event: mail belongs to the notification service\.\n\n## Open questions/);
  assert.match((await t.callTool("pb_update_spec", { name: "order-cancellation", status: "ready" })).error!, /Not written: the spec wouldn't parse[\s\S]*Verification[\s\S]*no tasks/);
  assert.match(t.read(".pi/pb/specs/order-cancellation/spec.md"), /Status: planning/);
  assert.match((await t.callTool("pb_update_spec", { name: "nope", section: "Goal", content: "x" })).error!, /No spec "nope"/);
});

/** SPEC() as a model often writes it ready: an Open questions heading kept over "none". */
const READY_WITH_NO_OPEN_QUESTIONS = SPEC().replace("## Tasks", "## Open questions\nNone — every unknown is settled in Decisions.\n## Tasks");
const draftOf = (t: ReturnType<typeof setup>, name: string) => path.join(t.repo, ".pi/pb/specs", name, "draft.json");

test("pb_write_spec: a rejected spec is kept as a draft, and one section edit saves it — nothing is rewritten whole", async () => {
  const t = setup();
  await written(t, SPEC()); // the session has the format; then the next write of a new spec is refused
  const refused = await t.callTool("pb_write_spec", { name: "refund-flow", content: READY_WITH_NO_OPEN_QUESTIONS });
  assert.match(refused.error!, /doesn't parse[\s\S]*Open questions[\s\S]*The draft is kept[\s\S]*pb_update_spec[\s\S]*not the whole spec/);
  assert.ok(!fs.existsSync(path.join(t.repo, ".pi/pb/specs/refund-flow/spec.md")), "nothing that fails the checks becomes the spec");
  assert.ok(fs.existsSync(draftOf(t, "refund-flow")));

  const saved = await t.callTool("pb_update_spec", { name: "refund-flow", section: "Open questions", mode: "remove" });
  assert.equal(saved.error, undefined, saved.error ?? "");
  assert.match(saved.content![0].text, /^✅ Wrote .*refund-flow\/spec\.md from the draft \(Open questions removed\): status ready/);
  const md = t.read(".pi/pb/specs/refund-flow/spec.md");
  assert.doesNotMatch(md, /Open questions/);
  assert.match(md, /## Decisions[\s\S]*## Tasks\n### T1: first file/);
  assert.ok(!fs.existsSync(draftOf(t, "refund-flow")), "a saved draft is gone");
  assert.deepEqual(t.progress("refund-flow").tasks.map((x: any) => [x.id, x.status]), [["T1", "todo"], ["T2", "todo"]]);
  assert.equal(t.progress("refund-flow").writtenIn, t.runtime().ctx.sessionManager.getSessionFile());
});

test("pb_write_spec: a citation the code doesn't have is fixed in its section, and an edit that leaves errors keeps the draft", async () => {
  const t = setup();
  await written(t, SPEC());
  citedPage(t);
  const cites = citingSpec("`src/missing.ts:1` holds the model.");
  assert.match((await t.callTool("pb_write_spec", { name: "slow-page", content: cites })).error!, /points at code that isn't there[\s\S]*The draft is kept/);
  assert.equal((await t.callTool("pb_update_spec", { name: "slow-page", section: "Findings", content: "- `src/page.ts:12` holds the model." })).error, undefined);
  assert.match(t.read(".pi/pb/specs/slow-page/spec.md"), /src\/page\.ts:12/);

  // Two problems: one edit fixes one, and only the other comes back.
  const twice = READY_WITH_NO_OPEN_QUESTIONS.replace("## Goal\nCancel orders.\n", "");
  const both = (await t.callTool("pb_write_spec", { name: "two-faults", content: twice })).error!;
  assert.match(both, /Goal[\s\S]*Open questions|Open questions[\s\S]*Goal/);
  const left = (await t.callTool("pb_update_spec", { name: "two-faults", section: "Open questions", mode: "remove" })).error!;
  assert.match(left, /missing the "## Goal" section[\s\S]*The draft is kept/);
  assert.doesNotMatch(left, /Open questions/);
  assert.ok(fs.existsSync(draftOf(t, "two-faults")));
  assert.equal((await t.callTool("pb_update_spec", { name: "two-faults", section: "Goal", content: "Cancel orders." })).error, undefined);
  assert.match(t.read(".pi/pb/specs/two-faults/spec.md"), /## Goal\nCancel orders\./);
});

test("a draft belongs to the session that wrote it: elsewhere, and once the spec is written whole, edits reach the spec", async () => {
  const t = setup();
  await written(t, SPEC());
  const before = t.read(specRel);
  assert.ok((await t.callTool("pb_write_spec", { name: "order-cancellation", content: READY_WITH_NO_OPEN_QUESTIONS })).error);
  assert.equal(t.read(specRel), before, "the refused rewrite leaves the spec as it was");

  // Another session's edit goes to the spec, never into this session's draft.
  const rt = t.runtime();
  const elsewhere = { ...rt.ctx, sessionManager: { ...rt.ctx.sessionManager, getSessionFile: () => path.join(t.repo, "other-session.jsonl") } };
  const other = await rt.tools.pb_update_spec.execute("x", { name: "order-cancellation", section: "Decisions", content: "- Notify by event, because mail belongs to the notification service.", mode: "append" }, undefined, undefined, elsewhere);
  assert.match(other.content[0].text, /^✅ Updated .*spec\.md \(Decisions\)/);
  assert.match(t.read(specRel), /Notify by event/);
  assert.doesNotMatch(fs.readFileSync(draftOf(t, "order-cancellation"), "utf8"), /Notify by event/);

  // A whole write that passes replaces the draft.
  assert.equal((await t.callTool("pb_write_spec", { name: "order-cancellation", content: SPEC() })).error, undefined);
  assert.ok(!fs.existsSync(draftOf(t, "order-cancellation")));
});

test("a build approves the spec, never a draft, and its approval discards one", async () => {
  const t = setup({ verify: "true" });
  await written(t, SPEC());
  assert.ok((await t.callTool("pb_write_spec", { name: "order-cancellation", content: READY_WITH_NO_OPEN_QUESTIONS })).error);
  assert.ok(fs.existsSync(draftOf(t, "order-cancellation")));
  t.agent.script = diligent;
  await t.run("build", "order-cancellation");
  assert.equal(t.progress("order-cancellation").phase, "built");
  assert.doesNotMatch(t.read(".pi/pb/specs/order-cancellation/approved.md"), /Open questions/);
  assert.ok(!fs.existsSync(draftOf(t, "order-cancellation")));
});

test("pb_update_spec remove: a section goes, a required one or one that isn't there is refused", async () => {
  const t = setup();
  await written(t, SPEC());
  assert.equal((await t.callTool("pb_update_spec", { name: "order-cancellation", section: "Out of scope", mode: "remove" })).error, undefined);
  assert.doesNotMatch(t.read(specRel), /## Out of scope/);
  const before = t.read(specRel);
  assert.match((await t.callTool("pb_update_spec", { name: "order-cancellation", section: "Goal", mode: "remove" })).error!, /missing the "## Goal" section/);
  assert.match((await t.callTool("pb_update_spec", { name: "order-cancellation", section: "Glossary", mode: "remove" })).error!, /no "## Glossary" section to remove/);
  assert.equal(t.read(specRel), before);
});

test("/pb:status names an unsaved draft", async () => {
  const t = setup();
  await written(t, SPEC());
  await t.callTool("pb_write_spec", { name: "refund-flow", content: READY_WITH_NO_OPEN_QUESTIONS });
  await t.run("status");
  assert.match(t.notes.at(-1)!, /refund-flow — .*unsaved draft \(1 error\)/);
});

test("pb_update_spec: replacing a section with nothing is refused and the file keeps what it had", async () => {
  const t = setup();
  process.chdir(t.repo);
  await t.callTool("pb_write_spec", { name: "order-cancellation", content: SPEC() });
  const specPath = ".pi/pb/specs/order-cancellation/spec.md";
  const before = t.read(specPath);
  // A blank body would leave the heading standing over nothing — and an empty section satisfies
  // every evidence gate by deleting what it inspects, Threats and Findings included.
  for (const section of ["Findings", "Threats and abuse"]) {
    for (const blank of ["", "   ", "\n \n"]) {
      assert.match((await t.callTool("pb_update_spec", { name: "order-cancellation", section, content: blank })).error!, /leaves it empty/);
    }
  }
  // the refusal names the section as the format writes it, hashes and all in the call stripped out
  assert.match((await t.callTool("pb_update_spec", { name: "order-cancellation", section: "## Findings", content: " " })).error!, /replacing Findings with nothing/);
  assert.equal(t.read(specPath), before); // a refused write moves nothing in the file
  // the format's own answer for a section with nothing to say stays legal
  assert.equal((await t.callTool("pb_update_spec", { name: "order-cancellation", section: "Context", content: "none — a docs line, nothing probed" })).error, undefined);
  assert.match(t.read(specPath), /## Context\nnone — a docs line, nothing probed\n/);
  // append is not a replacement, so it is untouched by the guard
  assert.equal((await t.callTool("pb_update_spec", { name: "order-cancellation", section: "Context", content: "- Nothing more was probed, because nothing more was needed.", mode: "append" })).error, undefined);
});

test("pb_update_spec: writing Tasks and ready in one call still runs the decidable checks", async () => {
  const t = setup();
  process.chdir(t.repo);
  // The bare-colon Decision is semantic: it is the reviewer's question, not a write refusal.
  const planning = `# Order cancellation
Status: planning
Depends on: none
Verification: tests
New tests: yes

## Goal
Cancel orders.
## Decisions
- Only PENDING orders can be cancelled.
## Tasks
`;
  assert.equal((await t.callTool("pb_write_spec", { name: "order-cancellation", content: planning })).error, undefined);

  // A task without an Acceptance line is structural, so the same call is refused and nothing lands.
  const r = await t.callTool("pb_update_spec", {
    name: "order-cancellation",
    section: "Tasks",
    content: "### T1: first step\nCap the list.\n- Test: `test -f T1.txt`",
    status: "ready",
  });
  assert.match(r.error!, /no "- Acceptance:" line/);
  assert.match(t.read(".pi/pb/specs/order-cancellation/spec.md"), /Status: planning/); // nothing was written

  // With the structure right, the spec becomes ready even though its Decision states no reason.
  const ok = await t.callTool("pb_update_spec", {
    name: "order-cancellation",
    section: "Tasks",
    content: "### T1: first step\nCap the list.\n- Acceptance: the list is capped (tests: T1)\n- Test: `test -f T1.txt`",
    status: "ready",
  });
  assert.equal(ok.error, undefined, ok.error ?? "");
  assert.match(t.read(".pi/pb/specs/order-cancellation/spec.md"), /Status: ready/);
});

test("spec size is reported, with a gentle note (never a rejection) when it's long", async () => {
  const t = setup();
  process.chdir(t.repo);
  const long = SPEC().replace("Cancel orders.", "Cancel orders. " + "Detail. ".repeat(7000));
  const r = await t.callTool("pb_write_spec", { name: "order-cancellation", content: long });
  assert.equal(r.error, undefined);
  assert.match(r.content![0].text, /~1\d{4} tokens\. That's long: if it copies code or repeats facts, pointing to the code/);
});

test('pb_write_spec refuses the reserved name "off"', async () => {
  const t = setup();
  process.chdir(t.repo);
  const r = await t.callTool("pb_write_spec", { name: "off", content: SPEC() });
  assert.match(r.error!, /reserved.*\/pb:plan.*off/);
});

test("store: reads of an invalid spec name see nothing instead of throwing, and an archived dependency counts as built", async () => {
  const t = setup();
  process.chdir(t.repo);
  const { Store } = await import("../extensions/pb/store.ts");
  const store = new Store(t.repo);
  const phrase = "tempo-gtfs-live-trains — implemented and on HEAD; this spec consumes its endpoints unchanged";
  assert.equal(store.progress(phrase), undefined);
  assert.deepEqual(store.checkpoints(phrase), []);
  assert.equal(store.readSpec(phrase), undefined); // already safe, pinned beside the two above
  assert.equal(store.finishedPhase(phrase), undefined);

  await t.callTool("pb_write_spec", { name: "archived-dep", content: SPEC() });
  store.saveProgress({ ...store.progress("archived-dep")!, phase: "built" });
  assert.equal(store.finishedPhase("archived-dep"), "built");
  store.archive("archived-dep");
  assert.equal(store.progress("archived-dep"), undefined); // the folder moved away
  assert.equal(store.finishedPhase("archived-dep"), "built"); // the gate still sees it as finished

  await t.callTool("pb_write_spec", { name: "archived-dep", content: SPEC() }); // rewritten after archiving
  assert.equal(store.finishedPhase("archived-dep"), undefined); // a live record wins over the archive
});

test("spec: rewriting a finished spec with different tasks warns to write a new spec instead", async () => {
  const t = setup();
  process.chdir(t.repo);
  await t.callTool("pb_write_spec", { name: "order-cancellation", content: SPEC() });
  const session = t.runtime().ctx.sessionManager.getSessionFile();
  fs.writeFileSync(
    path.join(t.repo, ".pi/pb/specs/order-cancellation/progress.json"),
    JSON.stringify({
      spec: "order-cancellation",
      phase: "reviewed",
      session,
      tasks: [{ id: "T1", title: "first file", status: "done", attempts: 1 }],
      updatedAt: "2026-10-01 10:00:00",
    }),
  );
  const changed = SPEC({ tasks: "### T1: a different change\nDo the new thing.\n- Acceptance: the new thing exists (tests: T1)\n- Test: `test -f T1.txt`\n" });
  const r = await t.callTool("pb_write_spec", { name: "order-cancellation", content: changed });
  assert.match(r.content![0].text, /already reviewed.*write a new spec instead/);
  const sameAgain = await t.callTool("pb_write_spec", { name: "order-cancellation", content: changed });
  assert.doesNotMatch(sameAgain.content![0].text, /already reviewed/); // identical tasks: a genuine revision, no warning
});

test("/pb:spec times the step to the ready write, and the spec header shows it", async () => {
  const t = setup();
  process.chdir(t.repo);
  t.agent.script = async (text, tool) => {
    if (!/pb_write_spec tool/.test(text)) return;
    await new Promise((r) => setTimeout(r, 1100)); // a step long enough to read back as a second
    await tool("pb_write_spec", { name: "order-cancellation", content: SPEC() });
  };
  await t.run("spec", "order-cancellation");
  const event = t.events("order-cancellation").filter((e: any) => e.type === "spec").at(-1);
  assert.equal(typeof event.ms, "number");
  assert.ok(event.ms >= 1000, `elapsed ${event.ms}ms`);

  const { Store } = await import("../extensions/pb/store.ts");
  new Store(t.repo).setPendingBuild(t.runtime().ctx.sessionManager.getSessionFile());
  t.selects.push("Not now");
  await t.fire("agent_settled", {});
  assert.match(t.posts.find((p) => p.startsWith("**✅ Spec written"))!, / · (?:<1s|\d+s)$/m);
});

test("/pb:spec <name> revises the spec from the file, not from memory", async () => {
  const t = setup();
  process.chdir(t.repo);
  await t.callTool("pb_write_spec", { name: "order-cancellation", content: PLANNING });
  await t.run("spec", "order-cancellation");
  assert.match(t.instructions.at(-1)!, /--- current \.pi\/pb\/specs\/order-cancellation\/spec\.md \(revise this\) ---[\s\S]*follow refund\(\) \(lines 40-80\)/);
  await t.run("spec");
  assert.match(t.instructions.at(-1)!, /Existing: order-cancellation \(reusing a name rewrites it; read its spec\.md first/);
});

test("spec writing leaves undecided questions open; the checkpoint asks nothing; questions while writing count down", async () => {
  const { specPrompt, checkpointPrompt, finishSpecPrompt } = await import("../extensions/pb/prompts.ts");
  assert.match(specPrompt("", []), /Transcribe the conversation's ledger[\s\S]*anything undecided goes under Open questions and the spec stays Status: planning[\s\S]*never invent a decision[\s\S]*only about a choice that changes behaviour, an API or data/);
  assert.match(finishSpecPrompt("x"), /ask me with pb_ask, all at once, about each open question[\s\S]*Anything still unanswered stays Open and the spec stays Status: planning/);
  assert.match(checkpointPrompt(80, []), /Don't ask me anything now: what's undecided goes into Open questions/);

  const t = setup({ verify: "true", askTimeoutSec: 0.001 });
  process.chdir(t.repo);
  t.selects.push("No thanks");
  await t.run("plan", "cancel orders");
  let answer: Result | undefined;
  const withAssumption = SPEC().replace("- Not doing soft delete, because audit lives elsewhere.", "- Not doing soft delete, because audit lives elsewhere.\n- Assumption: cancelling twice is a no-op, because the API is idempotent elsewhere.");
  t.agent.script = async (text, tool) => {
    if (/pb_write_spec tool/.test(text)) {
      answer = await tool("pb_ask", { question: "Which HTTP verb?", options: ["POST", "DELETE"], recommended: "POST" });
      return void (await tool("pb_write_spec", { name: "order-cancellation", content: withAssumption }));
    }
    return diligent(text, tool);
  };
  t.selects.push("Build here as soon as the spec is written (keeps our discussion; the cache stays warm)", "<timeout>");
  await t.run("build");
  assert.equal(t.dialogTimeouts.at(-1), 1); // the question counted down, though no build was running yet
  assert.match(answer!.content![0].text, /No answer in time: it stays open — do not take a reading or tag it assumed\. Record it under Open questions; planning stays incomplete until it is answered\./);
  assert.match(t.posts.find((p) => p.startsWith("**✅ Spec written"))!, /Settled without asking you \(the review checks them\):\n- Assumption: cancelling twice is a no-op/);
  assert.equal(t.progress("order-cancellation").phase, "built");

  // During a checkpoint, a question is turned away.
  const u = setup({ verify: "true" });
  process.chdir(u.repo);
  u.selects.push("No thanks");
  await u.run("plan", "cancel orders");
  let refused: Result | undefined;
  u.agent.script = async (text, tool) => {
    if (text.startsWith("[pb:compact]")) {
      refused = await tool("pb_ask", { question: "Mail or event?" });
      await tool("pb_write_spec", { name: "order-cancellation", content: PLANNING });
    }
  };
  await u.run("compact");
  assert.match(refused!.content![0].text, /Not now: this is a checkpoint\. Write the question under Open questions/);
  assert.equal(u.resets.length, 1);
});

test("map: /pb:archive skips the map when the spec established nothing new", async () => {
  const t = setup({ verify: "true", mapOnArchive: true });
  const { writeMap, readMap } = await import("../extensions/pb/map.ts");
  writeMap(t.repo, "- `README`: readme");
  await written(t); // ## Context, no Findings; the build records no Design
  t.agent.script = diligent;
  await t.run("build");
  const briefFile = path.join(os.tmpdir(), `pb-map-skip-${process.pid}.md`);
  if (fs.existsSync(briefFile)) fs.rmSync(briefFile);
  process.env.MOCK_BRIEF_OUT = briefFile;
  await t.run("archive");
  delete process.env.MOCK_BRIEF_OUT;
  assert.ok(!fs.existsSync(briefFile)); // the cartographer never ran
  assert.ok(t.notes.some((n) => /No new findings in order-cancellation for the project map; skipping\./.test(n)));
  assert.equal(readMap(t.repo), "- `README`: readme"); // untouched
  const archived = t.notes.filter((n) => n.startsWith("Archived order-cancellation to "));
  assert.equal(archived.length, 1); // one notice, no map trailer when skipping
  assert.ok(!archived[0].includes("Updating"));
});

test("map: by default /pb:archive leaves the map alone and says how to update it — the cartographer runs only when you choose", async () => {
  const t = setup({ verify: "true" });
  const { writeMap, readMap } = await import("../extensions/pb/map.ts");
  writeMap(t.repo, "- `README`: readme");
  await written(t, SPEC().replace("## Context", "## Findings\n- The order model lives in README.\n\n## Context")); // news the map could take
  t.agent.script = diligent;
  await t.run("build");
  const briefFile = path.join(os.tmpdir(), `pb-map-default-${process.pid}.md`);
  if (fs.existsSync(briefFile)) fs.rmSync(briefFile);
  process.env.MOCK_BRIEF_OUT = briefFile;
  try {
    await t.run("archive");
  } finally {
    delete process.env.MOCK_BRIEF_OUT;
  }
  assert.ok(!fs.existsSync(briefFile), "no cartographer run");
  assert.equal(readMap(t.repo), "- `README`: readme", "the map is untouched");
  assert.ok(t.notes.some((n) => n === 'The project map was not updated from order-cancellation: /pb:map does that when you choose, or set "mapOnArchive": true to have every archive do it.'), t.notes.join("\n"));
});

test("spec: acceptance lines are plain behaviour; old proof markers are inert prose", async () => {
  const t = setup();
  process.chdir(t.repo);
  const bare = SPEC({ tasks: "### T1: real file\nCreate T1.txt.\n- Acceptance: T1.txt exists\n- Test: `test -f T1.txt`" });
  assert.equal((await t.callTool("pb_write_spec", { name: "bare", content: bare })).error, undefined);
  // A spec written before this change keeps its marker as text; nothing resolves or refuses it.
  const legacy = SPEC({ tasks: "### T1: real file\nCreate T1.txt.\n- Acceptance: T1.txt exists (tests: no/such.spec.ts)\n- Acceptance: docs updated (non-testable: prose)\n- Test: `test -f T1.txt`" });
  assert.equal((await t.callTool("pb_write_spec", { name: "legacy", content: legacy })).error, undefined);
  // Qualified variants and asterisk bullets are ordinary acceptance lines.
  const variant = SPEC({ tasks: "### T1: real file\nCreate T1.txt.\n- Acceptance (abuse): T1.txt survives replays\n* Acceptance: T1.txt exists\n- Test: `test -f T1.txt`" });
  assert.equal((await t.callTool("pb_write_spec", { name: "variant", content: variant })).error, undefined);
  // The Tasks rewrite is held to the same parse, not to a proof marker.
  const edited = await t.callTool("pb_update_spec", { name: "bare", section: "Tasks", content: "### T1: real file\nCreate T1.txt.\n- Acceptance: T1.txt exists\n- Test: `test -f T1.txt`" });
  assert.equal(edited.error, undefined, edited.error ?? "");
  // A task with no Test: line is a doc/refactor task; its plain acceptance line is enough.
  const commandless = SPEC({ tasks: "### T1: docs for the banner\nUpdate the design doc; documentation-only change, no test command.\n- Acceptance: design doc updated" });
  assert.equal((await t.callTool("pb_write_spec", { name: "commandless", content: commandless })).error, undefined);
});

test("spec: a declared doc-only task gets no missing-Test nudge", async () => {
  const t = setup();
  process.chdir(t.repo);
  const docOnly = SPEC({ tasks: "### T1: docs for the banner\nNaming the prose that must follow the behaviour; doc-only, no test command.\n- Acceptance: javadoc updated" });
  const w = (await t.callTool("pb_write_spec", { name: "a", content: docOnly })).content![0].text;
  assert.doesNotMatch(w, /adds behaviour but has no Test/);
  const documented = SPEC({ tasks: "### T1: docs for the banner\nUpdate the design doc; documentation-only change, no test command.\n- Acceptance: design doc updated" });
  assert.doesNotMatch((await t.callTool("pb_write_spec", { name: "c", content: documented })).content![0].text, /adds behaviour but has no Test/); // "documentation-only" is the same declaration
  // Without the declaration the nudge stays: the reviewer then judges the tests at the end.
  const vague = SPEC({ tasks: "### T1: misc polish\nSmall behaviour touch-ups.\n- Acceptance: polish applied" });
  assert.match((await t.callTool("pb_write_spec", { name: "b", content: vague })).content![0].text, /adds behaviour but has no Test/);
});

test("spec review: a spec edited while the review runs is not built on the stale pass", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  await t.callTool("pb_write_spec", { name: "order-cancellation", content: SPEC() });
  process.env.MOCK_SPEC_EDIT = path.join(t.repo, ".pi/pb/specs/order-cancellation/spec.md");
  try {
    await t.run("build", "order-cancellation");
  } finally {
    delete process.env.MOCK_SPEC_EDIT;
  }
  assert.ok(!t.instructions.some((x) => /Task T1/.test(x))); // nothing built
  assert.ok(t.notes.some((n) => /changed while it was under review/.test(n)));
});

test("spec: the pre-approval dry-run is watched like every other check", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  await written(t, SPEC({
    tasks: "### T1: first file\nCreate T1.txt.\n- Acceptance: T1.txt exists (tests: T1)\n- Test: `sleep 0.5`\n\n### T2: second file\nCreate T2.txt.\n- Acceptance: T2.txt exists (tests: T2)\n- Test: `sleep 0.7`",
  }));
  const { Store } = await import("../extensions/pb/store.ts");
  new Store(t.repo).setPendingBuild(t.runtime().ctx.sessionManager.getSessionFile());
  t.selects.push("Not now");
  const pending = t.fire("agent_settled", {});
  await until(() => !!t.widgets.get("pb-dry-run"));
  assert.match(t.widgets.get("pb-dry-run")!.join("\n"), /pb dry-run order-cancellation \(\d\/2\) — `sleep 0\.\d`/);
  await pending;
  assert.equal(t.widgets.get("pb-dry-run"), undefined); // cleared with the results
});

test("guide: the spec topic states the bound owner, the single fix per finding and the one-pass scope", async () => {
  // /pb:help renders a pb:topic region, so guidance written outside one is invisible to its reader
  const doc = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "extensions", "pb", "guide.md"), "utf8");
  const topic = doc.slice(doc.indexOf("<!-- pb:topic spec -->"), doc.indexOf("<!-- pb:topic build -->"));
  assert.ok(topic.length > 1000, "the spec topic region was found");
  // the guide is hand-wrapped, so a claim is matched across line breaks, never at one wrap point
  const says = (phrase: string) => new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").split(/\s+/).join("\\s+"), "i");
  for (const claim of [
    "bounds how often something runs should name the code whose call it bounds",
    "`new: <path>` when nothing performs it yet",
    "the `assumed:` tag when nothing in the project enforces the cadence",
    "a backticked command is a measurement, not an owner",
    "the single fix the reviewer would make",
    "that reason belongs in the same fix line",
    "not as an either/or handed back to you",
    "it is the only one: there are no rounds, no carry and no outside lane",
    "Only a **P0** blocks the build",
    "A spec is reviewed once.",
    "After a P0, the edit that settles it is reviewed",
  ]) assert.match(topic, says(claim), claim);
});

test("rename sweep: prose citing a removed identifier is listed with file:line", async () => {
  const t = setup();
  process.chdir(t.repo);
  const { staleProseRefs } = await import("../extensions/pb/checkpoint.ts");
  const { execSync } = await import("node:child_process");
  fs.writeFileSync(path.join(t.repo, "src-helper.ts"), "export function oldHelperName() { return 1; }\n");
  fs.writeFileSync(path.join(t.repo, "REF.md"), "call `oldHelperName` first\n");
  execSync("git add -A && git commit -qm base", { cwd: t.repo });
  const base = execSync("git rev-parse HEAD", { cwd: t.repo, encoding: "utf8" }).trim();
  assert.deepEqual(staleProseRefs(t.repo, base), []);
  fs.writeFileSync(path.join(t.repo, "src-helper.ts"), "export function newHelperName() { return 1; }\n");
  const hits = staleProseRefs(t.repo, base);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].symbol, "oldHelperName");
  assert.ok(hits[0].referrers.some((r) => r.startsWith("REF.md:")));
});

test("rename sweep: deleted files are matched by basename, clean trees stay quiet", async () => {
  const t = setup();
  process.chdir(t.repo);
  const { staleProseRefs } = await import("../extensions/pb/checkpoint.ts");
  const { execSync } = await import("node:child_process");
  fs.writeFileSync(path.join(t.repo, "legacy-helper.ts"), "export const x = 1;\n");
  fs.writeFileSync(path.join(t.repo, "REF.md"), "see legacy-helper for details\n");
  execSync("git add -A && git commit -qm base", { cwd: t.repo });
  const base = execSync("git rev-parse HEAD", { cwd: t.repo, encoding: "utf8" }).trim();
  fs.rmSync(path.join(t.repo, "legacy-helper.ts"));
  const hits = staleProseRefs(t.repo, base);
  assert.ok(hits.some((h) => h.symbol === "legacy-helper" && h.referrers.some((r) => r.startsWith("REF.md:"))));
  assert.deepEqual(staleProseRefs(t.repo, undefined), []);
});

test("spec: the format checklist asks for prose inventory, real states and measured numbers", async () => {
  const { specPrompt, finishSpecPrompt } = await import("../extensions/pb/prompts.ts");
  for (const p of [specPrompt("", []), finishSpecPrompt("x")]) {
    assert.match(p, /prose that describes the behavior/);
    assert.match(p, /enumerate its real states/);
    assert.match(p, /Each one carries its evidence beside it: a path:line that says it, a probe/);
    assert.match(p, /## Migration and rollback/);
    assert.match(p, /path:line must point at a real line/);
    assert.match(p, /external surface/);
    assert.match(p, /## Goal\nThe outcome in a few sentences/);
    assert.match(p, /Goal, Decisions, Contracts, Threats and Acceptance bind the build/);
  }
});

test("spec: every observable contract value cites the code or test that pins it", async () => {
  const { specPrompt, finishSpecPrompt, specReviewBrief, SPEC_REVIEWER_SYSTEM } = await import("../extensions/pb/prompts.ts");
  for (const p of [specPrompt("", []), finishSpecPrompt("x")]) {
    assert.match(p, /Every observable value a Contract states/);
    assert.match(p, /is load-bearing \(see Evidence below\): a value code has today cites the code path or test that pins it today \(file:line\)/);
  }
  assert.match(specPrompt("", []), /never infer a status or an order from what the design should do/);
  const review = specReviewBrief("s", "# S\n\n## Contracts\n- 200\n");
  assert.match(review, /# Spec to review: s[\s\S]*## Contracts\n- 200/);
  assert.match(review, /one frozen draft[\s\S]*only a P0 blocks/);
  assert.match(SPEC_REVIEWER_SYSTEM, /the claims a Contract, a Decision or an Acceptance line rests on carry the evidence the rule below asks for, and that evidence says what the claim says/);
  assert.match(SPEC_REVIEWER_SYSTEM, /one sentence a tired human can act on: what goes wrong, for whom, and where/);
  assert.match(SPEC_REVIEWER_SYSTEM, /supporting evidence and the single change/);
});

test("contract values are computed: the format shows each formula's result for the cases Acceptance pins", async () => {
  const { specPrompt, finishSpecPrompt } = await import("../extensions/pb/prompts.ts");
  const contractsOf = (p: string) => p.slice(p.indexOf("## Contracts"), p.indexOf("## Migration and rollback"));
  for (const p of [specPrompt("", []), finishSpecPrompt("x")]) {
    const contracts = contractsOf(p);
    // a formula the reader must evaluate by hand is where a wrong value survives a review round
    assert.match(contracts, /computed value for each case/);
    // it sits beside the citation rule it complements, in Contracts and not in some other section
    assert.match(contracts, /Every observable value a Contract states[\s\S]*computed value for each case/);
    assert.doesNotMatch(p.slice(0, p.indexOf("## Contracts")), /computed value for each case/);
  }
});

test("spec: a task naming a full-suite run gets an advisory, not a rejection", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  const broad = SPEC({ tasks: "### T1: everything\nEdit the model and then run the full suite.\n- Acceptance: T1.txt exists (tests: T1)\n- Test: `test -f T1.txt`" });
  const warned = await t.callTool("pb_write_spec", { name: "broad", content: broad });
  assert.equal(warned.error, undefined);
  assert.match(warned.content![0].text, /T1 names a full-suite run .*the harness runs the full suite after the last task/);
  const narrow = SPEC({ tasks: "### T1: the model\nEdit the model.\n- Acceptance: T1.txt exists (tests: T1)\n- Test: `test -f T1.txt`" });
  const quiet = await t.callTool("pb_write_spec", { name: "narrow", content: narrow });
  assert.equal(quiet.error, undefined);
  assert.doesNotMatch(quiet.content![0].text, /full-suite run/);
});

test("spec: the format gives one acceptance form — task lines plus a Test: command", async () => {
  const { specPrompt, finishSpecPrompt } = await import("../extensions/pb/prompts.ts");
  for (const p of [specPrompt("", []), finishSpecPrompt("x")]) {
    assert.match(p, /- Acceptance: <one behaviour, as a test would check it>/);
    assert.match(p, /the task's Test: command is the proof/);
    assert.doesNotMatch(p, /\(tests:|non-testable|## Acceptance criteria/);
    assert.match(p, /probe: <what you ran>; conclusion:/);
    assert.match(p, /Say why in plain prose, not with a bare colon/);
    assert.match(p, /A doc-only task carries no Test: line — its acceptance lines still say what to check/);
  }
});

test("spec review defers to points the spec marks decided, absent new evidence", async () => {
  const { SPEC_REVIEWER_SYSTEM } = await import("../extensions/pb/prompts.ts");
  assert.match(SPEC_REVIEWER_SYSTEM, /point the spec marks decided is settled: check for new evidence, and comment only when you find it/);
});

test("assumptions: one notation beside the claim; older Decisions entries still count; the build's own are listed by the build", async () => {
  const { specAssumptions } = await import("../extensions/pb/spec.ts");
  const md = [
    "# S",
    "## Decisions",
    "- Use POST, because the router has no DELETE.",
    "- Assumption: cancelling twice is a no-op, because the API is idempotent elsewhere.",
    "- Assumption (build, T1): the queue is FIFO",
    "## Contracts",
    "- `POST /orders/{id}/cancel` returns 409 for a shipped order — assumed: falsified if the gateway remaps 4xx",
    "- The order list is capped at 500 rows (assumed: a larger page times out)",
    "```",
    "assumed: inside a fence is code, not a claim",
    "```",
    "## Findings",
    "- Assumption about nothing outside Decisions is prose, not an entry",
  ].join("\n");
  assert.deepEqual(specAssumptions(md), [
    "Assumption: cancelling twice is a no-op, because the API is idempotent elsewhere.",
    "`POST /orders/{id}/cancel` returns 409 for a shipped order — assumed: falsified if the gateway remaps 4xx",
    "The order list is capped at 500 rows (assumed: a larger page times out)",
  ]);
});

test("assumptions: a claim tagged `assumed:` is counted where the human decides, not only Decisions entries", async () => {
  const t = setup({ verify: "true" });
  const tagged = SPEC().replace(
    "- T1 owns T1.txt; T2 owns T2.txt; no shared seams beyond the file list above.",
    "- T1 owns T1.txt; T2 owns T2.txt; no shared seams beyond the file list above.\n- Each file is under 4 KB — assumed: falsified if a fixture writer pads it",
  );
  await written(t, tagged);
  await t.run("spec-review", "order-cancellation");
  assert.match(t.posts.at(-1)!, /1 assumption\b/);
});

test("spec stats: reviews, their findings by priority, claim checks, laps and the fresh runs' tokens are counted", async () => {
  const { renderCard, summarize } = await import("../extensions/pb/stats.ts");
  const t = setup({ verify: "true" });
  await written(t);
  process.env.MOCK_SPEC_REVIEW = "advisory"; // a pass with a P1 and a P2
  try {
    await t.run("spec-review", "order-cancellation");
  } finally {
    delete process.env.MOCK_SPEC_REVIEW;
  }
  const review = t.events("order-cancellation").find((e: any) => e.type === "spec-review");
  assert.ok(review.input >= 3000 && review.output >= 400, "the run's usage is recorded on the event"); // the mock reports 3000/400 per message
  const events = [
    ...t.events("order-cancellation"),
    { type: "spec-check", at: "2026-11-10 10:00:00", verdict: "pass", findings: 2, input: 1000, output: 100, cost: 0.01, ms: 4000 },
    { type: "spec-check", at: "2026-11-10 10:01:00", verdict: "error", findings: 0, input: 500, output: 50, cost: 0.005, ms: 2000 },
    { type: "spec-fix", at: "2026-11-10 10:02:00", applied: [1], rebutted: [], parked: [], assumed: [{ id: 2, claim: "x" }] },
  ];
  const stats = { name: "order-cancellation", phase: "written", events, explore: [], progress: t.progress("order-cancellation") } as any;
  const phase = summarize(stats).spec!;
  assert.deepEqual([phase.reviews, phase.blocked, phase.findings], [1, 0, [0, 1, 1, 0]]);
  assert.deepEqual([phase.claimChecks, phase.claims, phase.laps, phase.applied, phase.assumed], [1, 2, 1, 1, 1]); // a failed check is not a check
  assert.equal(phase.prompt, review.input + 1000 + 500); // every fresh run costs, reported or not
  assert.match(renderCard(stats), /^Spec +1 review · findings P0 0 P1 1 P2 1 P3 0 · 1 claim check: 2 claims · 1 lap: 1 applied, 0 rebutted, 0 parked, 1 assumed · in [\d.]+k · out [\d.]+k? · \$/m);
  assert.equal(summarize({ ...stats, events: [] }).spec, undefined); // no spec phase ran: no line
});

test("spec review: each finding names the check it fails, and the stats count findings per check", async () => {
  const { SPEC_CHECK_NAMES, SPEC_REVIEWER_SYSTEM } = await import("../extensions/pb/prompts.ts");
  const { renderCard, summarize } = await import("../extensions/pb/stats.ts");
  // The tags are the writer's checks by name, read off the one list, plus the evidence rule and a catch-all.
  assert.deepEqual(SPEC_CHECK_NAMES, ["Claims", "Values", "Proof", "Coverage", "Reach", "Consistency", "Overengineering", "Evidence", "Other"]);
  assert.match(SPEC_REVIEWER_SYSTEM, /Give each finding the check it fails in its check field: one of the names above, Evidence when it breaks the evidence rule below, or Other\./);
  const t = setup({ verify: "true" });
  await written(t);
  process.env.MOCK_SPEC_REVIEW = "tagged";
  try {
    await t.run("spec-review", "order-cancellation");
  } finally {
    delete process.env.MOCK_SPEC_REVIEW;
  }
  const review = t.events("order-cancellation").find((e: any) => e.type === "spec-review");
  // Spelled as the list spells it; a name outside the list is Other, never a new category; no tag stays none.
  assert.deepEqual(review.reported.map((f: any) => f.check), ["Values", "Claims", "Other", undefined]);
  assert.match(t.posts.at(-1)!, /- 1\. \[P1 · Values\] src\/order\.ts:42 — Context — the transition has no guard/, "numbered as recorded, so a finding can be named by its number");
  const stats = { name: "order-cancellation", phase: "written", events: t.events("order-cancellation"), explore: [], progress: t.progress("order-cancellation") } as any;
  assert.deepEqual(summarize(stats).spec!.byCheck, { Claims: 1, Other: 1, Values: 1 });
  assert.match(renderCard(stats), /findings P0 0 P1 1 P2 3 P3 0 · by check Claims 1 Other 1 Values 1 ·/);
});

test("spec checks: the writer runs the spec reviewer's checks before writing, from one list", async () => {
  const { specPrompt, finishSpecPrompt, SPEC_REVIEWER_SYSTEM } = await import("../extensions/pb/prompts.ts");
  const names = ["Claims", "Values", "Proof", "Coverage", "Reach", "Consistency"];
  const checksIn = (prompt: string) => names.map((n) => prompt.match(new RegExp(`^\\s*- ${n}: [^\\n]+$`, "m"))?.[0].trim());
  const reviewer = checksIn(SPEC_REVIEWER_SYSTEM);
  assert.ok(reviewer.every(Boolean), "the reviewer checks every item");
  for (const writer of [specPrompt("", []), finishSpecPrompt("x")]) assert.deepEqual(checksIn(writer), reviewer, "the writer runs the same list, word for word");
  const [claims, values, proof, coverage, reach] = reviewer.map(String);
  // The classes real spec reviews kept raising, each a line of its own.
  assert.match(claims, /open the line, because a fact remembered from the discussion is not evidence/);
  assert.match(values, /a time names its clock or zone;/);
  assert.match(proof, /that test can fail before the change/);
  assert.match(coverage, /each Contract and each Decision that changes behaviour has an Acceptance line that pins it/);
  assert.match(reach, /the existing tests, callers, links and docs that assert the behaviour being changed/);
  // The writer verifies what the build acts on by targeted reads; the explorer is the fallback, not the default.
  assert.match(specPrompt("", []), /For Claims, re-open only the lines a Contract or an Acceptance value rests on[^\n]*Call pb_explore once, with the list, only for those you can't place/);
});

test("spec format: the planner's operations and user answers have a home in the spec", async () => {
  const { specPrompt, PLANNER_ROLE } = await import("../extensions/pb/prompts.ts");
  const prompt = specPrompt("", []);
  assert.match(prompt, /## Migration and rollback\n[^\n]*ships something that can fail in production[^\n]*how we'd see it fail \(the log, metric or alert\), and what no test can show and how it is checked instead/);
  assert.match(prompt, /## Contracts\n[^\n]*what a user sees when it fails/);
  // The spec reply ends with the What-now block, not the planner's ledger.
  assert.match(PLANNER_ROLE, /A reply that writes the spec needs no ledger: the spec is the ledger\./);
});

test("spec rewrite: the write reports what it removed from the previous text, and nothing when it removed nothing", async () => {
  const t = setup();
  await written(t);
  const noteOf = (r: Result) => (r.content?.[0]?.text ?? "").match(/Note: this write removed [^\n]*/)?.[0];
  const same = await t.callTool("pb_write_spec", { name: "order-cancellation", content: SPEC().replace("Refunds.", "Refunds and chargebacks.") });
  assert.equal(noteOf(same), undefined, "an edit that keeps everything says nothing");
  const lossy = SPEC()
    .replace("## Out of scope\nRefunds.\n", "")
    .replace("- Not doing soft delete, because audit lives elsewhere.\n", "")
    .replace("- Acceptance: T2.txt exists", "- Acceptance: T2.txt exists and is empty");
  const note = noteOf(await t.callTool("pb_write_spec", { name: "order-cancellation", content: lossy }));
  assert.ok(note, "a lossy rewrite is named");
  assert.match(note!, /the "## Out of scope" section/);
  assert.match(note!, /1 Acceptance line \("Acceptance: T2\.txt exists"\)/, "a reworded line counts: the old words are gone");
  assert.match(note!, /1 Decisions entry \("Not doing soft delete, because audit lives elsewhere\."\)/);
  // A section update reports the same facts.
  const update = await t.callTool("pb_update_spec", { name: "order-cancellation", section: "Decisions", content: "- Only PENDING orders can be cancelled, because the state machine only allows that transition." });
  assert.equal(noteOf(update), undefined, "replacing with the same entry loses nothing");
  const dropped = await t.callTool("pb_update_spec", { name: "order-cancellation", section: "Decisions", content: "- Cancel any order, because support asked." });
  assert.match(noteOf(dropped) ?? "", /1 Decisions entry \("Only PENDING orders can be cancelled/);
});

test("scope: the Goal is the need asked for, each citation is verified once, and the spec reviewer reads narrowly and reports at most five findings that change the build", async () => {
  const { specPrompt, finishSpecPrompt, SPEC_REVIEWER_SYSTEM } = await import("../extensions/pb/prompts.ts");
  for (const writer of [specPrompt("", []), finishSpecPrompt("x")]) {
    // An outcome nobody asked for goes to Out of scope by default: no question, the human adds it back.
    assert.match(writer, /## Goal\n[^\n]*It is the need I asked for, in my terms, plus what the change itself must not break or let through[^\n]*name it under Out of scope, and I add it back if I want it\./);
    // The spec is the builder's contract, sized to the change.
    assert.match(writer, /Findings hold only facts that change what gets built; Decisions only the choices a competent builder could plausibly get wrong[^\n]*Keep the spec well under the size of the change it describes/);
    // Each citation is verified once: the writer the ones the build acts on, the reviewer the rest.
    assert.match(writer, /For Claims, re-open only the lines a Contract or an Acceptance value rests on: the build acts on those directly\. Every spec is reviewed from a fresh context, and the reviewer verifies the other citations/);
  }
  assert.match(SPEC_REVIEWER_SYSTEM, /Check the spec against the code where the build depends on it: the claims a Contract, a Decision or an Acceptance line rests on/);
  assert.match(SPEC_REVIEWER_SYSTEM, /Read narrowly: grep for the symbol, then read the line range you need, never a whole file to find one line[^\n]*Stop after about 40 tool calls, or sooner once your findings are settled, and report\./);
  assert.match(SPEC_REVIEWER_SYSTEM, /Report at most the five findings that matter most, highest priority first/);
  assert.match(SPEC_REVIEWER_SYSTEM, /Wiring the build catches by itself is not a finding: a test name, a doc or caller left out of a task/);
  // A Test: command is not wiring: only the human may change it, so one that selects nothing would stop the build mid-way.
  assert.match(SPEC_REVIEWER_SYSTEM, /A task's Test: command is the exception, since only the human may change it and the build stops when it can't prove anything: check each against the project's own runner \(its build file and how it selects tests\), and one that selects no test, so passes without proving anything, is a P1\./);
  assert.match(SPEC_REVIEWER_SYSTEM, /a Goal that bundles a second outcome the change's own need does not require[^\n]*is a finding whose fix is the cut/);
});

test("evidence: the writer and the spec reviewer judge claims by one rule", async () => {
  const { specPrompt, finishSpecPrompt, SPEC_REVIEWER_SYSTEM } = await import("../extensions/pb/prompts.ts");
  const rule = specPrompt("", []).match(/A claim is load-bearing when[^\n]*?Anything else needs no evidence\./)?.[0];
  assert.ok(rule, "the writer's format states the rule");
  for (const prompt of [finishSpecPrompt("x"), SPEC_REVIEWER_SYSTEM]) assert.ok(prompt.includes(rule), "every role reads the same rule, word for word");
  // A test proves what the change defines; a belief about code that exists today needs the code itself.
  assert.match(rule, /for a value this change defines \(a new status, error, event or stored value\), the Acceptance line that pins it, whose red test is the proof/);
  assert.match(rule, /A claim about existing code or a service needs the path:line or the probe: a test written from the same belief passes even when the belief is wrong/);
  assert.match(rule, /tagged `assumed: <what would falsify it>` right after it/);
  assert.match(SPEC_REVIEWER_SYSTEM, /A claim that is not load-bearing and carries no evidence is not a finding\./);
  // The rule is the one place evidence is asked for: no section repeats its own version.
  assert.doesNotMatch(specPrompt("", []), /Every quantitative claim|never a bare conclusion|is written as an Assumption/);
});
