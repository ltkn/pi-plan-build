/** Reviews: the code review, its verifier and abuse pass, the ledger, and /pb:fix laps. */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { type Finding, acceptanceOf, briefOf, CHANGES, contractHash, diligent, INJECTED, pausedWithFindings, provedFixed, repairLap, setup, SPEC, taskOf, written } from "./harness.mts";

test("review: the reviewer looks for what the change could do without, and prefers an invariant to another guard", async () => {
  const { REVIEWER_SYSTEM } = await import("../extensions/pb/prompts.ts");
  assert.match(REVIEWER_SYSTEM, /- Simplicity: what the change could do without\. An option, layer or abstraction with one user and no reason in the spec; a near-copy of a helper the project already has \(name it\); a check repeating what a type, a constraint or an earlier boundary already guarantees; code no path reaches\. P2, with the deletion or the reuse as the fix/);
  assert.match(REVIEWER_SYSTEM, /Adding guards is not the default fix: prefer the invariant that makes them unnecessary\./);
  assert.match(REVIEWER_SYSTEM, /- P2 worth fixing: conventions, clarity, comments, needless complexity, a second-best choice\./);
});

test("every reviewer reports through its tool before writing its reply", async () => {
  const { REVIEWER_SYSTEM, ATTACKER_SYSTEM, SPEC_REVIEWER_SYSTEM } = await import("../extensions/pb/prompts.ts");
  // A pass that explores for minutes and then answers in prose has done the work and reported nothing:
  // each prompt has to put the tool call ahead of the reply, in the name the role actually has.
  assert.match(REVIEWER_SYSTEM, /pb_report_findings[^.]*made as soon as you have them and before your reply/);
  assert.match(ATTACKER_SYSTEM, /report_findings, in one call made as soon as you have them and before your reply/);
  assert.match(SPEC_REVIEWER_SYSTEM, /report_findings in one call[^.]*as soon as you have them, before writing your reply/);
});

test("a repair lap is told when the review cites a path that does not exist in the project", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  process.env.MOCK_SPEC_REVIEW = "badfile";
  try {
    await t.run("spec-review", "order-cancellation");
  } finally {
    delete process.env.MOCK_SPEC_REVIEW;
  }
  t.agent.script = repairLap(t, { applied: [1], rebutted: [], parked: [], assumed: [], summary: "settled" });
  await t.run("spec-fix", "order-cancellation");
  assert.match(t.instructions.find((i) => i.includes("[pb:spec-fix]"))!, /The review cites paths that don't exist in this project: no\/such\/file\.ts — treat those locations as unverified/);
});

