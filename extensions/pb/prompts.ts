/**
 * What the agent is told in each phase. Kept short on purpose: long rule lists make
 * models write more defensive, more verbose code. Planning and building happen in
 * your Pi sessions; only the review is a separate, fresh call.
 */
import { tip } from "./help.ts";
import type { ParsedSpec, SpecTask } from "./spec.ts";
import { PB_DIR } from "./store.ts";

const P = PB_DIR.replace(/\\/g, "/");

export const QUALITY = "Write clean, idiomatic code in the project's own style. Fix root causes; no workarounds.";
export const COMMENTS =
  "Comments: only where the code can't speak for itself, and only about the code as it is, never its history: no dates, no \"decided\", \"agreed\", \"user\" or \"spec\", no previous values, no task ids, no TODO or \"revisit\" notes. Decisions and their reasons stay in the spec. Match the surrounding comment density.";

/* ================================== plan ================================== */

export function planPrompt(feature: string, testCmd: string | null): string {
  return `[pb:plan] ${feature}

Let's plan this together. Investigate as you like (read the code, run the build or tests, curl, one-off scripts in a temp directory), but don't change the project's files: that is blocked until /pb:build.

Look at the code involved and how similar features are built, and ${testCmd ? `run \`${testCmd}\` once` : "find and run the tests once"} so we know the baseline. Then tell me what you found, the approach you recommend (and any alternative worth weighing), and the questions only I can answer. Keep it in proportion to the change.

When I'm ready I'll run /pb:spec. End your first reply with this block, verbatim:

${tip("plan.next")}`;
}

/* ================================== spec ================================== */

export function specPrompt(which: string, existing: string[]): string {
  return `[pb:spec]${which ? ` ${which}` : ""}

Write the spec${which ? ` for: ${which}` : ""} from our discussion with the pb_write_spec tool (one call per spec). A new session will build it from the spec alone, so put in what it needs and nothing it doesn't: keep it as short as the change allows.

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
- Test: \`<command for this task's tests>\`   (optional)

Add "## Out of scope", "## Context" (files, conventions, test setup) or "## Acceptance criteria" only when they help.

- One spec per change you would merge on its own; if the discussion covers several, say so and write one each.
- Say each fact once: an example or the rule behind it, not both.
- Before writing, check the spec for contradictions and against the code; fix them in the spec and tell me briefly what you changed.
- Verification defaults to tests; "New tests: no" only if I said so.
- Name: short kebab-case.${existing.length ? ` Existing: ${existing.join(", ")} (reusing a name rewrites it).` : ""}

Then tell me where it is. End your reply with this block, verbatim:

${tip("spec.next")}`;
}

/* ================================== build ================================== */

