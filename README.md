# pi-plan-build

**Plan → spec → build → review for the [Pi coding agent](https://pi.dev).**

## Introduction

An AI coding agent writes code fast, but left to itself it can drift from what you
asked for, call its own work done, and review it in the same frame of mind that
produced it. pb (pi-plan-build) gives that work a shape you can trust:

1. **Plan together.** You and Pi agree on what to build. Nothing in the project
   changes yet.
2. **Write it down.** The agreement becomes a spec: the goal, the decisions and
   their reasons, the contracts, and small tasks, each with the test that proves it.
3. **Build from the spec.** A fresh session builds one task at a time. Each task's
   test must fail before the change and pass after it. **pb**, not the model,
   runs the checks and decides when the work is done.
4. **Review with fresh eyes.** A reviewer who never saw the build judges the
   code against the spec. A second reviewer tries to break it. Findings are
   numbered, each with a concrete fix, and `/pb:fix` applies them.

Your engineering standards live in AGENTS.md, written once, and every step
follows them. pb can run unattended: a finished build starts its own review, and
pb asks you only for decisions that are yours to make.

## Install

```bash
pi install git:github.com/ltkn/pi-plan-build@v1.43.0   # a tagged release
pi install /path/to/pi-plan-build                      # a local checkout, loaded in place
```

Add `.pi/` to your `.gitignore`. pb keeps its run state there.

## The flow

```
/pb:plan let admins cancel a pending order   plan together; the test baseline runs in the background
/pb:build                                    write the spec, have it reviewed once, then build it task by task
/pb:review                                   independent review: a spec pass, then an adversarial pass
/pb:fix 1 3                                  fix findings by number, then /pb:review checks only the fixes
/pb:commit                                   commit the change (you see the files and the message first)
/pb:archive                                  keep the spec as history, optionally refresh the project map
```

Every step ends with a header, a **Next:** line naming the one command to run,
and the evidence behind the result. After a review, a fix run or a commit, pb asks
the next step as a choice: Enter puts its command in the editor, and one more Enter
runs it. `alt+n` does the same at any time.
For a small change, skip the flow: work with Pi as usual, then `/pb:review`.

## Commands

| Command | What it does |
|---|---|
| `/pb:plan <what>` · `/pb:plan <spec>` | plan a change (project files stay untouched), or resume planning a spec |
| `/pb:approach [idea]` | while planning, hear how Pi would approach it |
| `/pb:spec [name]` | write or revise a spec without building it |
| `/pb:spec-review [name]` | the pre-build spec review on its own |
| `/pb:build [name] [--here]` | build from the spec in a fresh session (`--here`: in this one) |
| `/pb:review [focus] [--full]` | review the change against its spec (or, with no spec, its intent); follow-ups look only at what changed |
| `/pb:fix [spec] [ids] [direction]` | fix findings in a fresh fenced session; text after the ids directs the fixes |
| `/pb:commit [spec]` | commit the change's files with a message built from the spec |
| `/pb:undo` | restore files and conversation to before a task or a fix lap |
| `/pb:archive [--force]` | archive a finished spec |
| `/pb:standards [stack]` | write pb's standards section into AGENTS.md (java, vue, rust, plain, or detected) |
| `/pb:map [focus\|apply\|undo]` | refresh the project map in AGENTS.md |
| `/pb:deps [which]` | review dependencies and propose upgrades as changes of their own |
| `/pb:compact` | write the spec and reset the session to it (automatic at `checkpointAt`) |
| `/pb:status [--json]` · `/pb:stats` · `/pb:help [topic]` | where things stand, run statistics, the guide |

`pb-report [--cwd dir] [--stats] [--review]` prints the same `pb.report/2` JSON as
`/pb:status --json`, for scripts.

## Principles

- **The spec is the source of truth.** The build starts from the spec, not the
  chat, and both reviews judge against it. Its Goal, Out of scope, Decisions,
  Design, Contracts, Migration and rollback, and Threats and abuse bind the
  build. Once a build starts, its contract is frozen: only you re-approve a
  change to it, from its diff.
- **The harness decides when it's done.** The agent's word never ends a task or
  a build. pb runs the tests, the full suite and lint, and sends failures back.
- **Tests are proven to test.** A task's test must be seen failing before the
  behaviour exists.
- **Fresh eyes.** The spec is reviewed once before the first task. The code is
  reviewed by a read-only reviewer that never saw the build, then attacked by an
  adversarial pass. Blocking findings get a second look.
- **A lean context.** Each task starts from a reset to the spec and the work done
  so far. Broad questions go to a separate read-only explorer.
- **Never stops to ask mid-build.** An ambiguity becomes a recorded assumption
  the reviewer checks. Only a contract that can't be built as written pauses
  the build.
- **Undo means undo.** Files and conversation go back together.
- **Security by default.** Every entry point is treated as abusable, and every
  review can include an adversarial pass.

## Configuration

`.pi/pb/config.json`, created on first use. pb names any key it doesn't know
instead of ignoring it. `~/.pi/agent/pb/config.json` sets `maxConcurrent` and
`extra` for every project.

| Key | Default | Meaning |
|---|---|---|
| `verify` · `build` · `lint` | `"auto"` | the test, compile and lint commands (detected; `null` disables) |
| `extraChecks` | `[]` | more commands for the final check |
| `taskChecks` | `"end"` | `"each"` also runs a check after every task |
| `maxAttempts` | 3 | failed checks before a build pauses |
| `verifyTimeoutSec` · `commandTimeoutSec` · `probeTimeoutSec` | 900 · 1800 · 900 | time limits for checks, one shell command, and one probe (0 = none) |
| `askTimeoutSec` | 300 | how long a dialog waits before pb goes on with its default |
| `reviewAfterBuildSec` | 600 | idle time before a finished build or fix run starts its own review (0 = never) |
| `reviewer` | `{"verify": true, "security": "auto"}` | reviewer model and thinking, second look, adversarial pass (`auto`, `always`, `off`) |
| `specReviewer` · `planner` · `explorer` | `{}` | model and thinking for each role |
| `buildModel` | unset | build on another model than the one you planned with |
| `checkpointAt` | 75 | % of the context window at which planning writes its spec and resets |
| `buildReset` | `"task"` | reset between tasks (`"task"`), only past `checkpointAt`, or `"never"` |
| `maxConcurrent` | 0 | cap on parallel background runs (0 = no cap) |
| `mapOnArchive` | false | refresh the project map on `/pb:archive` |
| `baseline` · `checkpoints` · `notify` | true | test baseline while planning, undo snapshots, desktop notifications |
| `specWaitSec` · `testOutputCap` | 0 · 4000 | wait for a slow spec writer; characters of test output shown |
| `extra` | unset | your own instructions per role: `plan`, `spec`, `build`, `review`, `adversarial`, `map` |

## Learn more

The full guide is [`extensions/pb/guide.md`](extensions/pb/guide.md): the spec
format, checks, review, fixes, undo and the project map. In Pi, `/pb:help` lists
its topics and `/pb:help <topic>` shows one.
[`CHANGELOG.md`](CHANGELOG.md) says what changed in each release.

## Development

```bash
npm install
npm run check        # typecheck + tests against a simulated Pi (no model needed)
pi -e ./             # run Pi with this working copy loaded
```

`PI_PB_PI_COMMAND` overrides the `pi` executable for fresh runs (the tests use
`test/mock-pi.mjs`). `PI_PB_MAX_CONCURRENT` outranks `maxConcurrent`.

## License

MIT
