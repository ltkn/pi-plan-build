/**
 * What the agent is told in each phase: short mechanics only. Your engineering standards
 * live in AGENTS.md, which Pi loads into every session itself; they are added to a message
 * only when the session started before they existed. Long rule lists make models write more
 * defensive, more verbose code, so the mechanics stay minimal. Planning and building happen
 * in your Pi sessions; the explorer, the reviewer and the verifier are separate, fresh calls.
 */
import { tip } from "./help.ts";
import { BINDING_SECTIONS, type ParsedSpec, type SpecTask, sectionHeading, sectionOf } from "./spec.ts";
import { type AcceptanceCheck, type AcceptanceCriterion, type Finding, PB_DIR, type Progress, type TaskProgress, cap } from "./store.ts";

const P = PB_DIR.replace(/\\/g, "/");

/** Standards to include in a message: empty when the session already has them from AGENTS.md. */
const standardsBlock = (standards: string) => (standards ? `\n\nEngineering standards (from AGENTS.md):\n${standards.replace(/^#+.*\n+/, "")}` : "");

/** Your extra instructions for a role (the "extra" setting): added, never replacing pb's. */
export const extraBlock = (extra: string) => (extra ? `\n\nAlso, from your pb config:\n${extra}` : "");

/** The one edit rule for structured files: literal or line-based, never a regex that can backtrack. */
export const STRUCTURED_EDIT_RULE = "Edit structured files (`pom.xml`, JSON, YAML) by exact literal replacement or line-based edits, never a backtracking regex such as `(?:(?!-->).*?)*`.";

/* ================================ explorer ================================ */

export const EXPLORER_SYSTEM = `You are an EXPLORER in a fresh context: you answer a question about the code so the conversation that asked doesn't have to read it all. Check the project map in AGENTS.md first: read Security invariants in full and only the area headings covering the question's paths; explore only what the map doesn't answer. Read code with grep for regex, find and ls for patterns, and read for known paths, in parallel where it helps. Shell is for inspection only (ls, find, cat, head, tail, git status, git log, git diff, rg): no mkdir, touch, rm, cp, mv, redirects, installs, curl, or scripts — experiments stay in the session that asked. Do not create or modify any file. Be concise: conclusion first. Quote only what the question asked for (rows, excerpts); otherwise cite paths (file:line), not pastes. Your answer is all that goes back.`;

export function explorerBrief(question: string, context?: string): string {
  return `# Question\n\n${question}${context ? `\n\n# What is being planned\n\n${context}` : ""}\n\nBudget: read at most ~20 files and stop after ~30 tool steps. If the question needs more, don't keep going: answer what you have and say which sub-question to split off.\n\n# Return exactly\n\n## Answer — the conclusion first, 5-15 lines\n## Files — \`path:line — role\`, up to ~20, no pastes; one role is \`pattern to imitate\` when relevant\n## Uncertainties — what wasn't found, or would need running code`;
}

/* ================================= try ================================= */

export const TRY_SYSTEM = `You are a TRIER in a fresh context: you establish something by running code so the conversation that asked doesn't pay for the output. Check the project map in AGENTS.md first: read Security invariants in full and only the area headings covering the goal's paths. Read the project, then run commands, curl, one-off scripts or single-file programs in a temporary directory outside the project. Do not create or modify any project file; for a database use read-only queries. Prefer local code, docs and local/test data first. A read-only production query is allowed only when local data cannot answer it: state why, name the table and row cap (at most ~500 rows), and touch nothing else. Production writes, production channels, and real notifications are never allowed. Be concise: conclusion first. Include only the evidence the question asked for (rows, excerpts, output excerpts); otherwise state commands and exits. Your answer is all that goes back.`;

export function tryBrief(goal: string, context?: string): string {
  return `# Goal\n\n${goal}${context ? `\n\n# What is being planned\n\n${context}` : ""}\n\nBudget: stop after ~30 tool steps; keep scratch files in a temp dir outside the project. If a production database is the only source, state why plus the table and row cap (at most ~500 rows, read-only); never write, never notify.\n\n# Return exactly\n\n## Commands — what you ran, one line each\n## Result — evidence: exits and output excerpts, up to ~20 lines\n## Conclusion — what this establishes, 3-10 lines`;
}

/* ================================== plan ================================== */

/**
 * The stance for every planning discussion: a senior engineer, not an agreeable
 * assistant. Shared by the plan, continued-plan and approach prompts so the
 * pushback is identical wherever the discussion happens.
 */
const CHALLENGE =
  "Talk plainly: conclusion first, the consequence in everyday words, any term of art defined in a line. Paths, commands and error quotes stay verbatim. The register, for scale: “the sync races on first boot: two workers both see no lock row, so both write” — not “there exists an initialization-window concurrency hazard in the write path”. Push back like a senior engineer would: disagree when the idea is second-best and say what you would do instead, with concrete reasons grounded in this code. No objection without evidence: cite a path (file:line), a constraint found, or a test that would fail — never taste. Label each pushback blocker, suggestion, or nit, so it's clear what needs an answer. For each objection, say what would change your mind — a measurement, a probe via pb_try, a fact about the code. State an uncertainty once as an Assumption with its claim, what would settle it, and what settling costs; a second reversal must be a pb_try call, not more prose. When you know better, teach: explain the trade-off and the principle behind your alternative, and point to where this codebase already applies it — guide like a mentor, so the engineer grows, not just the plan. Name rabbit holes early — what isn't worth exploring, and why — and don't follow them. Challenge weak spots (missing cases, the wrong layer, reinventing what exists, generality it doesn't need). Small change, small pushback: never debate for its own sake. Present the decision like a senior engineer: one recommendation with its rationale (trade-offs, cost, risk, why it beats the rest). Define every option fully before rejecting it — what it is, pros/cons, then why not — never a bare verdict or a letter the reader hasn't seen defined.";

/**
 * How the agent's reports to the human read — shared by the task and fix-lap report tools,
 * so the sentence exists once. Discussion register lives in CHALLENGE; agent-facing reports
 * (findings, verifier verdicts) stay technical.
 */
export const reportRegister = `Write for someone who hasn't watched this session: what changed, why it's correct, a term defined inline the first time it appears, evidence quoted not paraphrased.`;

 /** baseline: "running" while the harness runs the suite in the background, "none" when it doesn't. */
export function planPrompt(feature: string, testCmd: string | null, standards: string, baseline: "running" | "none", extra = ""): string {
  const tests =
    baseline === "running" && testCmd
      ? `The harness is running \`${testCmd}\` in the background; its result shows up here when it's done, so don't run the full suite for a baseline yourself.`
      : `${testCmd ? `Run \`${testCmd}\` once` : "Find and run the tests once"} so we know the baseline.`;
  return `[pb:plan] ${feature}

Let's plan this together. Investigate as you like (read the code, run the build or tests, curl, one-off scripts in a temp directory), but don't change the project's files: that is blocked until /pb:build.