test("review brief: fix reports and acceptance drift render as sections", async () => {
  const { reviewerBrief, acceptanceDrift } = await import("../extensions/pb/prompts.ts");
  assert.equal(acceptanceDrift("# T", []), undefined); // no build-start: nothing to compare
  const tasks = ["### T1: a\n- Acceptance: a works"];
  assert.equal(acceptanceDrift(tasks.join("\n"), [{ type: "build-start", taskTexts: tasks }]), undefined);
  const drift = acceptanceDrift("- Acceptance: a works\n- Acceptance: b works", [{ type: "build-start", taskTexts: tasks }]);
  assert.match(drift!, /Acceptance drift during build[\s\S]*added\/reworded during build: - Acceptance: b works/);
  const reword = acceptanceDrift("- Acceptance: a works well", [{ type: "build-start", taskTexts: tasks }]);
  assert.match(reword!, /dropped\/reworded since build start: - Acceptance: a works[\s\S]*added\/reworded during build: - Acceptance: a works well/);
  const brief = reviewerBrief({
    changed: [],
    stat: "",
    check: "ok",
    focus: "",
    fixReports: [{ fixed: ["guard clause"], skipped: [], tests: "npm test green" }],
  });
  assert.match(brief, /## What the fix laps reported[\s\S]*Lap 1 fixed: guard clause[\s\S]*Lap 1 tests: npm test green/);
  assert.doesNotMatch(brief, /## Acceptance proof mapping/);
  assert.match(reviewerBrief({ changed: [], stat: "", check: "ok", focus: "", acceptanceDrift: drift }), /## Acceptance drift during build/);
});

test("review briefs: a diff capped once keeps the true cut count", async () => {
  const { reviewerBrief, verifierBrief, REVIEW_DIFF_CHARS } = await import("../extensions/pb/prompts.ts");
  const { cap } = await import("../extensions/pb/store.ts");
  const diff = cap("x".repeat(REVIEW_DIFF_CHARS + 12345), REVIEW_DIFF_CHARS);
  assert.match(diff, /\[truncated 12345 chars\]$/); // the capture's own cut
  const brief = reviewerBrief({ changed: [], stat: "", check: "ok", focus: "", diff });
  assert.match(brief, /\[truncated 12345 chars\]/);
  assert.doesNotMatch(brief, /\[truncated 25 chars\]/); // the marker is not truncated into a second, false cut
  const verifier = verifierBrief([], undefined, undefined, diff);
  assert.match(verifier, /\[truncated 12345 chars\]/);
  assert.doesNotMatch(verifier, /\[truncated 25 chars\]/);
});

test("review brief: every acceptance id is listed; a follow-up carries the previous statuses", async () => {
  const { reviewerBrief } = await import("../extensions/pb/prompts.ts");
  const brief = reviewerBrief({
    changed: [],
    stat: "",
    check: "ok",
    focus: "",
    acceptance: [{ id: "T1.1", text: "the test proves it", task: "T1" }],
    previous: {
      snapshot: "abc",
      findings: [],
      changed: ["T1.txt"],
      acceptance: [{ criterion: "T1.1", status: "met", evidence: "src/order.ts:12" }],
    },
  });
  assert.match(
    brief,
    /## This is a follow-up review[\s\S]*Acceptance at the previous review[\s\S]*- T1\.1: met — src\/order\.ts:12[\s\S]*## Acceptance checklist[\s\S]*Report every id below[\s\S]*- T1\.1 \(T1\): the test proves it/,
  );
  assert.match(brief, /an id left out counts as not verified/i);
});

test("review brief: what the build left unchecked reaches the reviewer as a claim to verify", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  t.agent.script = async (text, tool) => {
    const task = taskOf(text);
    if (!task || task === "final") return;
    await tool("pb_tests_red", { task });
    fs.writeFileSync(`${task}.txt`, "x");
    await tool("pb_task_done", { task, status: "done", changed: `did ${task}`, caveat: "none", rejected: "none", open: task === "T1" ? "the empty path is untested" : "none" });
  };
  await t.run("build");
  await t.run("review");
  const brief = briefOf(t);
  assert.match(brief, /## What the build says it left unchecked\n\nThe build's own open items[\s\S]*claims to verify, not evidence[\s\S]*- T1: the empty path is untested/);
  assert.doesNotMatch(brief, /- T2: none/);
});

test("review: a long prose report with no parseable findings is flagged, not silently passed", async () => {
  const { unparsedReport } = await import("../extensions/pb/review.ts");
  assert.equal(unparsedReport([{ priority: "P1", file: "f", title: "t" }], "whatever"), false); // tool findings: trusted
  assert.equal(unparsedReport(undefined, "1. [P2] src/order.ts:30 — name the constant"), false); // tagged prose parses
  assert.equal(unparsedReport(undefined, "Done."), false); // short prose: nothing to lose
  const lost = `P1 — the updated_at bump on in-place edits is silently lost in production. GexStalenessScheduler.updateStoredSet calls row.setUpdatedAt(now) on detached entities, so the bump never persists.\n\nP2 — a DB failure between the landed post and saveAll orphans a stale standing set with no coordinate rows.\n\n${"Fix: persist the bump through the repository. ".repeat(20)}`;
  assert.equal(unparsedReport(undefined, lost), true); // substantial but tagless: warn, don't pass clean
  assert.equal(unparsedReport([], lost), false); // an explicit empty report is a report, not silence
});

test("review: acceptance coverage treats silence as unverified, never met", async () => {
  const { acceptanceCoverage, normalizeAcceptance, verdictOf } = await import("../extensions/pb/review.ts");
  const expected = [
    { id: "T3.1", text: "the order can be cancelled" },
    { id: "T1.1", text: "the test proves it", task: "T1" },
    { id: "T2.1", text: "the audit entry exists", task: "T2" },
  ];
  const coverage = acceptanceCoverage(
    expected,
    normalizeAcceptance(
      [
        { criterion: "T3.1", status: "met", evidence: "src/order.ts:12" },
        { criterion: "T1.1", status: "met", evidence: "  " }, // met without evidence is not met
        { criterion: "T2.1", status: "not met", evidence: "the audit test does not run" },
        { criterion: "X9", status: "met", evidence: "invented" }, // not in the spec: dropped
      ],
      expected,
    ),
  );
  assert.deepEqual(
    coverage.lines.map((l) => [l.criterion.id, l.status]),
    [
      ["T3.1", "met"],
      ["T1.1", "not verified"],
      ["T2.1", "not met"],
    ],
  );
  assert.equal(coverage.met, 1);
  assert.equal(verdictOf([], coverage), "changes_needed"); // not met blocks even without a P1 finding
  assert.equal(verdictOf([{ priority: "P2", title: "advisory" }], coverage), "changes_needed");
  assert.equal(verdictOf([], acceptanceCoverage(expected, [])), "unverified"); // all omitted
  assert.equal(verdictOf([], acceptanceCoverage(expected.slice(0, 1), [])), "unverified"); // one omitted
  assert.equal(verdictOf([], acceptanceCoverage([], [])), "pass"); // no spec checklist: unchanged
  assert.equal(verdictOf([{ priority: "P0", title: "broken" }], acceptanceCoverage([], [])), "changes_needed");
});

test("review: the harness check's own artifacts are reported, not reverted behind your back", async () => {
  const t = setup({ verify: "touch review-artifact.txt" });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  assert.ok(fs.existsSync(path.join(t.repo, "review-artifact.txt"))); // the checks leave it behind
  fs.rmSync(path.join(t.repo, "review-artifact.txt")); // ...so the review's own check is what recreates it
  await t.run("review");
  assert.match(t.posts.at(-1)!, /Review — order-cancellation\*\* · PASS/);
  // Left in place and named: reverting it would also revert any edit you made in the same window.
  assert.ok(fs.existsSync(path.join(t.repo, "review-artifact.txt")));
  assert.match(t.posts.at(-1)!, /⚠ Files changed while the review ran[^\n]*review-artifact\.txt/);
});

test("review: a mid-build review doesn't clobber the build's last result", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  await t.callTool("pb_write_spec", { name: "order-cancellation", content: SPEC() });
  const session = t.runtime().ctx.sessionManager.getSessionFile();
  fs.writeFileSync(
    path.join(t.repo, ".pi/pb/specs/order-cancellation/progress.json"),
    JSON.stringify({
      spec: "order-cancellation",
      phase: "building",
      session,
      tasks: [
        { id: "T1", title: "first file", status: "doing", attempts: 1 },
        { id: "T2", title: "second file", status: "todo", attempts: 0 },
      ],
      current: "T1",
      lastVerify: { ok: true, command: "true", summary: "BUILD-RESULT", at: "2026-10-01 10:00:00" },
      updatedAt: "2026-10-01 10:00:00",
    }),
  );
  await t.run("review");
  assert.equal(t.progress("order-cancellation").lastVerify.summary, "BUILD-RESULT");
});

test("fix: an unfinished lap starts the next one automatically", async () => {
  const t = setup();
  process.chdir(t.repo);
  await t.callTool("pb_write_spec", { name: "order-cancellation", content: SPEC() });
  const session = t.runtime().ctx.sessionManager.getSessionFile();
  const findings = [
    { priority: "P2", file: "src/order.ts", line: 30, title: "first" },
    { priority: "P2", file: "src/order.ts", line: 12, title: "second" },
  ];
  fs.writeFileSync(
    path.join(t.repo, ".pi/pb/specs/order-cancellation/progress.json"),
    JSON.stringify({ spec: "order-cancellation", phase: "paused", session, tasks: [], review: { at: "2026-10-01 10:00:00", verdict: "changes", findings }, updatedAt: "2026-10-01 10:00:00" }),
  );
  let laps = 0;
  t.agent.script = async (text, tool) => {
    if (text.startsWith("[pb:fix")) {
      laps++;
      await provedFixed(tool, [1]);
      await provedFixed(tool, [1]);
    await tool("pb_fix_done", { fixed: [1], skipped: [], tests: "ok" }); // each lap numbers what it is shown from 1
    }
  };
  await t.run("fix");
  assert.equal(laps, 2);
  assert.deepEqual([...t.names.values()].filter((n) => n.startsWith("fix: order-cancellation")), ["fix: order-cancellation · lap 1", "fix: order-cancellation · lap 2"]);
  assert.match(t.posts.at(-1)!, /complete[\s\S]*\/pb:review/);
});

test("fix: a lap updates the spec's Design and Decisions to what it fixed, and nothing else", async () => {
  const t = setup();
  process.chdir(t.repo);
  await t.callTool("pb_write_spec", { name: "order-cancellation", content: SPEC() });
  await t.callTool("pb_write_spec", { name: "other-spec", content: SPEC().replace("# Order cancellation", "# Other spec") });
  const specFile = path.join(t.repo, ".pi/pb/specs/order-cancellation/spec.md");
  const before = fs.readFileSync(specFile, "utf8");
  const owner = JSON.parse(fs.readFileSync(path.join(t.repo, ".pi/pb/specs/order-cancellation/progress.json"), "utf8")).writtenIn;
  pausedWithFindings(t, "order-cancellation", [{ priority: "P2", file: "src/order.ts", line: 12, title: "today is frozen at mount" }]);
  const progressFile = path.join(t.repo, ".pi/pb/specs/order-cancellation/progress.json");
  fs.writeFileSync(progressFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(progressFile, "utf8")), writtenIn: owner }));
  const said: string[] = [];
  const tried = async (tool: (name: string, params: object) => Promise<{ error?: string }>, name: string, params: object) => said.push((await tool(name, params)).error ?? "written");
  t.agent.script = async (text, tool) => {
    if (!text.startsWith("[pb:fix")) return;
    await tried(tool, "pb_update_spec", { section: "Decisions", mode: "append", content: "- Today advances with the clock, because a tab left open past midnight must not show yesterday." });
    await tried(tool, "pb_update_spec", { section: "Design", content: "- `today` is derived from a ticking clock." });
    await tried(tool, "pb_update_spec", { section: "Contracts", content: "- T1 owns everything." });
    await tried(tool, "pb_update_spec", { section: "Tasks", content: "### T1: other\n- Acceptance: x\n- Test: `true`" });
    await tried(tool, "pb_update_spec", { status: "planning" });
    await tried(tool, "pb_update_spec", { name: "other-spec", section: "Decisions", mode: "append", content: "- an unrelated spec edit, because." });
    await tried(tool, "pb_write_spec", { name: "order-cancellation", content: SPEC() });
    await provedFixed(tool, [1]);
    await tool("pb_fix_done", { fixed: [1], skipped: [], tests: "ok" });
  };
  await t.run("fix");
  assert.deepEqual(said.slice(0, 2), ["written", "written"], "Design and Decisions follow the fix");
  for (const refusal of said.slice(2, 6)) assert.match(refusal, /This fix lap may change only order-cancellation's Design and Decisions[\s\S]*reported as skipped, for a spec revision/);
  assert.match(said[6]!, /This fix lap for order-cancellation can't rewrite a spec/);
  const after = fs.readFileSync(specFile, "utf8");
  assert.match(after, /Today advances with the clock/);
  assert.match(after, /## Design\n- `today` is derived from a ticking clock\./);
  assert.equal(contractHash(after), contractHash(before), "the approved contract is untouched, so nothing needs re-approval");
  assert.doesNotMatch(fs.readFileSync(path.join(t.repo, ".pi/pb/specs/other-spec/spec.md"), "utf8"), /an unrelated spec edit/);
  // The spec stays owned by the session that wrote it, not the lap that edited it.
  assert.equal(JSON.parse(fs.readFileSync(path.join(t.repo, ".pi/pb/specs/order-cancellation/progress.json"), "utf8")).writtenIn, owner);
  const { fixSeedPrompt } = await import("../extensions/pb/prompts.ts");
  assert.match(fixSeedPrompt("order-cancellation", []), /update those lines in this lap with pb_update_spec, so the spec says what the code now does; only Design and Decisions/);
});

test("fix: a report names findings by the number in the brief; a number outside it is refused", async () => {
  const t = setup();
  process.chdir(t.repo);
  await t.callTool("pb_write_spec", { name: "order-cancellation", content: SPEC() });
  pausedWithFindings(t, "order-cancellation", [{ priority: "P2", file: "src/order.ts", line: 12, title: "name the constant the reviewer named" }]);
  const said: string[] = [];
  t.agent.script = async (text, tool) => {
    if (!text.startsWith("[pb:fix")) return;
    said.push((await tool("pb_fix_done", { fixed: [2], skipped: [], tests: "ok" })).error ?? "recorded");
    said.push((await tool("pb_fix_done", { fixed: [], skipped: [], tests: "ok" })).error ?? "recorded");
    said.push((await tool("pb_fix_done", { fixed: [1], skipped: [1], tests: "ok" })).error ?? "recorded");
    await provedFixed(tool, [1]);
    await tool("pb_fix_done", { fixed: [1], skipped: [], tests: "ok" });
  };
  await t.run("fix");
  assert.match(said[0]!, /2 is not one of the findings shown for this lap/);
  assert.match(said[1]!, /Report at least one finding by its number/);
  assert.match(said[2]!, /cannot be both fixed and skipped/);
  assert.match(t.posts.at(-1)!, /\*\*✅ Fixes complete — order-cancellation\*\* · 1 lap · (?:<1s|\d+s)/);
  assert.match(t.posts.at(-1)!, /#1 name the constant the reviewer named/); // findings carry the number /pb:fix takes
  assert.match(t.posts.at(-1)!, /\*\*Next:\*\* `\/pb:review` checks the delta\./);
});

test("fix: a lap that revises the approved contract says re-approve before review", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  const approved = SPEC();
  await t.callTool("pb_write_spec", { name: "order-cancellation", content: approved });
  fs.writeFileSync(path.join(t.repo, ".pi/pb/specs/order-cancellation/approved.md"), approved);
  const session = t.runtime().ctx.sessionManager.getSessionFile();
  fs.writeFileSync(
    path.join(t.repo, ".pi/pb/specs/order-cancellation/progress.json"),
    JSON.stringify({
      spec: "order-cancellation",
      phase: "built",
      session,
      tasks: [],
      review: {
        at: "2026-10-01 10:00:00",
        verdict: "changes",
        findings: [{ priority: "P2", file: "src/order.ts", line: 12, title: "name the constant the reviewer named" }],
      },
      approval: { at: "2026-10-01 10:00:00", hash: "old-approved-hash", contractHash: contractHash(approved) },
      updatedAt: "2026-10-01 10:00:00",
    }),
  );
  t.agent.script = async (text, tool) => {
    if (!text.startsWith("[pb:fix")) return;
    // The lap itself can't touch the contract, but the human can edit the spec while it runs.
    fs.writeFileSync(path.join(t.repo, ".pi/pb/specs/order-cancellation/spec.md"), approved.replace("Cancel orders.", "Cancel pending orders."));
    await provedFixed(tool, [1]);
    await tool("pb_fix_done", { fixed: [1], skipped: [], tests: "ok" });
  };
  await t.run("fix");
  const post = t.posts.at(-1)!;
  assert.match(post, /\*\*The fix changed the approved contract\.\*\*/);
  assert.match(post, /\*\*Next:\*\* `\/pb:build order-cancellation` re-approves the revised contract/);
  assert.match(post, /re-approve it before `\/pb:review` can run/);
  assert.doesNotMatch(post, /\*\*Next:\*\* `\/pb:review` checks the delta\./);
});

test("fix: a lap that never reports stops the loop and escalates as silent", async () => {
  const t = setup();
  process.chdir(t.repo);
  await t.callTool("pb_write_spec", { name: "order-cancellation", content: SPEC() });
  const session = t.runtime().ctx.sessionManager.getSessionFile();
  fs.writeFileSync(
    path.join(t.repo, ".pi/pb/specs/order-cancellation/progress.json"),
    JSON.stringify({
      spec: "order-cancellation",
      phase: "paused",
      session,
      tasks: [],
      review: { at: "2026-10-01 10:00:00", verdict: "changes", findings: [{ priority: "P2", file: "src/order.ts", line: 30, title: "name the constant" }] },
      updatedAt: "2026-10-01 10:00:00",
    }),
  );
  t.agent.script = async () => {}; // the lap never reports, nudges unanswered
  await t.run("fix");
  assert.equal([...t.names.values()].filter((n) => n.startsWith("fix: order-cancellation · lap ")).length, 1); // never retried into a second silent session
  assert.match(t.posts.at(-1)!, /\*\*❌ Fixes stopped — order-cancellation\*\* · no report · (?:<1s|\d+s)/);
});

test("fix: pb runs the project's checks after a lap; a red check means the fixes don't count, and the next lap gets the failure", async () => {
  const t = setup({ verify: "false" }); // the suite fails whatever the lap does
  process.chdir(t.repo);
  await t.callTool("pb_write_spec", { name: "order-cancellation", content: SPEC() });
  pausedWithFindings(t, "order-cancellation", [{ priority: "P2", file: "src/order.ts", line: 12, title: "name the constant" }]);
  const seeds: string[] = [];
  t.agent.script = async (text, tool) => {
    if (!text.startsWith("[pb:fix")) return;
    seeds.push(text);
    await provedFixed(tool, [1]);
    await tool("pb_fix_done", { fixed: [1], skipped: [], tests: "all green here" });
  };
  await t.run("fix");
  assert.equal(seeds.length, 3, "a red check keeps the finding open, so the laps go on until the budget");
  assert.doesNotMatch(seeds[0], /pb's check after it failed/);
  assert.match(seeds[1], /The previous lap reported fixes, but pb's check after it failed, so none of them counts yet: make it pass without undoing them\.\n`false` failed/);
  const summary = t.posts.at(-1)!;
  assert.match(summary, /\*\*❌ Fixes stopped — order-cancellation\*\* · check failed · 3 laps/);
  assert.match(summary, /fixed none/, "the lap said fixed; pb's check said otherwise, and pb's word is the record");
  assert.match(summary, /\*\*pb's check after the last lap failed\*\*, so its fixes don't count yet:\n\n`false` failed/);
  const checks = t.events("order-cancellation").filter((e: any) => e.type === "check" && e.task === "fix");
  assert.ok(checks.some((e: any) => e.command === "false" && e.ok === false));
  assert.ok(!t.selectTitles.some((x) => x.includes("Review them now?")), "no review is offered over a red check");
});

test("fix: a green check is stated as a fact, and the follow-up review is offered", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  await t.callTool("pb_write_spec", { name: "order-cancellation", content: SPEC() });
  pausedWithFindings(t, "order-cancellation", [{ priority: "P2", file: "src/order.ts", line: 12, title: "name the constant" }]);
  t.agent.script = async (text, tool) => {
    if (!text.startsWith("[pb:fix")) return;
    await provedFixed(tool, [1]);
    await tool("pb_fix_done", { fixed: [1], skipped: [], tests: "ok" });
  };
  t.selects.push("Review the fixes now");
  await t.run("fix");
  const summary = t.posts.at(-1)!;
  assert.match(summary, /\*\*✅ Fixes complete — order-cancellation\*\* · 1 lap/);
  // The reproducing test the lap saw fail is re-run and must pass, then the project's checks.
  assert.match(summary, /pb's checks passed: `test -f [^`]+`, `true`/);
  assert.ok(t.selectTitles.includes("Fixes for order-cancellation are in. Review them now?"));
  assert.equal(t.stat.editorText, "/pb:review order-cancellation");
});

test("fix: a fixed finding needs a test seen failing first, or a stated reason no test can show it", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  await t.callTool("pb_write_spec", { name: "order-cancellation", content: SPEC() });
  pausedWithFindings(t, "order-cancellation", [
    { priority: "P2", file: "src/order.ts", line: 12, title: "the guard is missing" },
    { priority: "P3", file: "README.md", line: 3, title: "the doc names the old flag" },
  ]);
  const said: string[] = [];
  t.agent.script = async (text, tool) => {
    if (!text.startsWith("[pb:fix")) return;
    said.push((await tool("pb_fix_done", { fixed: [1, 2], skipped: [], tests: "ok" })).error ?? "recorded");
    // A test that passes before the fix proves nothing: refused, and it clears nothing it never set.
    said.push(String((await tool("pb_fix_red", { finding: 1, command: "true" })).content?.[0]?.text ?? ""));
    said.push((await tool("pb_fix_red", { finding: 9, command: "false" })).error ?? "recorded");
    await provedFixed(tool, [1]);
    said.push((await tool("pb_fix_done", { fixed: [1, 2], skipped: [], tests: "ok" })).error ?? "recorded");
    said.push((await tool("pb_fix_done", { fixed: [1, 2], skipped: [], untested: [{ finding: 2, why: "a doc line: no test can show it" }], tests: "ok" })).error ?? "recorded");
  };
  await t.run("fix");
  assert.match(said[0], /Not recorded: 1, 2 are reported fixed with no test seen failing first[\s\S]*call pb_fix_red, or list it in untested/);
  assert.match(said[1], /`true` passes before the fix, so it doesn't catch finding 1/);
  assert.match(said[2], /9 is not one of the findings shown for this lap/);
  assert.match(said[3], /Not recorded: 2 is reported fixed with no test seen failing first/);
  assert.equal(said[4], "recorded");
  const fix = t.events("order-cancellation").filter((e: any) => e.type === "fix").at(-1);
  assert.deepEqual(fix.fixedIds, [1, 2]);
  assert.equal(fix.reds.length, 1);
  assert.deepEqual(fix.untested, [{ finding: 2, why: "a doc line: no test can show it" }]);
  const { fixSeedPrompt } = await import("../extensions/pb/prompts.ts");
  assert.match(fixSeedPrompt("x", []), /first write a test that reproduces it and call pb_fix_red with the finding's number/);
  assert.doesNotMatch(fixSeedPrompt("x", []), /affected task's Test: line/, "the task's own command passed at build: it is not what fails first");
});

test("fix: a finding is a class — the lap looks for the same defect across the change, named by its base commit", async () => {
  const { fixSeedPrompt } = await import("../extensions/pb/prompts.ts");
  const seed = fixSeedPrompt("x", [], "", { base: "0123456789abcdef0123" });
  assert.match(seed, /A finding is a class, not a line: before fixing one, look for the same defect elsewhere in the change \(`git diff 0123456789ab` plus untracked files\) and fix every instance there too, naming each in your reply; an instance outside the change is reported, not fixed\./);
  assert.match(seed, /A rule you write in a doc must match what the code does: check it against the code and its tests\./);
});

test("fix: two findings sharing a title stay two — a report is read by number", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  await t.callTool("pb_write_spec", { name: "order-cancellation", content: SPEC() });
  pausedWithFindings(t, "order-cancellation", [
    { priority: "P2", file: "src/a.ts", line: 3, title: "the same words" },
    { priority: "P2", file: "src/b.ts", line: 9, title: "the same words" },
  ]);
  let laps = 0;
  t.agent.script = async (text, tool) => {
    if (!text.startsWith("[pb:fix")) return;
    laps++;
    if (laps > 1) return; // the second lap stays silent: what is left open is the point
    await provedFixed(tool, [1]);
    await tool("pb_fix_done", { fixed: [1], skipped: [], tests: "ok" });
  };
  await t.run("fix");
  assert.equal(laps, 2, "finding 2 was not fixed, so a second lap opened for it");
  assert.match(t.posts.at(-1)!, /fixed #1 the same words/);
  assert.doesNotMatch(t.posts.at(-1)!, /fixed #1 the same words, #2/);
});

test("fix: each lap is an undo point — /pb:undo restores its files and the spec, not the task list", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  await t.callTool("pb_write_spec", { name: "order-cancellation", content: SPEC() });
  pausedWithFindings(t, "order-cancellation", [{ priority: "P2", file: "src/order.ts", line: 12, title: "name the constant" }]);
  const file = path.join(t.repo, "fixed-by-lap.txt");
  const specFile = path.join(t.repo, ".pi/pb/specs/order-cancellation/spec.md");
  const specBefore = fs.readFileSync(specFile, "utf8");
  t.agent.script = async (text, tool) => {
    if (!text.startsWith("[pb:fix")) return;
    await provedFixed(tool, [1]);
    fs.writeFileSync(file, "the lap's edit");
    await tool("pb_update_spec", { section: "Decisions", mode: "append", content: "- The constant is named, because the review asked." });
    await tool("pb_fix_done", { fixed: [1], skipped: [], tests: "ok" });
  };
  t.selects.push("Later");
  await t.run("fix");
  const row = JSON.parse(t.read(".pi/pb/specs/order-cancellation/checkpoints.json")).find((c: any) => c.id === "fix1");
  assert.ok(row, "a row before the lap");
  assert.equal(row.kind, "fix");
  assert.equal(row.spec, specBefore);
  assert.ok(fs.existsSync(file));
  await t.run("undo", "fix1");
  assert.ok(!fs.existsSync(file), "the lap's file change is gone");
  assert.equal(fs.readFileSync(specFile, "utf8"), specBefore, "the spec lines the lap wrote are gone too");
  assert.doesNotMatch(t.posts.at(-1)!, /Tasks back to todo/, "a fix lap's row is not a build task");
  assert.equal(t.stat.editorText, "", "Later leaves nothing in the editor");
});

test("fix lap: the report is picked by event order, not the clock", async () => {
  const { lapReport } = await import("../extensions/pb/fix.ts");
  const prior = { at: "2026-01-01 10:00:01", type: "fix", fixed: ["first"], skipped: [], fixedIds: [1], skippedIds: [], tests: "ok" };
  const start = { at: "2026-01-01 10:00:01", type: "fix-start", findings: ["second"] };
  const events = [prior, start];
  const from = events.length; // the log position right after this lap's fix-start marker
  assert.equal(lapReport(events, from), undefined); // the prior report shares the second; it is not this lap's
  const report = { at: "2026-01-01 10:00:02", type: "fix", fixed: ["second"], skipped: ["third"], fixedIds: [1], skippedIds: [2], reds: ["npm test -- second"], tests: "npm test" };
  // Findings by the number the brief showed them as: two findings sharing a title stay two.
  assert.deepEqual(lapReport([...events, report], from), { fixed: [1], skipped: [2], reds: ["npm test -- second"], tests: "npm test" });
  assert.equal(lapReport([...events, { at: "2026-01-01 10:00:03", type: "fix" }], from), undefined); // a fix event without a fixed list is not a report
});

test("fix: a silent lap is not read as the prior lap's report, whatever the clock says", async () => {
  const t = setup();
  process.chdir(t.repo);
  await t.callTool("pb_write_spec", { name: "order-cancellation", content: SPEC() });
  pausedWithFindings(t, "order-cancellation", [
    { priority: "P2", file: "src/order.ts", line: 30, title: "first" },
    { priority: "P2", file: "src/order.ts", line: 12, title: "second" },
  ]);
  const { Store } = await import("../extensions/pb/store.ts");
  const event = Store.prototype.event;
  // Every fix report is stamped far in the future: the lap must attribute by event order, not by
  // comparing clock strings, or the prior lap's report stands in for this lap's silence.
  Store.prototype.event = function (this: InstanceType<typeof Store>, name: string, e: Record<string, unknown>) {
    return event.call(this, name, e.type === "fix" ? { ...e, at: "2099-01-01 00:00:00" } : e);
  };
  let laps = 0;
  try {
    t.agent.script = async (text, tool) => {
      if (!text.startsWith("[pb:fix")) return;
      laps++;
      if (laps === 1) await provedFixed(tool, [1]).then(() => tool("pb_fix_done", { fixed: [1], skipped: [], tests: "ok" })); // fixes "first"; later laps never report
    };
    await t.run("fix");
  } finally {
    Store.prototype.event = event;
  }
  assert.equal(laps, 2); // the silent lap stops the loop instead of consuming laps 2 and 3 on a stale report
  assert.equal([...t.names.values()].filter((n) => n.startsWith("fix: order-cancellation · lap ")).length, 2);
  assert.match(t.posts.at(-1)!, /no report after 2 nudges/);
});

test("fix: skipped findings never start a lap and reach the escalation", async () => {
  const t = setup();
  process.chdir(t.repo);
  await t.callTool("pb_write_spec", { name: "order-cancellation", content: SPEC() });
  const session = t.runtime().ctx.sessionManager.getSessionFile();
  fs.writeFileSync(
    path.join(t.repo, ".pi/pb/specs/order-cancellation/progress.json"),
    JSON.stringify({
      spec: "order-cancellation",
      phase: "paused",
      session,
      tasks: [],
      review: { at: "2026-10-01 10:00:00", verdict: "changes", findings: [{ priority: "P2", file: "a", title: "first" }, { priority: "P2", file: "b", title: "second" }] },
      updatedAt: "2026-10-01 10:00:00",
    }),
  );
  t.agent.script = async (text, tool) => {
    if (text.startsWith("[pb:fix")) await provedFixed(tool, [1]).then(() => tool("pb_fix_done", { fixed: [1], skipped: [2], tests: "ok" }));
  };
  await t.run("fix");
  assert.equal([...t.names.values()].filter((n) => n.startsWith("fix: order-cancellation · lap ")).length, 1);
  assert.match(t.posts.at(-1)!, /second/);
  assert.match(t.posts.at(-1)!, /spec revision/);
});

test("fix: unknown finding ids are refused, not guessed", async () => {
  const t = setup();
  process.chdir(t.repo);
  await t.callTool("pb_write_spec", { name: "order-cancellation", content: SPEC() });
  const session = t.runtime().ctx.sessionManager.getSessionFile();
  fs.writeFileSync(
    path.join(t.repo, ".pi/pb/specs/order-cancellation/progress.json"),
    JSON.stringify({
      spec: "order-cancellation",
      phase: "paused",
      session,
      tasks: [],
      review: { at: "2026-10-01 10:00:00", verdict: "changes", findings: [{ priority: "P2", file: "src/order.ts", line: 30, title: "name the constant" }] },
      updatedAt: "2026-10-01 10:00:00",
    }),
  );
  const before = [...t.names.values()].length;
  await t.run("fix", "99");
  assert.match(t.notes.at(-1)!, /no such finding/i);
  assert.match(t.notes.at(-1)!, /1\. name the constant/); // lists what's actually open
  assert.equal([...t.names.values()].length, before); // no session opened
});

test("fix: a lap opens a fenced session seeded with the findings", async () => {
  const t = setup();
  process.chdir(t.repo);
  await t.callTool("pb_write_spec", { name: "order-cancellation", content: SPEC() });
  const session = t.runtime().ctx.sessionManager.getSessionFile();
  fs.writeFileSync(
    path.join(t.repo, ".pi/pb/specs/order-cancellation/progress.json"),
    JSON.stringify({
      spec: "order-cancellation",
      phase: "paused",
      session,
      tasks: [],
      review: { at: "2026-10-01 10:00:00", verdict: "changes", findings: [{ priority: "P2", file: "src/order.ts", line: 30, title: "name the constant" }] },
      updatedAt: "2026-10-01 10:00:00",
    }),
  );
  await t.run("fix", "name the constant");
  assert.ok([...t.names.values()].includes("fix: order-cancellation · lap 1"));
  const seed = t.instructions.find((x) => x.startsWith("[pb:fix"))!;
  assert.match(seed, /Fix exactly the review findings below/);
  assert.match(seed, /name the constant/);
  assert.match(seed, /Do not commit or archive, and write nothing else under \.pi\//);
  assert.match(seed, /Before reporting, re-read your diff and fix what it shows: duplicated or dead code/);
  assert.match(seed, /Edit structured files .*exact literal replacement or line-based edits, never a backtracking regex/);
  assert.match(seed, /call pb_fix_done/);
});

test("fix: the report lands only in its own session, once", async () => {
  const t = setup();
  process.chdir(t.repo);
  const r = await t.callTool("pb_fix_done", { fixed: [1], skipped: [], tests: "none" });
  assert.match(r.error!, /not a pb fixes session/);
  await t.callTool("pb_write_spec", { name: "order-cancellation", content: SPEC() });
  const session = t.runtime().ctx.sessionManager.getSessionFile();
  fs.writeFileSync(
    path.join(t.repo, ".pi/pb/specs/order-cancellation/progress.json"),
    JSON.stringify({
      spec: "order-cancellation",
      phase: "paused",
      session,
      tasks: [],
      review: { at: "2026-10-01 10:00:00", verdict: "changes", findings: [{ priority: "P2", file: "src/order.ts", line: 30, title: "name the constant" }] },
      updatedAt: "2026-10-01 10:00:00",
    }),
  );
  t.agent.script = async (text, tool) => {
    if (text.startsWith("[pb:fix")) await provedFixed(tool, [1]).then(() => tool("pb_fix_done", { fixed: [1], skipped: [], tests: "`true` passes" }));
  };
  await t.run("fix");
  assert.equal(t.events("order-cancellation").filter((e: { type: string }) => e.type === "fix").length, 1); // the lap's single report landed, once
  const again = await t.callTool("pb_fix_done", { fixed: [], skipped: [], tests: "none" });
  assert.match(again.error!, /not a pb fixes session/); // single use: no double counting
});

test("fix: with no open findings there is nothing to open", async () => {
  const t = setup();
  process.chdir(t.repo);
  await t.callTool("pb_write_spec", { name: "order-cancellation", content: SPEC() });
  await t.run("fix");
  assert.match(t.notes.at(-1)!, /no open review findings/);
});

test("review: a pass verdict mid-build keeps the phase and says tasks remain", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  await t.callTool("pb_write_spec", { name: "order-cancellation", content: SPEC() });
  const session = t.runtime().ctx.sessionManager.getSessionFile();
  fs.writeFileSync(
    path.join(t.repo, ".pi/pb/specs/order-cancellation/progress.json"),
    JSON.stringify({
      spec: "order-cancellation",
      phase: "building",
      session,
      tasks: [
        { id: "T1", title: "first file", status: "done", attempts: 1 },
        { id: "T2", title: "second file", status: "todo", attempts: 0 },
      ],
      current: "T2",
      updatedAt: "2026-10-01 10:00:00",
    }),
  );
  fs.writeFileSync(path.join(t.repo, "T1.txt"), "x"); // what a done T1 made: pb re-runs its Test: before the review
  await t.run("review");
  const p = t.progress("order-cancellation");
  assert.equal(p.phase, "building"); // a pass must not strand the build as reviewed
  assert.equal(p.review?.verdict, "pass"); // the follow-up delta baseline is still kept
  assert.match(t.posts.at(-1)!, /still to build/);
  assert.match(t.posts.at(-1)!, /\*\*Next:\*\* `\/pb:build` continues the build; T2 still to do/);
  // A manual review while building uses the same acceptance checklist as the final one.
  assert.match(t.posts.at(-1)!, /\*\*Acceptance\*\* — 2\/2 met/);
  assert.equal(p.review?.acceptance?.length, 2);
});

test("review: an explicit spec name wins over this session's spec", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  const { Store } = await import("../extensions/pb/store.ts");
  new Store(t.repo).markAsked("standards");
  await t.callTool("pb_write_spec", { name: "order-cancellation", content: SPEC() });
  const session = t.runtime().ctx.sessionManager.getSessionFile();
  fs.writeFileSync(
    path.join(t.repo, ".pi/pb/specs/order-cancellation/progress.json"),
    JSON.stringify({ spec: "order-cancellation", phase: "paused", session, tasks: [], updatedAt: "2026-10-01 10:00:00" }),
  );
  await t.callTool("pb_write_spec", { name: "beta-flag", content: SPEC() });
  await t.run("review", "beta-flag");
  assert.ok([...t.names.values()].includes("review: beta-flag · spec"));
  assert.ok(![...t.names.values()].some((n) => n === "review: order-cancellation · spec"));
  assert.match(t.posts.at(-1)!, /Review — beta-flag/);
});

test('review: "done" outside a review session is refused instead of reviewed', async () => {
  const t = setup();
  process.chdir(t.repo);
  await t.run("review", "done");
  assert.match(t.notes.at(-1)!, /only works inside a review session/);
  assert.equal(t.instructions.length, 0);
});

test("review: a spec building in another session confirms before snapshotting", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  const { Store } = await import("../extensions/pb/store.ts");
  new Store(t.repo).markAsked("reviewer-model");
  await t.callTool("pb_write_spec", { name: "other-feature", content: SPEC() });
  fs.writeFileSync(
    path.join(t.repo, ".pi/pb/specs/other-feature/progress.json"),
    JSON.stringify({
      spec: "other-feature",
      phase: "building",
      session: "/elsewhere/other.jsonl",
      tasks: [{ id: "T1", title: "first file", status: "doing", attempts: 1 }],
      current: "T1",
      updatedAt: "2020-01-01 00:00:00",
    }),
  );
  t.selects.push("No, stop here");
  await t.run("review", "other-feature");
  assert.ok(t.selectTitles.some((x) => /building in another session/.test(x)));
  assert.equal(t.instructions.length, 0); // returned before snapshot, check and passes
});

test("review: a missing replay file warns without clearing the flag", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  await t.callTool("pb_write_spec", { name: "order-cancellation", content: SPEC() });
  const session = t.runtime().ctx.sessionManager.getSessionFile();
  fs.writeFileSync(
    path.join(t.repo, ".pi/pb/specs/order-cancellation/progress.json"),
    JSON.stringify({ spec: "order-cancellation", phase: "paused", session, tasks: [], reviewUnshown: true, updatedAt: "2026-10-01 10:00:00" }),
  );
  await t.run("review");
  assert.match(t.notes.at(-1)!, /was the spec archived/);
  assert.equal(t.progress("order-cancellation").reviewUnshown, true); // kept: the replay can retry
});

test("review: with several built specs the picker chooses", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  await t.callTool("pb_write_spec", { name: "order-cancellation", content: SPEC() });
  await t.callTool("pb_write_spec", { name: "beta-flag", content: SPEC() });
  for (const n of ["order-cancellation", "beta-flag"]) {
    fs.writeFileSync(
      path.join(t.repo, `.pi/pb/specs/${n}/progress.json`),
      JSON.stringify({ spec: n, phase: "built", session: "/elsewhere/other.jsonl", tasks: [], updatedAt: "2026-10-01 10:00:00" }),
    );
  }
  await t.run("review");
  assert.ok(t.selectTitles.some((x) => x === "Review what?"));
  assert.ok([...t.names.values()].includes("review: beta-flag · spec")); // pool[0]: sorted, default-picked
});

test("review: security auto skips the adversarial pass on calm ground", async () => {
  const t = setup({ verify: "true", reviewer: { security: "auto" } });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  await t.run("review");
  assert.match(t.posts.at(-1)!, /\*\*✅ Review — order-cancellation\*\* · PASS/);
  assert.doesNotMatch(t.posts.at(-1)!, /adversarial/);
});

test("review: security off never runs the adversarial pass", async () => {
  const t = setup({ verify: "true", reviewer: { security: "off" } });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  await t.run("review");
  assert.match(t.posts.at(-1)!, /\*\*✅ Review — order-cancellation\*\* · PASS/);
  assert.doesNotMatch(t.posts.at(-1)!, /adversarial/);
});

test("review: by default the adversarial pass runs only on sensitive ground", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  await t.run("review");
  assert.match(t.posts.at(-1)!, /\*\*✅ Review — order-cancellation\*\* · PASS/);
  assert.doesNotMatch(t.posts.at(-1)!, /adversarial/);
});

test("review: showing an archived spec's interrupted review says so instead of crashing", async () => {
  const t = setup({ verify: "true", mapOnArchive: false });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  await t.run("archive");
  const home = t.runtime().ctx.sessionManager.getSessionFile();
  fs.writeFileSync(
    path.join(t.repo, ".pi/pb/review-run.json"),
    JSON.stringify({ id: "dead-run", cwd: t.repo, name: "order-cancellation", label: "order-cancellation", brief: "", followUp: false, passes: [], home, interrupted: { role: "review", session: "gone.jsonl" } }),
  );
  t.selects.push("Show what it had reported");
  await t.run("review");
  assert.match(t.notes.at(-1)!, /The review's file is gone \(was the spec archived\?\)/);
  assert.ok(!fs.existsSync(path.join(t.repo, ".pi/pb/review-run.json"))); // migrated, then cleared as dead
  const runs = path.join(t.repo, ".pi/pb/review-runs");
  assert.deepEqual(fs.existsSync(runs) ? fs.readdirSync(runs) : [], []);
});

test("review: starting a new review clears an abandoned run from this session", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  process.chdir(t.repo);
  const { Store } = await import("../extensions/pb/store.ts");
  const store = new Store(t.repo);
  const home = t.runtime().ctx.sessionManager.getSessionFile();
  // A crash mid-review leaves a run with no interrupted marker: /pb:review can't offer it.
  store.saveReviewRun({ id: "crashed-run", cwd: t.repo, label: "crashed", brief: "", followUp: false, passes: [], home });
  await t.run("review");
  assert.equal(store.reviewRun("crashed-run"), undefined);
  assert.match(t.posts.at(-1)!, /Review — order-cancellation\*\* · PASS/);
});

test("review: pb runs the build's final checks and each finished task's Test: — a red one caps the verdict at UNVERIFIED", async () => {
  const t = setup({ verify: "true", lint: "test -d ." });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  fs.rmSync(path.join(t.repo, "T2.txt")); // T2's own proof no longer holds
  await t.run("review"); // the stand-in reviewer reports nothing wrong and every criterion met
  const brief = briefOf(t);
  // The same checks as the build's final step, lint included, then each task's Test: as evidence to cite.
  assert.match(brief, /## The checks the harness ran\n\n`true` → PASS[\s\S]*`test -d \.` → PASS[\s\S]*T1's Test: `test -f T1\.txt` → PASS[\s\S]*T2's Test: `test -f T2\.txt` → FAIL/);
  assert.match(brief, /A passing run of a task's Test: command is evidence you can cite for an acceptance line/);
  const result = t.posts.at(-1)!;
  assert.match(result, /\*\*⚠ Review — order-cancellation\*\* · UNVERIFIED/, "the reviewers found nothing, but pb's own run is red");
  assert.match(result, /⚠ \*\*pb's check failed before the review\*\*: `test -f T2\.txt` — a review never passes over a red check\./);
  assert.match(result, /\*\*Next:\*\* make `test -f T2\.txt` pass \(or fix what keeps it from running\), then `\/pb:review` again\./);
  assert.equal(t.progress("order-cancellation").phase, "built", "not marked reviewed");
});

test("review: when the second look can't run, the findings are reported unconfirmed", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  t.reviewer.review = CHANGES;
  process.env.MOCK_VERIFY = "crash"; // the verifier itself blows up
  try {
    await t.run("review");
  } finally {
    delete process.env.MOCK_VERIFY;
  }
  assert.match(t.posts.at(-1)!, /CHANGES NEEDED/); // the P1 stands: failure to verify never dismisses
  assert.match(t.posts.at(-1)!, /The second look at the blocking findings couldn't run \(verifier exploded\): they are reported unconfirmed\./);
});

test("review: a fresh review session with the spec first and the diff; you're brought back with the result", async () => {
  const t = setup({ verify: "true", reviewer: { security: "always" } });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  const home = t.runtime().ctx.sessionManager.getSessionFile();
  await t.run("review");
  const brief = briefOf(t);
  assert.match(brief, /^\[pb:review\] You are an independent REVIEWER in a fresh session[\s\S]*read-only: don't edit or write files[\s\S]*--- brief ---\n\n# The spec \(\.pi\/pb\/specs\/order-cancellation\/spec\.md\)[\s\S]*## Acceptance checklist[\s\S]*## Changed files\n\n(T1\.txt\n)?[\s\S]*T2\.txt/);
  assert.match(brief, /## The checks the harness ran\n\n`true` → PASS/);
  // The reviewer has no shell: the change travels in the brief as a frozen diff, untracked files included.
  assert.match(brief, /## The diff\n\n[\s\S]*\+x/);
  assert.doesNotMatch(brief, /Run: git diff/);
  assert.match(brief, /The diff below is from that commit to the tree the review started on\. Read files with read\/grep\/find\/ls/);
  assert.ok([...t.names.values()].includes("review: order-cancellation · spec"));
  assert.ok(![...t.names.values()].some((n) => n.endsWith("· adversarial"))); // the abuse pass is a background process
  assert.equal(t.runtime().ctx.sessionManager.getSessionFile(), home); // back where you were
  assert.match(t.posts.at(-1)!, /Review — order-cancellation\*\* · PASS[\s\S]*Acceptance: all met\.[\s\S]*1\. \[P2\] src\/order\.ts:30 — name the constant\n\[P3\] src\/order\.ts:12 — consider a guard clause\n   Fix: return early[\s\S]*The review sessions: spec `pi --session build-session-\d+` · adversarial `pi --session [^`]+`/);
  assert.equal(t.progress("order-cancellation").phase, "reviewed");
  assert.equal(t.progress("order-cancellation").reviewUnshown, undefined);
  assert.match(t.read(".pi/pb/specs/order-cancellation/review.md"), /Review — order-cancellation\*\* · PASS/); // kept with the spec

  await t.run("review");
  assert.match(t.notes.at(-1)!, /Nothing changed since the last review \(pass\)/);
  t.reviewer.review = CHANGES;
  await t.run("review", "--full");
  assert.match(t.posts.at(-1)!, /CHANGES NEEDED/);
});

test("review: the review session is read-only; a pass you leave can be continued", async () => {
  const t = setup({ verify: "true", reviewer: { security: "always" } });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  const home = t.runtime().ctx.sessionManager.getSessionFile();
  t.reviewer.script = true; // drive the review session by hand
  let blocked: string | undefined;
  t.agent.script = async (text, tool) => {
    if (text.startsWith("[pb:review]")) {
      assert.deepEqual(t.runtime().pi.getActiveTools(), ["read", "grep", "find", "ls", "pb_report_findings"]);
      blocked = (await tool("write", { path: "x.ts", content: "x" })).error;
      // You go elsewhere mid-pass (like /resume): the review can't take you back; its result waits in review.md.
      await t.runtime().ctx.switchSession(home);
      return;
    }
  };
  await t.run("review");
  assert.match(blocked!, /This is a review session: read-only/);
  assert.equal(t.runtime().ctx.sessionManager.getSessionFile(), home); // you went home by yourself
  const md = t.read(".pi/pb/specs/order-cancellation/review.md");
  assert.match(md, /UNVERIFIED[\s\S]*You left the review before it finished: this is what had been reported[\s\S]*`\/pb:review` continues it/);

  // /pb:review offers to continue: back into the review session, which carries on where it was; the
  // adversarial pass then runs in the background and its findings are merged.
  process.env.MOCK_ABUSE_FINDINGS = JSON.stringify([{ priority: "P2", file: "src/order.ts", line: 3, title: "cap the page size" }]);
  t.reviewer.script = false;
  try {
    await t.run("review");
  } finally {
    delete process.env.MOCK_ABUSE_FINDINGS;
  }
  assert.match(t.selectTitles.at(-1)!, /A review was interrupted/);
  assert.ok(t.instructions.some((i) => i.startsWith("[pb] You were interrupted. Carry on where you were")));
  assert.ok(!t.notes.some((n) => /This review was interrupted/.test(n))); // pb was continuing it: no hint needed
  assert.equal(t.runtime().ctx.sessionManager.getSessionFile(), home); // and back home at the end
  assert.match(t.posts.at(-1)!, /PASS · P0 0 · P1 0 · P2 2 · P3 1 · with an adversarial pass[\s\S]*Adversarial: cap the page size/);
  assert.equal(JSON.parse(t.read(".pi/pb/config.json")).maxAttempts, 2);
  const runs = path.join(t.repo, ".pi/pb/review-runs");
  assert.deepEqual(fs.existsSync(runs) ? fs.readdirSync(runs) : [], []); // finished: nothing left to continue
});

test("review: the review session is gated (reporting tool present, editing blocked)", async () => {
  const t = setup({ verify: "true", reviewer: { security: "always" } });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  const gated: string[][] = [];
  const blocked: (string | undefined)[] = [];
  t.reviewer.script = true; // drive the review session by hand
  t.agent.script = async (text, tool) => {
    if (text.startsWith("[pb:review]")) {
      gated.push(t.runtime().pi.getActiveTools());
      blocked.push((await tool("write", { path: "x.ts", content: "x" })).error);
      // The allowlist itself is the guard: a tool that is not on it is blocked even when it is
      // neither edit nor write (a late-connecting MCP server's tool, say), not just left to
      // Pi's active-tool state.
      blocked.push((await tool("bash", { command: "echo hi" })).error);
      await tool("pb_report_findings", { findings: [], acceptance: acceptanceOf(text) });
      return;
    }
    return diligent(text, tool);
  };
  await t.run("review");
  // Without the reporting tool a pass degrades to unparseable prose and its findings are lost.
  // No shell either: the reviewer reads the frozen diff and the tree, so it cannot act on what it judges.
  assert.deepEqual(gated, [["read", "grep", "find", "ls", "pb_report_findings"]]);
  assert.match(blocked[0]!, /This is a review session: read-only/);
  assert.match(blocked[1]!, /This is a review session: read-only/);
});

test("review: reopening an interrupted review session, /pb:review continue picks it up there", async () => {
  const t = setup({ verify: "true", reviewer: { security: "always" } });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  const home = t.runtime().ctx.sessionManager.getSessionFile();
  let reviewSession = "";
  t.reviewer.script = true;
  t.agent.script = async (text, tool) => {
    if (text.startsWith("[pb:review]")) {
      reviewSession = t.runtime().ctx.sessionManager.getSessionFile();
      await t.runtime().ctx.switchSession(home); // you leave mid-review
      return;
    }
    return diligent(text, tool);
  };
  await t.run("review");
  await t.runtime().ctx.switchSession(reviewSession); // later, /resume into it
  assert.match(t.notes.at(-1)!, /This review was interrupted: `\/pb:review continue` picks it up/);
  t.reviewer.script = false;
  await t.run("review", "continue");
  assert.equal(t.runtime().ctx.sessionManager.getSessionFile(), home);
  assert.match(t.posts.at(-1)!, /Review — order-cancellation\*\* · PASS[\s\S]*with an adversarial pass/);
});

test("review: an adversarial pass that fails is named, and the result is not recorded as complete", async () => {
  const t = setup({ verify: "true", reviewer: { security: "always" } });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  process.env.MOCK_ABUSE = "crash";
  try {
    await t.run("review");
  } finally {
    delete process.env.MOCK_ABUSE;
  }
  assert.match(t.posts.at(-1)!, /⚠ The adversarial pass failed \(abuse pass exploded\): its findings are missing, so this result is incomplete\. Run `\/pb:review` again\./);
  assert.doesNotMatch(t.posts.at(-1)!, /with an adversarial pass/);
  assert.ok(!t.progress("order-cancellation").review); // incomplete: nothing recorded as reviewed

  await t.run("review"); // the next one completes
  assert.match(t.posts.at(-1)!, /PASS · [\s\S]*with an adversarial pass/);
  assert.ok(t.progress("order-cancellation").review);
});

test("review: an incomplete review does not offer /pb:fix ids it never recorded", async () => {
  const t = setup({ verify: "true", reviewer: { security: "always" } });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  t.reviewer.review = [{ priority: "P1", file: "src/order.ts", line: 12, title: "the check is skipped", fix: "run it" }];
  process.env.MOCK_ABUSE = "crash";
  try {
    await t.run("review");
  } finally {
    delete process.env.MOCK_ABUSE;
  }
  const post = t.posts.at(-1)!;
  assert.match(post, /incomplete/);
  assert.doesNotMatch(post, /`\/pb:fix` \d/); // the displayed numbers resolve against the OLD (or no) recorded list
  assert.match(post, /this result is incomplete, so `\/pb:fix` does not see these findings yet/);
  assert.ok(!t.progress("order-cancellation").review);
  await t.run("fix", "1"); // the human tries the number anyway: there is genuinely nothing to fix
  assert.match(t.notes.at(-1)!, /no open review findings/);
});

test("review: the adversarial pass runs in the background and its findings are merged", async () => {
  const t = setup({ verify: "true", reviewer: { security: "always" } });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  const argsOut = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pb-args-")), "args.txt");
  process.env.MOCK_ABUSE_FINDINGS = JSON.stringify([{ priority: "P2", file: "src/order.ts", line: 3, title: "a forged owner cancels" }]);
  process.env.MOCK_ABUSE_ARGS_OUT = argsOut;
  try {
    await t.run("review");
  } finally {
    delete process.env.MOCK_ABUSE_FINDINGS;
    delete process.env.MOCK_ABUSE_ARGS_OUT;
  }
  assert.ok(!t.selectTitles.some((x) => /adversarial pass/.test(x)), "the pass is not asked for: it just runs");
  assert.ok(![...t.names.values()].some((n) => n.endsWith("· adversarial"))); // no session of its own
  // Read-only like the reviewer, and named its reporting tool: --tools is the whole selection,
  // extension tools included, so an unnamed tool is never declared to the model. The user's MCP
  // servers stay out too: they would be spawned (and their tools kept) inside the pass otherwise.
  const argv = fs.readFileSync(argsOut, "utf8").split("\n");
  assert.equal(argv[argv.indexOf("--tools") + 1], "read,grep,find,ls,report_findings");
  assert.ok(!argv.includes("bash"));
  assert.ok(argv.includes("--no-mcp"));
  assert.match(t.posts.at(-1)!, /with an adversarial pass[\s\S]*Adversarial: a forged owner cancels/);
});

test("review: an adversarial empty report with a long explanation is not a lost report", async () => {
  const t = setup({ verify: "true", reviewer: { security: "always" } });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  t.reviewer.review = [{ priority: "P2", file: "src/order.ts", line: 30, title: "name the constant" }];
  process.env.MOCK_ABUSE_PROSE = `No attacks found: I tried forged owners, replayed requests and reordered calls. `.repeat(12);
  try {
    await t.run("review");
  } finally {
    delete process.env.MOCK_ABUSE_PROSE;
  }
  const post = t.posts.at(-1)!;
  assert.match(post, /with an adversarial pass/);
  assert.doesNotMatch(post, /adversarial pass[\s\S]*reported in prose only/);
  assert.doesNotMatch(post, /NO VERDICT/);
});

test("review: compaction resets to role, brief, findings and files read; stalls wrap up", async () => {
  const t = setup();
  process.chdir(t.repo);
  const { Store } = await import("../extensions/pb/store.ts");
  const store = new Store(t.repo);
  const session = t.runtime().ctx.sessionManager.getSessionFile();
  store.saveReviewSession(session, {
    role: "review",
    spec: "order-cancellation",
    run: "run-1",
    findings: [{ priority: "P2", title: "name it" }],
    acceptance: [{ criterion: "T1.1", status: "met", evidence: "src/order.ts:1" }],
  });
  store.saveReviewRun({ id: "run-1", cwd: t.repo, label: "order-cancellation", brief: "BRIEF", followUp: false, passes: [] });
  const prep = (reads: string[], tokens: number) => ({ firstKeptEntryId: "e1", tokensBefore: tokens, fileOps: { read: new Set(reads), edited: new Set(), written: new Set() } });
  const [r1] = (await t.fire("session_before_compact", { preparation: prep(["a.ts", "b.ts"], 50000), reason: "threshold" })) as any[];
  assert.match(
    r1.compaction.summary,
    /\[pb review state: order-cancellation\] This review session was compacted[\s\S]*Files read before this point[\s\S]*- a\.ts[\s\S]*--- acceptance so far ---[\s\S]*T1\.1: met — src\/order\.ts:1[\s\S]*--- brief ---[\s\S]*BRIEF[\s\S]*--- findings so far ---[\s\S]*name it/,
  );
  assert.doesNotMatch(r1.compaction.summary, /report findings with what you have/);
  // Same reads at the same size three more times: the fourth wraps up instead of circling.
  await t.fire("session_before_compact", { preparation: prep(["a.ts", "b.ts"], 50000), reason: "threshold" });
  await t.fire("session_before_compact", { preparation: prep(["a.ts", "b.ts"], 50000), reason: "threshold" });
  const [r4] = (await t.fire("session_before_compact", { preparation: prep(["a.ts", "b.ts"], 50000), reason: "threshold" })) as any[];
  assert.match(r4.compaction.summary, /report findings with what you have and stop/);
  // New reads reset the count.
  const [r5] = (await t.fire("session_before_compact", { preparation: prep(["a.ts", "b.ts", "c.ts"], 50000), reason: "threshold" })) as any[];
  assert.doesNotMatch(r5.compaction.summary, /report findings with what you have/);
});

test("review: findings reported between compactions count as progress, so writing is not mistaken for circling", async () => {
  const t = setup();
  process.chdir(t.repo);
  const { Store } = await import("../extensions/pb/store.ts");
  const store = new Store(t.repo);
  const session = t.runtime().ctx.sessionManager.getSessionFile();
  store.saveReviewRun({ id: "run-1", cwd: t.repo, label: "order-cancellation", brief: "BRIEF", followUp: false, passes: [] });
  // The files read and the size stay the same; the only thing moving is the findings list, which is
  // exactly what a review does once reading is done.
  const prep = { firstKeptEntryId: "e1", tokensBefore: 50000, fileOps: { read: new Set(["a.ts"]), edited: new Set(), written: new Set() } };
  let r: any;
  for (let i = 0; i < 4; i++) {
    store.saveReviewSession(session, {
      role: "review",
      spec: "order-cancellation",
      run: "run-1",
      findings: Array.from({ length: i + 1 }, (_, n) => ({ priority: "P2", title: `finding ${n}` })),
    });
    [r] = (await t.fire("session_before_compact", { preparation: prep, reason: "threshold" })) as any[];
  }
  assert.doesNotMatch(r.compaction.summary, /report findings with what you have/);
});

test("review: acceptance results reported between compactions count as progress", async () => {
  const t = setup();
  process.chdir(t.repo);
  const { Store } = await import("../extensions/pb/store.ts");
  const store = new Store(t.repo);
  const session = t.runtime().ctx.sessionManager.getSessionFile();
  store.saveReviewRun({ id: "run-1", cwd: t.repo, label: "order-cancellation", brief: "BRIEF", followUp: false, passes: [] });
  // Reads and size stay fixed; only the acceptance checklist advances, as it does once checking starts.
  const prep = { firstKeptEntryId: "e1", tokensBefore: 50000, fileOps: { read: new Set(["a.ts"]), edited: new Set(), written: new Set() } };
  let r: any;
  for (let i = 0; i < 4; i++) {
    store.saveReviewSession(session, {
      role: "review",
      spec: "order-cancellation",
      run: "run-1",
      findings: [],
      acceptance: Array.from({ length: i + 1 }, (_, n) => ({ criterion: `T1.${n + 1}`, status: "met", evidence: "checked" })),
    });
    [r] = (await t.fire("session_before_compact", { preparation: prep, reason: "threshold" })) as any[];
  }
  assert.doesNotMatch(r.compaction.summary, /report findings with what you have/);
});

test("review: a stall from an earlier run never marks a later review of the same spec", async () => {
  const t = setup({ verify: "true", reviewer: { security: "off" } });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  // An earlier review of this spec wrapped up early; its event stays in the spec's history for good.
  fs.appendFileSync(
    path.join(t.repo, ".pi/pb/specs/order-cancellation/events.jsonl"),
    `${JSON.stringify({ at: "2026-01-01 00:00:00", type: "compact", thrash: true, run: "an-earlier-review-run" })}\n`,
  );
  await t.run("review");
  assert.match(t.posts.at(-1)!, /\*\*✅ Review — order-cancellation\*\* · PASS/);
  assert.doesNotMatch(t.posts.at(-1)!, /wrapped up early/);
});

test("review: a stall in this very run is still reported in its result", async () => {
  const t = setup({ verify: "true", reviewer: { security: "off" } });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  const { Store } = await import("../extensions/pb/store.ts");
  t.reviewer.script = true; // drive the review session by hand
  t.agent.script = async (text, tool) => {
    if (text.startsWith("[pb:review]")) {
      const run = new Store(t.repo).reviewRunForSession(t.runtime().ctx.sessionManager.getSessionFile())!;
      assert.ok(run.id); // every run carries the id its compact events are stamped with
      fs.appendFileSync(
        path.join(t.repo, ".pi/pb/specs/order-cancellation/events.jsonl"),
        `${JSON.stringify({ at: "now", type: "compact", thrash: true, run: run.id })}\n`,
      );
      await tool("pb_report_findings", { findings: [], acceptance: acceptanceOf(text) });
      return;
    }
    return diligent(text, tool);
  };
  await t.run("review");
  assert.match(t.posts.at(-1)!, /PASS[\s\S]*wrapped up early/);
});

test("review: a follow-up looks at the previous findings and what changed since", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  t.reviewer.review = CHANGES;
  await t.run("review");
  fs.writeFileSync(path.join(t.repo, "T1.txt"), "fixed");
  t.reviewer.review = [];
  await t.run("review");
  assert.match(briefOf(t), /## This is a follow-up review[\s\S]*1\. \[P1\] src\/order\.ts:12 — consider a guard clause[\s\S]*Changed since the previous review[\s\S]*T1\.txt/);
  assert.match(t.posts.at(-1)!, /Review — order-cancellation \(follow-up\)\*\* · PASS/);
});

test("review: the follow-up brief carries only fix reports from after the review it follows up", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  t.reviewer.review = CHANGES;
  await t.run("review");
  // A fix report stamped in the same second as the review but appended before its event is not
  // the follow-up's evidence; one appended after it is. Event order, not clock comparison.
  const reviewAt = "2026-10-01 10:00:00";
  const events = (t.events("order-cancellation") as Record<string, unknown>[]).map((e) => (e.type === "review" ? { ...e, at: reviewAt } : e));
  const reviewIndex = events.findIndex((e) => e.type === "review");
  events.splice(reviewIndex, 0, { at: reviewAt, type: "fix", fixed: ["early report"], skipped: [], tests: "ok" });
  events.push({ at: "2026-10-01 10:00:05", type: "fix", fixed: ["late report"], skipped: [], tests: "ok" });
  fs.writeFileSync(path.join(t.repo, ".pi/pb/specs/order-cancellation/events.jsonl"), `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);
  const p = t.progress("order-cancellation");
  p.review.at = reviewAt;
  fs.writeFileSync(path.join(t.repo, ".pi/pb/specs/order-cancellation/progress.json"), JSON.stringify(p));
  fs.writeFileSync(path.join(t.repo, "T1.txt"), "fixed");
  t.reviewer.review = [];
  await t.run("review");
  assert.match(briefOf(t), /## What the fix laps reported[\s\S]*Lap 1 fixed: late report/);
  assert.doesNotMatch(briefOf(t), /early report/);
});

test("review: an omitted or unverified acceptance item never passes; the next review carries it", async () => {
  const t = setup({ verify: "true", reviewer: { security: "off" } });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  t.reviewer.acceptance = [
    { criterion: "T1.1", status: "not verified", evidence: "the named test was not run" },
  ]; // T2.1 omitted on purpose
  await t.run("review");
  const post = t.posts.at(-1)!;
  assert.match(post, /UNVERIFIED/);
  assert.match(post, /\*\*Acceptance\*\* — 0\/2 met, 2 not verified/);
  assert.match(post, /\? not verified T1\.1: T1\.txt exists — the named test was not run/);
  assert.match(post, /\? not verified \(not reported\) T2\.1: T2\.txt exists/);
  assert.match(post, /A missing or unchecked criterion is never a pass/);
  const first = t.progress("order-cancellation");
  assert.equal(first.phase, "built");
  assert.equal(first.review.verdict, "unverified");
  assert.deepEqual(
    first.review.acceptance.map((a: { criterion: string; status: string }) => [a.criterion, a.status]),
    [
      ["T1.1", "not verified"],
      ["T2.1", "not verified"],
    ],
  );

  fs.writeFileSync(path.join(t.repo, "T1.txt"), "fixed");
  delete t.reviewer.acceptance; // the next pass reports every id automatically
  await t.run("review");
  assert.match(
    briefOf(t),
    /Acceptance at the previous review[\s\S]*T1\.1: not verified — the named test was not run[\s\S]*T2\.1: not verified — not reported/,
  );
  assert.match(t.posts.at(-1)!, /PASS[\s\S]*\*\*Acceptance\*\* — 2\/2 met/);
  assert.equal(t.progress("order-cancellation").phase, "reviewed");
});

test("review: findings carry priorities; P0/P1 are double-checked; only line-leading tags count in prose", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  t.reviewer.review = CHANGES;
  await t.run("review");
  assert.match(t.posts.at(-1)!, /CHANGES NEEDED · P0 0 · P1 1 · P2 1 · P3 0(?: · with an adversarial pass)? · (?:<1s|\d+s)\n/);
  assert.match(t.posts.at(-1)!, /\*\*Next:\*\* `\/pb:fix 1 2` \(or fix them by hand\), then `\/pb:review` again/);
  const review = t.events("order-cancellation").filter((e: any) => e.type === "review").at(-1);
  assert.equal(typeof review.ms, "number");
  assert.ok(review.ms > 0);
  process.env.MOCK_VERIFY = "reject"; // the verifier finds the P1 isn't real
  await t.run("review", "--full");
  delete process.env.MOCK_VERIFY;
  assert.match(t.posts.at(-1)!, /PASS · P0 0 · P1 0 · P2 1 · P3 0[\s\S]*Dismissed after a second look:\n- \[P1\] consider a guard clause — src\/order\.ts:11 already guards it/);
  t.reviewer.silent = true; // no tool call: the prose's line-leading tags are the findings
  t.reviewer.prose = "No [P0] or [P1] issues found.\n\n1. [P2] src/order.ts:30 — name the constant.";
  await t.run("review", "--full");
  // "No [P0] or [P1] issues" isn't a finding; with no acceptance tool report, silence is unverified, not pass.
  assert.match(t.posts.at(-1)!, /UNVERIFIED · P0 0 · P1 0 · P2 1 · P3 0/);
});

test("review: the second look reads the same frozen diff, with no shell to re-derive it", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  t.reviewer.review = CHANGES; // a P1: the verifier is asked
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pb-verify-")), "brief.md");
  process.env.MOCK_VERIFIER_BRIEF_OUT = out;
  try {
    await t.run("review");
  } finally {
    delete process.env.MOCK_VERIFIER_BRIEF_OUT;
  }
  const brief = fs.readFileSync(out, "utf8");
  assert.match(brief, /^# Findings to verify[\s\S]*# The change\n\n(Base commit: [0-9a-f]+\. )?The diff below is from (that commit|HEAD) to the tree the review started on\./);
  assert.match(brief, /\n\+x/); // an untracked file's content is in the diff, not behind a git command
  assert.doesNotMatch(brief, /git diff/);
});

test("review findings: display numbers run continuously across the change and outside it, and are the /pb:fix ids", async () => {
  const t = setup({ verify: "true", reviewer: { security: "off" } });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  t.reviewer.review = [
    { priority: "P2", file: "src/order.ts", line: 30, title: "in the change", fix: "x" },
    { priority: "P3", file: "src/order.ts", line: 12, title: "nit", fix: "y" },
    { priority: "P1", file: "src/legacy.ts", line: 1, title: "outside the change", fix: "z", outside: true },
  ];
  await t.run("review");
  const post = t.posts.at(-1)!;
  assert.match(post, /1\. \[P2\] src\/order\.ts:30 — in the change/);
  assert.match(post, /\n\[P3\] src\/order\.ts:12 — nit/); // nits are never numbered
  assert.match(post, /2\. \[P1 · Outside the change\] src\/legacy\.ts:1 — outside the change/);
  assert.match(post, /\*\*Next:\*\* `\/pb:fix 1 2`/);
  // The ids /pb:fix reads are the stored review findings, in the same display order.
  assert.deepEqual(t.progress("order-cancellation").review.findings.map((f: { title: string }) => f.title), ["in the change", "outside the change"]);
});

test("review: a pre-existing problem gets its own outside class instead of a prose note", async () => {
  const t = setup({ verify: "true", reviewer: { security: "off" } });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  t.reviewer.review = [{ priority: "P2", file: "src/order.ts", line: 30, title: "the legacy path still trusts the raw header", fix: "classify once and pass the result", outside: true }];
  t.reviewer.prose = "Worth knowing: the legacy path predates this change.";
  await t.run("review");
  const post = t.posts.at(-1)!;
  assert.match(post, /\*\*✅ Review — order-cancellation\*\* · PASS/); // an outside finding is advisory, even when it is the only one
  assert.match(post, /\*\*Outside the change\*\* — pre-existing, not caused by this revision[\s\S]*\[P2 · Outside the change\].*legacy path/);
  assert.doesNotMatch(post, /\*\*Findings\*\*/); // its own section, not mixed into the change's findings
  const saved = t.progress("order-cancellation").review.findings;
  assert.deepEqual(
    saved.map((f: { title: string; outside?: boolean; priority: string }) => [f.title, f.outside, f.priority]),
    [["the legacy path still trusts the raw header", true, "P2"]],
  );
});

test("review: a finding's class reaches every later rendering, not only its first report", async () => {
  const { findingLine, verifierBrief, VERIFIER_SYSTEM } = await import("../extensions/pb/prompts.ts");
  const finding = { priority: "P2" as const, file: "src/order.ts", line: 30, title: "the legacy path still trusts the raw header", fix: "classify once", outside: true };
  assert.match(findingLine(finding, 1), /^1\. \[P2 · Outside the change\] src\/order\.ts:30 — the legacy path still trusts the raw header/);
  assert.match(verifierBrief([finding], "abc"), /\[P2 · Outside the change\] src\/order\.ts:30/);
  assert.match(VERIFIER_SYSTEM, /Never reject a finding for being outside/);
});

test("review ledger: P0–P2 findings dedupe by place and title, count repeats, and cap; P3 stays out", async () => {
  const { reviewLedger, REVIEW_FINDINGS_CAP } = await import("../extensions/pb/store.ts");
  const ledger = reviewLedger([
    {
      type: "review-findings",
      at: "2026-01-01T00:00:00.000Z",
      findings: [
        { priority: "P2", file: "src/a.ts", line: 3, title: "Name\nit", fix: "rename", outside: true },
        { priority: "P3", file: "src/b.ts", line: 4, title: "a nit" },
      ],
    },
    {
      type: "review-findings",
      at: "2026-01-02T00:00:00.000Z",
      findings: [
        { priority: "P1", file: "src/a.ts", line: 3, title: "name it", fix: "rename it" },
        { priority: "P0", file: "src/c.ts", title: "guard the write" },
      ],
    },
  ]);
  assert.deepEqual(ledger.map((f) => [f.priority, f.file, f.line, f.title, f.count, f.outside]), [
    ["P0", "src/c.ts", undefined, "guard the write", 1, undefined],
    ["P1", "src/a.ts", 3, "Name it", 2, undefined], // an inside report wins over an earlier outside one
  ]);
  assert.equal(ledger[1].fix, "rename it");

  const many = Array.from({ length: REVIEW_FINDINGS_CAP + 5 }, (_, i) => ({ priority: "P2", file: `src/f${i}.ts`, title: `finding ${i}` }));
  assert.equal(reviewLedger([{ type: "review-findings", at: "2026-01-01T00:00:00.000Z", findings: many }]).length, REVIEW_FINDINGS_CAP);
});

test("review ledger: an injected marker cannot reach the project map", async () => {
  const { reviewLedger, UNTITLED_FINDING, LEDGER_FILE_CHARS, LEDGER_TITLE_CHARS, LEDGER_FIX_CHARS } = await import("../extensions/pb/store.ts");
  const { writeMap, readMap } = await import("../extensions/pb/map.ts");

  // Read back: what an event written before this change already carries comes out markup-free.
  const ledger = reviewLedger([{ type: "review-findings", at: "2026-01-01T00:00:00.000Z", findings: [INJECTED] }]);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].file, "src/order.ts");
  assert.equal(ledger[0].fix, "close it yourself");
  assert.ok(!/<!--|-->/.test(JSON.stringify(ledger)), JSON.stringify(ledger));
  assert.ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(JSON.stringify(ledger)), JSON.stringify(ledger));
  // A finding whose title is nothing but markup is still a lead: it keeps a placeholder, never vanishes.
  assert.deepEqual(
    reviewLedger([{ type: "review-findings", at: "2026-01-01T00:00:00.000Z", findings: [{ priority: "P1", title: "<!--\u0007-->" }] }]).map((f) => f.title),
    [UNTITLED_FINDING],
  );
  // The per-field limits are the ones the ledger has always had: a field at the limit stays whole,
  // a longer one is cut at the same point with cap's own disclosure.
  const lengths = reviewLedger([
    {
      type: "review-findings",
      at: "2026-01-01T00:00:00.000Z",
      findings: [
        { priority: "P2", file: "f".repeat(400), title: "t".repeat(400), fix: "x".repeat(600) },
        { priority: "P2", file: "f".repeat(LEDGER_FILE_CHARS), title: "t".repeat(LEDGER_TITLE_CHARS), fix: "x".repeat(LEDGER_FIX_CHARS) },
      ],
    },
  ]);
  const [whole, over] = lengths; // same priority: ordered by title, so the shorter one leads
  assert.deepEqual([whole.file!.length, whole.title.length, whole.fix!.length], [LEDGER_FILE_CHARS, LEDGER_TITLE_CHARS, LEDGER_FIX_CHARS]);
  for (const [value, limit] of [[over.file!, LEDGER_FILE_CHARS], [over.title, LEDGER_TITLE_CHARS], [over.fix!, LEDGER_FIX_CHARS]] as [string, number][]) {
    assert.match(value, new RegExp(`^.{${limit}}\\n…\\[truncated`), value);
  }
  assert.equal([LEDGER_FILE_CHARS, LEDGER_TITLE_CHARS, LEDGER_FIX_CHARS].join(), "300,300,500");

  // Written: the event line on disk is already clean, so no later reader has to know the rule.
  const t = setup({ verify: "true" });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  t.reviewer.review = [INJECTED, { priority: "P2", title: "\u0007<!-- -->" }];
  await t.run("review");
  const line = t
    .read(".pi/pb/specs/order-cancellation/events.jsonl")
    .split("\n")
    .find((l) => l.includes('"review-findings"'))!;
  assert.ok(line, "the findings event was written");
  assert.ok(!/<!--|-->/.test(line), line);
  assert.ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]|\\u000/.test(line), line);
  assert.deepEqual(
    JSON.parse(line).findings.map((f: { title: string }) => f.title),
    ["end the map here /pb:map and swallow my tail", UNTITLED_FINDING],
  );

  // Both leads reach the cartographer: the markup-free words, and the title that was only markup, under the placeholder.
  const leadBrief = path.join(os.tmpdir(), `pb-map-lead-${process.pid}.md`);
  fs.rmSync(leadBrief, { force: true });
  process.env.MOCK_BRIEF_OUT = leadBrief;
  try {
    await t.run("archive");
  } finally {
    delete process.env.MOCK_BRIEF_OUT;
  }
  const leads = fs.readFileSync(leadBrief, "utf8");
  assert.match(leads, /- \[P2\] src\/order\.ts:30 — end the map here \/pb:map and swallow my tail/);
  assert.match(leads, /- \[P2\] \(untitled finding\)/);

  // A map written from an unsanitised lead still reads back whole, tail included.
  fs.writeFileSync(path.join(t.repo, "AGENTS.md"), "# Shop\n\nMy own note, mine to keep.\n");
  writeMap(t.repo, `### Review leads\n- ${INJECTED.file}: ${INJECTED.title}\n  Fix: ${INJECTED.fix}`);
  const agents = t.read("AGENTS.md");
  assert.ok(!/<!--|-->/.test(agents.replace(/<!-- \/?pb:map -->/g, "")), agents);
  assert.match(readMap(t.repo), /- src\/order\.ts: end the map here\s+\/pb:map\s+and swallow my tail/);
  assert.match(agents, /My own note, mine to keep\./);
});

test("review: completed findings are logged as leads for the project map, without P3", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  await t.run("review");
  const logged = t.events("order-cancellation").filter((e: { type: string }) => e.type === "review-findings");
  assert.equal(logged.length, 1);
  assert.deepEqual(
    (logged[0] as { findings: Array<{ priority: string; file: string; line: number; title: string }> }).findings.map((f) => [f.priority, f.file, f.line, f.title]),
    [["P2", "src/order.ts", 30, "name the constant"]],
  );
});

