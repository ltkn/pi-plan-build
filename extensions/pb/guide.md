# Using pb

pb turns a conversation into a feature in four moves: **plan** it together,
write it down as a **spec**, **build** it task by task behind checks the harness
runs, and have it **reviewed** by someone who never saw the build. After every
step Pi shows a short **What now** block; `/pb:help <topic>` posts any section below.

Every phase ends with a header — `**<marker> <Phase> — <spec>**` followed by
the facts that summarize the outcome (`**✅ Build complete — order-cancellation** · 3/3 tasks · 25m`) —
then a `**Next:**` line naming the one primary action, a `**Evidence:**` line
with the facts behind the result (gates, progress, counts, where it ran), and
the details. A result also ends with a **What now** block; `/pb:help <topic>`
posts any section below. The time, where the harness measured it, is **active
time**: pauses you took are left out, and when they make a difference the
elapsed wall time follows in parentheses (`25m (55m elapsed)`). A spec written
by an older pb has no recorded spec, review or fix times; its `Time` line shows
only what its events already carry (the build's own start and end).

<!-- pb:topic flow -->
## The normal path

**You always know the next step.** The footer reads `pb · <spec> · <state> ·
next: <command>` and follows every command and turn; the terminal title carries
the spec and its state. **alt+n** puts that command in the editor (press Enter
to run it); `/pb:help` with no topic opens with where you are and what's next,
and `/pb:status` says it for every spec. Starting Pi on work in progress says it
once. Finding numbers (`/pb:fix`) and checkpoint ids (`/pb:undo`)
complete with what each one is.

1. **`/pb:plan <what you want, in your own words>`**: Pi investigates (it can
   run anything, but won't touch the project's files): the code involved, the
   conventions, how a similar feature is built. The harness runs the test suite
   in the background meanwhile, so you both know whether it passes today. Then
   you discuss: the approach, the trade-offs, the questions only you can answer.
   This is the cheapest place to change your mind.
2. **`/pb:build`**: first it asks, while you're here, how to go on once the
   spec is written: build it (in a fresh session, from the spec) or show you the
   spec first. Then Pi writes a short **spec** from the discussion (goal, findings,
   decisions, tasks); every spec gets one independent review before the first
   task — fresh eyes, read-only — and a P0 stops it for you to amend or rebut;
   P1-P3 are shown and the build carries them (see `/pb:help spec`). `/pb:spec-review
   [name]` is that same review on its own, for a spec you want judged before
   deciding to build. Run `/pb:build` again to go on after a block. A clean or advisory-only review
   starts by itself, so you can walk away. The
   tasks then run one by one, and the harness runs the full test suite after the
   last one; a failure goes back to Pi to fix. When the build pauses or finishes,
   pb sends a **desktop notification** — those are the moments you've reliably
   walked away from (`"notify": false` turns it off).
3. **A finding you want settled before the build**: say so to the planner
   (`/pb:plan <spec>` picks the planning up again). It has the whole discussion
   and edits the spec; nothing else runs. Everything else the build carries —
   its own checks and the code review catch most findings for far less. See
   `/pb:help spec-review`.
4. **`/pb:review`**: a fresh reviewer compares the change with the spec and
   your standards; blocking findings get a second look before you see them.
   Fix them right there, `/pb:review` again (it looks only at what changed),
   `/pb:commit`, and `/pb:archive`. Commit whenever you like — after the
   build, the fixes, the review or the archive: `/pb:commit` opens the change's
   files and a message built from the spec in an editor, for you to adjust and
   confirm; pb never commits on its own.

The build stays in the session that planned it: nothing you discussed is lost.
Each later task then starts from a fresh context reset to the build's state, so
the agent reads the spec and the code instead of inheriting the previous task's
conversation. The spec is written to disk so it survives every reset and reaches
the reviewer. For a large feature after a long, messy discussion, build in a
fresh session from the spec alone; pb recommends that itself when the session is
over half full or the build runs on another model.

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
Edit it there. The section is built from parts: a core every project gets,
the database rules when the project uses a SQL database, and the stack's own
lines. A Java, Rust or Vue project's section, and any project's with a database,
goes only in its own AGENTS.md: keep the shared one free of stack-specific and
database rules, since Pi loads both. The core covers:

- **Quality**: the best current practice for the stack, a proper fix rather
  than a workaround; modern idioms and the latest stable language and platform
  features, even where the surrounding code is older. Outdated code in the way
  gets refactored to current practice, planned as a task of its own.
- **No overengineering**: build for the needs you have, not ones you might; no
  option, layer, abstraction, endpoint or dependency without a stated need, since
  each is something more to secure. Within those needs the cleanest design beats
  the smallest: more work now is better than debt later. No near-copy of an
  existing helper, no code kept for a case nothing reaches.
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
- **One source of truth**: a rule or canonical form that already exists (a
  shared helper, a type, a constraint) is used, never re-implemented; a second
  copy drifts, and the gap between copies is a bypass.
- **Robustness**: at a boundary, input is assumed hostile or broken (sizes,
  ranges, encodings, duplicates, order, concurrent calls); business rules can't
  be bypassed by quantity, repetition, reordering or racing; every request's
  work is bounded; a failure halfway leaves consistent state. Values that are
  stored, compared or sent are validated strictly. Inside the boundary:
  invariants (types, constraints, transactions), not repeated checks, so the
  code stays clean where the data is already trusted.
- **Before calling it done**: the diff re-read as an attacker and as a race,
  and existing copies of any touched rule searched for.

The other parts:

- **Database** (when a SQL driver or ORM is in package.json, Cargo.toml,
  pom.xml, Gradle, go.mod, pyproject.toml or requirements.txt, or a migrations
  directory exists): normalization, uniqueness and constraints live in the
  database and are compared in SQL; consistency and concurrency come from the
  database: one transaction per request, constraints, atomic statements or row
  locks, not check-then-write in application code.
- **Java** (Maven or Gradle): the current LTS release, with records, sealed
  types, pattern matching, virtual threads and scoped values; no Lombok.
- **Rust** (Cargo): the stable toolchain and the current edition; typed errors (`thiserror`
  in libraries, `anyhow` only at a binary's edge) propagated with `?`; no
  `unwrap`, `expect` or `panic!` outside tests unless an invariant rules failure
  out; `unsafe` only with a `// SAFETY:` proof; newtypes for validated values;
  no blocking in async code and no lock held across `.await`; clippy with
  `-D warnings` and `cargo fmt --check` clean.

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
- **Vue**: Vue 3 with `<script setup lang="ts">`, TypeScript, Vite, Vue
  Router, TanStack Vue Query, Bootstrap 5 through Sass, Vitest with MSW,
  pnpm; Pinia only for client-only state.
- **Frontend tests**: each page through the real router against a scripted
  backend, one test per response `type` plus an unknown one.
- **Comments**: every platform-integration step says why it works that way.
  Still never history.
- **Before calling it done**: as above, plus a double click, a session that
  expires mid-edit, and a URL from the query string.

Make them yours: "Java 25 with records and sealed types; no Lombok", "every public
API has a Javadoc contract", "no new dependencies without asking". Keep them
short: every line is read in every session. A session that started before you
added them gets them in pb's messages until it's restarted.

**Not overengineering is not "simplest".** pb's one rule for it, used word for
word by the planner, the spec check, the builder and the reviewer: build for the
needs the change has, not ones it might have — every part it adds (an option, a
layer, an abstraction, an endpoint, a dependency, a job, a cache, a stored field)
traces to a stated need, and each is something more to secure — and within
those needs the cleanest design wins over the smallest, since more work now
beats debt later. The spec review flags a part with no stated need
(Overengineering), the code review makes it P1 when it adds attack surface, and
the review brief lists every dependency the change adds, read from the
manifests (npm, Cargo, Go, Maven, Gradle, Python), each needing its reason in
the spec.

**pb's presets are opinionated on purpose.** A concrete rule steers a model and
a bland one doesn't, so the Java, Rust and Vue sections take sides (the Vue one
assumes the backend decides every rule, an HttpOnly session cookie with CSRF
tokens, RFC 9457 problem details, TanStack Vue Query, Bootstrap and pnpm). The
offer names what a preset assumes before you accept it. If yours differs, don't
edit pb's section in AGENTS.md (`/pb:standards` rewrites it): put your own in a
template, below.

**Your own templates.** Put a section in `~/.pi/agent/pb/standards/<name>.md`:
a `java.md`, `vue.md`, `rust.md` or `plain.md` there replaces pb's (yours is
written as it is, without the database part), and any other name adds
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

