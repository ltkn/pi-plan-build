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
   decisions, tasks); a risky spec gets a review of its own before the first
   task — fresh eyes, read-only — and a P0/P1 stops it for you to amend or
   rebut; P2/P3 are shown and the build goes on (see `/pb:help spec`). Run
   `/pb:build` again to go on after a block. A clean or advisory-only review
   starts by itself, so you can walk away. The
   tasks then run one by one, and the harness runs the full test suite after the
   last one; a failure goes back to Pi to fix.
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

**The explorer.** For broad or multi-file questions (where things live, how a similar feature
is built, what calls what), Pi calls `pb_explore`: a separate, read-only
context that reads code only (experiments — curl, scripts, builds — stay in the
planning session) and hands back only the answer as Answer / Files (`path:line`)
/ Uncertainties, so the planning conversation stays lean. It checks the project
map in AGENTS.md first and explores only what the map doesn't answer. When the 1-3 files are
known, Pi reads them itself and trusts the explorer's Files list instead of
re-reading everything. Pi decides when it's worth it; several can
run at once. Each shows its question, its live steps (the last few of what it
greps and reads, repainted a few times a second so fast runs stay followable)
and then one summary line: time, files read, tokens in/out with output rate,
and the answer's first
line; expand it for the whole answer and the files it read. Give it a cheaper model in the config
(`"explorer": {"model": "provider/id"}`); its thinking level defaults to max
(clamped to what the model supports), `"explorer": {"thinking": "medium"}`
lowers it.

**Probes.** When something must be established by running (a library's behaviour
or limits, performance, a read-only query), Pi calls `pb_try` with the goal: a
separate context that reads the project but writes scratch files only outside
it (anything it changes in the project is put back) and hands back Commands /
Result / Conclusion. Trivial checks stay in the planning session.

**Investigating is free, changing the project isn't.** Pi can read, search, run
the build and tests, curl an API, and write and run one-off scripts or programs
(Python, Java, …) in a temporary directory. Editing or writing any file inside
the project is blocked in this session until you build here (`/pb:build` lifts
it). Commands can still write files, so pb snapshots the project when planning
starts; if anything changed by the time you build (or run `/pb:plan off`), it
lists the files and asks whether to keep or restore them.

**Questions.** Pi asks what only you can decide; a choice between options comes
as a dialog (`pb_ask`) with its recommendation marked. If you're away, it counts
down (`askTimeoutSec`, 5 minutes of idle time — any key you press restarts it)
and Pi goes on with its recommendation, telling
you it's an assumption to confirm. Picking "Something else (type it)" keeps the
options in the chat, lettered, so you can write your answer from them.

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

**Hearing the approach.** Mid-discussion, `/pb:approach [which idea]`
asks Pi how it would implement it: understanding, seams, non-goals, test
strategy, alternatives, risks, assumptions, open questions (listed, never
asked as dialogs). Chat only: nothing is written, so `/pb:spec` still does
the settling. Without an idea it infers the one from the discussion; with
several on the table, name one to expand it, or leave it out for a
comparison with a recommendation.

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

- **Goal**: the outcome in a few sentences — what is true after the change,
  for whom, and how you'll know it worked; no implementation.
- **Findings**: what the analysis established, so nobody redoes it: the files
  and classes involved and their roles, the code to imitate (by path and lines,
  not pasted), constraints, the test command and baseline. Each bullet cites
  its evidence: a `path:line`, a probe (`command` plus its conclusion, or
  `probe: …; conclusion: …`), or `constraint: …`. A `path:line` must cite a real
  line in the repo; a new file needs no line number.
- **Decisions**: each with its reason as it stands now, no history; rejected
  ideas as "Not doing X, because …", so they aren't reconsidered. The reason is
  prose the reviewer can judge, not a word from a list; a bare colon states no
  reason.
- **Contracts**: no later step sees the whole change at once — tasks are built
  one by one. So pin here every seam the tasks share: public signatures, API
  requests and responses with their error types, the data model and migrations,
  events, and which task owns each side. They're pinned as they must end up;
  everything behind them is left to the build, which asks before changing one,
  and the reviewer checks each. A single task that changes an external surface
  should have Contracts too; only truly independent internal tasks can omit it.
  A bullet that bounds how often something runs should name the code whose call
  it bounds — a `path:line`, or `new: <path>` when nothing performs it yet, or an
  `Assumption: … settles by …` when nothing in the project enforces the cadence
  (a third party's webhook, another service's cron); the reviewer checks it, and
  a backticked command is a measurement, not an owner. A bare count or duration
  keeps its own answer: a measurement. A section that does not apply is one line,
  "none — why", never an empty heading or TBD.
