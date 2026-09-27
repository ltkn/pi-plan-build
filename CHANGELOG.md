# Changelog

## 1.1.0

- **Builds run in the same session by default.** `/pb:build` lifts the planning protection and starts T1 right in the conversation that planned it, so nothing discussed is lost and the prompt cache keeps working; the spec isn't repeated when that session wrote it. `/pb:build --fresh` builds in a new session seeded with the spec (named, on your model and thinking level). pb recommends the fresh session itself when this one is over `freshAbove` (50%) of its context window, or when `buildModel` names another model: switching models mid-conversation re-sends the whole conversation uncached
- **The check runs inside `pb_task_done`.** The tool that finishes a task hands out the next one, and the harness runs its checks in that same call (the final check, by default), answering with the failure to fix, so a whole build is one run: no stop and restart per task, the prompt cache stays warm through long test runs (pb also asks Pi to keep it warm while a check runs), and a task can't be closed from a parallel tool batch. Its statuses are `done` and `blocked`; the task prompt names the command, so the agent doesn't run it again just before
- **One decisive check, at the end** (`taskChecks`, `"end"` by default): tasks are no longer checked one by one; the harness runs the full suite (a compile for `Verification: build`) after the last task, inside `pb_task_done`, and a failure goes back to fix. Per-task checks made every task leave the build green on its own, which sliced work unnaturally. `"each"` brings them back: a task's `Test:` line, or a compile when it has none (no longer the whole suite)
- **Changed tests don't stop the build**: deleted, cut-down or skipped existing tests no longer fail a task (a refactor legitimately moves and merges them); they're listed at the end, and the reviewer judges whether each was justified
- **Refactoring first**: the spec puts refactoring the standards call for in leading `(refactor)` tasks that keep behaviour (a large one becomes its own spec); the reviewer checks them for unchanged behaviour
- **The reviewer judges the spec too**: a faithful build of a wrong plan is still wrong; plan problems come back as findings on the spec file. The first review in a project offers to run the reviewer on a different model than the session's
- **A timeout on build questions** (`askTimeoutSec`, 5 minutes): unanswered, the build goes on with the recommendation, recorded as an assumption
- **Undo keeps your words**: the note on a rewound conversation repeats what you said in the part that was undone; undoing an undo returns your last message to the editor
- **The baseline runs in a git worktree** at the last commit, so it can't collide with a build in the working copy (Maven's `target/`); `node_modules` and virtualenvs are borrowed from the working copy
- **The spec is the planning session's checkpoint.** Past `checkpointAt` (75% of the window, capped to stay clear of Pi's own compaction), Pi writes the plan to its spec right after its reply, while it still has the whole discussion, and pb resets the session to the spec: a compaction with the spec as its summary and nothing else kept, with no summarizing model call. Should Pi compact a planning session anyway, the spec is its summary too
- **Specs that save re-analysis**: a `## Findings` section (files and roles, code to imitate by path, constraints, baseline), rejected ideas with their reasons, and `Status: planning` with `## Open questions` for an unfinished discussion (no tasks or verification needed yet). `/pb:build` finishes a planning spec before building. The spec's size is reported, with a gentle note past ~12k tokens, never a rejection
- **`pb_update_spec`**: replace or append one section, or set the status, so a checkpoint rewrites only what changed
- **`/pb:plan <spec>`** continues planning a spec in a fresh session seeded from it, open questions first
- **Checkpoints that keep an unsettled discussion**: Findings include the dead ends and why; Open questions include each option still being weighed with what was found for and against; the reset keeps your last message and the reply to it word for word. `/pb:checkpoint` checkpoints on demand (e.g. before quitting); `/pb:checkpoint undo` brings the whole discussion back
- **Fixed**: a build in the session that wrote the spec no longer assumes the session still knows it after a compaction dropped it; `/pb:spec <name>` revises from the file on disk
- **Java 25 defaults**: in a Maven or Gradle project, pb's standards section adds "Java 25: records, sealed types, pattern matching, virtual threads and scoped values; no Lombok". The quality line asks for modern idioms and the latest language features even where the surrounding code is older, with outdated code refactored as a task of its own
- **Questions without pausing (`pb_ask`)**: a dialog with options and Pi's recommendation, answered in place; during a build the answer goes into the spec's Decisions. Without a UI, a build question pauses as before. A pause that wasn't a failing check no longer costs the task an attempt, and resuming it sends a one-line "continue" instead of the whole task again
- **A reminder before a pause**: an agent that ends its run mid-task gets one reminder per attempt (`agent_before_settle`, like a stop hook) before the build pauses
- **`/pb:build` writes the spec when there isn't one**, then shows all of it (in the session, not sent to the model again) and asks: build here, build in a fresh session, edit the spec first (in an editor; saved only when it parses, and the build then gets your version), or not now. `/pb:spec` remains for revising, or writing several specs, before building
- **`pb_explore` instead of a fixed explorer step**: the planner (or the build) asks a separate, read-only context a question when a broad look is worth it and gets back only the answer; several run in parallel, the thinking level defaults to low, `explorer.model` can pick a cheaper model. Its usage is reported to Pi and counted in `/pb:stats`. The `explore` setting is gone
- **The test baseline runs in the harness**: `/pb:plan` runs the suite in the background (no tokens) and posts the result; `/pb:build` warns when it was red (`baseline` in the config)
- **Planning changes are shown**: edits are blocked while planning, but commands can still write, so pb snapshots the project when planning starts and, at `/pb:build` or `/pb:plan off`, lists what changed and offers to restore it
- **pb writes a build session's compaction summary** from its own state (tasks and their summaries, the current task, the last failure, the spec) instead of another model call
- **Optional pruning** (`pruneAbove`, off by default): above that share of the context window, long tool output of finished tasks is replaced by a short note at each task boundary
- **Undo rewinds the conversation too**: `/pb:undo` moves the session back to where the task was handed out, with a one-line note of what was undone instead of an LLM summary, so the discarded attempt doesn't anchor the next one; the cached prefix stays valid. Undoing an undo goes back to the old branch. After a rewind past the build's first message, a resume sends it again
- **A structured, double-checked review**: the reviewer reports findings through a `report_findings` tool (priority, file, line, fix) instead of prose; a second fresh call checks every P0/P1 against the code and dismissed ones are listed with its evidence (`reviewer.verify`). Any confirmed P0/P1 means changes needed. A reviewer that answers in prose only is read from line-leading `[Pn]` tags, so "no [P0] issues" no longer counts as a finding
- **Follow-up reviews**: the next `/pb:review` checks the previous findings and only what changed since; nothing changed means no call at all; `--full` reviews everything again. The brief puts the spec first, so repeat reviews reuse the cached prefix
- **Review without a spec**: `/pb:review [intent]` reviews the uncommitted change against its intent and your standards
- **The reviewer can't change your files**: pb snapshots the tree before the review and puts back anything it touched
- **`/pb:deps [which]`**: dependency versions, deprecations and upgrade risks, investigated in planning mode as a change of its own; the default standards no longer have every plan look up the latest versions
- **Your standards, once, in AGENTS.md**: the first time you plan, pb offers to add a short default section (quality with a proper fix rather than a workaround, modern idioms and the latest language features even where the surrounding code is older, with outdated code refactored as a task of its own, current non-deprecated APIs, comments without history, tests) to the project's or your global `AGENTS.md`, which Pi loads into every session itself (planning, build, reviewer, plain sessions). pb repeats them in a message only when the session started before they existed
- **Prioritized review findings**: P0 must fix, P1 before merging, P2 worth fixing, P3 nit; the header shows the count per priority
- **`buildModel`**: build on another model than the one you planned with (e.g. plan on a strong model, build on a local one)
- **Cut down.** Build instructions go from ~3,600 to ~1,100 characters (four short lines), the plan prompt from ~1,800 to ~730, the spec prompt from ~3,400 to ~1,450: long rule lists made models write more defensive, verbose code. The spec needs only Goal, Decisions and Tasks (Out of scope, Context, Acceptance criteria are optional), with decisions stated as they stand now, without dates or history. Comments explain the code as it is, never its history (no dates, "decided", previous values, task ids, revisit notes), with a one-line reminder in every task. No more "best solution even if more work", in the prompts or the default standards. Test output sent back to the agent: 30 key lines and a 40-line tail, 4,000 characters by default
- **No more gap check at the start of a build**: it cost too much context and stopped the build over points the model could resolve itself. The build now starts with T1 and treats the spec as settled. Where the spec is ambiguous, contradicts itself or doesn't match the code, the builder takes the sensible reading, records it as an assumption in the spec's Decisions (`pb_record_decision` with `assumption: true`) and carries on; it asks only about choices that change behaviour, an API or data. The build summary lists the assumptions and the reviewer checks them. `pb_spec_gaps` is removed
- `/pb:spec` runs a consistency pass before writing (examples against rules, acceptance against tasks, "unchanged" against "extended", every path and name against the code), fixes what it finds in the spec, and tells you; specs state each fact once
- **Stats**: the explorer's calls, compactions, prunes, reminders and questions; after a new plan in a build's session, its turns no longer count for the finished spec
- A progress line above the editor shows the build's tasks
- The build ignores `.pi/` except its spec
- The build session runs on the model and thinking level of the session you ran `/pb:build` from; a new Pi session would otherwise start from your settings' defaults (e.g. without thinking)
- Removed leftovers of wf: unused JSON-block parsing, transcript and session options in the runner, the diff summary and merge flags in the checkpoints

