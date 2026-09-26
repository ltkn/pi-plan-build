# Using pb

pb turns a conversation into a feature in four moves: **plan** it together,
write it down as a **spec**, **build** it in a fresh session task by task, and
have it **reviewed** by someone who never saw the build. After every step Pi
shows a short **What now** block; `/pb:help <topic>` posts any section below.

<!-- pb:topic flow -->
## The normal path

1. **`/pb:plan <what you want, in your own words>`**: Pi investigates (it can
   run anything, but won't touch the project's files): the code involved, the
   conventions, the test baseline. Then you discuss: the
   approach, the trade-offs, the questions only you can answer. Take your time;
   this is the cheapest place to change your mind.
2. **`/pb:spec`**: Pi writes the **spec**, a self-contained document: goal,
   decisions (including the ideas you rejected), context, acceptance criteria and
   tasks. Read it in `.pi/pb/specs/<name>/spec.md`. Revise by talking and running
   `/pb:spec` again.
3. **`/pb:build`**: a **new session** opens with nothing in it but the spec.
   The tasks run one by one, each behind a check the harness runs.
4. **`/pb:review`**: a fresh reviewer compares the change with the spec.
   Fix any findings in the build session, commit, and `/pb:archive`.

The build session never sees your planning conversation, only the spec. That's
the point: no half-discussed idea can creep back in, and the spec has to be
complete.
<!-- /pb -->

<!-- pb:topic plan -->
## Planning

`/pb:plan <describe what you want to build or change, in your own words>`, e.g.
`/pb:plan let admins cancel an order while it is still pending, and notify the
customer`. Pi investigates before you talk: the files and conventions involved,
the closest existing feature, the test command and whether the suite passes
today. A suite that already fails would block every task, so it's worth knowing
now.

**Investigating is free, changing the project isn't.** Pi can read, search, run
the build and tests, curl an API, and write and run one-off scripts or programs
(Python, Java, …) in a temporary directory. Editing or writing any file inside
the project is blocked in this session until you build. The block belongs to
this session: it survives a restart, and the build session isn't affected.

Discuss as long as you like. When a discussion turns out to cover two things you
would merge separately, Pi should say so; they become two specs.

`/pb:plan off` lifts the block for this session without building anything.

**Finding your sessions again.** `/pb:plan` names the session "plan: <what you
asked>", and `/pb:build` names its new session "build: <spec>". Both show up by
name in Pi's `/resume` picker, and the first message of each shows its id:
`pi --session <id>` reopens it directly, e.g. after a crash. `/pb:status` lists
where each build session is.
<!-- /pb -->

<!-- pb:topic spec -->
## The spec

`/pb:spec` has Pi write one spec per feature through the `pb_write_spec` tool,
which rejects anything that doesn't follow the format and says why. The header
tells the build how to check the work:

```
# Order cancellation
Depends on: none
Verification: tests            (or: build — why · none — why)
New tests: yes                 (or: no — why)
```

Then three sections: **Goal**, **Decisions** (each with its reason as it
stands now, no history; rejected ideas as "Not doing X, because …") and
**Tasks**, each as `### T1: title` with its detail, an `- Acceptance:` line and
optionally `- Test: \`command\``. **Out of scope**, **Context** and
**Acceptance criteria** are optional. A spec should be as short as the change
allows: everything in it is something the build has to read and may echo.

- **Several features from one conversation?** One spec each: each is built,
  reviewed and committed on its own. `Depends on:` orders them; building one
  before its dependency asks you first. Write them all while the discussion is
  fresh; when a later build finds the code has moved on, it resolves the
  difference and lists what it chose.
- **Small related changes** can share a spec.
- **You can edit a spec by hand.** It just has to keep the format.
<!-- /pb -->

<!-- pb:topic build -->
## Building