- **Migration and rollback**: only when data, a schema or a stored format
  outlives the change: how existing data moves, how it is rolled back, and what
  old and new code do while both run. "none — why" when nothing persists.
- **Requirements: <capability>**: only when the change alters what a capability
  guarantees. One section per capability, opened by `Overview:` — what the
  capability is and what it refuses to do, in a sentence or two — then
  `### ADDED`, `### MODIFIED` and `### REMOVED` groups of `### Requirement:`
  blocks. `/pb:archive` writes the overview into the living file's
  `## Overview`; a capability that has none must supply one, and a new overview
  replaces the old. It is plain text and never a review criterion. Each
  requirement opens with an `Invariant:` line — the rule that must hold for
  every input; the tasks' acceptance lines are the examples that prove it. A
  requirement written before invariants falls back to its statement. Older files
  may still carry `#### Scenario:` blocks: they parse and merge, but they are
  examples, never acceptance items. ADDED must be new; MODIFIED and REMOVED
  must exist; MODIFIED replaces the requirement whole, and a rename is REMOVED
  plus ADDED. The delta is checked when the spec is written, and
  `/pb:archive` merges it into `specs/<capability>.md` or refuses before moving
  anything. `specs/` is kept with the project, so the requirement base is
  committed and reviewed with it.
  Nobody has to open that file while the feature is being built: every task
  handout, reset summary and review brief carries the standing invariants of the
  capabilities the delta names, one line each, as they will read once this delta
  lands — the delta's own `Overview:` where it states one, and any requirement it
  modifies or removes left out, because as written it is no longer in force. A
  base pb can't read is named by file instead of skipped quietly, and the reviewer
  is told that breaking a standing invariant is a P1 finding, whether the change
  broke it or made it unreachable.
- **Open questions**: only while `Status: planning`.
- **Tasks**: each as `### T1: <outcome>`, what must be true when it's done
  rather than how to build it, with `- Acceptance:` lines and, when it adds
  behaviour, `- Test: \`command\``. Each Acceptance line is one behaviour as a
  test would check it, abuse cases included: they are the tests to write. The
  task's `Test:` command is the proof; there is no per-line proof marker. One
  task, unless a slice is worth reviewing on its own; then vertical slices, each
  working and tested, never a split by layer or a closing "add tests" task.
  Keep each task narrow: one coherent change with its own targeted `Test:`,
  never several independent changes bundled with a full-suite run. The harness
  runs the full suite once, after the last task; work that would bundle them is
  split instead.
- **Design**: written by the build, not the plan: the shape it settles on as it
  goes, recorded once by the first task whose design the later ones build on;
  every change to it after that goes in Decisions, never by rewriting Design.
  The reviewer checks the code against it, and `/pb:archive` hands it to the
  project map. Contracts are the shape the build must not invent; Design is the
  one it arrived at.

The spec pins what the change must do and how you'll know; how to build it is
left to the build, where the compiler and the tests give feedback. When a
decision rests on something only running code shows (a library's limits,
performance), planning tries it in a scratch copy first.

**Out of scope** is optional. The aim: a fresh or reset session starts where
the discussion ended, without re-analysing and without being buried. Pi points to code instead of copying it and states each
fact once; `pb_write_spec` reports the size and only suggests tightening a long
spec. `pb_update_spec` changes one section at a time.

A spec with `Status: planning` is a checkpoint of an unfinished discussion (no
tasks or verification needed yet). `/pb:build` finishes it first: open
questions settled, tasks written, `Status: ready`. `/pb:spec <name>` revises a
spec from the file on disk, not from memory.

