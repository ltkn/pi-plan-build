# Using pb

pb turns a conversation into a feature in four moves: **plan** it together,
write it down as a **spec**, **build** it task by task behind checks the harness
runs, and have it **reviewed** by someone who never saw the build. After every
step Pi shows a short **What now** block; `/pb:help <topic>` posts any section below.

<!-- pb:topic flow -->
## The normal path

1. **`/pb:plan <what you want, in your own words>`**: Pi investigates (it can
   run anything, but won't touch the project's files): the code involved, the
   conventions, how a similar feature is built. The harness runs the test suite
   in the background meanwhile, so you both know whether it passes today. Then
   you discuss: the approach, the trade-offs, the questions only you can answer.
   This is the cheapest place to change your mind.
2. **`/pb:build`**: Pi writes a short **spec** from the discussion (goal,
   decisions, tasks); you read it and choose: build here, build in a fresh
   session, edit it first, or not now. The tasks then run one by one, each
   behind a check the harness runs.
3. **`/pb:review`**: a fresh reviewer compares the change with the spec and
   your standards; blocking findings get a second look before you see them.
   Fix them right there, `/pb:review` again (it looks only at what changed),
   commit, and `/pb:archive`.

The build stays in the conversation that planned it: nothing you discussed is
lost, and the prompt cache keeps working. The spec is written to disk so it
survives compaction and reaches the reviewer. For a large feature after a long,
messy discussion, build in a fresh session from the spec alone; pb recommends
that itself when the session is over half full or the build runs on another model.

For a small change, you don't need the whole flow: work with Pi as usual and
run `/pb:review` on the uncommitted change.

Your engineering standards (quality, dependencies, comments, tests) live in
AGENTS.md, written once and loaded by Pi everywhere: see `/pb:help standards`.
<!-- /pb -->

<!-- pb:topic standards -->
## Your standards

Your engineering standards belong in **AGENTS.md**, which Pi loads into every
session by itself: planning, building, the reviewer's call, and your plain Pi
sessions too. The first time you plan in a project, pb offers once to add its
default section there (this project's `AGENTS.md`, or `~/.pi/agent/AGENTS.md`
for all your projects), marked `<!-- pb:standards -->`. Edit it there. The
default covers:

- **Quality**: the best current practice for the stack, a proper fix rather
  than a workaround; modern idioms unless they'd clash with the surrounding code.
- **Dependencies**: current, non-deprecated APIs. Upgrading is a change of its
  own (`/pb:deps`), not part of every feature.
- **Comments**: explain the code as it is, never its history (no dates,
  "decided", previous values or task ids); decisions stay in the spec.
- **Tests**: behaviour, in the project's style; never weaken an existing test.

Make them yours: "Java 21: records and sealed types, no Lombok", "every public
API has a Javadoc contract", "no new dependencies without asking". Keep them
short: every line is read in every session. A session that started before you
added them gets them in pb's messages until it's restarted.
<!-- /pb -->

<!-- pb:topic plan -->
## Planning

`/pb:plan <describe what you want to build or change, in your own words>`, e.g.
`/pb:plan let admins cancel an order while it is still pending, and notify the
customer`.

**The baseline.** When a test command is known, the harness runs the suite in
the background as planning starts (no tokens) and posts the result into the
session. A suite that already fails would fail the build's final check too, so
`/pb:build` warns you. `"baseline": false` in the config turns it off.

**The explorer.** For broad questions (where things live, how a similar feature
is built, what calls what), Pi calls `pb_explore`: a separate, read-only
context that reads what it needs and hands back only the answer, so the
planning conversation stays lean. Pi decides when it's worth it; several can
run at once. Give it a cheaper model in the config
(`"explorer": {"model": "provider/id"}`); its thinking level defaults to low.

**Investigating is free, changing the project isn't.** Pi can read, search, run
the build and tests, curl an API, and write and run one-off scripts or programs
(Python, Java, …) in a temporary directory. Editing or writing any file inside
the project is blocked in this session until you build here (`/pb:build` lifts
it). Commands can still write files, so pb snapshots the project when planning
starts; if anything changed by the time you build (or run `/pb:plan off`), it
lists the files and asks whether to keep or restore them.

**Questions.** Pi asks what only you can decide; a choice between options comes
as a dialog (`pb_ask`) with its recommendation marked.

Discuss as long as you like. When a discussion turns out to cover two things you
would merge separately, Pi should say so; they become two specs.

`/pb:plan off` lifts the block for this session without building anything.

**Dependencies** are planned on their own: `/pb:deps [which]` checks the
versions in use, deprecations and what an upgrade would break, and proposes the
upgrades worth doing; `/pb:build` turns them into a spec.

