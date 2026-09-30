# pi-plan-build

**Plan → spec → build → review for the [Pi coding agent](https://pi.dev).**
Plan a feature with Pi, build it task by task in the same conversation behind
checks the harness runs, and have it reviewed by someone who never saw the
build. Your engineering standards live in AGENTS.md, written once.

```
/pb:plan <what>       plan together; project files untouched; the test baseline runs in the background
/pb:plan <spec>       continue planning a spec in a fresh session, from the spec
/pb:compact [undo]    pb's compaction: planning, write the spec and reset to it (automatic at checkpointAt);
                      build, compact to the build's state
/pb:build [name]      write the spec if needed, show it, then build it here, task by task; the full suite decides
                      (--fresh: in a new session from the spec)
/pb:review [focus]    independent review, in fresh sessions you watch (spec pass, then adversarial pass), P0–P3, blocking findings
                      double-checked; follow-ups look only at what changed (--full: everything)
                      no spec? reviews the uncommitted change against its intent
/pb:deps [which]      check dependencies and propose upgrades, as a change of their own
/pb:map [focus|undo]  refresh the project map in AGENTS.md (done at /pb:archive too); undo puts the previous back
/pb:standards [stack] write the current standards into this project's AGENTS.md (created if missing; only pb's
                      section is replaced); java, vue, plain or your own template, detected by default
/pb:spec [which]      write or revise a spec without building (optional)
/pb:undo · /pb:status · /pb:stats · /pb:archive · /pb:help
```

## Install

```bash
pi install git:github.com/ltkn/pi-plan-build@v1.22.0   # from git
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
   … a long discussion? at 75% of the window Pi writes the plan to its spec
     and the session is reset to it (/pb:compact does it on demand)
/pb:build
   → asks now, while you're here: build here / in a fresh session / show me the spec first
   → Pi writes .pi/pb/specs/order-cancellation/spec.md (goal, findings,
     decisions, tasks with their test commands) and the build starts by itself
   → one run: skeleton (stubs, every task's tests failing, design written) → T1 → T2 → … → full suite ✗ → fix → full suite ✓
   ✅ BUILD COMPLETE
/pb:review
   → a spec pass in a fresh session: every acceptance criterion with evidence,
     decisions, tests, comments, your standards; then an adversarial pass that
     tries to break the change; P0/P1 findings double-checked
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
- **One run, one decisive check.** `pb_task_done` hands out the next task, so
  the whole build is one uninterrupted run and the prompt cache stays warm.
  After the last task the harness runs the full suite inside that same call; a
  failure goes straight back to fix, and after `maxAttempts` the build pauses
  for you. The agent's word never ends a build. A check after every task is
  available (`taskChecks: "each"`).
- **Design in code, tests proven to test.** Planning pins what and how you'll
  know; the build designs the how in a skeleton (stubs and every task's tests),
  where the compiler gives feedback. The harness requires it to compile and
  every test to fail before the behaviour exists: a test that passes without
  the change tests nothing. For a large change you see the design then, as
  signatures and failing tests, cheaper to change than finished code.
- **Refactors are welcome, and reviewed.** Changed existing tests don't stop the
  build (refactors move and merge them); they're listed and the reviewer judges
  each. Refactoring the standards call for comes first, as `(refactor)` tasks.
- **Questions without stopping.** When a choice changes behaviour, an API or
  data, Pi asks in a dialog (`pb_ask`) and carries on with your answer, which
  goes into the spec. If you're away, the build goes on with its
  recommendation after `askTimeoutSec`, recorded as an assumption. Everything
  else it resolves itself, as recorded assumptions you see at the end and the
  reviewer checks.
- **A lean context.** Broad code questions go to `pb_explore`, a separate
  read-only context (on a cheaper model if you like) that returns only the
  answer; the planner calls it when it's worth it. The test baseline runs in the
  harness, not the model, in a separate worktree so it can't collide with a
  build in your working copy. A full build session is reset between two tasks,
  where nothing is half-done, to a summary pb writes from its own state (the
  rules, the finished tasks, the spec, the next task), with no summarizing model
  call; if a single task still runs into Pi's compaction, pb's summary also
  carries what that task has changed so far.
- **Undo means undo.** `/pb:undo` restores the files and rewinds the
  conversation to before the task, so a discarded attempt doesn't anchor the
  next one, and everything before that point is still cached.
- **Security and robustness by default.** The standards assume every entry
  point will be abused and every boundary gets hostile or broken input, with
  invariants inside rather than checks everywhere; a spec states the threats
  and abuse cases of a change that touches a trust boundary or rules someone
  gains from breaking; and every review includes an adversarial pass with one job:
  break the change (access, business rules, races, resources, failure, numbers
  and time, trust, leaks, configuration).
- **A review you can watch.** The spec pass and the adversarial pass each run in a
  fresh, read-only Pi session that pb takes you into: watch it, interrupt it,
  ask it something; pb brings you back with the result, which is also kept in
  the spec's `review.md`.
- **Fresh eyes where they pay.** The reviewer never saw the build's reasoning,
  and judges the spec too: a faithful build of a wrong plan is still wrong. It
  reports findings through a tool; a second fresh call double-checks the
  blocking ones, so a false P1 doesn't cost you a fix cycle. pb offers once to
  run it on another model family than the one that built the change. It can't
  change your files: anything it touches is put back.
- **A project map, so the next feature doesn't start from zero.** When you
  archive a feature, pb folds what it established about the project (layout,
  patterns to follow, constraints, test quirks) into a short map in AGENTS.md.
  A fresh call writes it against the code as it is now; pb checks every path it
  names and has it correct the ones that don't resolve; it asks you only when
  something looks off, and `/pb:map undo` goes back. Every later session, plan,
  build, review and exploration starts with it.
- **Your standards, once, where Pi already looks.** Engineering standards
  live in AGENTS.md, which Pi loads into every session. pb offers once to add
  its default section: with Java 25 defaults in a Maven or Gradle project, and a
  frontend section in a Vue project, where the page renders what the backend decides.
- **Guarded planning.** Edits to the project are blocked while planning;
  commands can still write, so pb snapshots the project and shows you what
  changed before building.
- **Structured, not parsed from prose.** The agent reports through tools
  (`pb_write_spec`, `pb_task_done`, `pb_record_decision`, `pb_ask`), and so do
  the reviewer and the verifier.
- **The spec is the planning session's checkpoint.** A long planning session
  isn't compacted: at `checkpointAt` (75% of the window, always before Pi would
  compact) Pi writes the plan to its spec while it still has the whole
  discussion, and pb resets the session to the spec. No summarizing model call,
  and a better summary: what was found, decided, rejected, and still open.
  `/pb:plan <spec>` continues any time in a fresh session from the spec.
- **A spec that saves re-analysis.** Besides goal, decisions and tasks, it keeps
  the **Findings** (files and roles, the code to imitate by path, constraints,
  the test baseline), so a fresh or reset session starts from the conclusions
  instead of redoing the analysis, and rejected ideas stay rejected.

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
## Contracts                         # only what others depend on: signatures, API and errors, data, events
## Design                            # written by the build after its skeleton, not by the plan
## Open questions                    # only while planning
## Tasks
### T1: A pending order can be cancelled
…what must be true when it's done; how to build it is the build's…
- Acceptance: cancel() on PENDING sets CANCELLED
- Acceptance: cancel() on any other state throws, and changes nothing
- Test: `mvn -B -q -Dtest=OrderTest test`   # seen failing before the change, then passing
```

The spec pins what and how you'll know, not how: Goal, Decisions, Contracts and
Acceptance bind the build. The build starts with a skeleton that designs the
change in code (stubs, and every task's tests, which must compile and fail),
writes that design into `## Design`, then fills it in task by task. Each
Acceptance line is one behaviour, a test to write.

`## Out of scope` and `## Acceptance criteria` are optional: a spec is as long
as the change needs and no longer. Pi points to code instead of copying it;
`pb_write_spec` reports the spec's size and only suggests tightening a long one.
`pb_update_spec` changes single sections, so a checkpoint rewrites only what moved. One spec per feature you'd merge on its
own; one planning session can produce several (`Depends on:` orders them).

**Checks and tests are separate choices.** `Verification` decides what the
harness runs after the last task: `tests` (the full suite), `build` (compile or
typecheck only) or `none`. With `taskChecks: "each"`, it also runs each task's
`Test:` command (a compile when it has none). `New tests: no` tells the build not to add tests for this feature while
the existing ones still run.

## Configuration

`.pi/pb/config.json`, created on first use:

| Key | Default | Meaning |
|---|---|---|
| `verify` | `"auto"` | test command; detects `./mvnw`/`mvn -B -q test`, gradle, npm, cargo, go, pytest; `null` disables |
| `build` | `"auto"` | compile/typecheck command: for `Verification: build`, and a task without a `Test:` line under `taskChecks: "each"` |
| `verifyTimeoutSec` | 900 | |
| `maxAttempts` | 3 | failed checks (the final one, or a task's) before the build pauses |
| `taskChecks` | `"end"` | `"end"`: the full check after the last task; `"each"`: also a check after every task |
| `askTimeoutSec` | 300 | how long a dialog waits before going on without you: a `pb_ask` question in a build takes the recommendation, a dialog on the way into a build takes pb's choice; 0 = forever |
| `testOutputCap` | 4000 | chars of test output shown to the agent and the reviewer |
| `checkpoints` | true | per-task snapshots (git only) for `/pb:undo`, the changed-test report, the review's follow-ups, the planning and reviewer guards |
| `baseline` | true | `/pb:plan` runs the test suite on the last commit, in a separate worktree, in the background |
| `explorer` | `{}` | `{"model": "provider/id", "thinking": "medium"}` for `pb_explore` and the project map; unset model = your session's, thinking defaults to max (clamped to what the model supports) |
| `reviewer` | `{"verify": true, "security": "always"}` | `{"model": "provider/id", "thinking": "high", "verify": true, "security": "always"}`: the fresh reviewer, whether P0/P1 findings get a second look, and when the adversarial pass joins (`always`, asked for after the spec pass; `auto`: when the change looks sensitive; `off`) |
| `freshAbove` | 50 | above this % of the context window, `/pb:build` recommends a fresh session |
| `buildModel` | unset | `"provider/id"` to build on another model than the one you planned with (in a fresh session, by default) |
| `mapOnArchive` | true | `/pb:archive` updates the project map in AGENTS.md from the finished feature |
| `notify` | true | a desktop notification when pb asks you something (a question, or a dialog that goes on without you) |
| `designReview` | `"large"` | after the skeleton, show you its design before the tasks fill it in: `"large"` (the spec has Contracts, or more than two tasks with tests), `"ask"` (always), `"off"` |
| `extra` | unset | your instructions added to a role's prompt: `{"plan", "spec", "build", "review", "adversarial", "map"}`; also read from `~/.pi/agent/pb/config.json`, applied first |
| `checkpointAt` | 75 | past this % of the window (always before Pi's own compaction): a planning session writes its spec and is reset to it; a build is reset to its state at the next task boundary; 0 = never |

## On disk

| Path | What |
|---|---|
| `.pi/pb/specs/<name>/spec.md` | the spec: written by `/pb:build` or `/pb:spec`, decisions added during the build |
| `.pi/pb/specs/<name>/progress.json` | task states, the session the build runs in, the last review, harness-owned |
| `.pi/pb/specs/<name>/checkpoints.json`, `events.jsonl` | undo points (files and conversation) and stats |
| `.pi/pb/baseline.json`, `planning.json` | the last test baseline; planning sessions and their snapshots |
| `.pi/pb/explore.jsonl` | `pb_explore` usage per session |
| `.pi/pb/specs/<name>/review.md` | the last review's result (also posted in the session) |
| `.pi/pb/specs/<name>/sessions/`, `.pi/pb/sessions/` | the saved runs of the verifier, the explorer and the cartographer, to open with `pi --session <file>`; removed by `/pb:archive` |
| `.pi/pb-archive/` | archived specs (git-ignored by itself) |

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

## Credits

Inspired by **GVS5H** by Victor Gao, Vida Khosrowshahi, Ali Khosrowshahi,
Xihao Sun, Juhyun Lee, Ethan Tran and Simon (Sang Won) Lee
([arXiv:2608.26480](https://arxiv.org/abs/2608.26480)), which started pb with
three ideas: decomposition into small tasks, a verifier whose verdict outranks
the model's own "done", and fresh eyes against anchoring.

pb has since deviated a long way from it. The paper runs every role (manager,
worker, reviewer) in a fresh context over a shared ledger; pb's early versions
did the same, and pb dropped it: it plans and builds in one conversation to keep
the discussion and the prompt cache, checks by default only once, after the last
task, rather than after each, and keeps a fresh context only for the explorer and the
review. The spec as a checkpoint, the planning reset, and most of the rest are
pb's own. The paper's evaluation says nothing about pb: pb is an independent
tool for interactive work in Pi, not an implementation of it.

Built on [Pi](https://pi.dev) by Earendil.

## License

MIT