function gateLine(spec: ParsedSpec, testCmd: string | null, buildCmd: string | null): string {
  if (spec.gate === "tests") return `After each task the harness runs its test command (or \`${testCmd ?? "the test suite"}\`), and the full suite at the end.`;
  if (spec.gate === "build") return `After each task the harness compiles${buildCmd ? ` (\`${buildCmd}\`)` : ""}; no tests run (${spec.gateReason}).`;
  return `The harness runs no checks (${spec.gateReason}).`;
}

/** The first message of the build session: a few rules and the spec; the first task follows it. */
export function buildSeed(name: string, markdown: string, spec: ParsedSpec, testCmd: string | null, buildCmd: string | null): string {
  return `[pb:build ${name}] Build this feature from the spec below. The planning is done: implement it as written.

- Where the spec is unclear or doesn't match the code, take the sensible reading, record it with pb_record_decision (assumption: true) and carry on. Ask (pb_task_done with status "question") only when a choice changes behaviour, an API or data.
- ${QUALITY} Keep each change to its task.
- ${COMMENTS}
- Tests: ${spec.newTests ? "add or extend tests for the behaviour each task introduces." : `add none for this feature (${spec.newTestsReason}).`} Never delete, skip or weaken a test.
- Don't commit or discard changes with git, and leave .pi/ alone.
- ${gateLine(spec, testCmd, buildCmd)} Finish each task with pb_task_done.

--- spec: ${P}/specs/${name}/spec.md ---

${markdown}`;
}

export function taskPrompt(task: SpecTask, attempt: number, max: number): string {
  return `[pb:build] Task ${task.id}${attempt > 1 ? ` (attempt ${attempt} of ${max})` : ""}. Do only this task:

${task.text}

(Comments: the code as it is; no history, dates or decisions.) When done, call pb_task_done with task "${task.id}": status "done", or "blocked" with why, or "question" with the question.`;
}

export function fixPrompt(taskId: string, what: string, output: string, attempt: number, max: number): string {
  return `[pb:build] ${taskId === "final" ? "The final check" : `The check for ${taskId}`} failed (attempt ${attempt} of ${max}): ${what}

${output}

Fix the cause, then call pb_task_done again with task "${taskId}".`;
}

/* ================================== review ================================== */

export const REVIEWER_SYSTEM = `You are an independent REVIEWER in a fresh context. You did not take part in planning or building, and you are deliberately not shown the build conversation: judge the actual code against the spec.

Do not modify any file. Use read/grep/find/ls and bash only for inspection (git diff, git status, running a test is fine). Never run git commands that change the working tree or index (checkout, restore, reset, stash, clean, add, commit): the change under review may be uncommitted. Ignore .pi/ except the spec you are given.

The harness already ran this feature's check on the current tree; the result is in the brief. Don't re-run the full suite; run a specific test only when you need evidence. Read the diff file by file.

Check:
- The spec's acceptance criteria, one by one: met or not met, with evidence (file:line or test name). Each task's acceptance too.
- The spec's decisions respected, including the rejected alternatives ("Not doing X"): flag anything the build brought back.
- The builder's assumptions (Decisions entries starting "Assumption (build):"): the choices it made where the spec was ambiguous. Flag any that look wrong or second-best.
- Missing cases, error handling, convention breaks, changes outside the spec's scope, debug output, commented-out code or leftover TODOs.
- Tests, according to the spec's "New tests" line: when it is yes, tests that don't really test the behaviour, and missing tests for new behaviour; either way, existing tests that were deleted, skipped, disabled or weakened.
- Comments that restate the code, carry history (dates, "decided", previous values, task ids), mislead, or were left wrong by the change. The rule the build followed: ${COMMENTS}
- ${QUALITY} Flag workarounds (silenced errors, hardcoded values, special-cased test inputs, sleeps, disabled checks), deprecated APIs, and security problems (injection, secrets in code, missing validation or authorisation).

"changes_needed" is only for what should block a merge: an unmet acceptance criterion or decision, a bug, missing tests for new behaviour (unless the spec says no new tests), a weakened test, a risky change outside scope, a workaround where a proper fix belongs, a security problem. Nits and pre-existing issues are findings, not blockers; if those are all you found, the verdict is "pass".

Write the review in markdown: verdict first, then the acceptance checklist, then findings numbered and ordered by severity, each with file:line and a concrete fix. Be brief on what is fine. End with exactly one line, the last of your reply: VERDICT: pass   or   VERDICT: changes_needed`;

export function reviewerBrief(o: { name: string; markdown: string; spec: ParsedSpec; base?: string; changed: string[]; stat: string; check: string; focus: string }): string {
  const lines = [
    `# Review: ${o.name}${o.focus ? ` — focus: ${o.focus}` : ""}`,
    "",
    "## How to see the change",
    "",
    o.base ? `Base commit: ${o.base}\nRun: git diff ${o.base} -- . ':(exclude).pi'   and read the untracked files listed below.` : "No base commit recorded: use git diff HEAD and git status.",
    "",
    "## Changed files",
    "",
    o.changed.join("\n") || "(none)",
    o.stat ? `\n${o.stat}` : "",
    "",
    "## The check the harness ran",
    "",
    o.spec.gate === "none" ? `None: verification is "none" for this feature (${o.spec.gateReason}). Look harder at correctness yourself.` : o.check,
    "",
    `## The spec (${P}/specs/${o.name}/spec.md)`,
    "",
    o.markdown,
  ];
  return lines.join("\n");
}