## 1.0.0

pb replaces wf: a simpler flow built around a self-contained spec, a fresh build session and harness-run checks. Renamed from pi-ledger-workflow to **pi-plan-build**.

- `/pb:plan <what you want, in your own words>`: plan together. Pi investigates freely (bash, the build and tests, curl, one-off scripts or programs in a temp directory) while edits to the project's files are blocked for that session (a `tool_call` guard that survives restarts); `/pb:plan off` lifts it
- `/pb:spec [which]`: Pi writes one spec per feature through `pb_write_spec`, which validates the format (header with depends-on, verification and new-tests lines; Goal, Out of scope, Decisions with rejected alternatives, Context, Acceptance criteria, Tasks) and rejects what doesn't parse
- `/pb:build [name]`: a new session seeded only with the spec. The agent first checks the spec against the code (`pb_spec_gaps`); gaps pause the build. The harness then hands out the tasks one by one; the agent finishes each with `pb_task_done`, and the harness runs its check (`tests`: the task's test command and the full suite at the end; `build`: compile/typecheck only; `none`). Failures go back to the agent until `maxAttempts`, then the build pauses; `/pb:build [guidance]` resumes. Decisions made during the build are written into the spec (`pb_record_decision`). `New tests: no` builds without adding tests
- `/pb:review [focus]`: a fresh check, then one fresh reviewer with the spec, the diff and the check result, but not the build conversation; findings land in the session, verdict pass/changes needed
- `/pb:undo`: per-task snapshots in git's object store (never touching your branch or index), reversible; deleting, cutting or skipping existing tests fails a task's check
- An unfinished build whose session is gone (e.g. after a crash) can be restarted from any session with `/pb:build`; finished tasks stay done
- Planning and build sessions are named ("plan: …", "build: <spec>") so `/resume` finds them, and their first message shows `pi --session <id>`; `/pb:status` shows each build's session
- Spec names complete as you type after `/pb:build`, `/pb:review`, `/pb:stats` and `/pb:archive`
- `/pb:status`, `/pb:stats [all]` (first-try rate, checks, pauses, review, the build session's tokens, cache share, peak context, cost, time), `/pb:archive` (to the git-ignored `.pi/pb-archive/`), `/pb:help [topic]` and a What-now block after every step
- The quality bar (best practice, clean, secure, current APIs, no quick fixes) and the comment rules carry over into planning, building and review
- Removed with wf: the fresh manager/worker loop, the ledger files, the tester and parked spec tests, merging, escalation, `/wf:models`
- Requires Node ≥ 22.19 (Pi's minimum); TypeScript 7

## 0.2.0

- `workflow-help.md`: day-to-day guide for the normal path and edge cases (stuck tasks, stalls, replanning, undo, review findings)
- Situational **What now** block after every scope, plan, build and review result, taken from `workflow-help.md`
- `/wf:help [topic]` posts a guide section into the session
- Prompts hardened for smaller models:
  - output templates are valid JSON, with the field rules listed under them; the parser also repairs raw newlines inside strings
  - worker notes come in their own ```` ```wf-notes ```` markdown block instead of a JSON string
  - the manager sends only changed or new tasks; the harness keeps task order and the plan's details
  - workers must not discard working-tree changes with git or delete/skip/weaken tests (the reviewer checks for the latter)
  - the manager may drop a task only when it's unnecessary, never because it's hard; continuing a partial task is allowed, repeating an unchanged round is not ("files changed" is now in its brief)
  - explicit precedence when sources disagree: newest decision > manager instruction > task detail > plan
  - the cut-off summarizer always reports "partial" (it can't see tool results) and gets the task's acceptance
  - `/wf:plan` re-runs replace reversed decisions and keep task ids, status, attempts and source
- Prompts improved for smaller models:
  - worker: defined statuses, a stop rule (same error three times → report partial/blocked), read-before-edit steps, no debug leftovers, fixed notes headings, calibrated assumptions/proposals; its brief now names the verify command, the attempt number and the previous attempt at the same task
  - manager: structured `instruction`, escalation after 2 unsuccessful rounds, a tool budget, may ask when verification fails for unrelated reasons
  - reviewer: acceptance criteria checked one by one with evidence, calibrated `changes_needed`, no full re-run of the suite
  - scope records the test baseline (pass/fail, duration, pre-existing failures) and the targeted-test command; plan asks for smaller tasks with self-checkable acceptance
  - every fresh call ends with a role-specific instruction naming the block it must end with
- Fix: answering an attempt-limit pause with `/wf:build <guidance>` now resets the task's attempts (it used to re-ask immediately); plain `/wf:build` prompts for the answer

## 0.1.0

- `/wf:scope`, `/wf:plan`, `/wf:build`, `/wf:review`, `/wf:status`
- Fresh-context manager/worker loop over an on-disk ledger (`.pi/wf/`), test suite as ground truth
- Build-time questions (`questions: "ask" | "assume"`), inline answers, `/wf:build <answer|guidance>`
- Guards: round budget, per-task attempt limit, no-progress stop, cut-off summarizer, capped plan/notes
- Independent review without worker notes; review follow-ups become R-tasks