**Finding your sessions again.** `/pb:plan` names the session "plan: <what you
asked>", and a fresh build session is named "build: <spec>". Both show up by
name in Pi's `/resume` picker, and the first message of each shows its id:
`pi --session <id>` reopens it directly, e.g. after a crash. `/pb:status` lists
which session each build runs in.
<!-- /pb -->

<!-- pb:topic spec -->
## The spec

`/pb:build` (or `/pb:spec`) has Pi write one spec per feature through the
`pb_write_spec` tool, which rejects anything that doesn't follow the format and
says why. The header tells the build how to check the work:

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

Before writing, Pi checks the spec against itself and the code (examples
against rules, "unchanged" against "extended", every path and name), resolves
what it finds, and tells you.

When `/pb:build` wrote it, you see the whole spec and choose: **build here**,
**build in a fresh session**, **edit the spec first** (in an editor; it's saved
only when it still parses, and the build then gets your version), or **not now**.

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

`/pb:build` builds **in the session you run it from**. If this conversation
hasn't produced a spec yet, Pi writes one first and shows it. With several
specs, pick one. pb recommends a **fresh session** instead when this one is
more than half full (`freshAbove`) or when `buildModel` names another model
(switching models mid-conversation re-sends the whole conversation to the new
model, uncached); `/pb:build --fresh` asks for one directly: a new session
named "build: <spec>", seeded with the spec, on your model and thinking level.

1. **The tasks.** The build starts with T1 straight away. Pi finishes each task
   with `pb_task_done`, and the harness runs the task's check **inside that
   call**: a failure comes straight back to fix (up to `maxAttempts`, then the
   build pauses for you), a pass comes back with the next task. The whole build
   is one uninterrupted run, so the prompt cache stays warm even through long
   test runs.
2. **The end.** After the last task, the full test suite runs once (when the
   verification is `tests`), and the build is complete.

The build treats the spec as settled: it implements, it doesn't re-plan. Where
the spec is ambiguous, contradicts itself or doesn't match the code, Pi takes
the sensible reading, records it in the spec's Decisions as an **assumption**,
and carries on. The build summary lists these choices and the reviewer checks
them, so you look once, at the end. When a choice would change behaviour, an
API or data, Pi asks you in a dialog (`pb_ask`) and carries on with your
answer, which goes into the spec. It leaves `.pi/` alone.

A progress line above the editor shows the tasks while it runs. If Pi stops
mid-task without finishing it, pb reminds it once; if it stops again, the build
pauses.

**Compaction.** When a build session fills up, pb writes the compaction summary
itself from what it knows (the tasks and their summaries, the current task, the
last failure, the spec) instead of asking a model to summarize.

**Pruning** (optional, `"pruneAbove": <percent>`): above that share of the
context window, long tool output of finished tasks is replaced by a short note
at each task boundary. It rewrites the cached prompt once to make later turns
lighter, so it pays off only for long builds; measure with the eval before
turning it on.

While it runs, this is an ordinary Pi session: watch, interrupt with Esc, ask
things. **Decisions you make here** are written into the spec's Decisions
(`pb_record_decision`), so they survive compaction and reach the reviewer.
`/pb:build <guidance>` resumes after any pause and records the guidance too;
a pause that wasn't a failing check costs the task no attempt.

The harness also watches the tests themselves: a task that deletes existing
tests, cuts their number of cases, or skips them fails its check (when
verification is `tests`).
<!-- /pb -->

<!-- pb:topic verification -->
## Checks and tests

Two separate choices, both in the spec header:

**Verification: what runs when a task is done.**

| | After each task | At the end | Use for |
|---|---|---|---|
| `tests` | the task's `Test:` command; without one, a compile | the whole suite | the default |
| `build` | compile or typecheck only | the same | no tests wanted for this feature, or a suite you are deliberately ignoring |
| `none` | nothing: Pi's word | nothing | docs, config, spikes |

Give tasks a targeted `Test:` line: without one, a task is only compiled, and
the whole suite runs once at the end rather than after every task.

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
- **Throw the attempt away**: `/pb:undo <task>` restores the files and rewinds
  the conversation to before it, then `/pb:build <what to do differently>`.
- **The session is gone** (a crash, or you closed it): reopen it with `/resume`
  and `/pb:build` continues; or run `/pb:build` from any other session, which
  offers the spec as "restart the build" (finished tasks stay done) and brings
  the spec along, since that session never saw it.
- **The task or the spec is wrong**: say so and `/pb:spec <name>` to rewrite it
  (done tasks keep their status), then `/pb:build`.
- **The check itself is wrong** (a flaky or unrelated test): fix the check, or
  change the spec's `Test:` line or verification.
<!-- /pb -->