test("review: an outside P2 is advisory, but a mislabeled P0/P1 still blocks", async () => {
  const { verdictOf } = await import("../extensions/pb/review.ts");
  assert.equal(verdictOf([{ priority: "P2", title: "pre-existing", outside: true }]), "pass");
  // The class is the reviewer's claim, never a way to wave a blocker through.
  assert.equal(verdictOf([{ priority: "P1", title: "pre-existing", outside: true }]), "changes_needed");
  assert.equal(verdictOf([{ priority: "P0", title: "pre-existing", outside: true }]), "changes_needed");
});

test("review: a prose-only pass gives no verdict and leaves the phase short of reviewed", async () => {
  const t = setup({ verify: "true", reviewer: { security: "off" } });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  t.reviewer.silent = true; // no pb_report_findings: a real report in a shape nothing can parse
  t.reviewer.prose = `P1 — the updated_at bump on in-place edits is silently lost: the scheduler sets the field on a detached entity, so the save never persists it.\n\nP2 — a DB failure between the landed post and the standing-set save orphans the set with no coordinate rows.\n\n${"Fix: persist the bump through the repository, not the entity. ".repeat(20)}`;
  await t.run("review");
  const post = t.posts.at(-1)!;
  assert.match(post, /NO VERDICT/);
  assert.doesNotMatch(post, /\*\*✅ Review/);
  assert.match(post, /there is no verdict/);
  assert.match(t.read(".pi/pb/specs/order-cancellation/review.md"), /NO VERDICT/);
  const p = t.progress("order-cancellation");
  assert.equal(p.phase, "built"); // not promoted to reviewed on a lost pass
  assert.equal(p.review.verdict, "none");
  // The post says to run /pb:review again: that must start a fresh pass, not short-circuit on
  // "nothing changed" and demand --full. A lost review is not a baseline to skip from, and it is
  // not a follow-up either: there are no trustworthy previous findings to carry.
  const reviews = t.instructions.filter((i) => i.startsWith("[pb:review]")).length;
  await t.run("review");
  assert.equal(t.instructions.filter((i) => i.startsWith("[pb:review]")).length, reviews + 1);
  assert.doesNotMatch(briefOf(t), /## This is a follow-up review/);
  assert.ok(!t.notes.some((n) => /Nothing changed since the last review/.test(n)));
});

test("review: an empty report with a long explanation is a pass, not a lost pass", async () => {
  const t = setup({ verify: "true", reviewer: { security: "off" } });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  t.reviewer.review = [];
  t.reviewer.prose = `No findings: the change matches the spec, the tests pass, and I found nothing to report. `.repeat(12);
  await t.run("review");
  const post = t.posts.at(-1)!;
  assert.match(post, /\*\*✅ Review — order-cancellation\*\* · PASS/);
  assert.doesNotMatch(post, /NO VERDICT|there is no verdict/);
  assert.equal(t.progress("order-cancellation").review.verdict, "pass");
});

test("review: offers once to run the reviewer on another model than the one that built the change", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  t.selects.push("p/big");
  await t.run("review");
  assert.ok(t.selectTitles.some((x) => /The reviewer runs on p\/m, which likely built this too/.test(x)));
  assert.equal(JSON.parse(t.read(".pi/pb/config.json")).reviewer.model, "p/big");
  assert.equal(JSON.parse(t.read(".pi/pb/config.json")).maxAttempts, 2); // the rest kept as written
  await t.run("review", "--full");
  assert.equal(t.selectTitles.filter((x) => /The reviewer runs on/.test(x)).length, 1); // asked once
});

