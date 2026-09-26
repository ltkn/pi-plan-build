/**
 * What the agent is told in each phase: short mechanics only. Your engineering standards
 * live in AGENTS.md, which Pi loads into every session itself; they are added to a message
 * only when the session started before they existed. Long rule lists make models write more
 * defensive, more verbose code, so the mechanics stay minimal. Planning and building happen
 * in your Pi sessions; the explorer, the reviewer and the verifier are separate, fresh calls.
 */
import { tip } from "./help.ts";
import type { ParsedSpec, SpecTask } from "./spec.ts";
import { type Finding, PB_DIR, type Progress } from "./store.ts";

const P = PB_DIR.replace(/\\/g, "/");

/** Standards to include in a message: empty when the session already has them from AGENTS.md. */
const standardsBlock = (standards: string) => (standards ? `\n\nEngineering standards (from AGENTS.md):\n${standards.replace(/^#+.*\n+/, "")}` : "");

/* ================================ explorer ================================ */

export const EXPLORER_SYSTEM = `You are an EXPLORER in a fresh context: you answer a question about the code so the conversation that asked doesn't have to read it all. Do not modify any file; use read-only commands, and run a build or tests only when the question needs it. Report facts with paths (file:line where it helps), not a design. Be compact: your answer is all that goes back.`;

export function explorerBrief(question: string, context?: string): string {
  return `# Question\n\n${question}${context ? `\n\n# What is being planned\n\n${context}` : ""}`;
}

/* ================================== plan ================================== */

/** baseline: "running" while the harness runs the suite in the background, "none" when it doesn't. */
export function planPrompt(feature: string, testCmd: string | null, standards: string, baseline: "running" | "none"): string {
  const tests =
    baseline === "running" && testCmd
      ? `The harness is running \`${testCmd}\` in the background; its result shows up here when it's done, so don't run the full suite for a baseline yourself.`
      : `${testCmd ? `Run \`${testCmd}\` once` : "Find and run the tests once"} so we know the baseline.`;
  return `[pb:plan] ${feature}

Let's plan this together. Investigate as you like (read the code, run the build or tests, curl, one-off scripts in a temp directory), but don't change the project's files: that is blocked until /pb:build.

For a broad look (where things live, how a similar feature is built, the conventions), call pb_explore: it answers from a separate context, so this one stays lean. Read files yourself where our discussion needs exact lines. ${tests}

Tell me what you found, the approach you recommend (and any alternative worth weighing), and the questions only I can answer (pb_ask for a choice between options). Keep it in proportion to the change.${standardsBlock(standards)}

When I'm ready I'll run /pb:build (or /pb:spec to write the spec first). End your first reply with this block, verbatim:

${tip("plan.next")}`;
}

export function depsPrompt(scope: string): string {
  return `[pb:deps]${scope ? ` ${scope}` : ""}

Check ${scope ? `these dependencies: ${scope}` : "this project's dependencies"}: the versions in use against the latest stable ones, deprecated APIs we call, and what an upgrade would break. Don't change the project's files. Then propose the upgrades worth doing, each with its benefit and risk. If I agree, /pb:build turns them into a spec of their own.`;
}

/* ================================== spec ================================== */

export function specPrompt(which: string, existing: string[]): string {
  return `[pb:spec]${which ? ` ${which}` : ""}

Write the spec${which ? ` for: ${which}` : ""} from our discussion with the pb_write_spec tool (one call per spec). The build follows it, the reviewer checks against it, and after a compaction or in a fresh session it's all the build has: put in what it needs and nothing it doesn't, as short as the change allows.

# <title>
Depends on: <spec name> | none
Verification: tests | build — <why> | none — <why>
New tests: yes | no — <why>

## Goal
## Decisions
Each decision with its reason, as it stands now: no dates, no history, not who decided. Rejected ideas as "Not doing X, because …".
## Tasks
### T1: <title>
What to change and where.
- Acceptance: <checkable>
- Test: \`<command for this task's tests>\`   (optional: without it the task is only compiled; the full suite runs after the last task)

Add "## Out of scope", "## Context" (files, conventions, test setup) or "## Acceptance criteria" only when they help.

- One spec per change you would merge on its own; if the discussion covers several, say so and write one each.
- Say each fact once: an example or the rule behind it, not both.
- Before writing, check the spec for contradictions and against the code; fix them in the spec and tell me briefly what you changed.
- The approach follows the engineering standards (AGENTS.md).
- Verification defaults to tests; "New tests: no" only if I said so.
- Name: short kebab-case.${existing.length ? ` Existing: ${existing.join(", ")} (reusing a name rewrites it).` : ""}

Then tell me where it is. End your reply with this block, verbatim:

${tip("spec.next")}`;
}

/* ================================== build ================================== */