Check the project map in AGENTS.md first; only what it doesn't answer is worth a fresh call. How to investigate:
1. From the map, read Security invariants in full and only the area headings covering the touched paths; skip the rest.
2. For a broad or multi-file look (where things live, how a similar feature is built, the conventions, what calls what), call pb_explore: it answers from a separate context, so this one stays lean. Searching the whole repo for a common term goes to pb_explore, not a direct grep; grep directly only within named files or directories.
3. Budget: fan out once (up to 6 pb_explore and pb_try calls in one block), then synthesize. Never re-read a file the explorer already listed. When you catch yourself raising a grep limit past ~15 or searching the same term twice, stop and call pb_explore with what you've learned instead.
4. When you know the 1-3 files, read them yourself. Grep narrow: one path and pattern, low limit, no surrounding lines unless a match is ambiguous; read the exact lines for discussion. Trust its Files list instead of re-reading everything it read.
5. When a decision needs something only running code shows (library behaviour or limits, performance, a read-only query), call pb_try with the question to settle: back come Commands, Result and Conclusion. If settling it needs a scratch script file — or its output won't fit in a few lines — it belongs in pb_try. Single read-only commands stay here in a scratch copy. Prefer local code, docs and local/test data first. A read-only production query is allowed only when local data cannot answer it: the goal must state why plus the table and row cap (at most ~500 rows). Production writes, production channels, and real notifications are never allowed. ${tests}
6. Order: ask taste and scope first (vehicle, channel, frequency via pb_ask), then measure to calibrate the threshold — never run an expensive probe to decide a question the user answers directly. State an uncertainty once as an Assumption with what would settle it and what settling costs; a second reversal must be a pb_try call, not more prose. If a question goes unanswered, it stays an Open question and planning stays incomplete — never paper it over with an Assumption.

${CHALLENGE}

Planning is finished when every attack question below is answered and no Open questions remain.
Attack checklist (walk it before writing anything down): who abuses this (stolen session, another user, replay, automation)? What breaks on bad input (sizes, duplicates, order, concurrent calls)? What happens at the boundary — first run, empty state, dark channel, restart? Which parameters die if unused, and what calls each seam? For each: answered, or asked via pb_ask.

Reply with exactly:

- Findings — conclusion first (5–15 lines), then the files and constraints behind it (path:line), and measurements with the commands that produced them. State each fact once; no pastes.
- Recommendation — one option, with its rationale (trade-offs, cost, risk, why it beats the rest).
- Alternatives — each defined fully before it is rejected: what it is, pros/cons, then why not. Never a bare verdict or a letter/number the reader hasn't seen defined.
- Risks — only what applies: trust boundaries, races, failure halfway, unbounded work.
- Assumptions — each marked as such, with what would settle it.
- Open questions — then call pb_ask for the choices only I can answer (2–4 options each, with your recommendation marked).

Small change, small reply. Keep it in proportion to the change.${standardsBlock(standards)}${extraBlock(extra)}

When I'm ready I'll run /pb:build (or /pb:spec to write the spec first). End your first reply with this block, verbatim:

${tip("plan.next")}`;
}

export function depsPrompt(scope: string): string {
  return `[pb:deps]${scope ? ` ${scope}` : ""}

Check ${scope ? `these dependencies: ${scope}` : "this project's dependencies"}: the versions in use against the latest stable ones, deprecated APIs we call, and what an upgrade would break. Don't change the project's files. Then propose the upgrades worth doing, each with its benefit and risk. If I agree, /pb:build turns them into a spec of their own.`;
}

/* ================================== approach ================================== */

/** Mid-discussion readout of how the implementation would be approached. focus: one idea to expand; empty infers it. */
export function approachPrompt(focus: string, standards: string, extra = ""): string {
  const which = focus
    ? `Expand this idea: ${focus}. If the discussion holds several ideas, expand this one fully and cover the others briefly, with why this one is preferred (or what would change that).`
    : `Infer the idea from our discussion (usually there is just one). If several are on the table, expand each briefly, compare them, and recommend one with why.`;
  return `[pb:approach]${focus ? ` ${focus}` : ""}

${which}

Ground it first: the files and roles involved, the existing code to imitate (by path, not pasted), and the constraints found. Check the project map in AGENTS.md first; broad questions go to pb_explore, anything needing running code to pb_try. Don't change the project's files.

${CHALLENGE}

Reply with exactly:

- Understanding — the change in 2–3 sentences.
- Approach — the seams as they must end up (signatures, API with errors, data and migrations, events, which side owns each); everything behind them is left to the build.
- Non-goals — each as "Not doing X, because …", plus what stays untouched.
- Test strategy — the behaviours to prove (abuse cases included), red-proofable; no tasks.
- Alternatives — each defined fully before it is rejected: what it is, pros/cons, then why not.
- Risks — only what applies: trust boundaries, races, failure halfway, unbounded work.
- Assumptions — each marked as such, to confirm.
- Open questions — undecided, each with its options and your recommendation. List them only: do not call pb_ask.

No code, no task breakdown; keep it in proportion to the change.${standardsBlock(standards)}${extraBlock(extra)}

End your reply with this block, verbatim:

${tip("plan.next")}`;
}

/* ================================== spec ================================== */

/** The format, and what earns a place in a spec: shared by writing, finishing and checkpointing. */
const SPEC_FORMAT = `# <title>
Status: ready | planning
Depends on: <spec name> | none
Verification: tests | build — <why> | none — <why>
New tests: yes | no — <why>

