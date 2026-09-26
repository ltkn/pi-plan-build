# pi-plan-build

**Plan → spec → build → review for the [Pi coding agent](https://pi.dev).**
Plan a feature with Pi, turn it into a self-contained spec, build it in a fresh
session task by task behind checks the harness runs, and have it reviewed by
someone who never saw the build.

```
/pb:plan <what>       plan together; project files untouched  your session
/pb:spec [which]      write the spec(s) from the discussion   your session
/pb:build [name]      build a spec in a NEW session           fresh session, cached as it grows
/pb:review [focus]    independent review against the spec     one fresh call
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
   → Pi investigates (anything goes, but the project's files stay untouched):
     the code, conventions and test baseline; proposes an approach and asks
     what only you can decide
you: "Only PENDING orders. Not soft delete: audit lives elsewhere."
/pb:spec
   → .pi/pb/specs/order-cancellation/spec.md: goal, decisions (with rejected
     ideas), context, acceptance criteria, tasks with their test commands
/pb:build
   → a new session with nothing in it but the spec
   → T1 → check ✓ → T2 → check ✗ → fix → ✓ → … → full suite ✓
   ✅ BUILD COMPLETE
/pb:review
   → a fresh reviewer: every acceptance criterion with evidence, decisions,
     tests, comments, quality bar, security → fix findings in the build session
```

## Why it's built this way

- **The build starts from the spec alone.** A long planning discussion is full
  of ideas you dropped. The build session never sees it, so they can't creep
  back, and the spec has to be complete. Rejected ideas are written into the
  spec ("Not doing X, because …") so they stay rejected.
- **The build just builds.** It treats the spec as settled. Where the spec is
  unclear or doesn't match the code, it takes the sensible reading, records it as
  an assumption in the spec, and carries on: you see the list at the end, and
  the reviewer checks it. Spec problems are meant to be caught earlier: before
  writing a spec, `/pb:spec` checks it against itself and the code.
- **The harness decides when a task is done.** The agent finishes each task
  through a tool; the harness then runs the task's check (its tests, a compile,
  or nothing: you choose per spec). A failure goes back to the agent with the
  output; after `maxAttempts` the build pauses for you. Deleting or skipping
  existing tests fails the check.
- **One session per build, so the cache works.** Everything after the spec is
  served from the prompt cache; `/pb:stats` shows how much.
- **Fresh eyes where they pay.** The only separate model call is the review: a
  reviewer who never saw the build's reasoning isn't anchored by it.
- **Structured, not parsed from prose.** The agent reports through tools
  (`pb_write_spec`, `pb_task_done`, `pb_record_decision`),
  so formats can't drift.

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
after each task: `tests` (the task's `Test:` command, the full suite at the
end), `build` (compile or typecheck only) or `none`. `New tests: no` tells the
build not to add tests for this feature while the existing ones still run.

## Configuration

`.pi/pb/config.json`, created on first use:

| Key | Default | Meaning |
|---|---|---|
| `verify` | `"auto"` | test command; detects `./mvnw`/`mvn -B -q test`, gradle, npm, cargo, go, pytest; `null` disables |
| `build` | `"auto"` | compile/typecheck command for `Verification: build` (e.g. `mvn -B -q -DskipTests test-compile`, `tsc --noEmit`) |
| `verifyTimeoutSec` | 900 | |
| `maxAttempts` | 3 | failed checks per task before the build pauses |
| `testOutputCap` | 4000 | chars of test output shown to the agent and the reviewer |
| `checkpoints` | true | per-task snapshots (git only) for `/pb:undo` and the changed-test check |
| `reviewer` | `{}` | `{"model": "provider/id", "thinking": "high"}` for the fresh reviewer; unset = your session's |

## On disk

| Path | What |
|---|---|
| `.pi/pb/specs/<name>/spec.md` | the spec: written by `/pb:spec`, decisions added during the build |
| `.pi/pb/specs/<name>/progress.json` | task states and the build session, harness-owned |
| `.pi/pb/specs/<name>/checkpoints.json`, `events.jsonl` | undo points and stats |
| `.pi/pb-archive/` | archived specs (git-ignored by itself) |

Snapshots live in git's object store under `refs/pb/checkpoints`; your branch,
commits and staging area are never touched.

## Development

```bash
npm install
npm run check        # typecheck + tests (a simulated Pi; no model needed)
pi -e ./             # run Pi with this working copy loaded
```

`PI_PB_PI_COMMAND` overrides the `pi` executable used for the fresh reviewer
(the tests use it for `test/mock-pi.mjs`).

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