function gateLine(spec: ParsedSpec, buildCmd: string | null): string {
  if (spec.gate === "tests") return `it runs the task's Test: command (a compile when there is none), and the full suite after the last task`;
  if (spec.gate === "build") return `it compiles${buildCmd ? ` (\`${buildCmd}\`)` : ""}; no tests run (${spec.gateReason})`;
  return `no checks run (${spec.gateReason})`;
}

/** How the build works: the mechanics only (the standards come separately). */
export function buildMechanics(spec: ParsedSpec, buildCmd: string | null): string {
  return `- Where the spec is unclear or doesn't match the code, take the sensible reading, record it with pb_record_decision (assumption: true) and carry on. Ask with pb_ask only when a choice changes behaviour, an API or data.
- Keep each change to its task. Tests: ${spec.newTests ? "add or extend tests for the behaviour each task introduces." : `add none for this feature (${spec.newTestsReason}).`} Never delete, skip or weaken a test.
- Don't commit or discard changes with git, and leave .pi/ alone.
- Finish each task with pb_task_done: ${gateLine(spec, buildCmd)}. It gives you the next task.`;
}

/**
 * The first build message. In the session that wrote the spec, the agent already knows it;
 * anywhere else (a fresh session, or a session that never saw it) the spec comes along.
 */
export function buildIntro(name: string, spec: ParsedSpec, buildCmd: string | null, standards: string, markdown?: string): string {
  return `[pb:build ${name}] ${markdown ? "Build this feature from the spec below." : `Build the spec you wrote (${P}/specs/${name}/spec.md).`} The planning is done: implement it as written.

${buildMechanics(spec, buildCmd)}${standardsBlock(standards)}${markdown ? `\n\n--- spec: ${P}/specs/${name}/spec.md ---\n\n${markdown}` : ""}`;
}

/** check: the command pb_task_done will run for this task, if any. */
export function taskPrompt(task: SpecTask, attempt: number, max: number, check: string | null): string {
  return `[pb:build] Task ${task.id}${attempt > 1 ? ` (attempt ${attempt} of ${max})` : ""}. Do only this task:

${task.text}

(Comments: the code as it is; no history, dates or decisions.) When done, call pb_task_done with task "${task.id}"${check ? `: it runs \`${check}\` itself, so don't run that just before` : ""}. If it can't be done properly, status "blocked" with why.`;
}

export function continuePrompt(task: SpecTask): string {
  return `[pb:build] Continue task ${task.id}: ${task.title}. Finish it with pb_task_done.`;
}

export function fixText(taskId: string, what: string, output: string, attempt: number, max: number, last: boolean): string {
  const head = `${taskId === "final" ? "The final check" : `The check for ${taskId}`} failed (attempt ${attempt} of ${max}): ${what}`;
  return last
    ? `${head}\n\n${output}\n\nThat was the last attempt: the build is paused. Stop here; the human decides how to go on.`
    : `${head}\n\n${output}\n\nFix the cause, then call pb_task_done again with task "${taskId}".`;
}

export function nudgePrompt(taskId: string): string {
  return `[pb:build] You stopped without finishing ${taskId === "final" ? "the final check" : taskId}. Carry on and finish with pb_task_done; if it can't be done properly, pb_task_done with status "blocked"; if you need a decision, pb_ask.`;
}

/** What survives a compaction of a build session: the build's state, from what the harness knows. */
export function compactionSummary(p: Progress, markdown: string | undefined, previous?: string): string {
  const lines = [
    `[pb build state: ${p.spec}] This conversation was compacted by pb. The build of ${P}/specs/${p.spec}/spec.md goes on from here; the spec (below) is the source of truth.`,
    "",
    "Tasks:",
    ...p.tasks.map((t) => `- ${t.id} ${t.title}: ${t.status}${t.id === p.current ? " (current)" : ""}${t.summary ? ` — ${t.summary.replace(/\s+/g, " ")}` : ""}`),
  ];
  if (p.pause) lines.push("", `Paused: ${p.pause}`);
  if (p.lastVerify && p.lastVerify.ok === false) lines.push("", `Last check (failed):\n${p.lastVerify.summary}`);
  if (previous && !previous.startsWith("[pb build state")) lines.push("", "Earlier conversation, summarized before:", previous);
  if (markdown) lines.push("", `--- spec ---`, markdown);
  return lines.join("\n");
}

/* ================================== review ================================== */

