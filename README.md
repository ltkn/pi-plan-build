# pi-plan-build

**Plan → spec → build → review for the [Pi coding agent](https://pi.dev).**
Plan a feature with Pi, build it task by task in the same conversation behind
checks the harness runs, and have it reviewed by someone who never saw the
build. Your engineering standards live in AGENTS.md, written once.

```
/pb:plan <what>       plan together; project files untouched; the test baseline runs in the background
/pb:build [name]      write the spec if needed, show it, then build it here, task by task, each checked
                      (--fresh: in a new session from the spec)
/pb:review [focus]    independent review against the spec and your standards, P0–P3, blocking findings
                      double-checked; follow-ups look only at what changed (--full: everything)
                      no spec? reviews the uncommitted change against its intent
/pb:deps [which]      check dependencies and propose upgrades, as a change of their own
/pb:spec [which]      write or revise a spec without building (optional)
/pb:undo · /pb:status · /pb:stats · /pb:archive · /pb:help
```

## Install

```bash
pi install git:github.com/ltkn/pi-plan-build@v1.0.0   # from git
pi install /path/to/pi-plan-build                      # a local checkout, loaded in place
```

Add `.pi/pb/` to your project's `.gitignore` unless you want to keep the specs
in the repository.

## The flow

```
/pb:plan let admins cancel an order while it is still pending
   → the harness runs the test suite in the background (baseline, no tokens)
   → Pi investigates (anything goes, but the project's files stay untouched),
     asks pb_explore for the broad questions, proposes an approach and asks
     what only you can decide
you: "Only PENDING orders. Not soft delete: audit lives elsewhere."
/pb:build
   → Pi writes .pi/pb/specs/order-cancellation/spec.md (goal, decisions,
     tasks with their test commands); you read it: build here / fresh / edit / not now
   → one run: T1 → check ✓ → T2 → check ✗ → fix → ✓ → … → full suite ✓
   ✅ BUILD COMPLETE
/pb:review
   → a fresh reviewer: every acceptance criterion with evidence, decisions,
     tests, comments, your standards, security; P0/P1 findings double-checked
   → fix them right there, /pb:review again (only the findings and what changed)
```

For a small change, skip the flow: work with Pi as usual, then `/pb:review`.

## Why it's built this way

- **The build stays in the conversation.** Nothing you discussed is lost, and
  the prompt cache keeps working. The spec is written to disk so the decisions
  (and rejected ideas, as "Not doing X, because …") survive compaction and reach
  the reviewer. pb recommends a fresh session, built from the spec alone, when
  this one is over half full, or when the build runs on another model (a switch
  mid-conversation re-sends everything to the new model, uncached).
- **The check runs inside the tool that finishes a task.** `pb_task_done` runs
  the task's check and answers with the failure to fix or the next task, so the
  whole build is one uninterrupted run: no stop and restart per task, and the
  prompt cache stays warm through long test runs. The agent's word never
  closes a task; after `maxAttempts` failures the build pauses for you.
  Deleting or skipping existing tests fails the check.
- **Targeted checks, one full suite.** A task's `Test:` command runs after it;
  a task without one is only compiled; the whole suite runs once at the end.
- **Questions without stopping.** When a choice changes behaviour, an API or
  data, Pi asks in a dialog (`pb_ask`) and carries on with your answer, which
  goes into the spec. Everything else it resolves itself, as recorded
  assumptions you see at the end and the reviewer checks.
- **A lean context.** Broad code questions go to `pb_explore`, a separate
  read-only context (on a cheaper model if you like) that returns only the
  answer; the planner calls it when it's worth it. The test baseline runs in the
  harness, not the model. A build session's compaction is written by pb from its
  own state, not by another model call; optionally, long tool output of finished
  tasks is pruned at task boundaries.
- **Undo means undo.** `/pb:undo` restores the files and rewinds the
  conversation to before the task, so a discarded attempt doesn't anchor the
  next one, and everything before that point is still cached.
- **Fresh eyes where they pay.** The reviewer never saw the build's reasoning.
  It reports findings through a tool; a second fresh call double-checks the
  blocking ones, so a false P1 doesn't cost you a fix cycle. It can't change
  your files: anything it touches is put back.
- **Your standards, once, where Pi already looks.** Engineering standards
  live in AGENTS.md, which Pi loads into every session. pb offers once to add
  its default section.
- **Guarded planning.** Edits to the project are blocked while planning;
  commands can still write, so pb snapshots the project and shows you what
  changed before building.
- **Structured, not parsed from prose.** The agent reports through tools
  (`pb_write_spec`, `pb_task_done`, `pb_record_decision`, `pb_ask`), and so do
  the reviewer and the verifier.
- **Measured, not assumed.** `eval/` runs the same tasks with bare Pi, bare Pi
  plus `/pb:review`, and the full flow, and compares hidden-test results, a
  fixed judge's findings, cost, cache share and time.

## The spec

```
# Order cancellation
Depends on: none
Verification: tests                 # or: build — why  ·  none — why
New tests: yes                      # or: no — why

## Goal
## Decisions                         # each with its reason, as it stands now
## Tasks
### T1: Add CANCELLED to OrderStatus and the cancel() transition
…what to change, where, which pattern to follow…
- Acceptance: cancel() on PENDING sets CANCELLED; other states throw
- Test: `mvn -B -q -Dtest=OrderTest test`
```

`## Out of scope`, `## Context` and `## Acceptance criteria` are optional: a
spec is as short as the change allows. One spec per feature you'd merge on its
own; one planning session can produce several (`Depends on:` orders them).

**Checks and tests are separate choices.** `Verification` decides what runs
when a task is done: `tests` (the task's `Test:` command, a compile when it has
none, the full suite at the end), `build` (compile or typecheck only) or
`none`. `New tests: no` tells the build not to add tests for this feature while
the existing ones still run.

## Configuration

`.pi/pb/config.json`, created on first use:

| Key | Default | Meaning |
|---|---|---|
| `verify` | `"auto"` | test command; detects `./mvnw`/`mvn -B -q test`, gradle, npm, cargo, go, pytest; `null` disables |
| `build` | `"auto"` | compile/typecheck command: the check for a task without a `Test:` line, and for `Verification: build` |
| `verifyTimeoutSec` | 900 | |
| `maxAttempts` | 3 | failed checks per task before the build pauses |
| `testOutputCap` | 4000 | chars of test output shown to the agent and the reviewer |
| `checkpoints` | true | per-task snapshots (git only) for `/pb:undo`, the changed-test check, the review's follow-ups, the planning and reviewer guards |
| `baseline` | true | `/pb:plan` runs the test suite in the background |
| `explorer` | `{}` | `{"model": "provider/id", "thinking": "low"}` for `pb_explore`; unset model = your session's, thinking defaults to low |
| `reviewer` | `{"verify": true}` | `{"model": "provider/id", "thinking": "high", "verify": true}`: the fresh reviewer, and whether P0/P1 findings get a second look |
| `freshAbove` | 50 | above this % of the context window, `/pb:build` recommends a fresh session |
| `buildModel` | unset | `"provider/id"` to build on another model than the one you planned with (in a fresh session, by default) |
| `pruneAbove` | 0 | above this % of the context window, prune long tool output of finished tasks at task boundaries; 0 = never |

## On disk

| Path | What |
|---|---|
| `.pi/pb/specs/<name>/spec.md` | the spec: written by `/pb:build` or `/pb:spec`, decisions added during the build |
| `.pi/pb/specs/<name>/progress.json` | task states, the session the build runs in, the last review, harness-owned |
| `.pi/pb/specs/<name>/checkpoints.json`, `events.jsonl` | undo points (files and conversation) and stats |
| `.pi/pb/baseline.json`, `planning.json` | the last test baseline; planning sessions and their snapshots |
| `.pi/pb/explore.jsonl`, `reviews.jsonl` | `pb_explore` usage per session; reviews without a spec |
| `.pi/pb-archive/` | archived specs (git-ignored by itself) |

Snapshots live in git's object store under `refs/pb/checkpoints`; your branch,
commits and staging area are never touched.

## Development

```bash
npm install
npm run check        # typecheck + tests (a simulated Pi; no model needed)
pi -e ./             # run Pi with this working copy loaded
npm run eval -- --dry                     # the eval's wiring, against your real pi, no model calls
npm run eval -- --model provider/id       # the A/B eval: costs real tokens (see eval/README.md)
```

`PI_PB_PI_COMMAND` overrides the `pi` executable used for the fresh explorer,
reviewer and verifier (the tests use it for `test/mock-pi.mjs`).

## Credits

Inspired by **GVS5H** by Victor Gao, Vida Khosrowshahi, Ali Khosrowshahi,
Xihao Sun, Juhyun Lee, Ethan Tran and Simon (Sang Won) Lee
([arXiv:2608.26480](https://arxiv.org/abs/2608.26480)): decomposition into
small tasks, a verifier whose verdict outranks the model's own "done", and
fresh eyes against anchoring. pb is an independent tool for interactive work
in Pi, not an implementation of the paper; its results don't directly apply.

Built on [Pi](https://pi.dev) by Earendil.

## License

MIT