`/pb:build` (pick a spec if there are several) opens a new session named after
it, on the same model and thinking level as the session you ran it from (a new
Pi session would otherwise start from your settings' defaults). Inside:

1. **The tasks.** The build starts with T1 straight away; the harness hands the
   tasks out one at a time. When Pi says a task
   is done, the harness runs its check. Pass: next task. Fail: the output goes
   back to Pi to fix the root cause, up to `maxAttempts` times, then the build
   pauses for you.
2. **The end.** After the last task, the full test suite runs once (when the
   verification is `tests`), and the build is complete.

The build treats the spec as settled: it implements, it doesn't re-plan. Where
the spec is ambiguous, contradicts itself or doesn't match the code, Pi doesn't
stop to ask: it takes the sensible reading, records it in the spec's Decisions
as an **assumption**, and carries on. The build
summary lists these choices and the reviewer checks them, so you look once, at
the end. Pi stops with a question only when a choice would change behaviour, an
API or data. It also leaves `.pi/` alone.

The build's instructions are deliberately short (a handful of lines): long rule
lists make models write more defensive, more verbose code. Comments explain the
code as it is, never its history: no dates, "decided", previous values or task
ids; decisions stay in the spec.

Most such problems are caught earlier anyway: before writing a spec, `/pb:spec`
checks it against itself and the code (examples against rules, "unchanged"
against "extended", every path and name), resolves what it finds, and tells you.

While it runs, this is an ordinary Pi session: watch, interrupt with Esc, ask
things. **Decisions you make here** are written into the spec's Decisions
(`pb_record_decision`), so they survive compaction and reach the reviewer.
`/pb:build <guidance>` resumes after any pause and records the guidance too.

The harness also watches the tests themselves: a task that deletes existing
tests, cuts their number of cases, or skips them fails its check (when
verification is `tests`).
<!-- /pb -->

<!-- pb:topic verification -->
## Checks and tests

Two separate choices, both in the spec header:

**Verification: what runs after each task.**

| | After each task | At the end | Use for |
|---|---|---|---|
| `tests` | the task's `Test:` command, else the whole suite | the whole suite | the default |
| `build` | compile or typecheck only | the same | no tests wanted for this feature, or a suite you are deliberately ignoring |
| `none` | nothing: Pi's word | nothing | docs, config, spikes |

The commands come from `.pi/pb/config.json` (`"verify"` and `"build"`, `"auto"`
detects Maven, Gradle, npm/TypeScript, Cargo, Go and pytest).

**New tests: whether tasks add tests.** `yes` by default. `New tests: no —
<why>` is yours to set: the build adds no tests, the existing ones still run,
and the reviewer won't flag the missing ones.
<!-- /pb -->

<!-- pb:topic stuck -->
## A task keeps failing

After `maxAttempts` failed checks the build pauses on that task. Read the
failure (it's in the session), then:

- **A nudge**: `/pb:build <hint or different approach>`. The task gets a fresh
  set of attempts, and the hint goes into the spec's Decisions.
- **Throw the attempt away**: `/pb:undo <task>` restores the files to before it,
  then `/pb:build <what to do differently>`.
- **The build session is gone** (a crash, or you closed it): `/pb:build` from
  any other session offers the spec again as "restart the build"; finished
  tasks stay done, and the new session continues with the first open task.
- **The task or the spec is wrong**: go back to your planning session and
  `/pb:spec <name>` to rewrite it (done tasks keep their status), then
  `/pb:build` in the build session.
- **The check itself is wrong** (a flaky or unrelated test): fix the check, or
  change the spec's `Test:` line or verification.
<!-- /pb -->

<!-- pb:topic review -->
## Review

`/pb:review` runs the check once more, then starts a **fresh** reviewer: a
separate call that sees the spec, the diff and the check result, but not the
build conversation, so it isn't anchored by the builder's reasoning. It checks
every acceptance criterion with evidence, the decisions (including rejected
alternatives), tests, comments, the quality bar and security. `/pb:review
<focus>` points it at something specific.

The findings land in the session you ran it from; run it **in the build
session** and fix them right there: that session knows the code it just wrote.
Then `/pb:review` again if you want a second look. The reviewer's model can be
set in `.pi/pb/config.json` (`"reviewer": {"model": "provider/id"}`).
<!-- /pb -->

<!-- pb:topic undo -->
## Undo

Before each task the harness snapshots the working tree (in git's object store,
without touching your branch, commits or staging area). `/pb:undo` in the build
session lists the tasks; pick one and the files and task list go back to how
they were **before** it. `/pb:undo u1` reverses an undo. If you committed in
between, the undone work shows up as uncommitted changes (you're warned).
<!-- /pb -->

<!-- pb:topic status -->
## Status, stats and archive

- **`/pb:status`**: every spec, its state, verification, dependencies and tasks.
- **`/pb:stats`**: for this build: tasks done on the first try, checks run and
  failed, pauses, the review verdicts, and the build session's tokens, share
  served from cache, peak context, cost and time. `/pb:stats all` compares every
  spec, archived ones included.
- **`/pb:archive`**: moves a finished spec to `.pi/pb-archive/` (which git
  ignores), so `/pb:build` and `/pb:status` only show live work.
<!-- /pb -->

<!-- pb:topic rules -->
## Rules of thumb

- **Plan long, spec precisely, build short.** The spec is the only thing the
  build knows.
- **Write rejected ideas into the spec.** "Not doing X, because …" stops them
  from coming back.
- **Read what `/pb:spec` resolved, and the build's assumptions**: that's where
  a wrong guess shows up cheapest.
- **Nudge with `/pb:build <hint>`; undo when the code is wrong; rewrite the
  spec when the plan is wrong.**
- **Review in the build session, then commit** before building the next spec.
<!-- /pb -->

## What now? (the blocks shown in Pi)

### After /pb:plan
<!-- pb:tip plan.next -->
**What now**
- Answer the questions, push back on the recommendation, take your time.
- Ready? `/pb:spec` writes the spec · more: `/pb:help plan`
<!-- /pb -->

### After /pb:spec
<!-- pb:tip spec.next -->
**What now**
- Read the spec in `.pi/pb/specs/`: this is what the build will know, and nothing else.
- Change something? Say it here and `/pb:spec` again · more: `/pb:help spec`
- Next: `/pb:build` (a new session opens)
<!-- /pb -->

### Build paused
<!-- pb:tip build.paused -->
**What now**
- Answer or discuss here, then `/pb:build` to continue (`/pb:build <guidance>` records it in the spec).
- Code went wrong? `/pb:undo` · the spec is wrong? `/pb:spec {spec}` in your planning session · more: `/pb:help stuck`
<!-- /pb -->

### Build paused: a task keeps failing
<!-- pb:tip build.paused-attempts -->
**What now** ({task} keeps failing its check)
- Read the failure above. `/pb:build <hint or different approach>` gives {task} a fresh set of attempts.
- Code went somewhere bad? `/pb:undo {task}`, then `/pb:build <what to do differently>` · more: `/pb:help stuck`
<!-- /pb -->

### Build complete
<!-- pb:tip build.done -->
**What now**
- Next: `/pb:review`, here in this session, so you can fix findings right away.
- Then commit, and `/pb:archive` · more: `/pb:help review`
<!-- /pb -->

### Review passed
<!-- pb:tip review.pass -->
**What now**
- Minor findings? Ask Pi to fix them here, then commit.
- `/pb:archive` when it's merged; the next spec: `/pb:build` from your planning session.
<!-- /pb -->

### Review found changes
<!-- pb:tip review.changes -->
**What now**
- Ask Pi here to fix them ("fix findings 1 and 3"); it knows this code.
- Then `/pb:review` again · more: `/pb:help review`
<!-- /pb -->

### Review without a verdict
<!-- pb:tip review.other -->
**What now**
- Read the findings above; fix what's worth fixing here, then `/pb:review` again.
<!-- /pb -->

### After /pb:undo
<!-- pb:tip undo.done -->
**What now**
- `/pb:build` continues from here. Changed your mind? `/pb:undo {id}` goes back.
<!-- /pb -->