export const REVIEWER_SYSTEM = `You are an independent REVIEWER in a fresh context. You did not take part in planning or building, and you are deliberately not shown the build conversation: judge the actual code.

Do not modify any file. Use read/grep/find/ls and bash only for inspection (git diff, git status, running a test is fine). Never run git commands that change the working tree or index (checkout, restore, reset, stash, clean, add, commit): the change under review may be uncommitted. Ignore .pi/ except the spec you are given.

The harness already ran the check on the current tree; the result is in the brief. Don't re-run the full suite; run a specific test only when you need evidence. Read the diff file by file.

Check:
- With a spec: its acceptance criteria, one by one: met or not met, with evidence (file:line or test name). Each task's acceptance too. Its decisions respected, including the rejected alternatives ("Not doing X"): flag anything the build brought back. The builder's assumptions (Decisions entries starting "Assumption (build"): flag any that look wrong or second-best.
- Without a spec: whether the change does what the intent in the brief says.
- Missing cases, error handling, convention breaks, changes outside the scope, debug output, commented-out code or leftover TODOs.
- Tests, according to the spec's "New tests" line when there is one: tests that don't really test the behaviour, and missing tests for new behaviour; either way, existing tests that were deleted, skipped, disabled or weakened.
- The engineering standards in your instructions (AGENTS.md), if any: quality, dependencies, comments (restating the code, history such as dates, "decided", previous values or task ids, or left wrong by the change), tests.
- Workarounds (silenced errors, hardcoded values, special-cased test inputs, sleeps, disabled checks) and security problems (injection, secrets in code, missing validation or authorisation).

Report the findings with the report_findings tool: one call with all of them (an empty list when there are none), each with its priority:
- P0 must fix: broken behaviour, a security problem, data loss.
- P1 fix before merging: an unmet acceptance criterion or decision, a bug, missing tests for new behaviour (unless the spec says no new tests), a weakened test, a risky change outside scope, a workaround where a proper fix belongs.
- P2 worth fixing: conventions, clarity, comments, a second-best choice.
- P3 nit.
Pre-existing issues are at most P2. Report only what the author would want to fix, each with file, line and a concrete fix.

Then reply briefly in markdown: the acceptance checklist when there is a spec, and anything worth knowing that isn't a finding. Don't repeat the findings.`;

export const VERIFIER_SYSTEM = `You are a VERIFIER in a fresh context. A reviewer reported the findings in the brief about a change that may be uncommitted. For each one, look at the code yourself and decide: confirmed (the problem is real, in this change, and about as serious as its priority says) or rejected (not real, already handled, or not caused by this change), with one line of evidence (file:line).

Do not modify any file, and never run git commands that change the working tree or index. Report with the report_verdicts tool: one entry per finding, by its number.`;

export const findingLine = (f: Finding, n?: number) =>
  `${n !== undefined ? `${n}. ` : ""}[${f.priority}] ${f.file ? `${f.file}${f.line ? `:${f.line}` : ""} — ` : ""}${f.title}${f.fix ? `\n   Fix: ${f.fix}` : ""}`;

export interface ReviewBrief {
  /** the spec, when the change was built from one */
  spec?: { name: string; markdown: string; parsed: ParsedSpec };
  /** what the change is meant to do, when there is no spec */
  intent?: string;
  base?: string;
  changed: string[];
  stat: string;
  check: string;
  focus: string;
  /** the previous review: only its findings and what changed since are reviewed */
  previous?: { snapshot: string; findings: Finding[]; changed: string[] };
}

/** Static parts first (the spec), the parts that change between reviews last: a repeat review reuses the cached prefix. */
export function reviewerBrief(o: ReviewBrief): string {
  const lines: string[] = [];
  if (o.spec) lines.push(`# The spec (${P}/specs/${o.spec.name}/spec.md)`, "", o.spec.markdown, "");
  else lines.push("# No spec", "", `There is no spec: judge the change against its intent and the engineering standards.`, "", `Intent: ${o.intent || "(not given: infer it from the change, and say what you inferred)"}`, "");
  lines.push(`# Review${o.spec ? `: ${o.spec.name}` : " of the uncommitted change"}${o.focus ? ` — focus: ${o.focus}` : ""}`, "");
  if (o.previous) {
    lines.push(
      "## This is a follow-up review",
      "",
      "The previous review confirmed the findings below. For each: is it fixed? Report the ones still open again (same title). Then look only at what changed since that review for new problems; don't review the rest again.",
      "",
      ...(o.previous.findings.length ? o.previous.findings.map((f, i) => findingLine(f, i + 1)) : ["(none)"]),
      "",
      `Changed since the previous review (its tree is commit ${o.previous.snapshot}): git diff ${o.previous.snapshot} -- . ':(exclude).pi'`,
      "",
      o.previous.changed.join("\n") || "(nothing)",
      "",
    );
  }
  lines.push(
    "## How to see the change",
    "",
    o.base ? `Base commit: ${o.base}\nRun: git diff ${o.base} -- . ':(exclude).pi'   and read the untracked files listed below.` : "Run: git diff HEAD and git status.",
    "",
    "## Changed files",
    "",
    o.changed.join("\n") || "(none)",
    o.stat ? `\n${o.stat}` : "",
    "",
    "## The check the harness ran",
    "",
    o.spec?.parsed.gate === "none" ? `None: verification is "none" for this feature (${o.spec.parsed.gateReason}). Look harder at correctness yourself.` : o.check,
  );
  return lines.join("\n");
}

export function verifierBrief(findings: Finding[], base: string | undefined, spec?: string): string {
  return [
    "# Findings to verify",
    "",
    ...findings.map((f, i) => findingLine(f, i + 1)),
    "",
    "# The change",
    "",
    base ? `git diff ${base} -- . ':(exclude).pi', plus untracked files (git status).` : "git diff HEAD, plus untracked files (git status).",
    ...(spec ? ["", "# The spec it was built from", "", spec] : []),
  ].join("\n");
}