**Who you plan with.** For the whole planning conversation, Pi is the senior
engineer who owns the change end to end, from the need behind it to running it
in production, whose job is the best plan for what you need, not agreement with
what you first asked.
It starts from the problem: the goal and how you'll know it worked, and a
challenge to the request itself when it deserves one (the need behind it,
something that already does it, the cleanest thing that meets it, built for
the needs you have rather than ones you might); a request that is already right
gets one line. It pushes back with evidence — this code,
or a named practice, standard or documented behaviour and what it means here,
never taste — and walks what applies before a plan is settled, one or two
lenses for a small change: users (what they see when it works and when it
fails), design (where it belongs, what it couples), data (ownership, existing
records and clients, personal data), security (who can reach it, what could
leak, what a new dependency brings), input and state, verification (how it will
be proven, what no test shows) and operations (how it ships, how you'd see it
fail in production, latency and cost at scale). Legal, compliance and licensing
questions are flagged for the right person rather than answered. After its
first reply every answer ends with a short ledger, Decided and Open; overrule it
without new evidence and it records your choice with its objection and the risk,
then stops arguing. `/pb:spec` writes that ledger into the spec. This role is
part of the system prompt on every planning turn, so it holds through a long
discussion and a checkpoint reset, and it leaves when planning ends.

**What it thinks with.** Planning raises the session's thinking level to at
least `"high"` and, when `"planner": {"model": "provider/id"}` is set, switches
to that model; `"planner": {"thinking": "xhigh"}` raises the floor. Both are put
back when planning ends, unless you changed them yourself meanwhile.

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
Result / Conclusion. It is told to bound every command, and pb stops a probe
that outlives `probeTimeoutSec` (15 minutes by default), so a runaway loop
cannot hold the session for an hour. Trivial checks stay in the planning
session.

**Investigating is free, changing the project isn't.** Pi can read, search, run
the build and tests, curl an API, and write and run one-off scripts or programs
(Python, Java, …) in a temporary directory. Every shell command it runs is
capped at `commandTimeoutSec` (30 minutes by default), so a runaway loop stops
instead of holding the session for hours; raise it if the project's builds
legitimately take longer. Editing or writing any file inside
the project is blocked in this session until a build starts here
(`/pb:build --here` lifts it; a fresh build has its own session). Commands can still write files, so pb snapshots the project when planning
starts. A turn that changes a project file is named in the chat right away, and
when you build (or run `/pb:plan off`) pb lists everything that changed and asks
whether to keep or restore it.

**Questions.** Pi asks what only you can decide; a choice between options comes
as a dialog (`pb_ask`) with its recommendation marked. If you're away, it counts
down (`askTimeoutSec`, 5 minutes of idle time — any key you press restarts it),
and nothing is decided: the question stays open, waiting for your answer.
Picking "Something else (type it)" keeps the
options in the chat, lettered, so you can write your answer from them; a letter
("B", or "A and C") reaches Pi as the options it names. Independent questions
come together, one after another ("Question 1 of 3"), with one notification;
if you don't answer one in time, the rest wait in the chat instead of in more
dialogs. A question where several options can apply is a checklist: tick each
one, then Done. What you answer while planning is kept with the planning
session and handed to `/pb:spec`, so the spec carries every answer even after a
long discussion or a reset. A fix lap never asks: it reports a finding that
needs your decision as skipped.

A question you didn't answer (it timed out, or you closed the dialog) **stays in
the chat** with its options lettered: type your answer whenever you're back ("A"
is enough) and Pi follows it. If Pi is working, a message sent with Enter is read
after its current step, without interrupting it. When pb asks you something, a question or a dialog
that goes on without you, it also sends a **desktop notification**, in case
you're in another window (`"notify": false` turns it off). Ghostty, iTerm2,
WezTerm, Kitty and Windows Terminal show it; macOS Terminal and other terminals
on a Mac get the bell instead (the Dock icon bounces); in tmux it may not get
through.

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
The reset only changes what the model sees; the session file keeps everything,
so the discussion before it is still on the branch (`/tree`). The spec keeps
what the checkpoint wrote.

**Walking away.** Every dialog on the way into a build counts down
(`askTimeoutSec`, 5 minutes) and then goes on with pb's choice: build (here, if
a fresh session can't be opened at that point), keep files changed while
planning, build despite a red baseline or an unbuilt dependency. The build
summary lists what was decided without you.

**One build per working tree.** A build's undo points, review, checks and commit
see the whole tree, so `/pb:build` refuses while another spec is building in
another session right now (its session written to recently), and the build-start
screen names another spec whose build left uncommitted files: `/pb:commit` that
one first, or build anyway if they belong to this one. Build in sequence, and
commit between specs.

**Coming back later.** Reopen the session (`/resume`): after a checkpoint it
starts small, from the spec as it was at that checkpoint plus what followed.
Or start clean from the spec as it is on disk now (including your own edits):
`/pb:plan <spec>` continues planning in a fresh session, open questions first.
Quitting a big session that never reached the checkpoint? `/pb:compact`
first, or it comes back at full size.

`/pb:plan off` lifts the block for this session without building anything.

**Dependencies** are planned on their own: `/pb:deps [which]` is a planning
session like `/pb:plan` (the same investigation, background baseline and next
step) that reviews versions, the deprecated APIs you call, known
vulnerabilities and whether your code reaches them, and the runtime itself. It
names your stack's own read-only commands (`npm outdated`/`audit`, `cargo
outdated`/`audit`, the Maven versions plugin, `go list -u`, `govulncheck`,
`pip-audit`…) and never installs or updates anything into the project. A claim
that an upgrade breaks something cites the changelog and your call site. The
reply groups the upgrades into changes you would merge on their own (patch and
minor together, each major alone, a framework before its plugins); you choose
which, and `/pb:build` writes one spec per change and builds the first.

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
Status: ready                  (planning: a checkpoint — no tasks yet)
Depends on: none               (or: <spec name> — an optional note)
Also changes: ../frontend      (optional: sibling repositories the change also edits)
Verification: tests            (or: build — why · none — why)
New tests: yes                 (or: no — why)
```

