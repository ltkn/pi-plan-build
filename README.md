# pi-plan-build

**Plan → spec → build → review for the [Pi coding agent](https://pi.dev).**
Plan a feature with Pi, build it task by task in the same conversation behind
checks the harness runs, and have it reviewed by someone who never saw the
build. Your engineering standards live in AGENTS.md, written once.

```
/pb:plan <what>       plan together; project files untouched; the test baseline runs in the background
/pb:plan <spec>       continue planning a spec in a fresh session, from the spec
/pb:approach [idea]   in planning: hear how Pi would approach it (chat only: no writes, no dialogs)
/pb:compact [undo]    pb's compaction: planning, write the spec and reset to it (automatic at checkpointAt);
                      build, compact to the build's state
/pb:build [name]      write the spec if needed, show it, then build it here, task by task; the full suite decides
                      (--fresh: in a new session from the spec; --review: run the spec review even where auto would skip)
                      before the first task, risky specs get fresh eyes: P0/P1 findings stop the build until amended
/pb:fix [ids]         fix review findings in a fresh fenced session (all open ones by default); /pb:review checks the delta after
/pb:review [focus]    independent review, in fresh sessions you watch (spec pass, then adversarial pass), P0–P3, blocking findings
                      double-checked; follow-ups look only at what changed (--full: everything)
                      no spec? reviews the uncommitted change against its intent
/pb:deps [which]      check dependencies and propose upgrades, as a change of their own
/pb:map [focus|undo]  refresh the project map in AGENTS.md (done at /pb:archive too); undo puts the previous back
/pb:standards [stack] write the current standards into this project's AGENTS.md (created if missing; only pb's
                      section is replaced); java, vue, plain or your own template, detected by default
/pb:spec [which]      write or revise a spec without building (optional)
/pb:undo · /pb:status [--json] · /pb:stats [--json] · /pb:archive · /pb:help
pb-report [--cwd dir] [--stats] [--review]   # the same pb.report/1 JSON, for scripts
```

## Install

```bash
pi install git:github.com/ltkn/pi-plan-build@v1.37.0   # a tagged release
pi install /path/to/pi-plan-build                      # a local checkout, loaded in place
```

pb writes its run state under `.pi/`, so add `.pi/` to your `.gitignore`. The
one exception is the living requirement base: it lives in `specs/` and is meant
to be committed with the project.

## The flow

```
/pb:plan let admins cancel an order while it is still pending
   → the harness runs the test suite in the background (baseline, no tokens)
   → Pi investigates (project files untouched), asks pb_explore the broad
     questions, proposes an approach, asks what only you can decide
you: "Only PENDING orders. Not soft delete: audit lives elsewhere."
   … a long discussion? at 75% of the window Pi writes the plan to its spec
     and the session is reset to it (/pb:compact does it on demand)
/pb:build
   → asks now, while you're here: build here / in a fresh session / show the spec
   → Pi writes .pi/pb/specs/order-cancellation/spec.md and fresh eyes attack it
     before the first task (P0/P1 findings stop the build until amended)
   → one run: T1 → T2 → … (each: its tests seen failing, then passing)
     → coherence (3+ tasks) → full suite → fix → full suite ✓
   ✅ BUILD COMPLETE
/pb:review
   → a spec pass in a fresh session: every acceptance criterion met with
     evidence, not met, or not verified (silence is not a pass), plus decisions,
     tests, comments and your standards; then an adversarial pass that tries to
     break the change; P0/P1 findings double-checked
   → fix them right there (/pb:fix), then /pb:review again (only what changed)
```

For a small change, skip the flow: work with Pi as usual, then `/pb:review`.

## Why it's built this way

- **The build stays in the conversation.** Nothing you discussed is lost and
  the prompt cache keeps working; the spec on disk carries decisions and
  rejected ideas through compaction to the reviewer. pb recommends a fresh
  session above `freshAbove`, or when building on another model.
- **The harness decides when it's done.** `pb_task_done` hands out tasks in one
  uninterrupted run; after the last one the harness runs the full suite, sends
  a failure back to fix, and pauses after `maxAttempts`. The agent's word never
  ends a build.
- **Tests proven to test.** Each task writes its tests first, where the
  compiler gives feedback, and the harness requires them to fail before the
  behaviour exists. Contracts pin every shared seam; the first task that
  settles a shape records it in Design.
- **Refactors are welcome, and reviewed.** Refactors the standards call for
  come first as `(refactor)` tasks; changed existing tests are listed and
  judged, not blocked.
- **Questions without stopping.** A choice that changes behaviour, an API or
  data becomes a `pb_ask` dialog, and your answer goes into the spec. Away, the
  build proceeds on its recommendation as an assumption after
  `askTimeoutSec`; the reviewer checks it.
- **A lean context.** Broad questions go to `pb_explore`, a separate read-only
  context (on a cheaper model if you like). The baseline runs in the harness,
  in its own worktree, and a build resets between tasks to a summary pb writes
  from its own state.
- **Undo means undo.** `/pb:undo` restores the files and rewinds the
  conversation to before the task, so a discarded attempt doesn't anchor the
  next one, and the cache stays warm.
- **Fresh eyes on the plan.** A risky spec (security, persisted data or a
  migration, an external contract, threats, four or more tasks) is reviewed
  before T1: its Decisions are attacked, every "Not doing X" re-tested,
  unmeasured numbers flagged. A P0/P1 stops the build; `maxRounds` caps the
  loop (`--review` spends one more round, `--force` records the standing
  findings as accepted). Every acceptance line names its proof.
- **Fresh eyes on the build.** A spec pass, then an adversarial pass, each in a
  fresh read-only session you watch. The spec's acceptance criteria, requirement
  scenarios (`R1.1`, …) and task acceptance lines are answered one by one; a
  missing item is unverified, never a pass. Blocking findings get a second look,
  and pb offers another model family. A command the reviewer runs may change
  files: they're listed, never silently reverted.
- **Memory across features.** Archiving folds what the feature taught about the
  project into a short map in AGENTS.md, and pb checks every path it names
  against the repo, so the map doesn't drift. Requirement deltas accumulate in
  `specs/<capability>.md`.
- **Your standards, once.** Engineering standards live in AGENTS.md, which Pi
  loads into every session; pb offers once to add its default section for your
  stack.
- **Security by default.** Every entry point is assumed abusable and every
  boundary hostile. A change that touches a trust boundary states its threats
  and abuse cases, and every review has an adversarial pass whose only job is
  to break it.
- **Planning stays guarded.** Edits are blocked while planning, and commands
  that write are shown to you before the build.
- **Structured, not parsed from prose.** The agent, reviewer and verifier
  report through tools, not prose.
- **The spec is the checkpoint.** At `checkpointAt` Pi writes the plan while it
  still has the whole discussion, and the session resets to it; `/pb:plan
  <spec>` resumes any time. Findings keep the analysis, so the next session
  starts from conclusions.

## The spec

```
# Order cancellation
Status: ready                       # planning: a checkpoint, no tasks yet
Depends on: none
Verification: tests                 # or: build — why  ·  none — why
New tests: yes                      # or: no — why

## Goal
## Findings                          # what the analysis established: files, code to imitate, constraints, baseline
## Decisions                         # each with its reason, as it stands now; rejected ideas too
## Contracts                         # external surfaces and shared seams: signatures, API and errors, data, events
## Migration and rollback            # only when data or a stored format outlives the change; else "none — why"
## Requirements: order-cancellation # only when what a capability guarantees changes; merged on archive
### ADDED
### Requirement: Cancelling a pending order
A pending order can be cancelled by its owner and becomes CANCELLED; other states are unaffected.
#### Scenario: Owner cancels a pending order
- **GIVEN** an order in PENDING owned by the caller
- **WHEN** the owner cancels it
- **THEN** it becomes CANCELLED and cannot be cancelled again
## Design                            # the shape the build settled on, recorded as it went — not by the plan
## Open questions                    # only while planning
## Tasks
### T1: A pending order can be cancelled
…what must be true when it's done; how to build it is the build's…
- Acceptance: cancel() on PENDING sets CANCELLED (tests: cancels-pending)
- Acceptance: cancel() on any other state throws, and changes nothing (tests: rejects-other-states)
- Test: `mvn -B -q -Dtest=OrderTest test`   # seen failing before the change, then passing
```

The spec pins what and how you'll know, not how: Goal, Decisions, Contracts and
Acceptance bind the build. Contracts are required for any external surface (an
API, event, schema, config, public signature or stored shape), even for a
single task, since no later step sees the whole change at once. A
persisted-data change also needs `## Migration and rollback`, or an explicit
`none — why`; any section that doesn't apply is one line, never an empty
heading. `path:line` citations are checked against the repo when the spec is
written. Each Acceptance line is one behaviour with `(tests: …)` naming its
proof, or `(non-testable: …)` saying why no test can.

**Requirements accumulate across features.** A change that alters what a
capability guarantees carries a delta: `## Requirements: <capability>`, then
`### ADDED`, `### MODIFIED` and `### REMOVED` groups of requirement and scenario
blocks. ADDED must be new; MODIFIED and REMOVED must exist; MODIFIED replaces
the requirement whole, and a rename is REMOVED plus ADDED. A scenario's
`GIVEN` / `WHEN` / `THEN` lines are checked against the built code as review
criteria. `/pb:archive` merges the delta into `specs/<capability>.md`
transactionally: a delta that no longer applies stops the archive before
anything moves, and if the spec can't be archived the living files are
restored. `pb_write_spec` runs the same check, so a delta is never written
already broken.

`## Out of scope` and `## Acceptance criteria` are optional: a spec is as long
as the change needs and no longer. Pi points to code instead of copying it, and
`pb_update_spec` changes single sections, so a checkpoint rewrites only what
moved. One spec per feature you'd merge on its own; one planning session can
produce several (`Depends on:` orders them).

**Checks and tests are separate choices.** `Verification` decides what the
harness runs after the last task: `tests` (the full suite), `build` (compile or
typecheck only) or `none`. With `taskChecks: "each"` it also runs each task's
`Test:` command (a compile when it has none); with `"end"` each task is still
compiled when done, when a compile command exists. After the suite the final
gate also runs `lint` and `extraChecks`. `New tests: no` tells the build not to
add tests while the existing ones still run.

**Scripts read `pb.report/1`.** `/pb:status --json`, `/pb:stats --json` and
`pb-report` emit the same document: `schema`, `specs` (phase, verification, the
latest review's verdict and findings, every acceptance status, requirement
deltas, and stats with `--stats`), `requirements` (the living base), and
`summary`. The `schema` value changes only when the contract breaks.

## Configuration

`.pi/pb/config.json`, created on first use:

| Key | Default | Meaning |
|---|---|---|
| `verify` | `"auto"` | test command; detects `./mvnw`/`mvn -B -q test`, gradle, npm, cargo, go, pytest; `null` disables |
| `build` | `"auto"` | compile/typecheck command: for `Verification: build`, a task without a `Test:` line, and the per-task compile under `taskChecks: "end"` |
| `lint` | `"auto"` | lint command from package.json's `lint` script (other stacks set it explicitly); runs at the final gate after the suite |
| `extraChecks` | `[]` | extra project commands (e.g. standards scripts), run at the final gate after lint |
| `verifyTimeoutSec` | 900 | |
| `maxAttempts` | 3 | failed checks (the final one, or a task's) before the build pauses |
| `maxConcurrent` | 0 (uncapped) | cap on concurrent fresh runs (explorer, try, spec-review, map, verifier share one engine); extra runs queue FIFO; `~/.pi/agent/pb/config.json` caps every project, and `PI_PB_MAX_CONCURRENT` outranks both |
| `taskChecks` | `"end"` | `"end"`: the full check after the last task; `"each"`: also a check after every task |
| `askTimeoutSec` | 300 | how long a dialog waits before going on without you: a `pb_ask` in a build takes the recommendation, a dialog on the way into a build takes pb's choice; 0 = forever |
| `specWaitSec` | 0 | how long `/pb:build` waits for the spec before yielding to the pending offer; 0 = wait as long as it takes (for slow local models) |
| `testOutputCap` | 4000 | chars of test output shown to the agent and the reviewer |
| `checkpoints` | true | per-task snapshots (git only) for `/pb:undo`, the changed-test report, the review's follow-ups, and the planning and spec-review guards |
| `baseline` | true | `/pb:plan` runs the test suite on the last commit, in a separate worktree, in the background |
| `explorer` | `{}` | `{"model": "provider/id", "thinking": "medium"}` for `pb_explore` and the project map; unset model = your session's, thinking defaults to max (clamped to what the model supports) |
| `reviewer` | `{"verify": true, "security": "auto"}` | `{"model": "provider/id", "thinking": "high", "verify": true, "security": "auto"}`: the fresh reviewer, whether P0/P1 findings get a second look, and when the adversarial pass joins (`auto`: when the change looks sensitive; `always`, asked for after the spec pass; `off`) |
| `specReviewer` | `{"mode": "auto", "maxRounds": 2}` | `{"model": "provider/id", "thinking": "high", "mode": "auto", "maxRounds": 2}` for the fresh pre-T1 spec review; unset model = your session's, unset thinking = Pi's default. `mode`: `auto` reviews risky specs, `always` every spec, `off` none (an earlier blocking review still waits for `--review` or `--force`); `maxRounds` caps automatic blocking rounds. Point it at `buildModel` to have the implementer model validate the plan |
| `freshAbove` | 50 | above this % of the context window, `/pb:build` recommends a fresh session |
| `buildModel` | unset | `"provider/id"` to build on another model than the one you planned with (in a fresh session, by default) |
| `mapOnArchive` | true | `/pb:archive` updates the project map in AGENTS.md from the finished feature |
| `notify` | true | a desktop notification when pb asks you something, or when a spec review finishes while you're elsewhere |
| `extra` | unset | your instructions added to a role's prompt: `{"plan", "spec", "build", "review", "adversarial", "map"}`; also read from `~/.pi/agent/pb/config.json`, applied first |
| `checkpointAt` | 75 | past this % of the window (always before Pi's own compaction): a planning session writes its spec and is reset to it; a build is reset at the next task boundary; 0 = never |

## On disk

| Path | What |
|---|---|
| `specs/<capability>.md` | the living requirement base: durable project knowledge, meant to be committed; changed only when a spec with a `## Requirements:` delta is archived |
| `.pi/pb/specs/<name>/spec.md` | the spec: written by `/pb:build` or `/pb:spec`, decisions added during the build |
| `.pi/pb/specs/<name>/progress.json` | task states, the session the build runs in, the last review, harness-owned |
| `.pi/pb/specs/<name>/checkpoints.json`, `events.jsonl` | undo points (files and conversation) and stats |
| `.pi/pb/specs/<name>/review.md` | the last review's result (also posted in the session) |
| `.pi/pb/baseline.json`, `.pi/pb/planning/<session>.json` | the last test baseline; planning sessions and their snapshots |
| `.pi/pb/reviews/`, `pending-build/`, `fixes/`, `review-runs/` | one file per session or run, so parallel work never clobbers the others |
| `.pi/pb/explore.jsonl` | `pb_explore` usage per session |
| `.pi/pb/specs/<name>/sessions/`, `.pi/pb/sessions/` | saved runs of the verifier, explorer and cartographer, to open with `pi --session <file>`; removed by `/pb:archive` |
| `.pi/pb-archive/` | archived specs (git-ignored by itself) |

The living requirement base is project knowledge, like `AGENTS.md`, so pb
writes it outside the git-ignored `.pi/`: it is meant to be committed, reviewed
and shared. `.pi/pb/` holds only what a build needs while it runs, and
`.pi/pb-archive/` keeps finished specs' history local.

Snapshots live in git's object store under `refs/pb/checkpoints`; your branch,
commits and staging area are never touched.

## Development

```bash
npm install
npm run check        # typecheck + tests (a simulated Pi; no model needed)
pi -e ./             # run Pi with this working copy loaded
```

`PI_PB_PI_COMMAND` overrides the `pi` executable used for the fresh explorer,
reviewer and verifier (the tests use it for `test/mock-pi.mjs`).
`PI_PB_MAX_CONCURRENT` caps how many fresh runs run at once, outranking the
config's `maxConcurrent`.

## Credits

Inspired by **GVS5H** by Victor Gao, Vida Khosrowshahi, Ali Khosrowshahi,
Xihao Sun, Juhyun Lee, Ethan Tran and Simon (Sang Won) Lee
([arXiv:2608.26480](https://arxiv.org/abs/2608.26480)), which started pb with
three ideas: decomposition into small tasks, a verifier whose verdict outranks
the model's own "done", and fresh eyes against anchoring.

pb has since deviated a long way: it plans and builds in one conversation to
keep the discussion and the prompt cache, checks by default once after the last
task, and keeps a fresh context only for the explorer and the review. The spec
as checkpoint, the planning reset and most of the rest are pb's own. The paper's
evaluation says nothing about pb: it is an independent tool for interactive work
in Pi, not an implementation of the paper.

Built on [Pi](https://pi.dev) by Earendil.

## License

MIT
