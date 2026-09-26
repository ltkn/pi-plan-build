# Changelog

## Unreleased

- **Cut down.** Build instructions go from ~3,600 to ~1,100 characters (six short lines), the plan prompt from ~1,800 to ~730, the spec prompt from ~3,400 to ~1,450: long rule lists made models write more defensive, verbose code. The spec needs only Goal, Decisions and Tasks (Out of scope, Context, Acceptance criteria are optional), with decisions stated as they stand now, without dates or history. Comments explain the code as it is, never its history (no dates, "decided", previous values, task ids, revisit notes), with a one-line reminder in every task. No more "best solution even if more work". Test output sent back to the agent: 30 key lines and a 40-line tail, 4,000 characters by default
- **No more gap check at the start of a build**: it cost too much context and stopped the build over points the model could resolve itself. The build now starts with T1 and treats the spec as settled. Where the spec is ambiguous, contradicts itself or doesn't match the code, the builder takes the sensible reading, records it as an assumption in the spec's Decisions (`pb_record_decision` with `assumption: true`) and carries on; it stops only for choices that change behaviour, an API or data. The build summary lists the assumptions and the reviewer checks them. `pb_spec_gaps` is removed
- `/pb:spec` runs a consistency pass before writing (examples against rules, acceptance against tasks, "unchanged" against "extended", every path and name against the code), fixes what it finds in the spec, and tells you; specs state each fact once
- The build ignores `.pi/` except its spec
- The build session runs on the model and thinking level of the session you ran `/pb:build` from; a new Pi session would otherwise start from your settings' defaults (e.g. without thinking)

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