**A change that spans two repositories** (a backend and its frontend, side by
side) names the sibling in `Also changes:`; it must be a git repository one
folder up from the project. The build then records where it starts there,
every undo point snapshots it too (`/pb:undo` puts it back with the project),
the review's diff and changed files include it (as `../frontend/…`), and
`/pb:commit` offers its files and commits them in that repository with the same
message. Planning protects every sibling repository, named or not.

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
  everything behind them is left to the build, and a Contract that cannot be
  built as written stops it for a revised spec, never a dialog. The reviewer
  checks each. A single task that changes an external surface
  should have Contracts too; only truly independent internal tasks can omit it.
  A bullet that bounds how often something runs should name the code whose call
  it bounds — a `path:line`, or `new: <path>` when nothing performs it yet, or
  the `assumed:` tag when nothing in the project enforces the cadence (a third
  party's webhook, another service's cron); a backticked command is a
  measurement, not an owner. A section that does not apply is one
  line, "none — why", never an empty heading or TBD.
- **Evidence**, one rule for the whole spec, and the same one the spec reviewer
  judges by. A claim is *load-bearing* when the
  build would act differently if it were false: a number or bound, what this
  repository, its build, runtime or configuration does, or how an external
  service behaves. Each load-bearing claim carries its evidence beside it: a
  `path:line` that says it, a probe line, or — for a value this change itself
  defines, like a new status code — the Acceptance line that pins it, since its
  red test proves it. A claim about code or a service that exists today still
  needs the citation or the probe: a test written from the same belief would
  pass even if the belief were wrong. Whatever nothing settles yet is tagged
  `assumed: <what would falsify it>` right after the claim, and every such tag
  is listed for you before the build. Everything else needs no evidence.
- **Migration and rollback**: only when data, a schema or a stored format
  outlives the change, or it ships something that can fail in production: how
  existing data moves, how it is rolled out (a flag, the order of steps) and
  rolled back, what old and new code do while both run, how you'd see it fail
  (the log, metric or alert), and what no test can show and how it is checked
  instead. "none — why" when nothing outlives the change.
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

**Before writing, Pi runs the spec reviewer's own checks** on its draft, one
list shared word for word, so what a review would find is fixed before the
review pays for it:

- **Claims**: each claim about existing code says what the cited line says; Pi
  re-opens the line instead of trusting its memory of the discussion.
- **Values**: unit, range, sign and the empty case; a time names its clock or
  zone.
- **Proof**: each Acceptance line has a test its task's `Test:` selects, and
  that test can fail before the change.
- **Coverage**: each Contract and each behaviour-changing Decision has an
  Acceptance line; what no line pins is not built.
- **Reach**: the existing tests, callers, links and docs that assert the old
  behaviour are named, and a task updates each.
- **Consistency**: the sections agree.

When a rewrite or a section update removes a section, an Acceptance line or a
Decisions entry from the previous text, the tool's answer lists what is gone, so
nothing a review lap added disappears unnoticed.

The spec pins what the change must do and how you'll know; how to build it is
left to the build, where the compiler and the tests give feedback. When a
decision rests on something only running code shows (a library's limits,
performance), planning tries it in a scratch copy first.

**Out of scope** is optional. The aim: a fresh or reset session starts where
the discussion ended, without re-analysing and without being buried. Pi points to code instead of copying it and states each
fact once; `pb_write_spec` reports the size and only suggests tightening a long
spec. `pb_update_spec` changes one section at a time, or a line or two inside one
(`mode edit`, quoting the exact text it changes).