Before writing, Pi checks the spec against itself and the code (examples
against rules, "unchanged" against "extended", every path and name), resolves
what it finds, and tells you. Writing warns, never rejects: several tasks and
no Contracts (pin the shared seams, or ignore it if they're independent),
tasks sharing a `Test:` command (the later auto-proceeds once the earlier
proves it), a task that names a full-suite run (the harness does that once,
after the last task; keep the task's `Test:` targeted and split it if it
bundles several changes), a behaviour task with no `Test:` (add one, or stay disclosed),
a `Test:` that always passes like `true` (the build would wedge demanding
red — omit it instead), and a `Test:` that chains shells or reaches the
network (`;`, `|`, `$`, backticks, `curl`/`wget` — it runs with your
privileges, so review it; the dry-run below doesn't execute it). A ready spec keeps no Open questions.

When the spec is shown for approval, the harness runs each red-eligible
task's `Test:` once — except shell-chaining ones, which aren't run before
you've approved: failing is expected (nothing built yet), passing smells
behaviour that already exists, erroring smells a broken command. Docs,
config, refactors and other non-test changes have no red-eligible commands
and skip this entirely.

**Writing it is painless.** The questions belong to planning. What the
discussion left open, Pi settles itself and records in Decisions as
`Assumption: <claim> — settles by <how>, because <reason>`. They're listed when the spec is shown, and the
reviewer checks them. It asks you only about a choice that changes behaviour,
an API or data that you didn't settle, all at once, and when `/pb:build` is
writing the spec those questions count down too. A checkpoint asks nothing at
all: what's undecided goes under Open questions.

When `/pb:build` writes it, it asks first: **build here**, **build in a fresh
session**, or **show me the spec first**. Built straight away, the spec is still
shown in the session for later. Shown first, you choose: build here, build in a
fresh session, **edit the spec first** (in an editor; it's saved only when it
still parses, and the build then gets your version), or not now.

**Before the first task, a risky spec gets a review of its own.** A build runs
one when the spec touches a security-sensitive surface, carries Threats,
persists data or carries a migration, changes an external contract, changes the
requirement base, or has four or more tasks. Small,
reversible specs skip it and rely on the write-time checks and your read:
`/pb:build --review` asks for the pass anyway, and
`"specReviewer": {"mode": "always"}` reviews every spec (`"off"` never
starts one, though a spec an earlier review blocked still waits for `--review`
or `--force`).
The pass is fresh and read-only: it attacks every Decision, re-tests each "Not
doing X" rejection, flags unmeasured numbers and undefined empty paths, and
checks the spec against the repo: that its `path:line` citations and test
commands resolve, that external surfaces have Contracts, and that
persisted-data changes have a Migration and rollback answer. Every observable
value in a Contract — a status, error, header, ordering, event or stored value
— is checked against the code path or test the spec cites for it; a value with
no citation, or one its citation contradicts, is a finding. A `path:line` whose
file and symbol are right but whose number has drifted is corrected in place,
never reported on its own. It runs on your session's model by default; set
`"specReviewer": {"model": "provider/id"}` (or point it at `buildModel`) when
you want another model, such as the implementer, to validate the plan.

Only a P0 or P1 stops the build before the first task; P2/P3 are shown and the
build carries on, with the findings recorded beside the spec. A finding's first
line is one sentence you can act on — what goes wrong, for whom, and where — and
its trace and its one fix follow on `Evidence:` and `Fix:` lines: the single
change the reviewer would make, with its reason. If it weighed another option
and rejected it, one `Not:` line says what it was and why it loses; that line
is kept, shown to you, re-read by the next round, and handed to `/pb:fix`
labelled as already rejected, so a discarded idea is not quietly
re-implemented. A choice the reviewer can settle by looking, it settles itself
with one cheap read-only command and puts the command and its number on
`Evidence:` — never a full test run, and never an either/or handed back to you;
what no cheap command settles becomes a one-line question. The chat result
keeps earlier findings (with their resolution status) apart from new blocking
ones; the full text stays in the recorded review and its linked session. A
block means amend the spec (or record a rebuttal in Decisions) and run
`/pb:build` again: the next pass reviews the revision against the full spec and
the earlier findings, and judges each earlier P0/P1 against the new text first.
Scoping there is by responsibility, not location, and it is the same rule for
everything the reviewer checks: whatever the revision creates or exposes is a
finding wherever its text sits — a Decisions edit that contradicts untouched
Contracts text blocks, or a living capability the revision newly touches
without its delta — and only a problem that predates the revision, in text the
revision left alone, goes under Outside the change, where only a P0 blocks and
the rest carries with the spec. The first round has no such section: there,
everything is in scope. That carry is bounded in the reviewer's view only: it
lists at most eight earlier advisories, never dropping a P1 and losing P3
before P2, and names how many it left out — the recorded review and the count
in the post keep all of them. An unchanged blocked spec is re-posted, not
re-reviewed. After `maxRounds` blocking rounds (2 by default) the loop stops
and the next
changed spec waits for you: `/pb:build --review` spends one more round, or
`/pb:build --force` builds it as it stands and records the standing findings
as accepted. A block whose answer cannot be parsed is reformatted once; if
that fails too, the reviewer's own prose is shown and nothing re-runs until
you amend or ask with `--review`. Only the way into a build is gated: once
the first task has started, spec edits are the code reviewer's to judge, not
re-reviewed at plan level.

**Read the plan yourself, in this order.** The spec reviewer is a second pair
of eyes, not a substitute for yours:

1. **Goal and Out of scope**: does this solve the right problem, and is the
   boundary in the right place?
2. **Task acceptance lines**: is each one checkable, and would its task's
   `Test:` command prove it rather than merely describe the work?
3. **Decisions**: is each reason still true, and is every rejected alternative
   rejected deliberately ("Not doing X, because …")?
4. **Contracts, Migration and rollback, Threats and abuse**: are the shared
   seams pinned before the tasks split, and are rollback and abuse answered
   rather than assumed away?
5. **Tasks**: does each leave the code working, and does each named test prove
   its acceptance line? Do the tasks build in an order that could actually run?
6. **Findings (and Context)**: are the facts still true, and does every
   `path:line` citation still hold the content it is cited for? A line number
   that drifted is corrected silently, so judge the content.

A plan you cannot check this way is not ready: amend it with `/pb:spec` before
building. The pre-T1 review can miss something; this read is where you catch a
plan that is checkable but aimed at the wrong outcome.

- **Threats and abuse.** When a change adds or alters an entry point, touches
  a trust boundary (authentication, authorization, credentials, sensitive data,
  external input) or has rules someone gains from breaking (money, quantities,
  limits, quotas, state), the spec gets a `## Threats and abuse` section: who can
  reach it and with what, what they must prove or be allowed, how it could be
  abused (including by quantity, repetition, reordering or racing), and what
  prevents each abuse. Its task acceptance lines include the abuse cases.
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
- **You can edit a spec by hand.** It just has to keep the format. A running
  build pauses at its next step until `/pb:build` re-approves the edit.
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

Before the first task, a risky spec gets its own fresh-eyes review (see
`/pb:help spec`): P0/P1 findings stop the build there for you to read, P2/P3
are shown and carried, and `/pb:build --review` asks for a pass that would be
skipped. `/pb:build --force` builds it as it stands instead. The implementer
then checks the spec's paths, interfaces and test commands against the repo
before coding; a spec that cannot be built as written stops instead of being
worked around.

1. **The tasks.** Each task is built the same way: tests first, then the
   behaviour, then `pb_task_done` — reporting what changed plus the caveats,
   rejections and open items later tasks can catch on — which hands out the
   next one, naming the files finished tasks touched. The whole
   build is one uninterrupted run, so the prompt cache stays warm. How the shape
   is arrived at is the build's: the compiler and the tests give the feedback,
   task by task, where each step is checked by something real. The first task
   that settles a shape the later ones build on records it in the spec's
   `## Design`. A task that has grown into several changes finishes the smallest
   coherent part and reports the rest as open, so it can become its own task
   instead of one long run.

   Once the first task starts, the spec's contract is frozen: the build may add
   to `## Design` and `## Decisions`, and change nothing else — not through
   `pb_update_spec`, not by editing the file. If the spec itself must change,
   the build stops and asks; editing it by hand pauses the build at its next
   step, and `/pb:build` re-approves the revision (finished tasks stay done).
2. **Structured files are edited literally.** `pom.xml`, JSON, YAML and other
   structured files are changed by exact literal replacement or line-based
   edits, never by a regex that can backtrack — a nested-quantifier pattern such
   as `(?:(?!-->).*?)*` can run for minutes on a real file. The full suite stays
   with the harness after the last task; a task's `Test:` stays targeted.
3. **The end.** After the last task, on a build of three or more tasks the
   harness hands out one coherence pass first: re-read the whole diff and
   consolidate the duplication, dead code or inconsistent naming the slicing
   left behind, strictly within the spec (no behaviour, API or data change;
   nothing to consolidate is a fine result). Then it runs the full test suite (a
   compile for `Verification: build`) **inside that same call**. A failure
   comes straight back to fix, up to `maxAttempts`, then the build pauses for
   you. The agent's word never ends a build: the check does.

**A check after every task** (`"taskChecks": "each"`): the harness also runs each
task's `Test:` command (a compile when it has none) when the task is done. It
catches a broken task earlier, but makes every task leave the build green on
its own, which slices work unnaturally and costs a run per task. With `"end"`
each task is still compiled when done (when a compile command exists), and the
final gate additionally runs `lint` and `extraChecks` when configured.

The spec's Goal, Out of scope, Decisions, Design, Contracts, Migration and
rollback, Threats and abuse (`Threats` reads as the same section) and Acceptance
bind the build: changing one takes a `pb_ask`. How to build it is the build's: a better way found while
coding is taken, and a change to the Design goes in Decisions. Every task handout,
check retry, coherence pass and fix lap carries those binding sections, the
requirement rules and task acceptance lines, the standing guarantees of any capability its
requirement delta touches, and the finished tasks' caveats, rejections and open
items as a compact block. It is sized from your model's context window (a tenth of
it, with a stated minimum, so even a window too small for the reserve gets a real
limit), and nothing inside a section is shortened: a block that still runs over
drops whole sections in a fixed order (Decisions and Contracts last), says which it
dropped, and names the spec file to read.
Where
the spec is ambiguous, contradicts itself or doesn't match the code, Pi takes
the sensible reading, records it in the spec's Decisions as an **assumption**,
and carries on. The build summary lists these choices and the reviewer checks
them, so you look once, at the end. When a choice would change behaviour, an
API or data, Pi asks you in a dialog (`pb_ask`) and carries on with your
answer, which goes into the spec; answering early often saves later questions.
If you're away, the dialog counts down `askTimeoutSec` of idle time (5 minutes; any key restarts it) and the
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
report (what changed, and the caveats, rejections and open items later tasks can catch on), the spec's binding view — the same binding sections and requirement rules, bounded by your model's window with a stated minimum, naming any section it had to drop (Tasks and the rest stay in the spec) — the standing guarantees of what the spec's requirement delta touches, and the next task. The line it resets under leaves room for that view and the step after it, not for the whole spec, so a long spec doesn't force early resets. No summarizing model call,
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
is missing. Pi writes the tests for the task's Acceptance lines, calls
`pb_tests_red`, and the harness runs the command and requires the failure —
stubs of new signatures are fine, so the tests compile and fail on their
assertion rather than on a missing symbol. `pb_task_done` takes the task only
after that; the refusal costs no attempt. Tests that pass too early are sent
back, and `/pb:undo` takes the proof back with the files.

Two tasks that carry the very same `Test:` command share one run, so that run
shows only that something is missing among them. Once an earlier task is done
and proven, a later task with the same command is **pre-green**: its tests are
already satisfied, red is impossible, and the harness says so instead of
wedging — confirm the acceptance holds on top of the earlier change and finish;
the run is recorded and handed to the reviewer as proving nothing of the
task's own. And a task with no `Test:` command, a refactor, or a spec with
`New tests: no` or `Verification: build` has no red proof by construction.
Rewriting a task's `Test:` command drops its proof: the new command must be
seen failing again — as must edited, swapped or weakened test files, which the
proof is fingerprinted against. `pb_tests_red` also records what the tests are
claimed to prove and a capped head of the failure it saw; the review brief shows
both for every proven task, and a failed check retry shows them again so the
model does not build on a typo or an unrelated broken test. Each case is listed at the end of the build and handed to the reviewer as
partly proven or unproven — give a task its own targeted command where you
can, and when tasks share one, make it fail at each task's turn (a conjunction
over per-task artifacts, so each task still has something to prove). A task's
`Test:` command is the proof of its acceptance lines. A task with no red proof
— a `(refactor)`, no `Test:`, `New tests: no` or a no-test gate — is judged by
the reviewer on whether its acceptance is genuinely untestable or docs-only.