<!-- pb:topic review -->
## Review

`/pb:review` runs the check once more, then starts a **fresh** reviewer: a
separate call that sees the spec, the diff and the check result, but not the
build conversation, so it isn't anchored by the builder's reasoning. It checks
every acceptance criterion with evidence, the decisions (including rejected
alternatives and the build's assumptions), tests, comments, your standards and
security, and reports each finding through a tool, not as prose to be parsed.
`/pb:review <focus>` points it at something specific.

Every finding carries a priority: **P0** must fix (broken, insecure, data
loss), **P1** fix before merging (an unmet criterion or decision, a bug,
missing or weakened tests, a workaround), **P2** worth fixing (conventions,
clarity, comments), **P3** a nit. **P0 and P1 findings get a second look**: a
separate verifier checks each against the code, and the ones it rejects are
listed as dismissed, with its evidence, instead of costing you a fix cycle
(`"reviewer": {"verify": false}` skips it). Any confirmed P0 or P1 means
*changes needed*.

The findings land in the session you ran it from; run it **in the build
session** and fix them right there: that session knows the code it just wrote.
The next `/pb:review` is a **follow-up**: it checks the previous findings and
looks only at what changed since (`--full` reviews everything again). If
nothing changed, it says so and costs nothing.

**Without a spec**, `/pb:review [what the change is meant to do]` reviews the
uncommitted change against that intent and your standards: useful for any
change you made with Pi without the rest of the flow.

The reviewer can't change your files: pb snapshots the tree before it starts
and puts back anything it touched. Its model can be set in the config
(`"reviewer": {"model": "provider/id"}`); a different model family than the one
that built the change is a cheap way to get genuinely different eyes.
<!-- /pb -->

<!-- pb:topic undo -->
## Undo

Before each task the harness snapshots the working tree (in git's object store,
without touching your branch, commits or staging area). `/pb:undo` in the build
session lists the tasks; pick one and the files and task list go back to how
they were **before** it, and so does the **conversation**: the discarded attempt
drops out of the context (a one-line note says what was undone), so it doesn't
anchor the next try, and everything before that point is still in the prompt
cache. `/pb:undo u1` reverses an undo, conversation included. If you committed
in between, the undone work shows up as uncommitted changes (you're warned).
<!-- /pb -->

<!-- pb:topic status -->
## Status, stats and archive

- **`/pb:status`**: every spec, its state, verification, dependencies and tasks.
- **`/pb:stats`**: for this build: tasks done on the first try, checks run and
  failed, pauses, the review verdicts, the build session's tokens, share served
  from cache, peak context, cost and time, the explorer's calls, and how often
  the session was compacted, pruned, reminded or asked you something.
  `/pb:stats all` compares every spec, archived ones included.
- **`/pb:archive`**: moves a finished spec to `.pi/pb-archive/` (which git
  ignores), so `/pb:build` and `/pb:status` only show live work.
<!-- /pb -->

<!-- pb:topic rules -->
## Rules of thumb

- **Plan long, spec precisely, build short.** The spec is what survives: it's
  all a fresh or compacted build session has, and what the reviewer checks.
- **Write rejected ideas into the spec.** "Not doing X, because …" stops them
  from coming back.
- **Give tasks a `Test:` line**: a targeted check per task, the full suite once.
- **Read what the spec step resolved, and the build's assumptions**: that's
  where a wrong guess shows up cheapest.
- **Nudge with `/pb:build <hint>`; undo when the code is wrong; rewrite the
  spec when the plan is wrong.**
- **Small change? Skip the flow**: plain Pi, then `/pb:review`.
- **Review where you built, then commit** before building the next spec.
<!-- /pb -->

## What now? (the blocks shown in Pi)

### After /pb:plan
<!-- pb:tip plan.next -->
**What now**
- Answer the questions, push back on the recommendation, take your time.
- Ready? `/pb:build` writes the spec, shows it, and builds on your choice · more: `/pb:help plan`
<!-- /pb -->

### After /pb:spec
<!-- pb:tip spec.next -->
**What now**
- Read the spec in `.pi/pb/specs/`: the build follows it, and the reviewer checks against it.
- Change something? Say it here and `/pb:spec` again · more: `/pb:help spec`
- Next: `/pb:build` (here; `--fresh` for a new session)
<!-- /pb -->

### Build paused
<!-- pb:tip build.paused -->
**What now**
- Answer or discuss here, then `/pb:build` to continue (`/pb:build <guidance>` records it in the spec).
- Code went wrong? `/pb:undo` · the spec is wrong? `/pb:spec {spec}` · more: `/pb:help stuck`
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
- Then `/pb:review` again: it checks those findings and what changed · more: `/pb:help review`
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