## Goal
The outcome in a few sentences: what is true after the change, for whom, and how we'll know it worked — no implementation. Every task and acceptance line serves it; anything beyond it belongs in Out of scope.
## Findings
What the analysis established, as short as a fresh session needs to not redo it: the files and classes involved and their roles, the existing code to imitate (by path and lines, not pasted), constraints found, the test command and baseline. Each bullet says what makes it checkable — a path:line, a probe (probe: <what you ran>; conclusion: <what it showed>) or a constraint — never a bare conclusion. A path:line must point at a real line in the repo; a new file needs no line number. Dead ends too: what was tried or ruled out, and why.
## Decisions
Each decision with its reason, as it stands now: no dates, no history, not who decided. Say why in plain prose, not with a bare colon; rejected ideas as "Not doing X, because …", so they aren't reconsidered. Every quantitative claim (latencies, counts, windows) carries a measurement (command plus result) or is written as an Assumption.
## Contracts
No later step sees the whole change at once: tasks are built one by one. So pin here every seam other code, clients or stored data depend on — the public signatures, API requests and responses with their error types, the data model and migrations, events, and which task owns each side of every seam. A single task that changes an external surface needs this section too, and tasks sharing a seam (the same Test: command or a shared file) should pin it. Truly independent internal tasks need none, though a one-line "independent" section is accepted, and a "none — <why>" answer is fine when nothing is shared. Pin exactly these, as they must end up; leave everything behind them to the build. Every external outcome (API returns, message sends, file writes) used in Contracts must enumerate its real states, not a binary that conflates them; if the dependency doesn't report a state, say so and design for the unknown. Every observable value a Contract states — an HTTP status, error type, header, ordering, event name or stored value — cites the code path or test that pins it today (file:line), or is written as an Assumption; a value inferred from the design is built as written. A formula or derived figure — a size, limit, count, threshold, window — shows its computed value for each case Acceptance pins, inputs and result together (a tenth of a 128k window = 12800), because a number the reader must recompute by hand is the one that survives a review round wrong. A bound on how often something runs is a claim about a call site, so name the code that owns it — a path:line, new: <path> when nothing performs it yet, or an Assumption when nothing in the project enforces the cadence.
## Migration and rollback
Only when the change persists or transforms data, a schema or a stored format: how existing data moves to the new shape, how the change is rolled back, and what old and new code do while both run. Say "none — <why>" when nothing outlives the change.
## Threats and abuse
Only when the change adds or alters an entry point, touches a trust boundary (authentication, authorization, credentials, sensitive data, external input) or has rules someone gains from breaking (money, quantities, limits, quotas, state): who can reach it and with what, what they must prove or be allowed, how it could be abused (including by quantity, repetition, reordering or racing), and what prevents each abuse. A spec that is sensitive anywhere in Goal, Findings, Decisions, Contracts or Tasks should carry this section: say "none — <why>" if the keyword points at nothing. The task acceptance lines then include the abuse cases.
## Open questions
Only while Status is planning: what's undecided, the options still being weighed with what was found for and against each, and where the discussion stands.
## Tasks
### T1: <the outcome, e.g. "a pending order can be cancelled">
What must be true when it's done, and anything the build must know; not how to build it.
- Acceptance: <one behaviour, as a test would check it>   (one line each, abuse cases included: they are the tests to write; the task's Test: command is the proof)
- Test: \`<command that runs this task's tests>\`   (for a task that adds behaviour)

The spec pins what the change must do and how we'll know: Goal, Decisions, Contracts, Threats and Acceptance bind the build. How to build it is left to the build, which settles the shape task by task — the compiler and the tests giving feedback — and records what it settles on in "## Design". So don't write "## Design" yourself, and don't prescribe classes, methods or steps unless they are a Contract. Put what tasks share in Contracts: that is the shape the build must not invent.

One task, unless a slice is worth reviewing on its own; then vertical slices, each leaving the code working and tested, never a split by layer or a closing "add tests" task. Keep each task narrow: one coherent change with its own targeted Test:, never several independent changes bundled with a full-suite run — the harness runs the suite once after the last task, so split the work instead. A task that adds no behaviour (wiring, configuration, a "(refactor) …") has no Test: line. Name the prose that describes the behavior being changed (map sections, javadoc, schema comments, guides); updating it is a Task, never an afterthought. A doc-only task carries no Test: line — its acceptance lines still say what to check.

Add "## Out of scope" only when it helps. When you include a section that does not apply, say so in one line ("none — <why>"), never an empty heading or TBD.

- Point to code instead of copying it; state each fact once; leave out the discussion's history. A reader should start where we are, without re-analysing, and without being buried.`;

export function specPrompt(which: string, existing: string[], current?: { name: string; markdown: string }, extra = ""): string {
  return `[pb:spec]${which ? ` ${which}` : ""}

Write the spec${which ? ` for: ${which}` : ""} from our discussion with the pb_write_spec tool (one call per spec; pb_update_spec changes single sections of an existing one). The build follows it, the reviewer checks against it, and a fresh or reset session starts from it alone: put in what it needs and nothing it doesn't.

${SPEC_FORMAT}

- One spec per change you would merge on its own; if the discussion covers several, say so and write one each.
- Keep each task narrow: one coherent change with a targeted Test:. Split work that bundles several independent changes with a full verification; the harness runs the full suite once, after the last task, so no task needs to.
- Refactoring that the standards call for (outdated code in the way) comes first, as tasks titled "(refactor) …" that keep behaviour; a large one is a spec of its own that this one depends on.
- Before writing, check the spec for contradictions and against the code; fix them in the spec and tell me briefly what you changed.
- Every observable value in Contracts (status, error, header, ordering, event, stored value) names the file:line or test that pins it today, or is an Assumption. Open that code before writing the value: never infer a status or an order from what the design should do.
- The approach follows the engineering standards (AGENTS.md).
- Status: ready only if nothing is left open. Transcribe what was agreed into Decisions — anything undecided goes under Open questions and the spec stays Status: planning; never invent a decision to close a gap. Ask me (pb_ask, all independent questions at once) only about a choice that changes behaviour, an API or data and that we didn't settle.
- Verification defaults to tests; "New tests: no" only if I said so.
- Name: short kebab-case.${existing.length ? ` Existing: ${existing.join(", ")} (reusing a name rewrites it; read its spec.md first, it may differ from what you remember).` : ""}${extraBlock(extra)}${current ? `\n\n--- current ${P}/specs/${current.name}/spec.md (revise this) ---\n\n${current.markdown}` : ""}

Then tell me where it is. End your reply with this block, verbatim:

${tip("spec.next")}`;
}

/** Past the checkpoint: write the plan down while the whole discussion is still in context; pb then resets to it. */
export function checkpointPrompt(percent: number, specs: string[]): string {
  return `[pb:compact] This planning conversation is at ${percent}% of its context. Write the plan as it stands to the spec now, while you still have the whole discussion: afterwards the conversation continues from the spec alone.

${specs.length ? `Update ${specs.map((n) => `${P}/specs/${n}/spec.md`).join(", ")} with pb_update_spec, only the sections that changed (or pb_write_spec if most of it did).` : "Write it with pb_write_spec, Status: planning (Tasks and Verification can wait)."} Even if little is settled, the investigation isn't lost: record in Findings what was established and the dead ends (what was tried or ruled out, and why); in Decisions what is decided, with rejected ideas; in Open questions each option still being weighed, with what was found for and against it, and where the discussion stands. Leave out nothing the next step needs, and paste no code. Don't ask me anything now: what's undecided goes into Open questions. Then reply with one line, nothing else.`;
}

/** What a planning session is reset to: its spec(s), the plan as it stands, and the last exchange word for word. */
export function checkpointSummary(specs: { name: string; markdown: string }[], last?: { human?: string; answer?: string }, request?: string): string {
  const cut = (t: string) => (t.length > 6000 ? `${t.slice(0, 6000)}\n…[cut]` : t);
  return [
    `[pb plan checkpoint] The planning conversation was reset to its spec${specs.length > 1 ? "s" : ""} to free context. Continue from here: the spec is the plan as it stands, and its open questions are where we were. Planning mode is still on: the project's files stay untouched until /pb:build.`,
    ...(request ? [`\nOriginal request: ${cut(request)}`] : []),
    ...specs.map((s) => `\n--- ${P}/specs/${s.name}/spec.md ---\n\n${s.markdown}`),
    ...(last?.human || last?.answer
      ? ["\n--- the last exchange before the checkpoint, word for word ---", ...(last.human ? ["", `Human: ${cut(last.human)}`] : []), ...(last.answer ? ["", `Assistant: ${cut(last.answer)}`] : [])]
      : []),
  ].join("\n");
}

/** Continue planning a spec in a fresh session. */
export function continuePlanPrompt(name: string, markdown: string, standards: string, extra = ""): string {
  return `[pb:plan ${name}] Let's continue planning this, from its spec below: it holds what was found and decided so far. Don't redo the analysis or reopen rejected ideas unless something new turns up. The project's files stay untouched until /pb:build.

Investigating further:
1. Check the project map in AGENTS.md first — Security invariants in full, area headings for the touched paths only.
2. Grep narrow (one path and pattern, low limit, no surrounding lines).
3. Broad questions go to pb_explore, anything needing a scratch script to pb_try. Budget: fan out once (up to 6 pb_explore and pb_try calls in one block), then synthesize; never re-read a file the explorer listed. Prefer local code, docs and local/test data first; a read-only production query only when local data cannot answer it (goal states why, table, row cap at most ~500 rows); never write, never notify. State an uncertainty once as an Assumption with what would settle it and what settling costs; a second reversal must be a pb_try call, not more prose.

${CHALLENGE}

Start with the open questions: summarise where we are in a few lines, and ask what only I can answer.${standardsBlock(standards)}${extraBlock(extra)}

--- ${P}/specs/${name}/spec.md ---

${markdown}

End your first reply with this block, verbatim:

${tip("plan.next")}`;
}

/** A spec still marked planning: finish it before building. */
export function finishSpecPrompt(name: string, extra = ""): string {
  return `[pb:spec ${name}] Finish the spec ${P}/specs/${name}/spec.md for building: ask me with pb_ask, all at once, about each open question; write answered ones into Decisions; add the Tasks and the Verification line, leave no Open questions, and set Status: ready. Anything still unanswered stays Open and the spec stays Status: planning — never decide for me. (pb_update_spec for sections, or pb_write_spec). After writing it, stop: the harness shows it to me and asks whether to build.

${SPEC_FORMAT}${extraBlock(extra)}`;
}

/* ================================== build ================================== */

function gateLine(spec: ParsedSpec, buildCmd: string | null, each: boolean): string {
  if (spec.gate === "none") return `no checks run (${spec.gateReason})`;
  const end = spec.gate === "tests" ? "the full suite" : `a compile${buildCmd ? ` (\`${buildCmd}\`)` : ""}, no tests (${spec.gateReason})`;
  if (!each) return `after the last task the harness runs ${end}${buildCmd ? `; each task is also compiled (\`${buildCmd}\`) when done` : ""}; check each task yourself`;
  return spec.gate === "tests" ? "it runs the task's Test: command (a compile when there is none), and the full suite after the last task" : `it runs ${end}`;
}

/** How the build works: the mechanics only (the standards come separately). each: a check after every task. */
export function buildMechanics(spec: ParsedSpec, buildCmd: string | null, each = false, extra = ""): string {
  return `- This build is autonomous: never ask. Where the spec is unclear or a detail has moved, take the sensible reading and record it with pb_record_decision (assumption: true): what you assume, what would settle it, and what settling costs.
- Keep each change to its task. Tests: ${spec.newTests ? `add or extend tests for the behaviour each task introduces${spec.gate === "tests" ? ", seen failing before the code exists" : ""}.` : `add none for this feature (${spec.newTestsReason}).`} Change or remove an existing test only when what it covers changes; never skip or weaken one to get a check through.
- Goal, Decisions, Contracts, Threats and Acceptance bind you; the how is yours: record a shape later tasks need in "## Design" (pb_update_spec); later changes in pb_record_decision. If a Contract or the Goal cannot be built as written, stop with pb_task_done status "blocked" and the evidence: that needs a revised spec and a new approval.
- Don't commit or discard with git; leave .pi/ alone.
- Never touch production (data, channels, notifications); a prod read-only query only with why + table + cap ~500 rows.
- Tests quiet, full log to a temp file outside the project; failures back only.
- Finish each task with pb_task_done (changed/caveat/rejected/open): ${gateLine(spec, buildCmd, each)}. It gives you the next task.${extraBlock(extra)}`;
}

/**
 * The first build message. The spec is named, not pasted: the model reads it at the source, so a
 * long spec cannot be shortened, and the same text is never carried twice.
 */
export function buildIntro(name: string, spec: ParsedSpec, buildCmd: string | null, each: boolean, standards: string, extra = ""): string {
  return `[pb:build ${name}] Build ${P}/specs/${name}/spec.md. The planning is done: implement it as written.

${buildMechanics(spec, buildCmd, each, extra)}${standardsBlock(standards)}`;
}

export const isNone = (v: string | undefined) => !v || /^(none|n\/a|-|nothing)\.?$/i.test(v.trim());
const clip = (text: string, n: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, Math.max(0, n - 1)).trimEnd()}…` : flat;
};

/** Keep the first n lines, then one line saying how many were left out. */
const cappedList = (lines: string[], n: number, overflow: (rest: number) => string): string[] => [...lines.slice(0, n), ...(lines.length > n ? [overflow(lines.length - n)] : [])];

/**
 * Pi compacts at the context window minus this reserve (its default reserveTokens), so a build
 * session is reset before it gets there. The one copy: index.ts's reset trigger shares it.
 */
export const PI_RESERVE_TOKENS = 16384;

/**
 * What a build prompt says instead of a copy of the spec: the one file to read and the sections that
 * bind a step. A copy would be shortened, stale, or too big for the model reading it; the spec is
 * already the project's source of truth.
 */
export function specReference(name: string): string {
  return `The spec that binds this work is ${P}/specs/${name}/spec.md: read ${BINDING_SECTIONS.map((s) => `"${s}"`).join(", ")} before you change anything, and the sections a task names when it needs them.`;
}

/**
 * check: the command pb_task_done will run for this task, if any. red: its new tests must be seen failing first.
 * reference: the spec file and the sections that bind the task; read at the source, never pasted.
 */
export function taskPrompt(task: SpecTask, attempt: number, max: number, check: string | null, red = false, reference = ""): string {
  return `[pb:build] Task ${task.id}${attempt > 1 ? ` (attempt ${attempt} of ${max})` : ""}. Do only this task:

${task.text}

${reference ? `${reference}\n\n` : ""}Keep the change to this task: if it has grown into several changes, finish the smallest coherent part and report the rest as open. Don't run the full suite — the harness runs it after the last task. ${STRUCTURED_EDIT_RULE}

${red ? `Tests first: write the tests for its Acceptance lines, then call pb_tests_red. The harness runs \`${task.test}\` and needs it to fail for the behaviour that is missing (stubs of new signatures are fine, so the tests compile). Then make the change. ` : ""}(Comments: describe the code as it is, never its history — no dates or decisions.) When done, call pb_task_done with task "${task.id}"${check ? `: it runs \`${check}\` itself, so don't run that just before` : task.test ? ` once \`${task.test}\` passes` : ""} plus changed/caveat/rejected/open (each required: what changed, what the next task must respect, what was tried and discarded, what is still unchecked — "none" where there is genuinely nothing). If the Goal or a Contract cannot be built as written, status "blocked" with the evidence: the build stops for a revised spec and a new approval.`;
}

export function continuePrompt(task: SpecTask): string {
  return `[pb:build] Continue task ${task.id}: ${task.title}. Finish it with pb_task_done.`;
}

/**
 * check: nothing (the final check afterwards guards it). base: the build's base commit for the diff, if known.
 * reference: the spec file and the sections that bind the coherence pass.
 */
export function coherePrompt(base: string | undefined, attempt: number, max: number, reference = ""): string {
  const diff = base ? `git diff ${base} -- . ':(exclude).pi'` : `git diff HEAD -- . ':(exclude).pi'`;
  return `[pb:build] Coherence pass${attempt > 1 ? ` (attempt ${attempt} of ${max})` : ""}. Do only this task:

Read the whole change of this feature (\`${diff}\`, plus untracked files from git status), looking only for what task slicing leaves behind: duplicated helpers or logic across tasks, dead code a slice made redundant, and inconsistent naming or error handling. Consolidate what is worth consolidating, strictly within what the spec's Goal, Decisions, Contracts, Threats and Acceptance allow: change no behaviour, API, or data, and never weaken an existing test.

${reference ? `${reference}\n\n` : ""}${STRUCTURED_EDIT_RULE}

When done, call pb_task_done with task "cohere" plus changed/caveat/rejected/open ("none" where there is genuinely nothing). If the Goal or a Contract cannot be built as written, status "blocked" with the evidence. If there is nothing worth consolidating, say so and finish done anyway.`;
}

export function fixText(taskId: string, what: string, output: string, attempt: number, max: number, last: boolean, reference = ""): string {
  const head = `${taskId === "final" ? "The final check" : `The check for ${taskId}`} failed (attempt ${attempt} of ${max}): ${what}`;
  return last
    ? `${head}\n\n${output}\n\n${reference ? `${reference}\n\n` : ""}That was the last attempt: the build is paused. Stop here; the human decides how to go on.`
    : `${head}\n\n${output}\n\n${reference ? `${reference}\n\n` : ""}Fix the cause, then call pb_task_done again with task "${taskId}".`;
}

export function nudgePrompt(taskId: string): string {
  return `[pb:build] You stopped without finishing ${taskId === "final" ? "the final check" : taskId}. Carry on and finish with pb_task_done; if the Goal or a Contract cannot be built as written, pb_task_done with status "blocked" and the evidence; anything unclear is a reading you take and record with pb_record_decision (assumption: true).`;
}

/**
 * One finished task in a state summary: what it changed, plus the hooks a later task can
 * catch on (caveat, rejected, open) — "none" values stay out to keep the context lean.
 * Specs written before hooks existed carry only summary, which renders as the change.
 * Hooks are capped: a reset summary is context, not a transcript.
 */
const doneLine = (t: TaskProgress): string => {
  const changed = clip(t.changed ?? t.summary ?? "", 240);
  if (!changed) return "";
  const hooks = [
    ["caveat", t.caveat],
    ["rejected", t.rejected],
    ["open", t.open],
  ].flatMap(([k, v]) => (v && !isNone(v) ? [`${k}: ${clip(v, 180)}`] : []));
  return ` — ${[changed, ...hooks].join(" · ")}`;
};

/**
 * What a build session is reset or compacted to: everything the build needs, from what the harness knows.
 * At a task boundary (reset) nothing is half-done; mid-task (compaction) it adds what the task already
 * touched, so the model picks up where it was instead of starting the task over.
 */
export function buildStateSummary(o: {
  p: Progress;
  markdown?: string;
  mechanics: string;
  /** the current task's full prompt (or the final check's failure) */
  current: string;
  reason: "reset" | "compaction";
  /** files the current task has changed so far (mid-task only) */
  changed?: string[];
  /** files read in the part of the conversation that was summarized */
  read?: string[];
  previous?: string;
}): string {
  const { p } = o;
  const lines = [
    o.reason === "reset"
      ? `[pb build state: ${p.spec}] The build session was reset between two tasks to free context: nothing is half-done. The finished tasks are in the code and summarized below; the spec is the source of truth (${P}/specs/${p.spec}/spec.md — its Tasks and non-binding sections are left to the spec).`
      : `[pb build state: ${p.spec}] This conversation was compacted in the middle of ${p.current}. Carry on with it from where it was: its changes so far are in the files listed below; the spec is the source of truth (${P}/specs/${p.spec}/spec.md — its Tasks and non-binding sections are left to the spec).`,
    "",
    "How this build works:",
    o.mechanics,
    "",
    "Tasks:",
    ...p.tasks.map((t) => `- ${t.id} ${t.title}: ${t.status}${t.id === p.current ? " (current)" : ""}${t.status === "done" ? doneLine(t) : ""}`),
  ];
  // The spec's Decisions carry the recorded assumptions already; only an entry the spec refused
  // (or the human removed) is missing from the view and has to survive the reset here.
  const decisions = sectionOf(o.markdown ?? "", "Decisions").replace(/\s+/g, " ");
  const unrecorded = (p.assumptions ?? []).filter((a) => !decisions.includes(a.replace(/\s+/g, " ").trim()));
  if (unrecorded.length) lines.push("", "Assumptions made so far, not in the spec's Decisions:", ...unrecorded.map((a) => `- ${a.replace(/\s+/g, " ").trim()}`));
  if (o.changed?.length) lines.push("", `Files ${p.current} has changed so far:`, ...o.changed.map((f) => `- ${f}`));
  if (o.read?.length) lines.push("", "Files read before this point (read again what you need):", ...o.read.slice(0, 40).map((f) => `- ${f}`));
  if (p.lastVerify && p.lastVerify.ok === false) lines.push("", `Last check (failed):\n${p.lastVerify.summary}`);
  if (o.previous && !/^\[pb (build state|plan checkpoint)/.test(o.previous)) lines.push("", "Earlier conversation, summarized before:", o.previous);
  lines.push("", `--- ${o.reason === "reset" ? "next" : "current"} ---`, o.current);
  return lines.join("\n");
}

/* ================================== review ================================== */

/** The one read-only preamble every review role gets: the same limits wherever a pass judges code. */
export const READ_ONLY_PREAMBLE = `Do not modify any file. You have read/grep/find/ls only: no shell, so no git and no test runs. The change's diff is in the brief; read files for the context around it.`;

/**
 * How every pass classifies a problem the change did not cause. Pre-existing issues stay reportable;
 * one the change makes newly reachable is not pre-existing, and keeps its priority. Shared so the
 * reviewer and the abuse pass cannot drift on the one rule that decides whether a finding blocks.
 */
export const PRE_EXISTING_RULE = `Pre-existing issues are still findings, at most P2: report each one with \`outside: true\`, its own file, line and concrete fix — never leave it in prose, and never drop it because this change did not cause it. A problem the change makes newly reachable or materially worse is in the change and keeps its priority. Taste and hypotheticals are not findings.`;

export const REVIEWER_SYSTEM = `You are an independent REVIEWER in a fresh session. You did not take part in planning or building, and you are deliberately not shown the build conversation: judge the actual code.

## Ground rules

${READ_ONLY_PREAMBLE} The harness already ran the check on the current tree; the result is in the brief. Ignore .pi/ except the spec you are given.

The brief is a frozen snapshot: judge the change as it was when the review started.

## What to check

With a spec:
- Acceptance: every task acceptance id in the brief's checklist, one by one — met with evidence (file:line or test name), not met (and a P1 finding), or not verified with the reason. An id you leave out is not verified, never met; a criterion you did not check is not verified. The task's Test: command is the proof: check that the tests it runs really prove each line (a test that proves nothing is a P1), and judge a task with no Test: on whether its acceptance is genuinely untestable or docs-only behavior dressed as prose.
- Contracts: each exactly as written, or changed with a recorded decision. With no Contracts and more than one task, flag any seam the tasks share but nothing pins (P2).
- Design: the shape the build settled on, recorded as it went — consistent with the Contracts and Decisions, and the code matches it, or the change is recorded in Decisions.
- Decisions: respected, including every rejected alternative ("Not doing X"); flag anything the build brought back. Flag an assumption (a Decisions entry starting "Assumption", made while writing the spec or building) that looks wrong or second-best.
- Refactors and threats: tasks titled "(refactor)" keep behaviour unchanged; the spec's Threats and abuse, if any, has each abuse prevented and tested.
- The spec itself: a faithful build of a wrong plan is still wrong. Does the plan reach its goal, does it fit the code, did it miss a case? Report problems in the plan as findings on the spec file.
Without a spec: whether the change does what the intent in the brief says.

Always:
- Missing cases, error handling, convention breaks, changes outside the scope, debug output, commented-out code or leftover TODOs.
- Workarounds (silenced errors, hardcoded values, special-cased test inputs, sleeps, disabled checks) and security problems (injection, secrets in code, missing validation or authorisation).
- Tests, according to the spec's "New tests" line when there is one: tests that don't really test the behaviour, and missing tests for new behaviour. Existing tests that were deleted, cut down, skipped or disabled (the brief lists what the harness saw): fine when what they covered changed or moved (e.g. a refactor), a finding when they were weakened to get a check through. A test named as proof must reach the branch the change relies on: a sibling branch that produces the same failure (another cause, another status) proves only itself.
- Classifications: when behaviour is chosen by classifying an input (a kind, role, mode, type, state, host, tenant), test an input that matches more than one class. Check which class wins at each decision point — routing, lookup, authorization, default — and whether one class's guard is skipped because an earlier classifier already claimed the input. Two classifiers that can disagree on one input are a finding when the disagreement reaches a decision.
- The engineering standards in your instructions (AGENTS.md), if any: quality, dependencies, comments (restating the code, history such as dates, "decided", previous values or task ids, or left wrong by the change), tests.

## How to judge

Severity is the consequence and likelihood of a concrete failure in the shipped change, not how much you dislike the design. Before assigning P0 or P1, name the failure scenario: who or what triggers it, and what goes wrong. A different design, or a hypothetical failure with no path to it, is not a finding: P3 at most.
- P0 must fix: broken behaviour, a security problem, data loss.
- P1 fix before merging: an unmet acceptance criterion or decision, a bug, missing tests for new behaviour (unless the spec says no new tests), a weakened test, a risky change outside scope, a workaround where a proper fix belongs.
- P2 worth fixing: conventions, clarity, comments, a second-best choice.
- P3 nit.

Merge findings with the same concrete fix before reporting: same file and line plus the same action means one finding at the highest priority, its title naming each symptom — never two findings for one fix.
When the code is right and only the spec's framing is imprecise, report P3 with a proposed rewording, not P2: ask which reasonable reader would call the code wrong — if the code matches at least one reasonable reading of the spec, it's a note for the author, not a defect. A change that violates every reasonable reading keeps its priority.
${PRE_EXISTING_RULE}

## Report

Report the findings with the pb_report_findings tool: one call with all of them (an empty list when there are none), each with its priority, made as soon as you have them and before your reply: pb reads the call, never your prose.
Report acceptance in the same call: one entry for every id in the brief's checklist, with status met, not met, or not verified and evidence. Met and not met need evidence; not met also needs a P1 finding. An id you leave out is not verified, not passed: never write "all met" in prose instead of reporting the list.
Then reply briefly in markdown: only what is not a finding — context, a judgement call, a question. Don't repeat the findings or the acceptance checklist, and never leave a real problem here: a problem is a finding, with a priority and, when pre-existing, \`outside\`.`;

/** The abuse pass: one fresh call whose only job is to break the change, on sensitive ground by default (reviewer.security "auto"). */
export const ATTACKER_SYSTEM = `You are an ATTACKER in a fresh session, working for the defenders: find how this change can be abused or broken before someone else does. You did not build it and are not shown how it was built.

${READ_ONLY_PREAMBLE} Ignore .pi/ except the spec you are given.

For every entry point the change adds or alters (API routes, UI actions, commands, message or event consumers, webhooks, scheduled jobs, file or data imports), and every rule it enforces, ask who can reach it and what they gain by breaking it. Assume the caller controls every input, may hold a stolen session or another user's, can replay, reorder, race and automate requests, and can guess or enumerate identifiers. Look for:
- Access: authentication and authorization on every path and per object; what the caller must prove for each state change; logic reused from another flow that lost the precondition that made it safe there.
- Classifications: when a guard is chosen by a derived class (a kind, role, mode, type, state, host, tenant), try inputs that match more than one class. Check which class wins at each stage — routing, lookup, authorization, default — and whether one class's guard is skipped because another classifier claimed the input first.
- Business rules: bypassed with negative, zero, huge or fractional quantities, by repeating, skipping or reordering steps, by acting on yourself or twice (double discounts, refunds above what was paid, transfers to self, state changes out of order).
- Concurrency: races on shared state (two requests against one balance, stock or limit), check-then-act gaps, double submits, retries that aren't idempotent.
- Resources: work a single request can make unbounded (page sizes, upload sizes, loops, slow patterns, fan-out to other calls), cost amplification.
- Failure: a failure halfway leaving inconsistent or duplicated state; errors swallowed into success.
- Numbers and time: overflow, floating point for money, rounding, time zones, clock skew, expiry at the edges.
- Trust: data from the database, other services, queues or files treated as safe without the checks its source doesn't guarantee; injection of any kind (queries, commands, templates, paths, deserialization, redirects).
- Leaks: secrets, personal data, other users' data or whether an account exists, through responses, errors, logs or timing.
- Configuration: security-relevant defaults, migrations and permissions (grants, roles, public access).
- The spec's Threats and abuse, if any: each abuse really prevented, and tested.

Report only problems someone could actually use or hit, with report_findings, in one call made as soon as you have them and before your reply (pb reads the call, never your prose): in each title, the abuse in a sentence (who, how, what they gain or break), and a concrete fix, at the boundary or as an invariant (a type, a constraint, a transaction, a lock), not checks scattered through the code. Merge findings with the same concrete fix into one at the highest priority, its title naming each symptom. P0: exploitable now for serious gain or damage; P1: exploitable with effort, or for limited gain; P2: hardening worth doing. ${PRE_EXISTING_RULE} No findings is a fine result. Then reply with one line that adds no problem: a real problem belongs in the tool report, never only in that line.`;

/** The first message of a review session: its role, the brief, and how the session works. */
export function reviewSessionPrompt(brief: string, extra = ""): string {
  return `[pb:review] ${REVIEWER_SYSTEM}${extraBlock(extra)}

This session is read-only: don't edit or write files. The human can watch it and may ask you something; answer, and report again with pb_report_findings if your findings change.

--- brief ---

${brief}`;
}

export const VERIFIER_SYSTEM = `You are a VERIFIER in a fresh context. A reviewer reported the findings in the brief about a change that may be uncommitted. For each one, look at the code yourself and decide: confirmed (the problem is real where the finding says) or rejected (not real, or already handled), with one line of evidence (file:line).

A finding marked "outside the change" is pre-existing: confirm it when the problem is real and still present, whether or not this change caused it. Never reject a finding for being outside or pre-existing — that is its class, not a reason to dismiss it.

${READ_ONLY_PREAMBLE} Report with the report_verdicts tool: one entry per finding, by its number.`;

/**
 * A finding's detail lines, in the one order every reader sees them: post, brief and fix seed alike.
 * A field a finding gains is added here, never at a call site, so no renderer of findings shows less
 * than another.
 */
export const findingDetails = (f: Finding) => `${f.fix ? `\n   Fix: ${f.fix}` : ""}`;

export const findingLine = (f: Finding, n?: number) =>
  `${n !== undefined ? `${n}. ` : ""}[${f.priority}${f.outside ? " · Outside the change" : ""}] ${f.file ? `${f.file}${f.line ? `:${f.line}` : ""} — ` : ""}${f.title}${findingDetails(f)}`;

/**
 * How much of the frozen diff a review brief carries. Most changes fit; past the cap the reviewer
 * reads the files it needs, since it has no shell to produce a diff itself.
 */
export const REVIEW_DIFF_CHARS = 120_000;

export interface ReviewBrief {
  /** the spec, when the change was built from one: named, never pasted */
  spec?: { name: string; parsed: ParsedSpec };
  /** the spec's acceptance checklist: every id must be reported, omission counts as not verified */
  acceptance?: AcceptanceCriterion[];
  /** what the change is meant to do, when there is no spec */
  intent?: string;
  base?: string;
  /** the diff from base (or HEAD) to the tree the review started on, capped for the brief */
  diff?: string;
  changed: string[];
  stat: string;
  check: string;
  focus: string;
  /** the previous review: only its findings, acceptance and what changed since are reviewed */
  previous?: { snapshot: string; findings: Finding[]; changed: string[]; acceptance?: AcceptanceCheck[] };
  /** existing tests the build deleted, cut down or skipped */
  testChanges?: string[];
  /** tasks whose new tests were never seen failing, with why: the review judges each */
  redNotes?: string[];
  /** what the build itself reported as still unchecked, one line per task: claims to verify, not evidence */
  openNotes?: string[];
  /** what the fix laps reported (fixed/skipped titles plus their test results): judge the evidence, not the claim */
  fixReports?: Array<{ fixed: string[]; skipped: string[]; tests: string }>;
  /** where the spec's Design comes from: how hard to look for drift between Design, Decisions and code */
  designNote?: string;
  /** acceptance lines added, dropped or reworded since the build started (advisory): clarification or goalpost-moving */
  acceptanceDrift?: string;
  /** identifiers the diff removed that prose still cites (file:line each): P2 candidates, history excepted */
  staleRefs?: Array<{ symbol: string; referrers: string[] }>;
  /** the spec was edited by hand after writing: gates were bypassed visibly, judge its shape too */
  humanOverride?: string;
  /** why the recorded diff base is missing or unusable: what the reviewer can't see must be said */
  baseWarning?: string;
  /** untracked files over the snapshot cap: in no diff, so the reviewer reads them itself */
  largeFiles?: string[];
}

/**
 * Where the spec's Design comes from, from its events (each stamped when written): planner-origin when the
 * build never wrote it, otherwise how often the build rewrote it and whether the first write came before
 * any task proof, mid-build, or only after the last check (post-hoc: the shape was never a constraint).
 * Undefined when the spec has no Design section. One line for the reviewer: how hard to look for drift.
 */
export function designProvenance(markdown: string, events: Array<Record<string, unknown>>): string | undefined {
  if (!sectionHeading("Design").test(markdown)) return undefined;
  const at = (e: Record<string, unknown>) => (typeof e.at === "string" ? e.at : "");
  const buildStart = events.find((e) => e.type === "build-start");
  const writes = events.filter((e) => e.type === "spec" && typeof e.update === "string" && /^design$/i.test(e.update));
  const buildWrites = buildStart ? writes.filter((e) => at(e) >= at(buildStart)) : [];
  if (!buildWrites.length) return "Design provenance: from the plan, untouched by the build.";
  const proof = events.filter((e) => (e.type === "red" || e.type === "check") && typeof e.task === "string" && e.task !== "final").map(at).sort();
  const first = at(buildWrites[0]);
  const where = !proof.length ? "during the build" : first < proof[0] ? "before any task proof" : "during the build";
  const last = at(buildWrites[buildWrites.length - 1]);
  const postHoc = proof.length > 0 && last > proof[proof.length - 1];
  const times = buildWrites.length === 1 ? "recorded once" : `rewritten ${buildWrites.length} times`;
  return `Design provenance: ${times}, first ${where}${postHoc ? ", last after the last check — every change should be in Decisions" : ""}.`;
}

/**
 * Acceptance lines added, dropped or reworded since the build started (advisory only): the
 * build-start event carries the Tasks text as the build saw it. A quiet tightening of the goal
 * mid-build looks exactly like drift here, so the reviewer judges whether each change is a
 * legitimate clarification.
 */
export function acceptanceDrift(markdown: string, events: Array<Record<string, unknown>>): string | undefined {
  const start = events.find((e) => e.type === "build-start" && Array.isArray(e.taskTexts));
  if (!start) return undefined;
  const line = /^\s*[-*]\s*Acceptance(\s*\([^)]*\))?:/;
  const acc = (text: string) => text.split("\n").map((l) => l.trimEnd()).filter((l) => line.test(l)).map((l) => l.trim());
  const before = acc((start.taskTexts as unknown[]).filter((x): x is string => typeof x === "string").join("\n"));
  const after = acc(markdown);
  const missing = before.filter((l) => !after.includes(l));
  const added = after.filter((l) => !before.includes(l));
  if (!missing.length && !added.length) return undefined;
  return [
    "Acceptance drift during build (judge whether each is a legitimate clarification or a quiet change of the goal):",
    ...cappedList(missing, 8, (n) => `… +${n} more`).map((l) => `- dropped/reworded since build start: ${l}`),
    ...cappedList(added, 8, (n) => `… +${n} more`).map((l) => `- added/reworded during build: ${l}`),
  ].join("\n");
}

/** Static parts first (the spec), the parts that change between reviews last: a repeat review reuses the cached prefix. */
export function reviewerBrief(o: ReviewBrief): string {
  const lines: string[] = [];
  const focus = o.focus.replace(/\s+/g, " ").trim();
  if (o.spec)
    lines.push(
      `# The spec (${P}/specs/${o.spec.name}/spec.md)`,
      "",
      `Read it at that path before judging: its ${BINDING_SECTIONS.map((s) => `"${s}"`).join(", ")} and each task's Acceptance lines are what the change must satisfy. The spec is the source of truth, not this brief.`,
      "",
    );
  else lines.push("# No spec", "", `There is no spec: judge the change against its intent and the engineering standards.`, "", `Intent: ${o.intent || "(not given: infer it from the change, and say what you inferred)"}`, "");
  lines.push(`# Review${o.spec ? `: ${o.spec.name}` : " of the uncommitted change"}${focus ? ` — focus: ${focus}` : ""}`, "");
  if (o.previous) {
    lines.push(
      "## This is a follow-up review",
      "",
      "The previous review confirmed the findings below. For each: is it fixed? Report the ones still open again (same title). Then focus on what changed since that review for new problems; revisit unchanged code only where the change makes an older problem newly relevant.",
      "",
      ...(o.previous.findings.length ? o.previous.findings.map((f, i) => findingLine(f, i + 1)) : ["(none)"]),
      "",
      `Changed since the previous review (its tree is commit ${o.previous.snapshot}): the files below; the diff below covers the whole change.`,
      "",
      o.previous.changed.join("\n") || "(nothing)",
      "",
      ...(o.previous.acceptance?.length
        ? [
            "Acceptance at the previous review (carry a `met` forward only when nothing changed since can affect it; report every current id anyway):",
            "",
            ...o.previous.acceptance.map((c) => `- ${c.criterion}: ${c.status}${c.evidence ? ` — ${c.evidence}` : ""}`),
            "",
          ]
        : []),
    );
  }
  if (o.acceptance?.length) {
    lines.push(
      "## Acceptance checklist",
      "",
      "Report every id below in the `acceptance` array of your report, with status met, not met, or not verified and evidence. An id left out counts as not verified: a criterion not checked is never met.",
      "",
      ...o.acceptance.map((c) => `- ${c.id}${c.task ? ` (${c.task})` : ""}: ${c.text}`),
      "",
    );
  }
  lines.push(
    "## How to see the change",
    "",
    o.base
      ? `Base commit: ${o.base}. The diff below is from that commit to the tree the review started on. Read files with read/grep/find/ls for anything past the cut, and read the untracked files listed below.`
      : "The diff below is from HEAD to the tree the review started on. Read files with read/grep/find/ls for anything past the cut, and read the untracked files listed below.",
    ...(o.baseWarning ? ["", `⚠ ${o.baseWarning}`] : []),
    "",
    "## The diff",
    "",
    o.diff?.trim() ? cap(o.diff.trim(), REVIEW_DIFF_CHARS) : "(no diff captured: the change is in the files listed below; read them.)",
    "",
    "## Changed files",
    "",
    o.changed.join("\n") || "(none)",
    o.stat ? `\n${o.stat}` : "",
    ...(o.largeFiles?.length
      ? ["", "## Files too large to capture", "", "These untracked files are over 20 MB: snapshots and diffs skip them, so read them yourself if they matter:", ...o.largeFiles.map((f) => `- ${f}`)]
      : []),
    "",
    ...(o.testChanges?.length ? ["", "## Existing tests the build changed", "", "Deleted, cut down or skipped; judge whether each was justified:", ...o.testChanges.map((c) => `- ${c}`)] : []),
    ...(o.redNotes?.length
      ? ["", "## New tests never seen failing", "", "Judge each: does its acceptance still have a test that checks it?", ...o.redNotes.map((n) => `- ${n}`)]
      : []),
    ...(o.openNotes?.length
      ? [
          "",
          "## What the build says it left unchecked",
          "",
          "The build's own open items, one per task. They are claims to verify, not evidence: check each against the code and report what is still open.",
          ...o.openNotes.map((n) => `- ${n}`),
        ]
      : []),
    ...(o.fixReports?.length
      ? [
          "",
          "## What the fix laps reported",
          "",
          "Each lap's own fixed/skipped claims with the tests it ran: verify each fix against the change and the check below, not against the claim.",
          ...o.fixReports.flatMap((r, i) => [
            `Lap ${i + 1} fixed: ${r.fixed.length ? r.fixed.join("; ") : "(none)"}`,
            `Lap ${i + 1} skipped (needs a spec revision, not an edit): ${r.skipped.length ? r.skipped.join("; ") : "(none)"}`,
            `Lap ${i + 1} tests: ${r.tests || "(not reported)"}`,
          ]),
        ]
      : []),
    ...(o.designNote ? ["", "## Design provenance", "", o.designNote] : []),
    ...(o.acceptanceDrift ? ["", "## Acceptance drift during build", "", o.acceptanceDrift] : []),
    ...(o.humanOverride ? ["", "## Human override", "", o.humanOverride] : []),
    ...(o.staleRefs?.length
      ? ["", "## Possibly stale prose references", "", "These identifiers vanished from the code but are still cited in prose; judge each as a P2 candidate (intentional history is fine):", ...o.staleRefs.map((s) => `- ${s.symbol}: ${s.referrers.join(", ")}`)]
      : []),
    "",
    "## The check the harness ran",
    "",
    o.spec?.parsed.gate === "none" ? `None: verification is "none" for this feature (${o.spec.parsed.gateReason}). Look harder at correctness yourself.` : o.check,
  );
  return lines.join("\n");
}

export const SPEC_REVIEWER_SYSTEM = `You are a SPEC REVIEWER in a fresh context: you review one feature spec before anything is built, so design flaws are caught at 1x cost instead of 3x. The spec is a frozen draft: this is the only pass; there are no earlier findings, rounds or outside lane. Inspect the repository with read/grep/find/ls only: you have no shell, so you cannot run commands, tests or builds. Do not create, modify or delete files.

Report every finding with report_findings in one call, an empty list when there are none, and make that call as soon as you have them, before writing your reply: pb reads the call, never your prose, so a reply is not a report. The title is one sentence a tired human can act on: what goes wrong, for whom, and where. The optional file:line and fix are the supporting evidence and the single change you would make. If you weighed another fix and rejected it, say why in the same fix line; do not report an either/or as a finding.

Priority:
- P0 — unsafe to build: a security or authorization hole, data loss or corruption, or a contract contradiction that cannot be built as written. Only P0 blocks the build.
- P1 — a real problem likely to make the build wrong or fail, but not unsafe. Advisory to the human; do not inflate a normal-path bug, a missing test or a taste issue to P0.
- P2 — a real weakness, edge case, ambiguity, missing measurement, documentation or rollback gap. P3 — polish or preference.
No P0 means pass, however many P1-P3 findings you report.

Check the spec against the code: every path:line resolves; every Test: command names a runner and test file the project has; every observable contract value is backed by the code path or test it cites; a contract the tasks do not implement, or a contradiction between Contracts, Decisions, Migration, Threats and tasks, is a finding. Attack the Decisions and each rejected alternative; flag an unmeasured quantitative claim; probe undefined empty paths. A point the spec marks decided is settled: check for new evidence, and comment only when you find it. When a rule is selected by a classification, test an input that matches more than one class and say which class must win. Do not reward length or polish. No findings is a valid result.

A fork a read-only inspection can settle, settle before you write, with one cheap targeted read or grep, and put the file:line and result in the finding. Never ask for a test, build or install: you cannot run one. What no read settles, report as a finding with the question the human must answer. Be concise: conclusion first.`;

/** One frozen draft, one independent pass: no earlier findings, rounds or outside lane. */
export function specReviewBrief(name: string, markdown: string): string {
  return `# Spec to review: ${name}

${markdown}

# Your job

Review this one frozen draft against the repository as it is now. Report findings with report_findings: an empty list is a pass; only a P0 blocks the build, while P1-P3 are advisory to the human. Do not modify the spec or the project.`;
}

export function reviewStateSummary(o: { label: string; role: "review" | "abuse"; brief: string; findings: Finding[]; acceptance?: AcceptanceCheck[]; read?: string[]; wrapUp?: boolean }): string {
  return [
    `[pb review state: ${o.label}] This ${o.role === "review" ? "review" : "abuse-pass"} session was compacted. The brief below is the complete baseline: re-read any files you need from it, and carry on where the findings and acceptance checks leave off.`,
    "",
    ...(o.wrapUp ? ["Compacted repeatedly without reading anything new: report findings with what you have and stop — do not start another reading round.", ""] : []),
    ...(o.read?.length ? ["Files read before this point (read again what you need):", ...o.read.slice(0, 40).map((f) => `- ${f}`), ""] : []),
    ...(o.acceptance?.length
      ? ["--- acceptance so far ---", "", ...o.acceptance.map((c) => `- ${c.criterion}: ${c.status}${c.evidence ? ` — ${c.evidence}` : ""}`), ""]
      : []),
    "--- brief ---",
    "",
    o.brief,
    "",
    "--- findings so far ---",
    "",
    ...(o.findings.length ? o.findings.map((f, i) => findingLine(f, i + 1)) : ["(none yet)"]),
  ].join("\n");
}

export function verifierBrief(findings: Finding[], base: string | undefined, specPath?: string, diff?: string): string {
  return [
    "# Findings to verify",
    "",
    ...findings.map((f, i) => findingLine(f, i + 1)),
    "",
    "# The change",
    "",
    base ? `Base commit: ${base}. The diff below is from that commit to the tree the review started on.` : "The diff below is from HEAD to the tree the review started on.",
    "",
    diff?.trim() ? cap(diff.trim(), REVIEW_DIFF_CHARS) : "(no diff captured: read the files named by the findings.)",
    ...(specPath ? ["", "# The spec it was built from", "", `Read it at ${specPath}: it is the source of truth for what the change should do.`] : []),
  ].join("\n");
}