**A spec is never overwritten from an older copy.** pb remembers what each session
has seen of a spec: what it wrote, read whole, or was seeded with. A section
replace, or a whole `pb_write_spec` rewrite, is refused when the text on disk
changed since that session saw it (your hand edit, another session's), and the
refusal returns the text as it stands; the model then edits it by quoting it, or
reads the file and writes again. While a spec this session worked on differs on
disk, each turn says so, naming the sections.

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
network (`;`, `|`, `&`, `$`, `<`, `>`, backticks, a newline, `curl`/`wget` —
it runs with your
privileges, so review it; the dry-run below doesn't execute it). A ready spec keeps no Open questions.

When the spec is shown for approval, the harness runs each red-eligible
task's `Test:` once — except shell-chaining ones, which aren't run before
you've approved: failing is expected (nothing built yet), passing smells
behaviour that already exists, erroring smells a broken command. Docs,
config, refactors and other non-test changes have no red-eligible commands
and skip this entirely.

**Writing it is painless.** The questions belong to planning. What the
discussion left open stays open: it goes under Open questions and the spec
stays `Status: planning` until you answer — Pi never invents a decision to
close a gap. It asks you only about a choice that changes behaviour,
an API or data that you didn't settle, all at once, and when `/pb:build` is
writing the spec those questions count down too. (A claim nothing settles is
tagged `assumed:` and listed for you before the build; the build records its own
small readings as it goes — the reviewer checks both.) A checkpoint asks nothing at
all: what's undecided goes under Open questions.

When `/pb:build` writes it, it asks first: **build it** (in a fresh session, from
the spec) or **show me the spec first**. Built straight away, the spec is still
shown in the session for later. Shown first, you choose: build it in a fresh
session, **edit the spec first** (in an editor; it's saved only when it still
parses, and the build then gets your version), or not now. That offer comes
after a turn, where pb can't open a session itself, so choosing to build leaves
`/pb:build <spec>` in the editor: press Enter.

The header is `**✅ Spec written — <name>**` with the task and acceptance-criterion counts
and, when the step recorded it, the time it took from `/pb:build` or `/pb:spec` to the
first ready write. `**Next:**` says what happens next: the build starting, or your
choice of where to build.

**Before the first task, every spec gets one independent review.** The pass is
fresh and read-only, and it is the only one: there are no rounds, no carry and
no outside lane. It attacks every Decision, re-tests each "Not doing X"
rejection, flags unmeasured numbers and undefined empty paths, and checks the
spec against the repo: that its `path:line` citations and test commands
resolve, that external surfaces have Contracts, and that persisted-data
changes have a Migration and rollback answer. Every observable value in a
Contract — a status, error, header, ordering, event or stored value — is
checked against the code path or test the spec cites for it; a value with no
citation, or one its citation contradicts, is a finding. It runs on your
session's model by default; set `"specReviewer": {"model": "provider/id",
"thinking": "high"}` (or point it at `buildModel`) when you want another model,
such as the implementer, to validate the plan.

The reviewer reports at most the five findings that would make the build
wrong — behaviour, a security or data hole, a contract the tasks can't all meet —
and leaves out wiring the build catches by itself (a test name, a Test: command
that can't select its test, a doc left out of a task). A Goal that grew past
what you asked for is a finding too, fixed by the cut: the writer keeps the Goal
to your request and puts anything else it thinks worth having under Out of
scope, where you can take it back in.

Only a **P0** blocks the build: a security or authorization hole, data loss or
corruption, or a contract contradiction that cannot be built as written. P1-P3
are information: the build carries them and the code review judges the result.
The P1s reach the code reviewer as leads: the spec itself may be the flaw, so it
checks each against the code and reports one that still holds.
A pass recorded earlier posts its P1s again when the build starts, since you may
not have seen them. A finding has a
priority, the check it fails (Claims, Values, Proof, Coverage, Reach,
Consistency, Overengineering, Evidence or Other; `/pb:stats` counts findings per check), a
one-sentence title naming what goes wrong and where, and optionally
its file, line and the single fix the reviewer would make. If it weighed
another fix and rejected it, that reason belongs in the same fix line, not as
an either/or handed back to you. The reviewer has no shell at all: it reads the
frozen diff and the repository with read-only file tools, so it cannot act on
what it judges. A choice a read can settle, it settles itself and cites the
file:line and what it found. The findings, the pass, the diff it saw and the
full transcript are recorded beside the spec.

**A spec is reviewed once.** A later `/pb:build` reuses the verdict on the same
text, re-posting a standing P0 instead of running again. After a pass, an edit
is not reviewed again: a fresh pass always finds new subjects, and the code
review judges the build against the final text (`/pb:spec-review` reviews it
again when you want). The build-start screen still shows what changed since the
review read it: the sections, and every line it read that the text no longer has,
since a removal is rarely what settling a finding meant to do. After a P0, the edit
that settles it is reviewed, since the P0 holds the build until a review sees it
gone. Once the first task has started, spec edits are the code reviewer's to judge.

**`/pb:spec-review [name]` runs that pass without the build**, for a spec that
is written but must not be built yet — a plan you want judged before you commit
to it, or one someone else wrote. It is the same reviewer, the same report and
the same record, so the verdict it leaves is what a later `/pb:build` rides on:
T1 starts without a second pass while the text is unchanged, and a P0 it found
holds that build until the spec is amended. Nothing else follows from it — no
approval, no task, no checkpoint. With no name it reviews this session's spec,
or the only ready one, and headless with several ready it refuses and lists
them, so nothing is judged sight unseen. `/pb:spec-review --fresh` pays for
another pass at the exact same text instead of reusing the recorded verdict.
Run it again after editing, since the verdict is bound to
the bytes, not to the day: a re-posted verdict names the commit its citations
were read in, because a pass covers the spec's text while the code around it can
move. Ask it about a spec whose build is already running and you get the plan
review as advice — the running build is not re-gated, and `/pb:review` is what
judges the code.

**If the reviewer answers in prose instead of its report tool**, nothing can be
recorded, and the build does not start on a review that didn't happen. pb shows
what it wrote instead and the run's session, so you can read the review anyway;
`/pb:build` tries again, or `"specReviewer": {"model": "provider/id"}` in
`.pi/pb/config.json` points the pass at a model that reports.

The header reads `**✅ Spec review — <name>** · PASS` or `**❌ Spec review — <name>** · FAIL`,
followed by the review's time; a pass that reported nothing through its tool is `❌ FAIL` too,
because no review of that text was recorded. `**Next:**` on a pass is the build; a P0 says
to fix the spec and run `/pb:build` again.

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
6. **Findings**: are the facts still true, and does every
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
  before its dependency asks you first (an archived, finished dependency counts
  as built). Write them all while the discussion is
  fresh; when a later build finds the code has moved on, it resolves the
  difference and lists what it chose.
- **Small related changes** can share a spec.
- **You can edit a spec by hand.** It just has to keep the format. A running
  build pauses at its next step until `/pb:build` re-approves the edit.
<!-- /pb -->

<!-- pb:topic spec-review -->
## Reviewing a written spec

`/pb:spec-review <name>` runs the same independent pass the build runs, records
it, and builds nothing; `/pb:build` then starts without a second review. The
review's own cost and the code state it read are named under the findings — it
is a reading of the code as it stands.

**What to do with the findings**: most need nothing. P2–P3, and anything about
proofs, test names or docs, the build carries — its own checks and the code
review catch those for far less. A finding you want settled before the build —
a P0, or a P1 about behaviour or a security guard — you settle with the planner:
`/pb:plan <spec>` picks the planning up again, with the whole discussion, and it
edits the spec. There is no separate repair run: the planner already has the
context, and you keep the calls.

A spec is reviewed once. After a pass, your edits go to the build unreviewed and
the code review judges the result; after a P0, the next `/pb:build` reviews the
edit that settles it.
<!-- /pb -->

<!-- pb:topic build -->
## Building

`/pb:build` builds **from the spec, in a fresh session**: a new session named
"build: <spec>", seeded with the spec, on your model and thinking level (or
`buildModel`). The planning discussion does not come along, on purpose: the
spec is what was approved and what both reviews judge against, so a build that
also read the chat could follow something the spec never said. If the build
can't succeed from the spec alone, the spec is missing something, and the
first task shows it. If this conversation hasn't produced a spec yet, Pi writes
one first and shows it. With several specs, pick one. `/pb:build <spec> --here`
builds in the session you run it from instead (a tiny change, or when you want
the discussion along); a paused build always resumes in its own session.

Before the first task, every spec gets one independent fresh-eyes review (see
`/pb:help spec`): only a P0 stops the build there for you to read; a P1 asks
whether to build on it; P2-P3 are shown as advisory findings and the build
carries on. Once T1 starts the build
asks nothing: an unclear detail is a reading it records as an assumption, and
only a Goal or a Contract that cannot be built as written stops it, for a
revised spec and a new approval.

1. **The tasks.** Each task is built the same way: tests first, then the
   behaviour, then `pb_task_done` — reporting what changed plus the caveats,
   rejections and open items later tasks can catch on — which hands out the
   next one, naming the spec to read. The build runs uninterrupted, but each
   task after the first starts from a fresh context reset to the build's state,
   so the agent reads the code it builds on instead of inheriting the previous
   task's conversation. How the shape
   is arrived at is the build's: the compiler and the tests give the feedback,
   task by task, where each step is checked by something real. The first task
   that settles a shape the later ones build on records it in the spec's
   `## Design`. A task that has grown into several changes finishes the smallest
   coherent part and reports the rest as open, so it can become its own task
   instead of one long run.

   Once the first task starts, the spec's contract is frozen: the build may add
   to `## Design` and `## Decisions`, and change nothing else — not through
   `pb_update_spec`, not by editing the file. The decisions you approved hold
   too: the build (running, or paused in its own session) and its fix laps may
   add decisions but never change or drop an approved one. If the spec itself
   must change, the build stops and asks; editing it by hand pauses the build at
   its next step, and `/pb:build` re-approves the revision (finished tasks stay
   done), showing any approved decision that was removed.
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

   The completion summary carries the build's **active time** — the time it was
   actually running, with your pauses left out; when they differ, the elapsed
   time follows in parentheses. A pause shows the build time so far.

**A check after every task** (`"taskChecks": "each"`): the harness also runs each
task's `Test:` command (a compile when it has none) when the task is done. It
catches a broken task earlier, but makes every task leave the build green on
its own, which slices work unnaturally and costs a run per task. With `"end"`
each task is still compiled when done (when a compile command exists). `lint`
runs after every task's check and fails that task like any check. An
auto-detected lint gates every task only when the planning baseline ran it
clean on this commit; otherwise it runs at the final gate alone, so existing
warnings never stall the first task (set `"lint"` to gate every task anyway).
The final gate additionally runs `extraChecks` when configured.

The spec's Goal, Out of scope, Decisions, Design, Contracts, Migration and
rollback, Threats and abuse (`Threats` reads as the same section) and Acceptance
bind the build. How to build it is the build's: a better way found while coding
is taken, and a change to the Design goes in Decisions. Every task handout,
check retry, coherence pass and fix lap names the spec file and those sections;
the finished tasks' caveats, rejections and open items reach the model through
the reset and compaction summaries, and each task's changed files are listed
from its checkpoint; the next task's handoff directs it to inspect the parts it
depends on and to treat code as evidence, not approval, when it conflicts with
the spec. The spec is never pasted: it would be shortened, stale or too big
for the model reading it, so the model reads the one file that is the source
of truth.

**The build never stops to ask.** Where the spec is ambiguous, contradicts
itself or doesn't match the code, Pi takes the sensible reading, records it in
the spec's Decisions as an **assumption** with what would settle it, and carries
on. The build summary lists these choices and the reviewer checks them, so you
look once, at the end. Only a Goal or a Contract that cannot be built as written
stops it: Pi reports what the repo contradicts, with the evidence, and the build
pauses for a revised spec — `/pb:build` approves the revision and carries on.
It leaves `.pi/` alone.

A progress line above the editor shows the tasks while it runs. If Pi stops
mid-task without finishing it, pb reminds it once; if it stops again, the build
pauses.

**Compacting a build on demand.** `/pb:compact` in a build session (while it's
paused, or between your messages) compacts it the same way: the summary is the
build's state, written by pb, not by a model.

**A fresh context per task.** When a task finishes, pb resets the session right
there, between two tasks, where nothing is half-done. The next task starts from
a summary pb writes itself: the build's rules, every finished task with its
report (what changed, and the caveats, rejections and open items later tasks can
catch on), the spec's path with the sections that bind the build, and the next
task — its prompt naming the changed files each earlier task left (from
checkpoints, not the model's word), directing it to inspect the parts it
depends on, and treating code as evidence rather than approval when it
conflicts with the spec.
No summarizing model call. The point is focus: the next task reads the code it
builds on instead of inheriting a long conversation about the previous ones.
`buildReset: "threshold"` restores the older behaviour (reset only past
`checkpointAt`, 75% of the window and always before Pi would compact);
`buildReset: "never"` leaves compaction to Pi. Should a single task still run
into Pi's own compaction, pb writes that summary too, adding the files the task
has changed so far and the files read before, so it carries on instead of
starting over. `/pb:undo` to a task from before a reset restores the files only
(the old conversation would bring the whole context back) and says what was
undone. Undo restores the whole tree, so when a file differs that no finished
step changed (your own edit, or the step in progress), it names those files and
asks: restore all, or only what the finished steps changed and keep the rest.

While it runs, this is an ordinary Pi session: watch, interrupt with Esc, ask
things. **Decisions you make here** are written into the spec's Decisions
(`pb_record_decision`), so they survive compaction and reach the reviewer.
`/pb:build <guidance>` resumes after any pause and records the guidance too;
a pause that wasn't a failing check costs the task no attempt.

The harness also watches the existing tests: when a task deletes some, cuts
their number of cases or adds skip markers, it doesn't stop the build (a
refactor legitimately moves and merges tests); the changes are listed at the
end and handed to the reviewer, who judges whether each was justified.

**When the build completes**, pb asks whether to review it now. A build often
finishes with nobody watching (overnight), so with no answer for
`reviewAfterBuildSec` (10 minutes by default; any key restarts the countdown)
pb starts `/pb:review` itself, as if you had typed it. A review can't change
your files, so the only thing it spends unasked is its model time. "Not now"
leaves it to you, `0` turns the offer off, and a headless run never makes it.
pb never starts a fix lap on its own: `/pb:fix` changes code, so it waits for you.
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
after that; the refusal costs no attempt. A run that passes is sent back and
clears any earlier proof: the tests changed, or the command no longer runs them.
Calling `pb_tests_red` again is allowed, and only the latest failed run counts.
`/pb:undo` takes the proof back with the files.

Two tasks that carry the very same `Test:` command share one run, so that run
shows only that something is missing among them. Once an earlier task is done
and proven, a later task with the same command cannot fail again: the harness
says so instead of wedging, and hands that disclosure to the reviewer — confirm
the acceptance holds on top of the earlier change and finish. A task with no
`Test:` command, a refactor, or a spec with `New tests: no` or
`Verification: build` has no red proof by construction. Rewriting a task's
`Test:` command drops its proof: the new command must be seen failing again.
Each case is listed at the end of the build and handed to the reviewer as
partly proven or unproven — give a task its own targeted command where you
can, and when tasks share one, make it fail at each task's turn (a conjunction
over per-task artifacts, so each task still has something to prove). A task's
`Test:` command is the proof of its acceptance lines. A task with no red proof
— a `(refactor)`, no `Test:`, `New tests: no` or a no-test gate — is judged by
the reviewer on whether its acceptance is genuinely untestable or docs-only.