test("review: works without a spec, on the uncommitted change and its intent", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  await t.run("review");
  assert.match(t.notes.at(-1)!, /Nothing to review: there are no uncommitted changes/);
  fs.writeFileSync(path.join(t.repo, "README"), "hello\n");
  await t.run("review", "greet more warmly");
  assert.match(briefOf(t), /--- brief ---\n\n# No spec[\s\S]*Intent: greet more warmly[\s\S]*## Changed files\n\nREADME/);
  assert.match(t.posts.at(-1)!, /Review — the uncommitted change\*\* · PASS/);
  assert.doesNotMatch(t.posts.at(-1)!, /Commit message/); // no spec to write it from
  // A path-like first word is intent text here, never refused: specDir's guard keeps it out of
  // paths, and the arg is documented as free text (only /pb:build refuses those).
  const before = t.posts.at(-1);
  await t.run("review", "src/README warm the greeting");
  assert.equal(t.notes.filter((n) => /isn't a valid spec name/.test(n)).length, 0);
  assert.notEqual(t.posts.at(-1), before); // a fresh result, not the previous review's
  assert.match(briefOf(t), /Intent: src\/README warm the greeting/); // the whole line went through as intent
});

test("review: a file edited while the review ran is reported, never reverted", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  t.reviewer.write = path.join(t.repo, "T1.txt"); // the human's (or another session's) edit, in the review's window
  await t.run("review");
  assert.equal(t.read("T1.txt"), "edited while the review ran");
  assert.match(t.posts.at(-1)!, /⚠ Files changed while the review ran \(left as they are — the reviewer can't write, so these are yours or another session's\): T1\.txt/);
});

test("review: a base commit that no longer resolves is said, not diffed as nothing", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  process.chdir(t.repo);
  const { Store } = await import("../extensions/pb/store.ts");
  const store = new Store(t.repo);
  const p = store.progress("order-cancellation")!;
  p.baseCommit = "0".repeat(40); // history rewritten or GC'd since the build
  store.saveProgress(p);
  await t.run("review");
  assert.match(t.notes.at(-1)!, /The build's base commit `0{40}` no longer resolves here/);
  assert.match(briefOf(t), /⚠ The build's base commit `0{40}` no longer resolves here/);
  assert.doesNotMatch(briefOf(t), /Base commit: 0{40}/); // never diff against a base that isn't there
});

test("review: untracked files over the snapshot cap are named, since no diff can show them", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  fs.writeFileSync(path.join(t.repo, "huge.bin"), Buffer.alloc(21 * 1024 * 1024));
  await t.run("review");
  assert.match(briefOf(t), /## Files too large to capture[\s\S]*- huge\.bin/);
  assert.match(t.posts.at(-1)!, /⚠ Untracked files over 20 MB are in no snapshot or diff \(read them yourself\): huge\.bin/);
});

test("review: a follow-up isn't 'nothing changed' when only a huge untracked file moved", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  await t.run("review");
  fs.writeFileSync(path.join(t.repo, "huge.bin"), Buffer.alloc(21 * 1024 * 1024));
  await t.run("review");
  assert.ok(!t.notes.some((n) => /Nothing changed since the last review/.test(n)));
  assert.match(briefOf(t), /## Files too large to capture[\s\S]*- huge\.bin/);
  assert.match(t.posts.at(-1)!, /⚠ Untracked files over 20 MB/);
});

test("stats: tasks, first try, checks, pauses, review, and the build session's tokens and cache", async () => {
  const t = setup({ taskChecks: "each",  verify: "true", reviewer: { security: "always" } });
  await written(t);
  let lazy = true;
  t.agent.script = async (text, tool) => {
    if (text.includes("Task T1") && lazy) {
      lazy = false;
      await tool("pb_tests_red", { task: "T1" });
      return void (await tool("pb_task_done", { task: "T1", status: "done", changed: "claimed", caveat: "none", rejected: "none", open: "none" }));
    }
    return diligent(text, tool);
  };
  await t.run("build");
  await t.run("review");
  await t.run("stats");
  const card = t.posts.at(-1)!;
  if (process.env.SHOW_STATS) console.log(card);
  assert.match(card, /Tasks +2 of 2 done · first try 1\/2 \(50%\) · 3 task checks · most: T1 \(2\)/);
  assert.match(card, /Checks +4 run, 1 failed/); // T1 ×2, T2, final
  assert.match(card, /Review +pass/);
  assert.match(card, /in [\d.]+k \(90% cached\)/);
  assert.match(card, /Context +peak 10\.0k \(10% of 100\.0k\)/);
  assert.match(card, /Reviewer +in 16\.0k · out 900/); // the reviewer's turn (10k/100) and the abuse pass's two (3k/400 each)
  assert.match(card, /Time +[^\n]*build [^·\n]+ · review (?:<1s|\d+s)/);

  await t.run("stats", "all");
  assert.match(t.posts.at(-1)!, /order-cancellation +2\/2 +50%/);
});

test("archive: a failed archive leaves the live spec's review guard state in place", async () => {
  const t = setup({ mapOnArchive: false, verify: "true" });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  await t.run("review"); // the reviewer session's read-only record now guards it
  fs.writeFileSync(path.join(t.repo, ".pi/pb-archive"), "a file where the archive root belongs"); // archive() will throw
  try {
    await t.run("archive");
  } finally {
    fs.rmSync(path.join(t.repo, ".pi/pb-archive"), { force: true });
  }
  assert.match(t.notes.at(-1)!, /Could not archive/);
  assert.ok(fs.existsSync(path.join(t.repo, ".pi/pb/specs/order-cancellation/spec.md"))); // still live
  const guards = fs.readdirSync(path.join(t.repo, ".pi/pb/reviews"));
  assert.ok(guards.length > 0, "the fail-closed review-session records must survive a failed archive");
});

test("review sessions are per-session files: two passes don't clobber, archive GCs by spec", async () => {
  const t = setup();
  process.chdir(t.repo);
  const { Store } = await import("../extensions/pb/store.ts");
  const s = new Store(t.repo);
  s.saveReviewSession("/s/r1.jsonl", { role: "review", spec: "a" });
  s.saveReviewSession("/s/r2.jsonl", { role: "abuse", spec: "a" }); // must not drop r1
  assert.equal(s.reviewSession("/s/r1.jsonl")?.role, "review");
  assert.equal(s.reviewSession("/s/r2.jsonl")?.role, "abuse");
  assert.ok(!fs.existsSync(path.join(t.repo, ".pi/pb/review-sessions.json"))); // no shared file to race on
  s.saveReviewSession("/s/r3.jsonl", { role: "review", spec: "b" });
  s.dropSessions("a");
  assert.equal(s.reviewSession("/s/r1.jsonl"), undefined);
  assert.equal(s.reviewSession("/s/r2.jsonl"), undefined);
  assert.equal(s.reviewSession("/s/r3.jsonl")?.spec, "b");
});

test("legacy review-sessions.json migrates to per-session files on first write", async () => {
  const t = setup();
  process.chdir(t.repo);
  const { Store } = await import("../extensions/pb/store.ts");
  fs.writeFileSync(path.join(t.repo, ".pi/pb/review-sessions.json"), JSON.stringify({ "/s/old.jsonl": { role: "review", spec: "a" } }));
  const s = new Store(t.repo);
  assert.equal(s.reviewSession("/s/old.jsonl")?.spec, "a"); // legacy still read
  s.saveReviewSession("/s/new.jsonl", { role: "abuse", spec: "b" });
  assert.equal(s.reviewSession("/s/old.jsonl")?.spec, "a");
  assert.equal(s.reviewSession("/s/new.jsonl")?.role, "abuse");
  assert.ok(!fs.existsSync(path.join(t.repo, ".pi/pb/review-sessions.json"))); // migrated away
});

test("review runs are per-run files: two reviews don't clobber, archive GCs by spec", async () => {
  const t = setup();
  process.chdir(t.repo);
  const { Store } = await import("../extensions/pb/store.ts");
  const s = new Store(t.repo);
  const run = (id: string, home: string, name?: string) => ({ id, cwd: t.repo, ...(name ? { name } : {}), label: id, brief: "BRIEF", followUp: false, passes: [], home, interrupted: { role: "review" as const, session: `/${id}.jsonl` } });
  s.saveReviewRun(run("run-a", "/home-a.jsonl", "a"));
  s.saveReviewRun(run("run-b", "/home-b.jsonl", "b")); // must not overwrite run-a
  assert.equal(s.reviewRun("run-a")?.label, "run-a");
  assert.equal(s.reviewRun("run-b")?.label, "run-b");
  assert.equal(s.interruptedReview("/home-a.jsonl")?.id, "run-a");
  assert.equal(s.interruptedReview("/home-b.jsonl")?.id, "run-b");
  assert.equal(s.reviewRunForSession("/run-b.jsonl")?.id, "run-b"); // its pass session finds its own run
  s.clearReviewRun("run-a"); // finishing one...
  assert.equal(s.reviewRun("run-a"), undefined);
  assert.equal(s.interruptedReview("/home-b.jsonl")?.id, "run-b"); // ...leaves the other to continue
  s.dropSessions("b"); // archiving the spec drops its dead runs
  assert.equal(s.reviewRun("run-b"), undefined);
});

test("review runs: a new review from the same session clears what it supersedes, and only that", async () => {
  const t = setup();
  process.chdir(t.repo);
  const { Store } = await import("../extensions/pb/store.ts");
  const s = new Store(t.repo);
  const run = (id: string, home: string) => ({ id, cwd: t.repo, label: id, brief: "", followUp: false, passes: [], home });
  s.saveReviewRun(run("crashed", "/home-a.jsonl")); // no interrupted marker: never offered again
  s.saveReviewRun(run("other", "/home-b.jsonl"));
  s.clearReviewRunsForHome("/home-a.jsonl");
  assert.equal(s.reviewRun("crashed"), undefined);
  assert.equal(s.reviewRun("other")?.id, "other"); // another session's review is untouched
});

test("legacy review-run.json migrates to its per-run file", async () => {
  const t = setup();
  process.chdir(t.repo);
  const { Store } = await import("../extensions/pb/store.ts");
  fs.writeFileSync(path.join(t.repo, ".pi/pb/review-run.json"), JSON.stringify({ id: "old-run", cwd: t.repo, label: "old", brief: "", followUp: false, passes: [], home: "/h.jsonl" }));
  const s = new Store(t.repo);
  assert.equal(s.reviewRun("old-run")?.label, "old");
  assert.ok(!fs.existsSync(path.join(t.repo, ".pi/pb/review-run.json"))); // migrated away
  assert.equal(s.interruptedReview("/h.jsonl"), undefined); // no interrupted pass recorded: nothing to offer
});

test("fresh runs preview what and where: pattern in path, full command capped", async () => {
  const { previewCall } = await import("../extensions/pb/runner.ts");
  assert.equal(previewCall({ pattern: "tradingview", path: "src/main/java" }), "tradingview in src/main/java");
  assert.equal(previewCall({ path: "src/order/Order.java" }), "src/order/Order.java");
  assert.equal(previewCall({ command: "cd /tmp && python3 probe.py" }), "cd /tmp && python3 probe.py");
  assert.equal(previewCall({ command: `x${"y".repeat(200)}` }), `x${"y".repeat(118)}…`);
  assert.equal(previewCall({ pattern: "*.java" }), "*.java");
});

test("map: completed review findings reach the cartographer as a separate lead section", async () => {
  const t = setup({ verify: "true" });
  const { writeMap } = await import("../extensions/pb/map.ts");
  writeMap(t.repo, "- `README`: readme");
  await written(t); // ## Context, no Findings; the build records no Design
  t.agent.script = diligent;
  await t.run("build");
  await t.run("review");
  const briefFile = path.join(os.tmpdir(), `pb-map-review-${process.pid}.md`);
  if (fs.existsSync(briefFile)) fs.rmSync(briefFile);
  process.env.MOCK_BRIEF_OUT = briefFile;
  try {
    await t.run("archive");
  } finally {
    delete process.env.MOCK_BRIEF_OUT;
  }
  const brief = fs.readFileSync(briefFile, "utf8");
  assert.match(brief, /# Review findings for order-cancellation \(leads, not evidence\)/);
  assert.match(brief, /\[P2\] src\/order\.ts:30 — name the constant/);
  assert.match(brief, /verify it against the code as it is now/);
  // The review findings alone made the map news: the spec has no Findings and no Design.
  assert.ok(t.notes.some((n) => /Updating the project map from order-cancellation/.test(n)));
});

test("map: review findings are leads the cartographer must verify against the code", async () => {
  const { CARTOGRAPHER_SYSTEM, cartographerBrief } = await import("../extensions/pb/map.ts");
  assert.match(CARTOGRAPHER_SYSTEM, /Review findings in a brief are leads, not evidence: check each against the code as it is now, and leave out one that no longer holds/);
  const brief = cartographerBrief({
    current: "- `README`: readme",
    spec: { name: "x", findings: "" },
    reviewFindings: [{ priority: "P1", file: "src/a.ts", line: 2, title: "guard the write", fix: "add the guard", count: 2, last: "2026-01-01T00:00:00.000Z" }],
  });
  assert.match(brief, /# Review findings for x \(leads, not evidence\)[\s\S]*\[P1\] src\/a\.ts:2 — guard the write \(reported 2 times\)\n  Fix: add the guard/);
});

test("reviewing planning changes without a snapshot warns instead of silently keeping", async () => {
  const t = setup({ checkpoints: false });
  process.chdir(t.repo);
  const { Store } = await import("../extensions/pb/store.ts");
  new Store(t.repo).markAsked("standards");
  await t.run("plan", "cancel orders");
  fs.writeFileSync(path.join(t.repo, "stray.txt"), "x");
  const before = t.notes.length;
  await t.run("plan", "off");
  assert.ok(t.notes.slice(before).some((n) => /Checkpoints are off.*can't list/.test(n)));
});

test("review: a task's Test: command is the proof; there is no marker mapping", async () => {
  const { REVIEWER_SYSTEM, taskPrompt } = await import("../extensions/pb/prompts.ts");
  const { parseSpec } = await import("../extensions/pb/spec.ts");
  assert.match(REVIEWER_SYSTEM, /The task's Test: command is the proof/);
  assert.doesNotMatch(REVIEWER_SYSTEM, /non-testable|faked mapping/);
  assert.match(REVIEWER_SYSTEM, /met with evidence/);
  assert.match(REVIEWER_SYSTEM, /an id you leave out is not verified/i);
  assert.match(REVIEWER_SYSTEM, /not met.*P1 finding/);
  const spec = parseSpec(SPEC()).spec!;
  assert.match(taskPrompt(spec.tasks[0], 1, 3, [], true), /then call pb_tests_red\. The harness runs `test -f T1\.txt` and needs it to fail/);
});

test("review: a contract edited after approval is refused until /pb:build re-approves", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  assert.equal(t.progress("order-cancellation").phase, "built");
  const specFile = path.join(t.repo, ".pi/pb/specs/order-cancellation/spec.md");
  fs.writeFileSync(specFile, fs.readFileSync(specFile, "utf8").replace("Cancel orders.", "Cancel orders before they ship."));
  const before = t.instructions.length;
  await t.run("review");
  assert.equal(t.instructions.length, before); // no reviewer started
  assert.match(t.notes.at(-1)!, /contract changed since the build was approved/);
  // /pb:build re-approves without building anything; the review then judges the spec as it stands.
  await t.run("build", "order-cancellation");
  assert.ok(t.posts.some((x) => /Spec re-approved/.test(x)));
  await t.run("review");
  assert.ok(t.instructions.some((x) => x.startsWith("[pb:review]")));
});

test("review ledger: a rejected alternative is not a lead — no such key reaches the map", async () => {
  const { ledgerFindings } = await import("../extensions/pb/store.ts");
  // `alternative` no longer exists on Finding (the Not: machinery is gone), but a runtime caller —
  // an old event replayed, a tool sending extra JSON — can still hand one in: the ledger must drop it.
  const stored = ledgerFindings([
    { priority: "P1", file: "src/scan.ts", line: 10, title: "the bound names no owner", fix: "name src/scan.ts:10", alternative: "dropping the cadence" } as Finding,
    { priority: "P0", title: "a blocker with no alternative" },
  ]);
  assert.deepEqual(stored, [
    { priority: "P1", file: "src/scan.ts", line: 10, title: "the bound names no owner", fix: "name src/scan.ts:10" },
    { priority: "P0", title: "a blocker with no alternative" },
  ]);
  assert.ok(stored.every((e) => !("alternative" in e)), JSON.stringify(stored));
  assert.ok(!JSON.stringify(stored).includes('"alternative"'), JSON.stringify(stored));
});

test("review: the prompts merge same-fix findings and calibrate framing", async () => {
  const { REVIEWER_SYSTEM, ATTACKER_SYSTEM, SPEC_REVIEWER_SYSTEM, VERIFIER_SYSTEM } = await import("../extensions/pb/prompts.ts");
  assert.match(REVIEWER_SYSTEM, /same concrete fix/);
  assert.match(REVIEWER_SYSTEM, /reasonable reader/);
  assert.match(REVIEWER_SYSTEM, /## Ground rules[\s\S]*## What to check[\s\S]*## How to judge[\s\S]*## Report/);
  assert.match(REVIEWER_SYSTEM, /Severity is the consequence and likelihood/);
  assert.match(ATTACKER_SYSTEM, /same concrete fix/);
  // Pre-existing problems are reported, not suppressed: the cap is a priority, not a filter.
  assert.match(ATTACKER_SYSTEM, /Pre-existing issues are still findings, at most P2/);
  assert.match(ATTACKER_SYSTEM, /newly reachable or materially worse is in the change and keeps its priority/);
  assert.match(REVIEWER_SYSTEM, /newly reachable or materially worse is in the change and keeps its priority/);
  assert.match(ATTACKER_SYSTEM, /Pre-existing issues are still findings, at most P2/);
  assert.match(REVIEWER_SYSTEM, /Pre-existing issues are still findings/);
  // A real problem belongs in the tool report, never only in the closing prose.
  assert.match(REVIEWER_SYSTEM, /never leave a real problem here/);
  assert.match(ATTACKER_SYSTEM, /never only in that line/);
  // Every pass that judges behaviour tests a classification that matches more than one class.
  for (const prompt of [REVIEWER_SYSTEM, ATTACKER_SYSTEM, SPEC_REVIEWER_SYSTEM]) assert.match(prompt, /more than one class/);
  assert.match(VERIFIER_SYSTEM, /Never reject a finding for being outside/);
});

test("review: findings with the same concrete fix merge; distinct ones stay split", async () => {
  const { mergeFindings } = await import("../extensions/pb/review.ts");
  const dupes = [
    { priority: "P2", file: "a.ts", line: 93, title: "two lists can drift", fix: "Make one list the source of truth with ordering in the list and membership derived from it" },
    { priority: "P3", file: "a.ts", line: 93, title: "second copy of membership", fix: "One list as source of truth: ordering in the list, membership derived from it" },
  ];
  const merged = mergeFindings(dupes as any);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].priority, "P2");
  assert.match(merged[0].title, /two lists can drift \/ second copy of membership/);
  const distinct = [
    { priority: "P1", file: "a.ts", line: 251, title: "race reports an unrefreshed paste", fix: "Add snapshot_id to paste rows and require it to equal the reported snapshot" },
    { priority: "P2", file: "a.ts", line: 251, title: "gate on updatedAt instead", fix: "Read set rows and require max updatedAt at or after the snapshot time" },
  ];
  assert.equal(mergeFindings(distinct as any).length, 2); // different prescriptions stay split
  assert.equal(
    mergeFindings([
      { priority: "P2", file: "a.ts", line: 1, title: "x" },
      { priority: "P2", file: "a.ts", line: 1, title: "y" },
    ] as any).length,
    2,
  ); // no fix text: never merge
  assert.equal(
    mergeFindings([
      { priority: "P2", title: "x", fix: "do the same thing" },
      { priority: "P2", title: "y", fix: "do the same thing" },
    ] as any).length,
    2,
  ); // no file: never merge
  const classed = mergeFindings([
    { priority: "P2", file: "b.ts", line: 4, title: "pre-existing copy", fix: "guard the transition", outside: true },
    { priority: "P1", file: "b.ts", line: 4, title: "the change reaches it", fix: "guard the transition" },
  ] as any);
  assert.equal(classed.length, 1);
  assert.equal(classed[0].priority, "P1");
  assert.equal(classed[0].outside, undefined); // a defect the change reaches is not outside it
});

test("review: the brief carries stale prose references for judgment, absent when clean", async () => {
  const { reviewerBrief } = await import("../extensions/pb/prompts.ts");
  const base = { changed: [], stat: "", check: "", focus: "" };
  assert.match(reviewerBrief({ ...base, staleRefs: [{ symbol: "oldHelperName", referrers: ["REF.md:1"] }] }), /Possibly stale prose references[\s\S]*oldHelperName: REF\.md:1/);
  assert.doesNotMatch(reviewerBrief({ ...base }), /Possibly stale prose/);
});

test("verify-test: proves named tests that ran and passed", async () => {
  const { spawnSync } = await import("node:child_process");
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
  const run = (args: string[]) =>
    spawnSync(process.execPath, [path.join(root, "scripts", "verify-test.mjs"), ...args], { cwd: root, encoding: "utf8", timeout: 120000 });
  const fixture = ["--file", "test/verify-fixture.test.mjs"];
  const passed = run([...fixture, "verify fixture passes one"]);
  assert.equal(passed.status, 0, passed.stdout + passed.stderr);
  // Regex metacharacters in a name match literally, and an unescaped (a+b) would not.
  const regex = run([...fixture, "verify fixture regex (a+b)"]);
  assert.equal(regex.status, 0, regex.stdout + regex.stderr);
  // The default test file is the repo's own suite, named without --file.
  const real = run(["plan mode stays with its session, not with the build session"]);
  assert.equal(real.status, 0, real.stdout + real.stderr);
});

test("verify-test: refuses to prove a skipped, missing or failing test", async () => {
  const { spawnSync } = await import("node:child_process");
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
  const run = (args: string[]) =>
    spawnSync(process.execPath, [path.join(root, "scripts", "verify-test.mjs"), ...args], { cwd: root, encoding: "utf8", timeout: 120000 });
  const fixture = ["--file", "test/verify-fixture.test.mjs"];
  // The trap: `node --test --test-name-pattern=<zero-match>` itself exits 0.
  assert.notEqual(run([...fixture, "verify fixture matches nothing"]).status, 0);
  assert.notEqual(run([...fixture, "verify fixture skips one"]).status, 0);
  // A bodyless todo prints `ok N - … # TODO` with `# fail 0` and exit 0: not a proof.
  assert.notEqual(run([...fixture, "verify fixture todo one"]).status, 0);
  assert.notEqual(run([...fixture, "verify fixture fails one"]).status, 0);
});

test("stats: review precision line reports reported dismissed and fixed", async () => {
  const { renderCard } = await import("../extensions/pb/stats.ts");
  const spec = (events: unknown[]) =>
    ({
      name: "demo",
      phase: "reviewed",
      events,
      explore: [],
      progress: { spec: "demo", phase: "reviewed", session: "s", tasks: [], updatedAt: "2026-10-01 10:08:00" },
    }) as any;
  const card = renderCard(
    spec([
      { type: "review", at: "2026-10-01 10:08:00", verdict: "pass", p: [1, 2, 0, 1], dismissed: 2, ms: 60_000 },
      { type: "fix", at: "2026-10-01 10:20:00", fixed: ["a", "b"], skipped: [], tests: "green" },
      { type: "fix", at: "2026-10-01 10:30:00", fixed: ["b", "c"], skipped: [], tests: "green" }, // b reported twice, fixed once
    ]),
  );
  assert.match(card, /^Precision 6 reported · 2 dismissed \(33%\) · 3 fixed$/m);
  // No review happened: the line is absent, not zero-filled.
  assert.doesNotMatch(renderCard(spec([{ type: "build-start", at: "2026-10-01 10:00:00" }])), /Precision/);
  // A clean review has no share to show: pct(0, 0) is the same dash the rest of the card uses.
  assert.match(
    renderCard(spec([{ type: "review", at: "2026-10-01 10:08:00", verdict: "pass", p: [0, 0, 0, 0], dismissed: 0, ms: 60_000 }])),
    /^Precision 0 reported · 0 dismissed \(–\) · 0 fixed$/m,
  );
});

test("review: findings are tagged against the project map, and the first review's tally is what /pb:stats judges the map by", async () => {
  const { REVIEWER_SYSTEM, ATTACKER_SYSTEM, MAP_FINDING_RULE, findingLine } = await import("../extensions/pb/prompts.ts");
  // One rule, word for word, in the reviewer and the abuse pass.
  assert.ok(REVIEWER_SYSTEM.includes(MAP_FINDING_RULE) && ATTACKER_SYSTEM.includes(MAP_FINDING_RULE));
  const t = setup({ verify: "true" });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  t.reviewer.review = [
    { priority: "P1", file: "src/order.ts", line: 12, title: "the repository is called from the controller", fix: "go through the service", map: "stated" },
    { priority: "P2", file: "AGENTS.md", line: 20, title: "the map names a filter that no longer exists", fix: "name OrderGuard", map: "wrong" },
    { priority: "P2", file: "src/order.ts", line: 30, title: "name the constant", map: "made-up" },
  ] as any;
  await t.run("review");
  assert.match(t.posts.at(-1)!, /\[P1 · The map states this rule\] src\/order\.ts:12/);
  assert.match(t.posts.at(-1)!, /\[P2 · The map is wrong here\] AGENTS\.md:20/);
  assert.match(t.posts.at(-1)!, /\[P2\] src\/order\.ts:30 — name the constant/); // an unknown tag is dropped, never minted
  const review = t.events("order-cancellation").filter((e: any) => e.type === "review").at(-1);
  assert.equal(review.mapStated, 1);
  assert.equal(review.mapWrong, 1);
  // The verifier's dismissal takes a finding out of the tally: only what survived counts.
  process.env.MOCK_VERIFY = "reject";
  await t.run("review", "--full");
  delete process.env.MOCK_VERIFY;
  const second = t.events("order-cancellation").filter((e: any) => e.type === "review").at(-1);
  assert.equal(second.mapStated, 0);
  // The stats read the first review: a follow-up re-reporting the same finding is not counted twice.
  await t.run("stats", "order-cancellation");
  assert.match(t.posts.at(-1)!, /Map +first review: 1 broke a rule the map states · 1 found a map line wrong/);
  await t.run("stats", "compare");
  assert.match(t.posts.at(-1)!.split("\n").find((l) => l.startsWith("order-cancellation"))!, / 1\/1 /);
  assert.equal(findingLine({ priority: "P3", title: "x" }), "[P3] x");
});