The commands come from `.pi/pb/config.json` (`"verify"` and `"build"`, `"auto"`
detects Maven, Gradle, npm/TypeScript, Cargo, Go and pytest; `"lint"` uses
package.json's `lint` script, `"extraChecks"` runs project commands after it).

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
- **A task's tests pass before it starts, under its own command**: an earlier
  task implemented more than its slice, and no earlier task proved this
  command — red is impossible and the harness can't tell implemented from
  untested. Don't hollow out the earlier task to force a failure: report
  blocked, give the task its own `Test:` line (`/pb:spec`), and resume.
- **Compacted in circles**: if Pi compacts the same task over and over with
  nothing new read, changed, or shrunk, the build pauses instead of looping.
  Usually one giant tool output refilling the context (a verbose `Test:`
  command; `testOutputCap` trims what the harness shows, not what the agent
  saw), an oversized spec, or the task looping. Look, then go on, throw the
  task away, or split it.
<!-- /pb -->

<!-- pb:topic review -->
## Review

`/pb:review` runs the check once more, then opens a **fresh session**, "review:
<spec> · spec", and takes you there: the reviewer sees the spec, the diff and the check
result, but not the build conversation, so it isn't anchored by the builder's
reasoning. It reports
every acceptance criterion as met with evidence, not met, or not verified. It
also checks the decisions (including rejected
alternatives and the build's assumptions), `(refactor)` tasks for unchanged
behaviour, the existing tests the build changed, the tasks whose new tests
carry no proof (with why each), the fix laps' own reports on a follow-up
(claims plus test results, judged as evidence), acceptance lines
that moved during the build, and where the spec's Design comes from (how
hard to look for drift between Design, Decisions and code), comments, your
standards and security, and reports each finding through a tool, not as prose
to be parsed.
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
*changes needed*. Findings with the same concrete fix are reported once, at
the highest priority. When the code is right and only the spec's framing is
imprecise, that's a P3 note with a proposed rewording, not a defect.

Every finding also carries a **class**: in this change, or **outside the
change** (a problem that pre-dates it). An outside finding is still a finding:
reported with its file, line, priority and fix, capped at P2 and advisory, so
it stays visible and pickable by `/pb:fix` instead of living in a prose note.
The cap is a rule, not a bypass: an outside P0/P1 (a misclassification, or a
serious pre-existing problem the reviewer insists on) still blocks. A closing
prose note is only for what is not a problem; a real problem left there has no
class and no verdict. The verifier judges an outside finding on whether the
problem is real, not on whether this change caused it.

When behaviour is chosen by a derived classification, the reviewer also tries
an input that matches more than one class (a kind, role, mode, type, state,
host, tenant) and checks which class wins at each decision — routing, lookup,
authorization, default — since a guard can trust a different classifier than
the router and be skipped.

**Every task acceptance line is a checklist item.** Each task's
`- Acceptance:` lines become `T1.1`, `T1.2`, … in reading order. Requirement
invariants are binding rules checked for regressions, and legacy scenarios are
examples — neither is a checklist id.
The reviewer reports each one as **met** with evidence (file:line or test
name), **not met**, or **not verified** with the reason.
The checklist follows the spec as written, and every spec review uses the same
list, including a manual `/pb:review` during a build. An omitted or unchecked
item counts as not verified, never as met: a review with nothing blocking but
any unverified item ends **UNVERIFIED**, not pass, and leaves the phase where
it was. A not-met item is blocking and comes with a P1 finding. P2/P3 findings
stay advisory.

The findings land in the session you ran it from; run it **in the build
session** and fix them right there: that session knows the code it just wrote.
Or fix them in a fresh fenced session: `/pb:fix [ids]` takes P0–P2 finding
ids (no ids = all open ones); P3 nits never block and are fixed by hand or
ignored. The next `/pb:review` is a **follow-up**: it checks the previous findings and
looks only at what changed since (`--full` reviews everything again). If
nothing changed, it says so and costs nothing.

**The adversarial pass, when the change looks sensitive.** A second fresh session, "review:
<spec> · adversarial", has a single job: break the change. For every entry point it adds or alters and
every rule it enforces, it looks for:

- **access**: another user's data, a stolen session, what each state change
  requires the caller to prove, reused logic that lost its preconditions
- **classifications**: an input that matches more than one class (a kind,
  role, mode, type, state, host, tenant) at once, and which class a guard
  trusts when routing and authorization disagree
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
`"reviewer": {"security": "always" | "auto" | "off"}`: `auto` is the default;
it runs the pass only when the spec has Threats and abuse or the change touches
auth, entry points, money, quantities or state (a broad guess); `always` runs it
on every review; `off` never.

**Without a spec**, `/pb:review [what the change is meant to do]` reviews the
uncommitted change against that intent and your standards: useful for any
change you made with Pi without the rest of the flow.

**Inside the review.** The spec pass, and the adversarial pass when one is due, each run
in a real Pi session you're in: you watch everything natively, and you can
interrupt it or ask it something ("why is 3 a P1?"). Its model is read-only: it
can't edit or write files; anything a command it runs changes while the review
runs is listed in the result, not reverted behind your back (it may be your own
concurrent edit). A pass
ends when it has reported its findings and stops, or at `/pb:review done`. When
the spec pass is done and an adversarial pass is due, pb asks whether to run it now
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
exploration starts with it instead of rediscovering it. Area headings carry
their path prefix (Security invariants carries none: read it in full every
time); sessions read only the headings covering the paths they touch.

- **When a feature is done**, `/pb:archive` updates it from what the feature
  established: its spec's Findings, the design the build settled on, the files
  it changed, and the completed reviews' P0–P2 findings as leads the
  cartographer must check against the code (a finding that no longer holds is
  left out); `"mapOnArchive": false` turns that off.
- **Any time**, `/pb:map [focus]` refreshes it from the code as it is now.
- **`/pb:map undo`** puts the previous map back (again: swaps them back).

Nothing pb writes there can break the section: text it stores — a finding's file,
title or fix, a proposed line — loses control characters and HTML comment markers
on the way in and on the way back, a finding whose title was nothing but markup
keeps a `(untitled finding)` placeholder instead of vanishing from the ledger, and
each tab becomes a space so no line turns into an indented code block.

A fresh, read-only call proposes the whole new map (it revisits all of it, not
only the new area). Its readers are capable models that explore fast, so it
holds only what exploring wouldn't show them: security and data invariants with
the code that enforces them, where new code goes and what to copy, known gaps,
commands and quirks, docs the code contradicts, and layout only where names
mislead. It's written in short bullet lines, as short as the project allows, up
to about 20,000 tokens: it's read in every session, so a line stays only if it
saves a later feature a search or a mistake. Your session doesn't grow. Only a
name shaped like a path is checked at all: it carries a slash, starts with a
dot, or is a root file name pb knows (`README`, `package.json`, `pom.xml`). So
`Store.config`, `process.env` and `thread.lock` stay prose in any repo, however
many `.lock` or `.config` files that repo tracks, and so do `.` and `..`, which
name nothing anywhere. A checked name resolves four ways: from the project
root, under the path a heading names, as the end of a real file (`auth/Login`
finds `…/auth/Login.java`), or in a gitignored file of the working tree outside
`node_modules/` (so `pb/config.json` finds `.pi/pb/config.json`). Nothing above
the project root counts as found, and a name that walks there (`../old/Ctrl`)
is reported like a missing file. The one price of a warning worth trusting: a
stale name written bare (`gone.md`) is left alone. The names that still don't
resolve go back to it once to be corrected, and so does a map over the budget,
to be trimmed. Then the map is written and the change is shown. It asks you
first only when something looks off: paths that still don't resolve, or a
large part of the existing map removed; unanswered, the current map stays.
`/pb:plan` warns when paths in the map no longer exist (a cheap check, no
model call).

pb finds its section by its two markers, and counts a marker only on a line of
its own and outside a fenced example, with fences read from the top of the file:
a marker you show in a documented example stays documentation wherever the
example sits — above your map, inside it, or as the only place your AGENTS.md
mentions them. A ``` you never closed is read past only when it leaves pb no
marker outside fences at all — typically because it stands above your whole
section — and there pb reads the file blind to fences rather than refuse.
Where the markers still can't be resolved (an end missing, or a marker standing
twice) pb writes nothing at all and names the file and the marker, before any
cartographer is run: your text after the stray marker and the previous-map
backup stay exactly as they are, and `/pb:map undo` refuses the same way.
<!-- /pb -->

<!-- pb:topic status -->
## Status, stats and archive

- **`/pb:status`**: every spec, its state, verification, dependencies and tasks.
  `/pb:status --json` prints the same information as the `pb.report/1`
  document for scripts.
- **`/pb:stats`**: for this build: tasks done on the first try, checks run and
  failed, pauses, the review verdicts with the latest review's confirmed P0/P1,
  red proofs (proven, sent back, pre-green), tokens in and out per role (with
  output rate where pure run time is known: explorer calls), peak context, cost
  and time, and how often the session was compacted, reset, reminded or asked
  you something. Build and review show no rate: their wall time includes your
  pauses. `/pb:stats all` compares every spec, archived ones included.
  `/pb:stats --json` prints the same report with each spec's stats.
- **`pb-report`**: the report without Pi, for scripts and dashboards:
  `pb-report [--cwd dir] [--stats] [--review]`. The `schema` field is
  `pb.report/1`; a breaking change gets a new one.
- **`/pb:archive`**: moves a finished spec to `.pi/pb-archive/` (which git
  ignores), so `/pb:build` and `/pb:status` only show live work, and offers to
  update the project map (`/pb:help map`). A spec's requirement delta is merged
  into `specs/` in the same step: a delta that no longer applies stops the
  archive before anything moves, and if the spec can't be moved the living
  files are put back. `specs/` is tracked with the project; the archive stays
  local.
<!-- /pb -->

<!-- pb:topic rules -->
## Rules of thumb

- **Plan long, spec precisely, build short.** The spec is what survives: it's
  all a fresh or compacted build session has, and what the reviewer checks.
- **Write rejected ideas into the spec.** "Not doing X, because …" stops them
  from coming back.
- **Give tasks a `Test:` line**: how Pi checks each task; the harness runs the full suite once.
- **Keep tasks narrow and edits literal**: one coherent change per task, with a
  targeted `Test:`, and the full suite left to the harness. Edit `pom.xml`, JSON,
  YAML and other structured files by literal replacement or line-based edits,
  never a nested-quantifier regex that can backtrack for minutes.
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
**What now** — the plan is ready to discuss, nothing is built yet
- React to the plan: agree, disagree, or answer its questions. Example: *"go with option B, but keep the old endpoint"*
- Done discussing: `/pb:build` writes the spec and starts building. Example: `/pb:build --fresh` builds in a new session · more: `/pb:help plan`
<!-- /pb -->

### After /pb:spec
<!-- pb:tip spec.next -->
**What now** — the spec is written, nothing is built yet
- Check it: read the spec in `.pi/pb/specs/` — the build follows it word for word, and the reviewer checks against it.
- Change something: say what and run `/pb:spec` again. Example: *"split T2 into two tasks"*
- Build it: `/pb:build` here, or `/pb:build --fresh` for a new session — risky specs are reviewed first: a P0/P1 stops it before the first task · more: `/pb:help spec`
<!-- /pb -->

### Build paused
<!-- pb:tip build.paused -->
**What now** — the build is paused, finished tasks stay done
- Continue: answer or discuss here, then `/pb:build` to carry on. Example: `/pb:build keep going with the current approach` (your hint is recorded in the spec).
- Code went wrong? Throw the attempt away with `/pb:undo`, then `/pb:build` tries again.
- Spec went wrong? Rewrite it with `/pb:spec {spec}` · more: `/pb:help stuck`
<!-- /pb -->

### Build paused: a task keeps failing
<!-- pb:tip build.paused-attempts -->
**What now** — {task} failed its check too many times, the build is waiting
- Steer it: say what to try differently and it retries with fresh attempts. Example: `/pb:build mock the clock instead of sleeping`
- Throw this attempt away: `/pb:undo {task}` restores the files, then `/pb:build` tries again · more: `/pb:help stuck`
<!-- /pb -->

### Build complete
<!-- pb:tip build.done -->
**What now** — the build finished, every check passed
- Review it: `/pb:review` here in this session, so you can fix findings right away.
- Then commit (the message above is ready to paste), and `/pb:archive` · more: `/pb:help review`
<!-- /pb -->

### Review passed
<!-- pb:tip review.pass -->
**What now** — the review passed, the change is ready to merge
- Minor findings? Ask Pi to fix them here ("fix finding 2"), then commit with the message above.
- Done: `/pb:archive` files the spec away; the next feature starts with `/pb:build` from its planning session.
<!-- /pb -->

### Review found changes
<!-- pb:tip review.changes -->
**What now** — the review found things to fix before merging
- Fix them in a fresh fenced session: `/pb:fix 1 4 5` takes finding ids (P0–P2 only; P3 nits fix by hand or ignore), no ids fixes all open ones — or fix them here, this session knows the code. Example: *"fix findings 1 and 3"*
- Then `/pb:review` again — it checks only those findings and what changed · more: `/pb:help review`
<!-- /pb -->

### Review could not verify everything
<!-- pb:tip review.unverified -->
**What now** — the review found nothing blocking, but some task acceptance items were not verified
- Read the acceptance list above: every `not verified` or missing id needs evidence, not silence.
- Check that behaviour yourself or run the named test, then `/pb:review` again. If nothing else changed, `/pb:review --full` re-checks the whole change. If the criterion is not checkable as written, amend the spec with `/pb:spec`.
<!-- /pb -->

### Review without a verdict
<!-- pb:tip review.other -->
**What now** — the review ended without a verdict, read what's above first
- Fix what's worth fixing here, then `/pb:review` again.
<!-- /pb -->

### After /pb:undo
<!-- pb:tip undo.done -->
**What now** — undone to before {id}, that attempt is gone from the conversation
- Carry on: `/pb:build` continues from here. Changed your mind? `/pb:undo {id}` goes back the other way.
<!-- /pb -->
