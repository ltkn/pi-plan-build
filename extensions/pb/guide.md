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
2. **`/pb:build`**: first it asks, while you're here, how to go on once the
   spec is written: build here, build in a fresh session, or show you the spec
   first. Then Pi writes a short **spec** from the discussion (goal, findings,
   decisions, tasks) and, unless you wanted to see it, the build starts by
   itself, so you can walk away. The tasks then run one by one, and the
   harness runs the full test suite after the last one; a failure goes back to
   Pi to fix.
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

Your engineering standards (quality, dependencies, comments, tests, security,
concurrency) live in AGENTS.md, written once and loaded by Pi everywhere: see
`/pb:help standards`.
<!-- /pb -->

<!-- pb:topic standards -->
## Your standards

Your engineering standards belong in **AGENTS.md**, which Pi loads into every
session by itself: planning, building, the reviewer's call, and your plain Pi
sessions too. The first time you plan or build in a project, pb offers once to
add its default section there (this project's `AGENTS.md`, or
`~/.pi/agent/AGENTS.md` for all your projects), marked `<!-- pb:standards -->`.
Edit it there. A Java or Vue project's section goes only in its own AGENTS.md:
keep the shared one free of stack-specific rules, since Pi loads both. The
default covers:

- **Quality**: the best current practice for the stack, a proper fix rather
  than a workaround; modern idioms and the latest stable language and platform
  features, even where the surrounding code is older. Outdated code in the way
  gets refactored to current practice, planned as a task of its own.
- **Java** (added for Maven or Gradle projects): Java 25, records, sealed types,
  pattern matching, virtual threads and scoped values; no Lombok.
- **Dependencies**: current, non-deprecated APIs. Upgrading is a change of its
  own (`/pb:deps`), not part of every feature.
- **Comments**: concise, and only where they add what the code can't say;
  the code as it is, never its history (no dates, "decided", previous values
  or task ids); decisions stay in the spec.
- **Tests**: behaviour, written to current best practice even where existing
  tests aren't; new test tooling as a task of its own; never weaken an
  existing test; a test proves a fix only if it fails without it.
- **Security**: every entry point (API, UI action, command, message, file,
  webhook) is assumed to be abused by someone who controls its input, holds a
  stolen or another user's session, and replays or automates requests. Each
  operation checks who the caller is, what they may act on and what they have
  proven; logic reused from another flow keeps that flow's preconditions;
  security-relevant changes get abuse-case tests, written from the attacker's
  side.
- **One source of truth**: a rule or canonical form that already exists (in
  the database or a shared helper) is used, never re-implemented; a second copy
  drifts, and the gap between copies is a bypass.
- **Robustness**: at a boundary, input is assumed hostile or broken (sizes,
  ranges, encodings, duplicates, order, concurrent calls); business rules can't
  be bypassed by quantity, repetition, reordering or racing; every request's
  work is bounded; a failure halfway leaves consistent state. Values that are
  stored, compared or sent are validated strictly. Inside the boundary:
  invariants (types, constraints, transactions), not repeated checks, so the
  code stays clean where the data is already trusted.
- **Consistency and concurrency** come from the database: one transaction per
  request, constraints, atomic statements or row locks, not check-then-write in
  application code.
- **Before calling it done**: the diff re-read as an attacker and as a race,
  and existing copies of any touched rule searched for.