The commands come from `.pi/pb/config.json` (`"verify"` and `"build"`, `"auto"`
detects Maven, Gradle, npm/TypeScript, Cargo, Go and pytest; `"lint"` uses
package.json's `lint` script, else clippy for a Cargo project, `"extraChecks"` runs
project commands at the final gate).

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
  untested. Don't hollow out the earlier task to force a failure: give the
  task its own `Test:` line (`/pb:spec`), then `/pb:build` re-approves the
  revision and resumes. (When an earlier task *did* prove the same command,
  the harness records that no run could prove this one and lets it finish.)
- **Compacted in circles**: if Pi compacts the same task over and over with
  nothing new read, changed, or shrunk, the build pauses instead of looping.
  Usually one giant tool output refilling the context (a verbose `Test:`
  command; `testOutputCap` trims what the harness shows, not what the agent
  saw), an oversized spec, or the task looping. Look, then go on, throw the
  task away, or split it.
<!-- /pb -->

<!-- pb:topic review -->
## Review

`/pb:review` first runs the checks itself: the same ones as the build's final
step (suite or compile, lint, extra checks), then each finished task's `Test:`
command. The reviewer has no shell, so those runs are the evidence it can cite
for an acceptance line. A red one caps the verdict: a review never passes over
it, whatever the reviewers found (UNVERIFIED, naming the command). Then it opens
a **fresh session**, "review: <spec> · spec", and takes you there: the reviewer
sees the spec, the diff and those results, but not the build conversation, so it isn't anchored by the builder's
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
`/pb:review <focus>` points it at something specific. A focus is always
answered, even when nothing changed since the last review (the one pb may have
started by itself after the build): it is then a review of the whole change.

