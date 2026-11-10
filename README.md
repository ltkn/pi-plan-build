# pi-plan-build

**Plan → spec → build → review for the [Pi coding agent](https://pi.dev).**
Plan a feature with Pi, build it task by task in the same conversation behind
checks the harness runs, and have it reviewed by someone who never saw the
build. Your engineering standards live in AGENTS.md, written once.

```
/pb:plan <what>       plan together; project files untouched; the test baseline runs in the background
/pb:plan <spec>       continue planning a spec in a fresh session, from the spec
/pb:approach [idea]   in planning: hear how Pi would approach it (chat only: no writes, no dialogs)
/pb:compact           pb's compaction: planning, write the spec and reset to it (automatic at checkpointAt);
                      build, compact to the build's state
/pb:build [name]      write the spec if needed, show it, then build it here, task by task; the full suite decides
                      (--fresh: in a new session from the spec). Before T1, one fresh reviewer
                      reads the frozen draft: P0 findings stop the build until amended; P1-P3 are advisory
/pb:fix [ids]         fix review findings in a fresh fenced session (all open ones by default): each finding fixed
                      wherever the change repeats it, proven by a test seen failing first; pb runs the checks after
                      each lap and offers the follow-up review; each lap is an /pb:undo point. A changed contract is
                      re-approved by /pb:build first, then /pb:review checks the delta
/pb:review [focus]    independent review: a spec pass in a fresh session you watch, then an adversarial pass in the background, P0–P3, blocking findings
                      double-checked; follow-ups look only at what changed (--full: everything)
                      no spec? reviews the uncommitted change against its intent
/pb:deps [which]      review dependencies (versions, deprecations, vulnerabilities, runtime) with the stack's own
                      read-only commands, and propose upgrades grouped into changes of their own
/pb:map [focus|undo]  refresh the project map in AGENTS.md (done at /pb:archive too); undo puts the previous back
/pb:standards [stack] write the current standards into this project's AGENTS.md (created if missing; only pb's
                      section is replaced); java, vue, rust, plain or your own template, detected by default
/pb:spec [which]      write or revise a spec without building (optional)
/pb:spec-review [name] [--fresh] the pre-build review on its own: one fresh reviewer reads the ready spec, nothing
                      is built; the verdict is recorded, so /pb:build starts at T1 without re-reviewing; --fresh bypasses the recorded verdict
/pb:spec-fix [name] [ids]
                    one repair lap over the findings recorded against this exact text: it runs the probes,
                    applies the fix it recommends, argues in Decisions when a finding is wrong, parks only
                    what it won't decide; a claim check then reads the new text for claims standing on nothing
/pb:spec-harden [name]
                    auto-pilot over a written spec: repair laps over the P0-P2 findings, one claim check,
                    one confirming review, a lap kept for what it finds, then a digest naming what is left;
                    budgets specFix.maxLaps / specFix.maxReviews
/pb:undo · /pb:status [--json] · /pb:stats [--json] · /pb:archive · /pb:help
alt+n                 the next step's command into the editor; the footer always shows where you are and what's next
pb-report [--cwd dir] [--stats] [--review]   # the same pb.report/2 JSON, for scripts
```

## Install

```bash
pi install git:github.com/ltkn/pi-plan-build@v1.37.0   # a tagged release
pi install /path/to/pi-plan-build                      # a local checkout, loaded in place
```

pb writes its run state under `.pi/`, so add `.pi/` to your `.gitignore`.
Archived specs under `.pi/pb-archive/` are local history; git is the durable
record of the specs your project merged.

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
   → Pi writes .pi/pb/specs/order-cancellation/spec.md and one fresh reviewer
     reads it before the first task (P0 findings stop the build until amended;
     the result header is ✅ PASS or ❌ FAIL with the review's time;
     /pb:spec-review runs that same pass on a spec you aren't building yet)
   → a long list of findings? /pb:spec-harden repairs the plan (measures what needs
     measuring, settles what it can defend, rebuts a wrong finding in `## Decisions`)
     and asks you only where two defensible answers differ;
     /pb:spec-fix [ids] runs one such lap on your say-so
   → one run: T1 → T2 → … (each: its tests seen failing, then passing)
     → coherence (3+ tasks) → full suite → fix → full suite ✓
   → **✅ Build complete — order-cancellation** · 3/3 tasks · 25m (elapsed in parentheses when pauses count)
     **Next:** `/pb:review`, then commit and `/pb:archive`
/pb:review
   → a spec pass in a fresh session: every acceptance criterion met with
     evidence, not met, or not verified (silence is not a pass), plus decisions,
     tests, comments and your standards; then an adversarial pass that tries to
     break the change; P0/P1 findings double-checked
   → **✅ Review — order-cancellation** · PASS · the review's active time (CHANGES NEEDED / UNVERIFIED likewise)
   → **Next:** `/pb:fix <ids>` for open findings, then `/pb:build` to re-approve if the fix changed the approved contract, then `/pb:review` again (only what changed)
```

For a small change, skip the flow: work with Pi as usual, then `/pb:review`.

## Why it's built this way

- **The build stays in one session, but not one context.** Nothing you
  discussed is lost — the session keeps it — while each task after the first
  starts from a reset to the spec, the done tasks and their changed files; the
  agent reads the code instead of inheriting the previous task's conversation. The spec on
  disk carries decisions and rejected ideas through every reset to the
  reviewer. pb still recommends a fresh session above `freshAbove`, or when
  building on another model.
- **The harness decides when it's done.** `pb_task_done` hands out tasks in one
  uninterrupted run; after the last one the harness runs the full suite, sends
  a failure back to fix, and pauses after `maxAttempts`. The agent's word never
  ends a build.
- **Narrow tasks, literal edits.** A task carries one coherent change with a
  targeted `Test:`; work that would bundle several changes with a full
  verification is split, because the harness runs the suite once after the last
  task. Structured files such as `pom.xml`, JSON and YAML are edited by exact
  literal replacement or line-based edits, never by a regex that can backtrack
  for minutes (a nested-quantifier pattern such as `(?:(?!-->).*?)*`).
- **Tests proven to test.** Each task writes its tests first, where the
  compiler gives feedback, and the harness requires them to fail before the
  behaviour exists. Contracts pin every shared seam; the first task that
  settles a shape records it in Design.
- **Refactors are welcome, and reviewed.** Refactors the standards call for
  come first as `(refactor)` tasks; changed existing tests are listed and
  judged, not blocked.
- **A build that never stops to ask.** Ambiguity is a reading the build takes
  and records in the spec's Decisions as an assumption, with what would settle
  it; the reviewer checks it. Only a Goal or a Contract that cannot be built as
  written stops the build — with the evidence, for a revised spec and a new
  approval. No dialog, no timeout, nothing to babysit.
- **A lean context.** Broad questions go to `pb_explore`, a separate read-only
  context (on a cheaper model if you like). The baseline runs in the harness,
  in its own worktree, and every task after the first starts from a reset to a
  summary pb writes from its own state: the tasks already done, the files they
  changed, and the spec to read — not a copy of the conversation before it.
- **Undo means undo.** `/pb:undo` restores the files and rewinds the
  conversation to before the task, so a discarded attempt doesn't anchor the
  next one. When that point lies before a task-boundary reset, it restores the
  files only and says so; the build carries on from the spec and the state.
- **The human view says what happened.** Each phase ends with a consistent header —
  `**<marker> <Phase> — <spec>**` with the facts that summarize it
  (`**✅ Build complete — order-cancellation** · 3/3 tasks · 25m`) — then a `**Next:**` line
  naming the one primary action, a `**Evidence:**` line with the facts behind the result
  (gates, progress, counts, where it ran), and the details below. Review findings are
  numbered continuously in the display, the same numbers `/pb:fix` takes (P3 nits are
  unnumbered). Times are active time: pauses are left out, and the elapsed wall time
  follows in parentheses when a pause made them differ. `/pb:stats` keeps the same numbers
  after the message scrolls away. A spec written by an older pb has no recorded phase
  times; those parts of the line simply don't appear.
- **Fresh eyes on the plan.** Every spec gets one independent read before T1:
  its Decisions are attacked, every "Not doing X" re-tested, unmeasured numbers
  flagged. Only a P0 (unsafe to build) stops the build; a P1 is shown and you
  choose to build anyway, repair first or stop; P2-P3 are shown as advisory
  findings and the build proceeds. There are no review rounds: editing
  the spec makes the next build start review the new text. Every acceptance
  line is proven by its task's `Test:`.
- **Fresh eyes on the build.** A spec pass in a fresh read-only session you
  watch, then an adversarial pass in the background with the same frozen brief.
  Each task acceptance line is answered one by one; a missing item is unverified,
  never a pass. Blocking findings get a
  second look, and pb offers another model family. A pre-existing problem is
  reported as an outside finding (advisory, capped at P2), never left as a
  prose note. The reviewer has no shell at all: it reads the frozen diff and
  the tree, so it cannot mutate what it judges.
- **Memory across features.** Archiving folds what the feature taught about the
  project into a short map in AGENTS.md — its findings, the design it settled
  on, and the review's P0–P2 findings as leads the cartographer rechecks
  against the code — and pb checks every path it names against the repo, so the
  map doesn't drift. Nothing pb writes there can carry markup that breaks the
  section, and where the section's own markers can't be resolved pb writes
  nothing and says which marker, leaving your text and the undo backup alone.
  The spec an archive keeps is the durable record of what the feature settled;
  earlier versions stay in git.
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
Depends on: none                    # or: <spec name> — an optional note
Verification: tests                 # or: build — why  ·  none — why
New tests: yes                      # or: no — why

## Goal
## Findings                          # what the analysis established: files, code to imitate, constraints, baseline
## Decisions                         # each with its reason, as it stands now; rejected ideas too
## Contracts                         # external surfaces and shared seams: signatures, API and errors, data, events
## Migration and rollback            # data that outlives the change, or a production rollout: how it ships, rolls back, is seen failing; else "none — why"
## Design                            # the shape the build settled on, recorded as it went — not by the plan
## Open questions                    # only while planning
## Tasks
### T1: A pending order can be cancelled
…what must be true when it's done; how to build it is the build's…
- Acceptance: cancel() on PENDING sets CANCELLED
- Acceptance: cancel() on any other state throws, and changes nothing
- Test: `mvn -B -q -Dtest=OrderTest test`   # seen failing before the change, then passing
```

The spec pins what and how you'll know, not how: Goal, Out of scope, Decisions,
Design, Contracts, Migration and rollback, Threats and abuse and Acceptance bind the
build. Contracts are expected for any external surface (an
API, event, schema, config, public signature or stored shape), even for a
single task, since no later step sees the whole change at once; the reviewer
checks it. A persisted-data change also needs `## Migration and rollback`, or
an explicit `none — why`; any section that doesn't apply is one line, never an
empty heading. `path:line` citations are checked against the repo when the spec
is written. Each Acceptance line is one behaviour; the task's `Test:` command
is its proof. Keep each task to one coherent change with a targeted `Test:`:
the harness runs the full suite after the last task, so a task never needs to
run it, and work that would bundle several changes with that verification is
split. Once the build starts, that
contract is frozen: the build may change only Design and Decisions, and a hand
edit to anything else pauses it until `/pb:build` shows you the changed blocks
and re-approves the revision.

**Requirements are the spec's contracts.** A capability's durable rules live
in the spec that changed them — its Decisions, Contracts and task acceptance —
and are approved and versioned with that spec. There is no separate requirements
file, delta grammar or merge step: `/pb:archive` keeps the approved spec as the
historical record, and git holds the versions before it. When a later feature
changes a rule, it states the new rule in its own spec; nothing is inherited
from a second copy that could drift.

`## Out of scope` is optional: a spec is as long as the change needs and no
longer. Pi points to code instead of copying it, and
`pb_update_spec` changes single sections, so a checkpoint rewrites only what
moved. One spec per feature you'd merge on its own; one planning session can
produce several (`Depends on:` orders them).

**Checks and tests are separate choices.** `Verification` decides what the
harness runs after the last task: `tests` (the full suite), `build` (compile or
typecheck only) or `none`. With `taskChecks: "each"` it also runs each task's
`Test:` command (a compile when it has none); with `"end"` each task is still
compiled when done, when a compile command exists. `lint` runs after every
task's check and fails that task like any check, so a lint finding goes back to
the task that caused it. An auto-detected lint does so only when the planning
baseline ran it clean on this commit; otherwise it gates just the final check,
so warnings already in the code never stall the first task. After the suite the
final gate runs `extraChecks`. `New tests: no` tells the build not to
add tests while the existing ones still run.

**Scripts read `pb.report/2`.** (pb.report/1 lost its dead `context.asks` count.) `/pb:status --json`, `/pb:stats --json` and
`pb-report` emit the same document: `schema`, `specs` (phase, verification, the
latest review's verdict and findings, every acceptance status, and stats with
`--stats`), and `summary`. The `schema` value changes only when the contract breaks.

## Configuration

`.pi/pb/config.json`, created on first use:

| Key | Default | Meaning |
|---|---|---|
| `verify` | `"auto"` | test command; detects `./mvnw`/`mvn -B -q test`, gradle, npm, cargo, go, pytest; `null` disables |
| `build` | `"auto"` | compile/typecheck command: for `Verification: build`, a task without a `Test:` line, and the per-task compile under `taskChecks: "end"` |
| `lint` | `"auto"` | lint command: package.json's `lint` script, else `cargo clippy -q --all-targets -- -D warnings` for a Cargo project (other stacks set it explicitly). Set explicitly, it runs after every task's check; auto-detected, only when the planning baseline ran it clean on this commit, else at the final gate only |
| `extraChecks` | `[]` | extra project commands (e.g. standards scripts), run at the final gate after lint |
| `verifyTimeoutSec` | 900 | how long the build's own test/compile/lint run may take; raise it together with `commandTimeoutSec` when the suite legitimately takes longer |
| `commandTimeoutSec` | 1800 | cap on one `bash`/`powershell` command, applied before Pi runs it, in pb's sessions and inside `pb_try` (a shorter timeout the model set stays). The project's own long commands (its suite, compile, lint, extra checks and the specs' `Test:` lines) get the larger of this and `verifyTimeoutSec`, never less; inside a probe no command outlasts the probe. A command stopped at a limit says which one and how to raise it; 0 = no limit |
| `probeTimeoutSec` | 900 | how long one `pb_try` probe may run before pb kills it; 0 = no limit |
| `maxAttempts` | 3 | failed checks (the final one, or a task's) before the build pauses |
| `maxConcurrent` | 0 (uncapped) | cap on concurrent fresh runs (explorer, try, spec-review, map, verifier share one engine); extra runs queue FIFO; `~/.pi/agent/pb/config.json` caps every project, and `PI_PB_MAX_CONCURRENT` outranks both |
| `taskChecks` | `"end"` | `"end"`: the full check after the last task; `"each"`: also a check after every task |
| `askTimeoutSec` | 300 | how long a planning or spec-writing dialog waits before the question stays open; a dialog on the way into a build takes pb's choice; 0 = forever |
| `specWaitSec` | 0 | how long `/pb:build` waits for the spec before yielding to the pending offer; 0 = wait as long as it takes (for slow local models) |
| `testOutputCap` | 4000 | chars of test output shown to the agent and the reviewer |
| `checkpoints` | true | per-task snapshots (git only) for `/pb:undo`, the changed-test report, the review's follow-ups, and the planning and spec-review guards |
| `baseline` | true | `/pb:plan` runs the test suite on the last commit, in a separate worktree, in the background |
| `planner` | `{}` | `{"model": "provider/id", "thinking": "xhigh"}` for the planning conversation: applied when planning starts, put back when it ends unless you changed them meanwhile; thinking is a floor, default `"high"`, never lowered |
| `explorer` | `{}` | `{"model": "provider/id", "thinking": "medium", "idleSec": 600, "timeoutSec": 1800, "commandTimeoutSec": 120}` for `pb_explore` and the project map; unset model = your session's, thinking defaults to max (clamped to what the model supports). An explorer run stops after `idleSec` without progress or `timeoutSec` in all, each of its commands after `commandTimeoutSec`; 0 = no limit. Its shell runs read-only inspection commands only (ls, find, cat, head, tail, wc, rg, grep, git status/log/diff/show), enforced |
| `reviewer` | `{"verify": true, "security": "auto"}` | `{"model": "provider/id", "thinking": "high", "verify": true, "security": "auto"}`: the fresh reviewer, whether P0/P1 findings get a second look, and when the adversarial pass joins (`auto`: when the change looks sensitive; `always` on every review; `off`) |
| `specReviewer` | `{}` | `{"model": "provider/id", "thinking": "high"}` for the one fresh pre-T1 spec review; unset model = your session's, unset thinking = Pi's default. Only a P0 blocks; P1-P3 are advisory. Point it at `buildModel` to have the implementer model validate the plan |
| `specFix` | `{}` | `{"model": "provider/id", "thinking": "low", "maxLaps": 3, "maxReviews": 2}` for the repair laps (`/pb:spec-fix`, `/pb:spec-harden`) and the claim check (after a manual lap; once per hardening run); unset thinking runs the claim check at `low`; the budgets cap a hardening run, which stops when nothing is left un-evidenced, a lap changes nothing, or a budget is spent |
| `freshAbove` | 50 | above this % of the context window, `/pb:build` recommends a fresh session |
| `buildModel` | unset | `"provider/id"` to build on another model than the one you planned with (in a fresh session, by default) |
| `mapOnArchive` | true | `/pb:archive` updates the project map in AGENTS.md from the finished feature |
| `notify` | true | a desktop notification when pb asks you something, when a build pauses or finishes, or when a spec review finishes while you're elsewhere |
| `extra` | unset | your instructions added to a role's prompt: `{"plan", "spec", "build", "review", "adversarial", "map"}`; also read from `~/.pi/agent/pb/config.json`, applied first |
| `checkpointAt` | 75 | past this % of the window (always before Pi's own compaction): a planning session writes its spec and is reset to it; a build uses it only when `buildReset` is `"threshold"`; 0 turns both off |
| `buildReset` | `"task"` | what a build does between tasks: `"task"` resets at every boundary (the summary carries the done tasks, and the next task's prompt names their changed files and directs it to inspect what it depends on); `"threshold"` only past `checkpointAt`; `"never"` leaves compaction to Pi |

## On disk

| Path | What |
|---|---|
| `.pi/pb/specs/<name>/spec.md` | the spec: written by `/pb:build` or `/pb:spec`, decisions added during the build |
| `.pi/pb/specs/<name>/progress.json` | task states, the session the build runs in, the last review, harness-owned |
| `.pi/pb/specs/<name>/checkpoints.json`, `events.jsonl` | undo points (files and conversation) and stats |
| `.pi/pb/specs/<name>/review.md` | the last review's result (also posted in the session) |
| `.pi/pb/baseline.json`, `.pi/pb/planning/<session>.json` | the last test baseline; planning sessions and their snapshots |
| `.pi/pb/reviews/`, `pending-build/`, `fixes/`, `review-runs/` | one file per session or run, so parallel work never clobbers the others |
| `.pi/pb/explore.jsonl` | `pb_explore` usage per session |
| `.pi/pb/specs/<name>/sessions/`, `.pi/pb/sessions/` | saved runs of the verifier, explorer, cartographer, spec reviewer and claim checker, to open with `pi --session <file>`; removed by `/pb:archive` |
| `.pi/pb-archive/` | archived specs (git-ignored by itself) |

`.pi/pb/` holds only what a build needs while it runs, and
`.pi/pb-archive/` keeps finished specs' history local. Commit the spec while it
is live if your team reviews it; once archived, git keeps the record.

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

pb has since deviated a long way: it plans and builds in one session, resets
the build's context at every task boundary so each later task reads the code
instead of the previous conversation, checks by default once after the last
task, and keeps a separate fresh context for the explorer, the spec review and
the code review. The spec as checkpoint, the planning reset and most of the
rest are pb's own. The paper's evaluation says nothing about pb: it is an
independent tool for interactive work in Pi, not an implementation of the paper.

Built on [Pi](https://pi.dev) by Earendil.

## License

MIT