A Vue project (`vue` in package.json, and no pom.xml or Gradle build) gets a
frontend section instead, offered even when a shared AGENTS.md (a parent
folder's, or `~/.pi/agent/`) already has pb's section: the page renders what the backend decides. It keeps
Quality, Dependencies, Tests and Security, and drops the database rules. Its
other bullets:

- **One source of truth**: every rule lives in the backend; input is sent as
  typed, with no client-side validation, trimming or normalizing.
- **Frontend role**: no business rules on the page; minimal state, with backend
  data in the query cache. UI quality is still the page's job: loading and
  disabled states, focus after errors, accessible messages.
- **Backend refusals**: RFC 9457 problem details; the page branches only on
  `type` and shows `detail` and `errors` as sent.
- **Browser security**: an HttpOnly session cookie, CSRF tokens on writes, no
  open redirects, no Referer from pages whose URL carries a token, no `v-html`
  on backend or user data.
- **Vue**: Vue 3.5 with `<script setup lang="ts">`, TypeScript 6, Vite, Vue
  Router, TanStack Vue Query, Bootstrap 5.3 through Sass, Vitest with MSW,
  pnpm; Pinia only for client-only state.
- **Frontend tests**: each page through the real router against a scripted
  backend, one test per response `type` plus an unknown one.
- **Comments**: dense, because backend (Java) developers maintain these apps:
  every platform-integration step says why. Still never history.
- **Before calling it done**: as above, plus a double click, a session that
  expires mid-edit, and a URL from the query string.

Make them yours: "Java 25: records, sealed types, pattern matching, virtual
threads and scoped values; no Lombok", "every public
API has a Javadoc contract", "no new dependencies without asking". Keep them
short: every line is read in every session. A session that started before you
added them gets them in pb's messages until it's restarted.

**Your own templates.** Put a section in `~/.pi/agent/pb/standards/<name>.md`:
a `java.md`, `vue.md` or `plain.md` there replaces pb's, and any other name adds
a stack. An optional first line says when it applies, e.g.
`detect: go.mod` or `detect: package.json:react` (files at the project root,
or a dependency in one); yours are checked before pb's. pb adds its markers,
and a heading when yours has none.

`/pb:standards [stack]` writes the current section into this
project's AGENTS.md at any time: after a pb update improved them, after you
declined the offer, or when the file went missing. It creates the file if
needed and replaces only pb's section, so your own lines and the project map
stay as they are; your edits inside pb's section are replaced. Without an
argument, the section is picked from the project.

**Your own instructions for a role.** `"extra"` in `.pi/pb/config.json` (and
in `~/.pi/agent/pb/config.json` for every project, applied first) adds your
instructions to a role's prompt: `plan`, `spec`, `build`, `review`,
`adversarial`, `map`, e.g. `{"extra": {"review": "Check every new message has an
i18n key."}}`. They're added after pb's, never instead: pb's prompts carry the
formats and tools the harness relies on.
<!-- /pb -->

<!-- pb:topic plan -->
## Planning

`/pb:plan <describe what you want to build or change, in your own words>`, e.g.
`/pb:plan let admins cancel an order while it is still pending, and notify the
customer`.

**The baseline.** When a test command is known, the harness runs the suite on
the last commit as planning starts, in a separate git worktree (so it can't
collide with a build in your working copy, e.g. Maven's `target/`), in the
background and without tokens, and posts the result into the session. A suite that already fails would fail the build's final check too, so
`/pb:build` warns you. `"baseline": false` in the config turns it off.

**The explorer.** For broad questions (where things live, how a similar feature
is built, what calls what), Pi calls `pb_explore`: a separate, read-only
context that reads what it needs and hands back only the answer, so the
planning conversation stays lean. Pi decides when it's worth it; several can
run at once. Each shows its question, its live steps (what it greps and reads)
and then one summary line: time, files read, tokens, and the answer's first
line; expand it for the whole answer and the files it read. Give it a cheaper model in the config
(`"explorer": {"model": "provider/id"}`); its thinking level defaults to max
(clamped to what the model supports), `"explorer": {"thinking": "medium"}`
lowers it.

**Investigating is free, changing the project isn't.** Pi can read, search, run
the build and tests, curl an API, and write and run one-off scripts or programs
(Python, Java, …) in a temporary directory. Editing or writing any file inside
the project is blocked in this session until you build here (`/pb:build` lifts
it). Commands can still write files, so pb snapshots the project when planning
starts; if anything changed by the time you build (or run `/pb:plan off`), it
lists the files and asks whether to keep or restore them.

**Questions.** Pi asks what only you can decide; a choice between options comes
as a dialog (`pb_ask`) with its recommendation marked. If you're away, it counts
down (`askTimeoutSec`, 5 minutes) and Pi goes on with its recommendation, telling
you it's an assumption to confirm.

A question you didn't answer (it timed out, or you closed the dialog) **stays in
the chat** with its options lettered: type your answer whenever you're back ("A"
is enough) and Pi follows it. If Pi is working, a message sent with Enter is read
after its current step, without interrupting it. When pb asks you something, a question or a dialog
that goes on without you, it also sends a **desktop notification**, in case
you're in another window (`"notify": false` turns it off). Ghostty, iTerm2,
WezTerm, Kitty, macOS Terminal and Windows Terminal show it; in tmux it may
not get through.

Discuss as long as you like. When a discussion turns out to cover two things you
would merge separately, Pi should say so; they become two specs.

**Long discussions: the checkpoint.** A planning session isn't compacted like
other sessions. When it passes `checkpointAt` (75% of its context window, and
always early enough to stay clear of Pi's own compaction), Pi writes the plan to
its spec right after its reply, while it still has the whole discussion:
`Status: planning`, the Findings (with the dead ends, and why), the Decisions
with rejected ideas, and the Open questions (with each option still being
weighed and what was found for and against it), so even a discussion that
settled little keeps what it found. pb then resets the session to that spec,
plus your last message and the reply to it, word for word. The discussion goes
on from the plan as it stands, with room to spare. Later checkpoints update only
the sections that changed.

**On demand**: `/pb:compact` writes and resets now, e.g. before you quit.
**Changed your mind?** `/pb:compact undo` brings the whole discussion back
(the reset only changed what the model sees; the session file keeps
everything). The spec keeps what the checkpoint wrote.

**Walking away.** Every dialog on the way into a build counts down
(`askTimeoutSec`, 5 minutes) and then goes on with pb's choice: build (here, if
a fresh session can't be opened at that point), keep files changed while
planning, build despite a red baseline or an unbuilt dependency. The build
summary lists what was decided without you.

**Coming back later.** Reopen the session (`/resume`): after a checkpoint it
starts small, from the spec as it was at that checkpoint plus what followed.
Or start clean from the spec as it is on disk now (including your own edits):
`/pb:plan <spec>` continues planning in a fresh session, open questions first.
Quitting a big session that never reached the checkpoint? `/pb:compact`
first, or it comes back at full size.

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

Then the sections:

- **Goal.**
- **Findings**: what the analysis established, so nobody redoes it: the files
  and classes involved and their roles, the code to imitate (by path and lines,
  not pasted), constraints, the test command and baseline.
- **Decisions**: each with its reason as it stands now, no history; rejected
  ideas as "Not doing X, because …", so they aren't reconsidered.
- **Contracts**: only when other code, clients or stored data depend on the
  change: public signatures, API requests and responses with their error types,
  the data model and migrations, events. They're pinned as they must end up;
  everything behind them is left to the build, which asks before changing one,
  and the reviewer checks each.
- **Open questions**: only while `Status: planning`.
- **Tasks**: each as `### T1: <outcome>`, what must be true when it's done
  rather than how to build it, with `- Acceptance:` lines and, when it adds
  behaviour, `- Test: \`command\``. Each Acceptance line is one behaviour as a
  test would check it, abuse cases included: they are the tests to write. One
  task, unless a slice is worth reviewing on its own; then vertical slices, each
  working and tested, never a split by layer or a closing "add tests" task.
- **Design**: written by the build, not the plan: the shape the skeleton
  settled on and why. The reviewer checks the code against it, and `/pb:archive`
  hands it to the project map.

The spec pins what the change must do and how you'll know; how to build it is
left to the build, where the compiler and the tests give feedback. When a
decision rests on something only running code shows (a library's limits,
performance), planning tries it in a scratch copy first.

**Out of scope** and **Acceptance criteria** are optional. The aim: a fresh or
reset session starts where the discussion ended, without re-analysing and
without being buried. Pi points to code instead of copying it and states each
fact once; `pb_write_spec` reports the size and only suggests tightening a long
spec. `pb_update_spec` changes one section at a time.

A spec with `Status: planning` is a checkpoint of an unfinished discussion (no
tasks or verification needed yet). `/pb:build` finishes it first: open
questions settled, tasks written, `Status: ready`. `/pb:spec <name>` revises a
spec from the file on disk, not from memory.

Before writing, Pi checks the spec against itself and the code (examples
against rules, "unchanged" against "extended", every path and name), resolves
what it finds, and tells you.

**Writing it is painless.** The questions belong to planning. What the
discussion left open, Pi settles itself and records in Decisions as
`Assumption: … because …`. They're listed when the spec is shown, and the
reviewer checks them. It asks you only about a choice that changes behaviour,
an API or data that you didn't settle, all at once, and when `/pb:build` is
writing the spec those questions count down too. A checkpoint asks nothing at
all: what's undecided goes under Open questions.

When `/pb:build` writes it, it asks first: **build here**, **build in a fresh
session**, or **show me the spec first**. Built straight away, the spec is still
shown in the session for later. Shown first, you choose: build here, build in a
fresh session, **edit the spec first** (in an editor; it's saved only when it
still parses, and the build then gets your version), or not now.

- **Threats and abuse.** When a change adds or alters an entry point, touches
  a trust boundary (authentication, authorization, credentials, sensitive data,
  external input) or has rules someone gains from breaking (money, quantities,
  limits, quotas, state), the spec gets a `## Threats and abuse` section: who can
  reach it and with what, what they must prove or be allowed, how it could be
  abused (including by quantity, repetition, reordering or racing), and what
  prevents each abuse. Its acceptance criteria include the abuse cases.
  That's the cheapest place to catch a design hole, before any code exists.
- **Refactoring first.** When outdated code stands in the way (your standards
  ask for current practice), the spec starts with tasks titled `(refactor) …`
  that keep behaviour; the reviewer checks exactly that. A large refactor is a
  spec of its own that the feature `Depends on:`.
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

1. **The skeleton.** When tasks add behaviour (they have a `Test:` line, with
   `Verification: tests` and `New tests: yes`), the build starts by designing the
   change in code, without its behaviour: the types, signatures and wiring as
   stubs, and the tests for every task's Acceptance lines. Pi reports the design
   with `pb_skeleton_done`; the harness requires the code to compile and **every
   task's tests to fail**, and writes the design into the spec's `## Design`.
   For a large change (the spec has Contracts, or more than two such tasks) pb
   shows you the design and asks: go on, edit it first, or stop to look at the
   stubs and tests (`"designReview"`: `"large"` by default, `"ask"` always,
   `"off"`); unanswered, it goes on. A design is cheaper to change as
   signatures and failing tests than as finished code.
2. **The tasks.** Each task then fills the design in until its tests pass. Pi finishes each task
   with `pb_task_done`, which hands out the next one: the whole build is one
   uninterrupted run, so the prompt cache stays warm. Pi checks its own work as
   it goes (the task's `Test:` line tells it how).
3. **The end.** After the last task, the harness runs the full test suite (a
   compile for `Verification: build`) **inside that same call**. A failure
   comes straight back to fix, up to `maxAttempts`, then the build pauses for
   you. The agent's word never ends a build: the check does.

**A check after every task** (`"taskChecks": "each"`): the harness also runs each
task's `Test:` command (a compile when it has none) when the task is done. It
catches a broken task earlier, but makes every task leave the build green on
its own, which slices work unnaturally and costs a run per task.

The spec's Goal, Decisions, Contracts and Acceptance bind the build: changing
one takes a `pb_ask`. How to build it is the build's: a better way found while
coding is taken, and a change to the Design is recorded. Where
the spec is ambiguous, contradicts itself or doesn't match the code, Pi takes
the sensible reading, records it in the spec's Decisions as an **assumption**,
and carries on. The build summary lists these choices and the reviewer checks
them, so you look once, at the end. When a choice would change behaviour, an
API or data, Pi asks you in a dialog (`pb_ask`) and carries on with your
answer, which goes into the spec; answering early often saves later questions.
If you're away, the dialog counts down (`askTimeoutSec`, 5 minutes) and the
build goes on with Pi's recommendation, recorded as an assumption. It leaves
`.pi/` alone.

A progress line above the editor shows the tasks while it runs. If Pi stops
mid-task without finishing it, pb reminds it once; if it stops again, the build
pauses.

**Compacting a build on demand.** `/pb:compact` in a build session (while it's
paused, or between your messages) compacts it the same way: the summary is the
build's state, written by pb, not by a model.

**A full build session.** When a task finishes and the session is past
`checkpointAt` (75% of its window, always before Pi would compact), pb resets it
right there, between two tasks, where nothing is half-done. The build goes on
from a summary pb writes itself: the build's rules, every task with its
summary, the assumptions, the spec and the next task. No summarizing model call,
and nothing of the finished task is needed any more. Should a single task still
run into Pi's own compaction, pb writes that summary too, adding the files the
task has changed so far and the files read before, so it carries on instead of
starting over. `/pb:undo` to a task from before a reset restores the files only
(the old conversation would bring the whole context back) and says what was
undone.

While it runs, this is an ordinary Pi session: watch, interrupt with Esc, ask
things. **Decisions you make here** are written into the spec's Decisions
(`pb_record_decision`), so they survive compaction and reach the reviewer.
`/pb:build <guidance>` resumes after any pause and records the guidance too;
a pause that wasn't a failing check costs the task no attempt.

The harness also watches the existing tests: when a task deletes some, cuts
their number of cases or adds skip markers, it doesn't stop the build (a
refactor legitimately moves and merges tests); the changes are listed at the
end and handed to the reviewer, who judges whether each was justified.
<!-- /pb -->

<!-- pb:topic verification -->
## Checks and tests

Two separate choices, both in the spec header:

**Verification: what the harness runs.**

| | At the end | After each task (`taskChecks: "each"` only) | Use for |
|---|---|---|---|
| `tests` | the whole suite | the task's `Test:` command; without one, a compile | the default |
| `build` | compile or typecheck only | the same | no tests wanted for this feature, or a suite you are deliberately ignoring |
| `none` | nothing: Pi's word | nothing | docs, config, spikes |

Give tasks a targeted `Test:` line: it's how Pi checks each task as it goes.

**Red, then green.** With `Verification: tests` and `New tests: yes`, a task
with a `Test:` line (and not titled "(refactor) …") must have its tests seen
**failing** before its change exists: that shows they check the behaviour that
is missing. The skeleton does it for every task at once, after a compile, so a
test fails on its assertion rather than on a missing symbol. A task that
wasn't covered (added to the spec later) proves its own with `pb_tests_red`
before `pb_task_done` takes it; that refusal costs no attempt. Tests that pass
too early are sent back, and `/pb:undo` takes the proof back with the files.

The commands come from `.pi/pb/config.json` (`"verify"` and `"build"`, `"auto"`
detects Maven, Gradle, npm/TypeScript, Cargo, Go and pytest).

**New tests: whether tasks add tests.** `yes` by default. `New tests: no —
<why>` is yours to set: the build adds no tests, the existing ones still run,
and the reviewer won't flag the missing ones.
<!-- /pb -->

<!-- pb:topic stuck -->
## A check keeps failing

After `maxAttempts` failed checks (the final one, or a task's with
`taskChecks: "each"`) the build pauses. Read the failure (it's in the session),
then:

- **A nudge**: `/pb:build <hint or different approach>`. The check gets a
  fresh set of attempts, and the hint goes into the spec's Decisions.
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

`/pb:review` runs the check once more, then opens a **fresh session**, "review:
<spec> · spec", and takes you there: the reviewer sees the spec, the diff and the check
result, but not the build conversation, so it isn't anchored by the builder's
reasoning. It checks
every acceptance criterion with evidence, the decisions (including rejected
alternatives and the build's assumptions), `(refactor)` tasks for unchanged
behaviour, the existing tests the build changed, comments, your standards and
security, and reports each finding through a tool, not as prose to be parsed.
It also judges **the spec itself**: a faithful build of a wrong plan is still
wrong, so problems in the plan come back as findings on the spec file.
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

**The adversarial pass, on every review.** A second fresh session, "review:
<spec> · adversarial", has a single job: break the change. For every entry point it adds or alters and
every rule it enforces, it looks for:

- **access**: another user's data, a stolen session, what each state change
  requires the caller to prove, reused logic that lost its preconditions
- **business rules** bypassed by negative, zero or huge quantities, repeated,
  skipped or reordered steps, acting on yourself or twice
- **concurrency**: races on shared state, check-then-act gaps, double submits,
  retries that aren't idempotent
- **resources**: unbounded work per request, cost amplification
- **failure**: inconsistent or duplicated state after a failure halfway
- **numbers and time**: overflow, floats for money, rounding, time zones, expiry
- **trust**: data from the database, services, queues or files taken as safe;
  injection of any kind
- **leaks** through responses, errors, logs or timing
- **configuration**: defaults, migrations and permissions
- the spec's Threats and abuse: each one prevented and tested

It proposes fixes at the boundary or as invariants, not checks scattered through
the code. Its findings, marked "Adversarial:", get the same second look as the rest.
`"reviewer": {"security": "always" | "auto" | "off"}`: `always` is the default;
`auto` runs it only when the spec has Threats and abuse or the change touches
auth, entry points, money, quantities or state (a broad guess); `off` never.

**Without a spec**, `/pb:review [what the change is meant to do]` reviews the
uncommitted change against that intent and your standards: useful for any
change you made with Pi without the rest of the flow.

**Inside the review.** The spec pass, and then the adversarial pass, each run
in a real Pi session you're in: you watch everything natively, and you can
interrupt it or ask it something ("why is 3 a P1?"). Its model is read-only: it
can't edit or write files, and anything its commands change is put back. A pass
ends when it has reported its findings and stops, or at `/pb:review done`. When
the spec pass is done, pb asks whether to run the adversarial pass now
(unanswered, after `askTimeoutSec`, it runs; skipped, the result says so), and
finally takes you back to your session with the result. Asking questions is
fine; arguing it out of a finding makes it less independent. Both sessions stay
in `/resume`, named "review: <spec> · spec" and "· adversarial" (without a spec,
"· intent"), and the result names them too.

**If you leave** (say `/resume` elsewhere) before it's done, the pass you left
stops, and pb keeps where the review stood. The next `/pb:review` offers to
**continue it**: back into that session, where the model carries on from where
it was, then the rest of the review. Reopening that session yourself works too:
`/pb:review continue` there. What had been reported is also in the spec's
`review.md`, where every result is saved.

The double-check of P0/P1 findings runs in the background, with its last lines
shown above the editor; its whole run, like the explorer's and the project
map's, is saved to open with `pi --session <file>`. `/pb:archive` removes those
saved runs.

The reviewer can't change your files: pb snapshots the tree before it starts
and puts back anything it touched. By default it runs on your session's model,
likely the one that built the change and shares its blind spots; the first
review in a project offers to pick another (`"reviewer": {"model": "provider/id"}`
in the config). A different model family is the cheapest way to get genuinely
different eyes.
<!-- /pb -->

<!-- pb:topic undo -->
## Undo

Before each task the harness snapshots the working tree (in git's object store,
without touching your branch, commits or staging area). `/pb:undo` in the build
session lists the tasks; pick one and the files and task list go back to how
they were **before** it, and so does the **conversation**: the discarded attempt
drops out of the context (a short note says what was undone, and repeats what
you said meanwhile so your guidance isn't lost), so it doesn't anchor the next
try, and everything before that point is still in the prompt cache.
`/pb:undo u1` reverses an undo, conversation included. If you committed
in between, the undone work shows up as uncommitted changes (you're warned).
<!-- /pb -->

<!-- pb:topic map -->
## The project map

A short section of this project's AGENTS.md (marked `<!-- pb:map -->`, apart
from the standards and from what you wrote) with what stays true across
features: the layout and the role of each module, the patterns to follow (by
path), constraints the code doesn't make obvious, test and build quirks. Pi
loads AGENTS.md into every session, so every plan, build, review and
exploration starts with it instead of rediscovering it.

- **When a feature is done**, `/pb:archive` updates it from what the feature
  established (its spec's Findings, the files it changed); `"mapOnArchive":
  false` turns that off.
- **Any time**, `/pb:map [focus]` refreshes it from the code as it is now.
- **`/pb:map undo`** puts the previous map back (again: swaps them back).

A fresh, read-only call proposes the whole new map (it revisits all of it, not
only the new area). Its readers are capable models that explore fast, so it
holds only what exploring wouldn't show them: security and data invariants with
the code that enforces them, where new code goes and what to copy, known gaps,
commands and quirks, docs the code contradicts, and layout only where names
mislead. It's written in short bullet lines, as short as the project allows, up
to about 20,000 tokens: it's read in every session, so a line stays only if it
saves a later feature a search or a mistake. Your session doesn't grow. pb
checks every path it names, from the project root, under the path a heading
names, and as the end of a real file (`auth/Login` finds
`…/auth/Login.java`); the ones that still don't resolve go back to it once to
be corrected, and so does a map over the budget, to be trimmed. Then the map is written and the change is shown. It asks you
first only when something looks off: paths that still don't resolve, or a
large part of the existing map removed; unanswered, the current map stays.
`/pb:plan` warns when paths in the map no longer exist (a cheap check, no
model call).
<!-- /pb -->

<!-- pb:topic status -->
## Status, stats and archive

- **`/pb:status`**: every spec, its state, verification, dependencies and tasks.
- **`/pb:stats`**: for this build: tasks done on the first try, checks run and
  failed, pauses, the review verdicts, the build session's tokens, share served
  from cache, peak context, cost and time, the explorer's calls, and how often
  the session was compacted, reset, reminded or asked you something.
  `/pb:stats all` compares every spec, archived ones included.
- **`/pb:archive`**: moves a finished spec to `.pi/pb-archive/` (which git
  ignores), so `/pb:build` and `/pb:status` only show live work, and offers to
  update the project map (`/pb:help map`).
<!-- /pb -->

<!-- pb:topic rules -->
## Rules of thumb

- **Plan long, spec precisely, build short.** The spec is what survives: it's
  all a fresh or compacted build session has, and what the reviewer checks.
- **Write rejected ideas into the spec.** "Not doing X, because …" stops them
  from coming back.
- **Give tasks a `Test:` line**: how Pi checks each task; the harness runs the full suite once.
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
- Ready? `/pb:build` asks how to build, writes the spec, and builds · more: `/pb:help plan`
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
- Then commit (the message above is ready to paste), and `/pb:archive` · more: `/pb:help review`
<!-- /pb -->

### Review passed
<!-- pb:tip review.pass -->
**What now**
- Minor findings? Ask Pi to fix them here, then commit with the message above.
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