Every finding carries a priority: **P0** must fix (broken, insecure, data
loss), **P1** fix before merging (an unmet criterion or decision, a bug,
missing or weakened tests, a workaround), **P2** worth fixing (conventions,
clarity, comments), **P3** a nit. **P0 and P1 findings get a second look**: a
separate verifier checks each against the code, and the ones it rejects are
listed as dismissed, with its evidence, instead of costing you a fix cycle
(`"reviewer": {"verify": false}` skips it). It owes an entry for every finding
it was handed, and pb counts the answers among what comes back: report nothing,
or only some of them, and the result says so — `verifier ⚠ 0/2`, or `verifier ✗
1/2` when its own run failed too — with a line saying the findings it left out
are reported *unconfirmed*. A run that answered everything and then failed is
not a clean check either: its mark carries the counts and the failure
(`verifier ✗ 2/2`), the line says the double-check is incomplete, and the spec
stays unreviewed even when every blocker was dismissed. Unconfirmed is not a
verdict: the second look removes a finding only by rejecting it, so one it
never mentioned stands exactly as if it had confirmed it. The next step names
`/pb:review --full`, because a plain `/pb:review` re-reads only what changed
and an unchanged tree gets no second look at all. Any confirmed P0 or P1 means
*changes needed*. Findings with the same concrete fix are reported once, at
the highest priority. When the code is right and only the spec's framing is
imprecise, that's a P3 note with a proposed rewording, not a defect.

**What a PASS is made of.** Only pb's own checks are executed proof: the
evidence line starts with them (`checks 3/3 green`, or `no checks run` when the
project has no command to run). Everything after that — the passes, the
second look, the criteria met — is model judgement: more eyes, not proof. A
PASS over `no checks run` rests on judgement alone. A finding that rests on a
rule the project map states is confirmed only when the code bears the rule
out, because the map is model-written too.

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
`- Acceptance:` lines become `T1.1`, `T1.2`, … in reading order.
The reviewer reports each one as **met** with evidence (file:line or test
name), **not met**, or **not verified** with the reason.
The checklist follows the spec as written, and every spec review uses the same
list, including a manual `/pb:review` during a build. An omitted or unchecked
item counts as not verified, never as met: a review with nothing blocking but
any unverified item ends **UNVERIFIED**, not pass, and leaves the phase where
it was. A not-met item is blocking and comes with a P1 finding. P2/P3 findings
stay advisory.

The header reads `**✅ Review — <label>** · PASS`, `**❌ Review — <label>** · CHANGES NEEDED` or
`**⚠ Review — <label>** · UNVERIFIED`, followed by the review's active time: the watched
reviewer, the adversarial pass and the verification pass together. Findings in the
Change section and outside it are numbered continuously (P0–P2; P3 nits are unnumbered),
the same numbers `/pb:fix` takes. `**Next:**` names one action — `/pb:fix <ids>` for open
findings, `/pb:build` when a mid-build review passed with tasks remaining or the fix changed
the approved contract, or `/pb:review` after fixes.

The findings land in the session you ran it from; run it **in the build
session** and fix them right there: that session knows the code it just wrote.
Or fix them in a fresh fenced session: `/pb:fix [ids]` takes P0–P2 finding
ids (no ids = all open ones); P3 nits never block and are fixed by hand or
ignored. A lap treats each finding as a class: it looks for the same defect
across the change (the diff since the build's base commit) and fixes every
instance, reporting any outside the change instead. Each behavioural fix is
proven like a build task: the lap writes a test that reproduces the finding and
pb runs it (`pb_fix_red`) and sees it fail before the fix; a finding no test can
show, such as a doc line, is reported with why. After each lap **pb runs the
checks itself**: each reproducing test, which must now pass, then the same
project checks as the build's final step. A red check means the lap's fixes
don't count: the next lap gets the failure, and with no lap left the run stops
on it. When everything is fixed and green, pb offers the follow-up review. Each
lap is an undo point: `/pb:undo fix1` restores the files and the spec as they
were before it. A fix lap keeps the spec true to what it fixed: when a fix changes
behaviour the spec's Design or Decisions describe, the lap updates those lines
itself, and it can change nothing else in the spec. A finding that needs the
Goal, Contracts or Acceptance changed is reported as skipped, for you to revise
with `/pb:spec`; one the lap didn't finish is reported open, and the next lap
takes it. The report ends the lap: nothing it does afterwards would be checked,
so it gets no further turn. **Esc in a lap pauses it**: pb doesn't push it to
report, and waits until you type `continue` or tell it what to do instead. If
the lap stops on its own without reporting, pb reminds it twice, then ends the
run as silent. If the fixes change the approved contract, `/pb:build` must re-approve
it before the review runs; otherwise the next `/pb:review` is a **follow-up**:
it checks the fixes and nothing else: whether each previous finding is fixed,
what the fixes broke or left inconsistent, and any new P0 or P1 in the lines
changed since. It reports no new P2 or P3 in code the fixes left alone, and its
adversarial pass runs only when the fixes touch sensitive code (`--full` reviews
everything again). If nothing changed, it says so and costs nothing, unless pb's check
failed under the last review: a check can fail for reasons outside the change (a port
in use, a service down), so once it runs green the review follows up instead.

**The adversarial pass, when the change looks sensitive.** A background pass (its own fresh
process, not a session you watch) has a single job: break the change. For every entry point it adds or alters and
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

**Inside the review.** The spec pass runs in a real Pi session you're in: you
watch everything natively, and you can interrupt it or ask it something ("why is
3 a P1?"). Its model is read-only: read/grep/find/ls and the reporting tool, no
shell, so neither it nor a command of its own can change the tree it judges; the
change arrives as a frozen diff from the build's base commit to the tree the
review started on. The pass ends when it has reported its findings and stops, or
at `/pb:review done`. When it is done and an adversarial pass is due, that pass
runs in the background on the same frozen brief, and pb takes you back to your
session with the merged result once it finishes. Asking the reviewer questions
is fine; arguing it out of a finding makes it less independent. The review
session stays in `/resume`, named "review: <spec> · spec" (without a spec,
"· intent"), and the result names it and the adversarial pass's saved session.

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

The reviewer can't change your files: no shell, no edit and no write, and the
diff it judges is the one frozen when the review started. By default it runs on your session's model,
likely the one that built the change and shares its blind spots; the first
review in a project offers to pick another (`"reviewer": {"model": "provider/id"}`
in the config). A different model family is the cheapest way to get genuinely
different eyes.
<!-- /pb -->

<!-- pb:topic undo -->
## Undo

Before each task the harness snapshots the working tree (in git's object store,
without touching your branch, commits or staging area). A row is stored in the
undo list only when it adds information: one repeating the previous row's files,
conversation point and task list would say nothing new. `/pb:undo` in the build
session lists the tasks; pick one and the files and task list go back to how
they were **before** it. A `/pb:fix` lap's row also restores the spec text and
phase from before that lap. Either way the **conversation** goes back too: the discarded attempt drops out of the
context (a short note says what was undone, and repeats what
you said meanwhile so your guidance isn't lost), so it doesn't anchor the next
try. When the rewind point lies before a task-boundary reset, only the files and
task list go back, and the result says so. `/pb:undo u1` reverses an undo,
conversation included. If you committed
in between, the undone work shows up as uncommitted changes (you're warned).
<!-- /pb -->

<!-- pb:topic map -->
## The project map

A short section of this project's AGENTS.md (marked `<!-- pb:map -->`, apart
from the standards and from what you wrote) with what stays true across
features: the layout and the role of each module, the patterns to follow (by
path), constraints the code doesn't make obvious, test and build quirks. Pi
loads AGENTS.md into every session, so every plan, build, review and
exploration starts with it instead of rediscovering it. The whole-project
headings (Security invariants, Layout, Tests + build, Docs, Known gaps) carry
no path and are read in every session; every other heading is an area heading
with its path prefix, and sessions read only those covering the paths they
touch.

- **When a feature is done**, with `"mapOnArchive": true`, `/pb:archive` updates
  it from what the feature established: its spec's Findings, the design the build
  settled on, the files it changed, and the completed reviews' P0–P2 findings as
  leads the cartographer must check against the code (a finding that no longer
  holds is left out). It is off by default — the cartographer is a long run — so
  the archive says when the map was left as it was, and `/pb:archive <name>
  --force` skips it even when it is on. It reads only the
  feature's change: the lines that cite a changed file are re-checked, the
  change is read against every rule on the map, and every other line is kept
  as it is.
- **Any time**, `/pb:map [focus]` audits the whole map against the code as it
  is now: every path, command and claim. Run it after a large change outside
  pb, or when you want the map re-proven.
- **`/pb:map undo`** puts the previous map back (again: swaps them back).
- A proposal that looks off (paths that don't resolve, lines the code
  contradicts, much of the map removed) asks first. Unanswered, it is written
  and pb posts what it was flagged for: `/pb:map undo` goes back.
- **`/pb:map apply`** writes a proposal you dismissed. It is written only onto
  the map it was made against; if the map changed since, run `/pb:map` again.

Nothing pb writes there can break the section: text it stores — a finding's file,
title or fix, a proposed line — loses control characters and HTML comment markers
on the way in and on the way back, a finding whose title was nothing but markup
keeps a `(untitled finding)` placeholder instead of vanishing from the ledger, and
each tab becomes a space so no line turns into an indented code block.

**The core and the area notes.** The map's whole-project headings (Security
invariants, Layout, Tests + build, Docs, Known gaps) stay in the root AGENTS.md,
which every session reads. Every other heading names one folder, `### Orders
(src/orders/)`, and lives in that folder's own AGENTS.md, under the same
markers; the core ends with an `Area notes` list of them. pb names the notes a
session needs: each build handout those for the folders its spec cites, the
review those for the files the change touched, and planning and the explorer
read the list. Any other agent working in that folder finds its notes there too.
A heading whose folder doesn't exist, is the root, is dot-named, ignored by git,
or leads outside the project through a link stays in the core. An area the map
drops leaves its folder (your own text in that file stays), and `/pb:map undo`
swaps the areas back with the rest.

A fresh, read-only call proposes the whole new map (it revisits all of it, not
only the new area). Its readers are capable models that explore fast, so it
holds only what exploring wouldn't show them: security and data invariants with
the code that enforces them, where new code goes and what to copy, known gaps,
commands and quirks, docs the code contradicts, and layout only where names
mislead. Each bullet is at most two sentences, about 400 characters: the rule,
where it is enforced and the test that proves it, with the mechanism left to the
code or a doc it names. The limit is per bullet, not per map: a project with
more invariants gets more lines, never fewer rules, and the total (about 20,000
tokens) is only a sanity bound. It's read in every session, so a line stays only
if it saves a later feature a search or a mistake. Your session doesn't grow. Only a
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
resolve go back to it once to be corrected or rewritten so they no longer read
as paths here (a route gets its verb; an outside repo is prose), and so do the
lines a fresh check finds the code contradicts, and the
bullets over the length, to be shortened without dropping a rule, and a map over
the budget, to be trimmed. That check reads the code behind every new or changed
line (up to 60) before anything is written, since agents read the map as
instructions and a wrong line is worse than none; a contradicted line the
cartographer keeps word for word is put to you like a path that doesn't
resolve, and a check that reports nothing is said, never read as a pass. Then the map is written and the change is shown, with
the bullets still too long counted. It asks you first only when something looks off: paths that still don't
resolve, or a large part of the existing map removed; unanswered, the current
map stays.
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

- **`/pb:status`**: every spec, its state, verification, dependencies and tasks,
  and its next step.
  `/pb:status --json` prints the same information as the `pb.report/2`
  document for scripts.
- **`/pb:stats`**: for this build: tasks done on the first try, checks run and
  failed, pauses, the review verdicts with the latest review's confirmed P0/P1,
  a `Precision` line — findings the reviewers reported, how many the verifier
  dismissed (their share of the reported), how many were fixed in fix laps, how
  many answers the second looks on this spec never got (summed over its
  reviews), which shows as `· 3 blocking never double-checked` only above zero
  (a verifier skipped by the config, a review with no blocking findings and a
  review recorded before the counts all mean nothing missed), and how many
  verifier runs failed, which shows as `· 1 verifier run failed` even when
  every finding was answered —,
  red proofs (proven, sent back, no run could prove), tokens in and out per role (with
  output rate where pure run time is known: explorer calls), peak context, cost,
  and a `Time` line: the spec-writing step, the spec review, the build and the
  latest review. Build time is active time, with the elapsed time in parentheses
  when pauses made them differ; the review time covers its reviewer, adversarial
  and verification passes. The card also reports how often the session was
  compacted, reset or reminded. Only explorer calls show an
  output rate: they are a single measured run, while build and review time
  covers many turns. `/pb:stats all` compares every spec, archived ones included.
  `/pb:stats compare [n]` lines up the last n specs (default 10) phase by phase:
  what the first spec review and the first code review found, the repair and fix
  laps, the first-try rate and each phase's cost, to judge a change to pb itself.
  Its `map` column (and the card's `Map` line) is how the project map is judged:
  of the first code review's findings, how many broke a rule the map states (the
  map said it, and the build didn't follow: too long, or in the wrong place) and
  how many found a map line wrong. The reviewer marks both, and the post shows
  them on each finding.
  `/pb:stats --json` prints the same report with each spec's stats.
- **`pb-report`**: the report without Pi, for scripts and dashboards:
  `pb-report [--cwd dir] [--stats] [--review]`. The `schema` field is
  `pb.report/2`; a breaking change gets a new one (pb.report/1 lost its dead `context.asks` count).
- **`/pb:commit [spec]`**: commits the work whenever you choose. It opens an
  editor with the message and, below it, every uncommitted file since the
  build began (never pb's own state or the spec file): edit the message, delete
  a file's line to leave that file out (your own unrelated edits, say), clear
  the message to cancel. Only the paths left are committed — never `git add -A`. The message comes from the
  spec, not a model: the first commit carries the title, goal and tasks, a
  later one the review fixes since, and a map-only commit after `/pb:archive`
  the map's changes. Your hooks run; whatever else you had staged stays staged
  and out of the commit. Nothing changed since the last commit: it says so and
  stops. It refuses while a build is still writing files.
- **`/pb:archive`**: moves a finished spec to `.pi/pb-archive/` (which git
  ignores), so `/pb:build` and `/pb:status` only show live work; it updates the
  project map only with `"mapOnArchive": true` (`/pb:help map`). A spec with work left (a build not
  finished, never reviewed, a last review that wasn't a pass, or open findings)
  is archived only after you confirm, with what it still owes named: once
  archived, its findings are out of `/pb:fix`'s reach. The approved spec moves with it; the
  archive stays local, and git keeps the history of the specs that were live.
  `/pb:archive <name> --force` puts away a spec you have abandoned in one step:
  no question and no project-map update (`/pb:map` makes that one when you
  choose). It needs the name spelled out, never touches your files, and ends a
  review still kept as running rather than refusing it. A build live in another
  session is refused either way, `--force` included; the build's own session
  gets through once Pi is idle, since that is the build that crashed there.
  Every archive records why it left and which files the tree still holds
  against HEAD (in sibling repositories too), and the closing line names them
  with the ways out: `/pb:commit <name>`, or putting them back by hand.
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
- Steer it in words: agree, disagree, or answer its questions. Example: *"go with option B, but keep the old endpoint"*
- `/pb:build` — writes the spec, has it reviewed, and builds it in a fresh session
- `/pb:spec` — only writes the spec, to read it before anything is built · more: `/pb:help plan`
<!-- /pb -->

### After /pb:spec
<!-- pb:tip spec.next -->
**What now** — the spec is written, nothing is built yet
- Read it in `.pi/pb/specs/`: the build follows it, the reviewer checks against it. To change it, say what, then `/pb:spec` again. Example: *"split T2 into two tasks"*
- `/pb:build` — reviews it, then builds it in a fresh session (only a P0 stops it before the first task)
- `/pb:spec-review` — only the review, nothing built; `/pb:build` then starts without reviewing again · more: `/pb:help spec`
<!-- /pb -->

### A spec review with findings
<!-- pb:tip spec.findings -->
**What now** — these findings are information; only a P0 holds the build
- `/pb:build {name}` — builds and carries them, in a fresh session; the code review judges the result
- `/pb:plan {name}` — settle one first: tell the planner which and how, e.g. *"settle finding 2: keep the old endpoint"*. The edit is not reviewed again; the code review judges against it.
<!-- /pb -->

### Build paused
<!-- pb:tip build.paused -->
**What now** — the build is paused, finished tasks stay done
- `/pb:build {spec}` — carries on where it stopped
- `/pb:build {spec} keep going with the current approach` — carries on with your hint (recorded in the spec)
- `/pb:undo` — throws the last attempt away; `/pb:build {spec}` then tries again
- `/pb:spec {spec}` — the spec went wrong: rewrite it · more: `/pb:help stuck`
<!-- /pb -->

### Build stopped: the spec cannot be built as written
<!-- pb:tip build.contract -->
**What now** — the build stopped: the spec cannot be built as written (its Goal, a Contract, or a task's Test: line, which only you may change)
- Read the reason above: it names what the code or the repo contradicts, with the evidence, and often the exact edit.
- Edit `.pi/pb/specs/{spec}/spec.md`, then `/pb:build {spec}` — the revision is approved and the build carries on; finished tasks stay done
- `/pb:spec {spec}` — have Pi rewrite the spec instead, then `/pb:build {spec}` · more: `/pb:help spec`
<!-- /pb -->

### Build paused: a task keeps failing
<!-- pb:tip build.paused-attempts -->
**What now** — {task} failed its check too many times, the build is waiting
- `/pb:build {spec} mock the clock instead of sleeping` — retries with fresh attempts, steered by what you say
- `/pb:build {spec}` — retries as it is
- `/pb:undo {task}` — restores the files to before {task}; `/pb:build {spec}` then tries again · more: `/pb:help stuck`
<!-- /pb -->

### Build complete
<!-- pb:tip build.done -->
**What now** — the build finished, every check passed
- `/pb:review` — a fresh review here in this session, so you can fix findings right away
- `/pb:review the cancel endpoint's authorization` — the same, with a focus you name
- `/pb:commit {spec}` — after the review: you see the files and the message first, then `/pb:archive {spec}` · more: `/pb:help review`
<!-- /pb -->

### Review passed
<!-- pb:tip review.pass -->
**What now** — the review passed, the change is ready to merge
- `/pb:commit {spec}` — commits it (you see the files and the message first), then `/pb:archive {spec}`
- `/pb:fix {spec} {ids}` — fixes the P2 findings first, optional; then `/pb:review` checks only the fixes
- Or in words, here: *"fix finding 2"* — this session knows the code
<!-- /pb -->

### Review passed, but the build is not done
<!-- pb:tip review.mid-build -->
**What now** — the review passed, but tasks remain in this build
- `/pb:build {spec}` — runs the next task; the findings above are advisory
- `/pb:fix {spec} {ids}` — fixes them first, in a fresh session
- Or in words, here: *"fix finding 1"*
<!-- /pb -->

### Review found changes
<!-- pb:tip review.changes -->
**What now** — the review found things to fix before merging
- `/pb:fix {spec} {ids}` — fixes them in a fresh fenced session (P0–P2; a P3 is yours to fix by hand or ignore)
- `/pb:fix {spec} {ids} keep the public API unchanged` — the same, with your direction: it binds where it differs from a finding's Fix
- Or in words, here: *"fix findings 1 and 3"* — this session knows the code
- Then `/pb:review` checks only the fixes; `/pb:review --full` reviews everything again · more: `/pb:help review`
<!-- /pb -->

### Review could not verify everything
<!-- pb:tip review.unverified -->
**What now** — the review found nothing blocking, but some task acceptance items were not verified
- Read the acceptance list above: every `not verified` or missing id needs evidence, not silence.
- `/pb:review` — after you checked that behaviour or ran the named test
- `/pb:review --full` — re-checks the whole change, when nothing else changed
- `/pb:spec {spec}` — the criterion can't be checked as written: amend it
<!-- /pb -->

### Review held back by a red check
<!-- pb:tip review.red-check -->
**What now** — the reviewers found nothing blocking, but pb's own check failed, so the review can't pass
- Run {checks} yourself: a failure the change caused is fixed like a finding; one from outside it (a port in use, a service down) only needs a clean run
- `/pb:review` — once it passes: with nothing else changed, pb re-runs the check and a short follow-up, not the whole review
- `/pb:review --full` — reviews everything again
<!-- /pb -->

### Review without a verdict
<!-- pb:tip review.other -->
**What now** — the review ended without a verdict, read what's above first
- `/pb:review` — runs it again, after you fixed what's worth fixing
- `/pb:review --full` — reviews the whole change again
<!-- /pb -->

### Fixes done
<!-- pb:tip fix.done -->
**What now** — the fix lap is over; a review confirms it
- `/pb:review` — checks only the fixes: each finding, and what the fixes broke
- `/pb:review --full` — reviews the whole change again
- `/pb:fix {spec} {ids}` — the ones still open, in another lap
<!-- /pb -->

### After /pb:commit
<!-- pb:tip commit.done -->
**What now** — committed; pushing is yours
- `/pb:archive {spec}` — files the spec away once you're done with it
- `/pb:status` — every spec and where it stands
- `/pb:plan <what you want next>` — starts the next feature
<!-- /pb -->

### After /pb:archive
<!-- pb:tip archive.done -->
**What now** — the spec is filed away
- `/pb:plan <what you want next>` — starts the next feature
- `/pb:status` — every spec and where it stands
- `/pb:map` — updates the project map from what this feature taught
<!-- /pb -->

### After /pb:undo
<!-- pb:tip undo.done -->
**What now** — undone to before {id}, that attempt is gone from the conversation
- `/pb:build` — continues from here
- `/pb:build tell it what to do differently` — continues with your hint
- `/pb:undo {id}` — changed your mind: goes back the other way
<!-- /pb -->
