/** The fixes: /pb:fix, pb_fix_done, and the fix-lap loop. */
import * as path from "node:path";
import { Type } from "./schema.ts";
import type {
  ExtensionAPI,
  ExtensionCommandContext
} from "@earendil-works/pi-coding-agent";
import { type FixDirection, fixNudgePrompt, fixSeedPrompt, reportRegister } from "./prompts.ts";
import { safeBlock } from "./markdown.ts";
import { duration } from "./format.ts";
import { KEBAB_NAME } from "./names.ts";
import { snapshot } from "./checkpoint.ts";
import { type Checkpoint, type Finding, Store, appendCheckpoint, gitHead, isSpecFinding, now, readEvents } from "./store.ts";
import { contractChanges, removedLines, sectionKeyAtLine, sectionOf, specHash } from "./spec.ts";
import { runVerify } from "./verify.ts";
import { approvalDrift, approveSpec, choose, cmd, commands, post, evidenceLine, finalCheckCommands, fixCompletions, loadSpec, repoSnapshots, nextLine, phaseHeader, reply, sleep, specOfSession, specRef, stop, tree, withChecking } from "./kit.ts";
import { tip } from "./help.ts";
import { notifyDesktop } from "./notify.ts";

/** One lap's report shape, normalized from its `fix` event: findings by the number its brief showed them as. */
export interface LapReport {
  fixed: number[];
  skipped: number[];
  /** reported unfinished: they stay for the next lap */
  open: number[];
  /** the test commands pb saw fail before the fixes: re-run after the lap, they must now pass */
  reds: string[];
  tests: string;
}

/**
 * The report a fix lap owns: the last `fix` event appended after `from`, the event-log position
 * right after the lap's own fix-start marker. Event order, not clock time — `at` strings truncate
 * to seconds, so a prior lap's report in the same second must not read as this lap's.
 */
export function lapReport(events: readonly Record<string, unknown>[], from: number): LapReport | undefined {
  const last = events
    .slice(from)
    .filter((e) => (e as { type?: unknown }).type === "fix")
    .at(-1) as { fixedIds?: unknown; skippedIds?: unknown; openIds?: unknown; reds?: unknown; tests?: unknown } | undefined;
  const numbers = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is number => Number.isInteger(x)) : []);
  if (!last || !Array.isArray(last.fixedIds)) return undefined;
  return {
    fixed: numbers(last.fixedIds),
    skipped: numbers(last.skippedIds),
    open: numbers(last.openIds),
    reds: Array.isArray(last.reds) ? last.reds.filter((x): x is string => typeof x === "string") : [],
    tests: typeof last.tests === "string" ? last.tests : "",
  };
}

/** How long a human direction to a fix run may be: a few paragraphs of instructions, not a document. */
export const MAX_FIX_DIRECTION_CHARS = 8_000;

/** What `/pb:fix` was asked for once its spec name is taken off: the findings, and the human's direction if any. */
export type FixRequest = { picked: Finding[]; direction?: string } | { misses: string[] };

/**
 * Reads `/pb:fix` arguments after the spec name: leading finding numbers, then free text that
 * directs the run (an optional `:` or `--` may separate them). With no number, words that each
 * name exactly one finding by its title select those findings, and anything else is a direction
 * for every open finding. Numbers index `open`, the list the review numbered.
 */
export function parseFixRequest(rest: string, open: readonly Finding[]): FixRequest {
  const lead = /^(?:[\s,]*\d+\b)+/.exec(rest.trimStart())?.[0] ?? "";
  const numbers = lead.match(/\d+/g) ?? [];
  const after = rest.trimStart().slice(lead.length).trim().replace(/^(?::|--)\s*/, "").trim();
  if (numbers.length) {
    const misses = numbers.filter((n) => !open[Number(n) - 1]);
    if (misses.length) return { misses };
    const picked = [...new Set(numbers.map((n) => open[Number(n) - 1]!))];
    return after ? { picked, direction: after } : { picked };
  }
  if (!after) return { picked: [...open] };
  const words = after.split(/\s+/);
  const byTitle = words.map((w) => {
    const hits = open.filter((f) => f.title.toLowerCase().includes(w.toLowerCase()));
    return hits.length === 1 ? hits[0] : undefined;
  });
  if (byTitle.every((f) => f)) return { picked: [...new Set(byTitle as Finding[])] };
  return { picked: [...open], direction: after };
}

export function registerFix(pi: ExtensionAPI) {
  pi.registerTool({
    name: "pb_fix_red",
    label: "Fix test fails first",
    description:
      "In a pb fixes session (opened by /pb:fix): after writing a test that reproduces a finding and before fixing it, pb runs the command and requires it to FAIL, proving the test catches the defect. pb_fix_done counts a behavioural finding as fixed only with this proof. Call it again after changing the test: only the latest failed run counts.",
    parameters: Type.Object({
      finding: Type.Number({ description: "the finding's number, as the brief shows it" }),
      command: Type.String({ description: "the command that runs the reproducing test, targeted (one file or one test), not the whole suite" }),
    }),
    executionMode: "sequential",
    async execute(_id, params, signal, _onUpdate, ctx) {
      const store = new Store(ctx.cwd);
      const session = ctx.sessionManager.getSessionFile();
      const rec = store.fixSession(session);
      if (!session || !rec) throw new Error("This is not a pb fixes session: pb_fix_red runs only inside the session /pb:fix opened.");
      const n = params.finding;
      if (!Number.isInteger(n) || n < 1 || n > rec.findings.length) throw new Error(`${n} is not one of the findings shown for this lap: the brief numbers them 1–${rec.findings.length}.`);
      const command = params.command.trim();
      if (!command) throw new Error("Give the command that runs the reproducing test.");
      const cfg = store.config();
      const r = await withChecking(() => runVerify(command, ctx.cwd, cfg.verifyTimeoutSec, cfg.testOutputCap, signal));
      const reds = { ...(rec.reds ?? {}) };
      // Only the latest run counts: a green run clears an earlier failure, as the build's red gate does.
      if (r.ok !== false) delete reds[String(n)];
      else reds[String(n)] = command;
      store.saveFixSession(session, { ...rec, reds });
      store.event(rec.spec, { type: "red", task: "fix", finding: n, ok: r.ok === false, command });
      if (r.ok !== false)
        return reply(`\`${command}\` passes before the fix, so it doesn't catch finding ${n} (or doesn't run the new test). Make it fail for the defect the finding names, then call pb_fix_red again.\n\n${r.summary}`);
      return reply(`Seen failing: \`${command}\` (finding ${n})\n\n${r.summary}\n\nCheck it fails for the reason the finding names, not a typo. Then fix it; pb re-runs this command after the lap, and it must pass.`);
    },
  });

  pi.registerTool({
    name: "pb_fix_done",
    label: "Fixes done",
    description:
      "In a pb fixes session (opened by /pb:fix): report which review findings this lap fixed, which need a design decision (spec revision) instead of an edit, and which it did not finish, with the test results. Name each by the number it was shown as in the brief. The report ends the lap: make it when the work is done. The home session runs the approved path after the fix — /pb:build to re-approve a revised contract, otherwise /pb:review to check the delta. " + reportRegister,
    parameters: Type.Object({
      fixed: Type.Array(Type.Number(), { description: "the numbers of the findings this lap fixed, as shown in the brief (e.g. 1, 3)" }),
      skipped: Type.Array(Type.Number(), { description: "the numbers of findings whose fix needs the spec's Goal, Contracts or Acceptance changed (a design decision), not an edit, as shown in the brief" }),
      open: Type.Optional(Type.Array(Type.Number(), { description: "the numbers of findings this lap did not finish: they stay open and the next lap takes them. Never put an unfinished finding in skipped" })),
      untested: Type.Optional(Type.Array(Type.Object({ finding: Type.Number(), why: Type.String({ description: "why no test can show this fix (a doc or comment, a config value)" }) }), { description: "fixed findings with no reproducing test, each with why" })),
      tests: Type.String({ description: "test commands run and what each showed" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const store = new Store(ctx.cwd);
      const session = ctx.sessionManager.getSessionFile();
      const rec = store.fixSession(session);
      if (!session || !rec) throw new Error("This is not a pb fixes session. Fix review findings only inside the session /pb:fix opened — carry on there, or run /pb:fix for a new one.");
      const picked = (numbers: number[]): Finding[] => {
        const out: Finding[] = [];
        for (const n of numbers) {
          const f = Number.isInteger(n) && n >= 1 && n <= rec.findings.length ? rec.findings[n - 1] : undefined;
          if (!f) throw new Error(`${n} is not one of the findings shown for this lap: the brief numbers them 1–${rec.findings.length}. Report the number it was shown as.`);
          if (!out.includes(f)) out.push(f);
        }
        return out;
      };
      const fixed = picked(params.fixed);
      const skipped = picked(params.skipped);
      const open = picked(params.open ?? []);
      const twice = [...fixed, ...skipped, ...open].filter((f, i, all) => all.indexOf(f) !== i);
      if (twice.length) throw new Error(`A finding goes in one list only — fixed, skipped or open: ${[...new Set(twice)].map((f) => f.title).join("; ")}. Pick one.`);
      if (!fixed.length && !skipped.length && !open.length) throw new Error("Report at least one finding by its number in fixed, skipped or open, with the test results.");
      const numberOf = (f: Finding) => rec.findings.indexOf(f) + 1;
      const reds = rec.reds ?? {};
      const untested = new Map((params.untested ?? []).filter((u) => u.why?.trim()).map((u) => [u.finding, u.why.trim()]));
      // A behavioural fix is proven the way a build task is: a test seen failing before it.
      const unproven = fixed.filter((f) => !reds[String(numberOf(f))] && !untested.has(numberOf(f)));
      if (unproven.length)
        throw new Error(
          `Not recorded: ${unproven.map((f) => `${numberOf(f)}`).join(", ")} ${unproven.length === 1 ? "is" : "are"} reported fixed with no test seen failing first. Write a test that reproduces each and call pb_fix_red, or list it in untested with why no test can show it (a doc, a comment, a config value).`,
        );
      store.event(rec.spec, {
        type: "fix",
        fixed: fixed.map((f) => f.title),
        skipped: skipped.map((f) => f.title),
        fixedIds: fixed.map(numberOf),
        skippedIds: skipped.map(numberOf),
        ...(open.length ? { openIds: open.map(numberOf) } : {}),
        reds: [...new Set(fixed.flatMap((f) => reds[String(numberOf(f))] ?? []))],
        ...(untested.size ? { untested: [...untested].map(([finding, why]) => ({ finding, why })) } : {}),
        tests: params.tests,
      });
      store.clearFixSession(session);
      const cur = store.progress(rec.spec);
      const drift = cur ? approvalDrift(store, cur) : undefined;
      // The lap's reply is not the outcome: pb's checks decide whether a reported fix counts, and the human reads
      // the result in their own session. One fixed line keeps the lap from posting a report that reads as final.
      const line = drift
        ? "Fix report sent. The fix changed the approved contract: pb asks you to re-approve the change when the run ends (or /pb:build does)."
        : "Fix report sent. pb is checking the fixes now; the result and the next step come in your session.";
      // The report ends the run: work after it would land in no lap's record, so the model gets no further turn.
      post(line);
      return stop(
        `Recorded as reported for \`${rec.spec}\`: ${fixed.length} reported fixed, ${skipped.length} skipped${open.length ? `, ${open.length} open for the next lap` : ""}. They are not confirmed yet: ${drift ? "the contract needs re-approval first" : "pb runs the checks now, and a fix counts only if they pass"}. This lap is over: make no further changes.`,
      );
    },
  });

  /* --------------------------------- plan -------------------------------- */
  /** Run the test suite in the background; its result is posted into the session when it's done. Returns whether it started (a second plan in the same session shares the one in flight). */

  const FIX_LAPS = 3;
  /** Spec lines a finding's text cites: `spec.md:83`, or a bare `:83` not glued to another file's name (`Foo.java:83`). */
  const citedSpecLines = (text: string): number[] => [...text.matchAll(/(?:\bspec\.md:|(?<![\w./\-\]]):)(\d+)/g)].map((m) => Number(m[1]));

  /** Finish-nudges before a silent lap stops the loop (never retried: a second silent session doubles nothing). */

  const FIX_NUDGES = 2;

  /**
   * The sections a lap may edit beyond what every lap may (Design, and additions to Decisions): the ones its findings
   * filed against the spec point at, by their own line and by each spec line they cite (`spec.md:83`, or a bare `:83`
   * in a spec finding, which can only mean its own file). One stale rule is often stated in several places, and a
   * finding that names them all is fixed in all of them, or it comes back. Decisions listed here means its approved
   * lines may be reworded too. A code finding unlocks nothing, and a line pb can't place in a section unlocks nothing.
   */
  const unlockedSections = (store: Store, spec: string, findings: Finding[]): { specSections?: string[] } => {
    const md = store.readSpec(spec);
    if (!md) return {};
    const keys = findings
      .filter((f) => isSpecFinding(f, spec))
      .flatMap((f) => [...(f.line !== undefined ? [f.line] : []), ...citedSpecLines(`${f.title}\n${f.fix ?? ""}`)])
      .map((line) => sectionKeyAtLine(md, line))
      .filter((k): k is string => !!k && k !== "section:design");
    return keys.length ? { specSections: [...new Set(keys)] } : {};
  };

  /** The entry id of the lap's last answer when Esc cut it short (Pi's own stop reason), else undefined. */
  const abortedAt = (c: ExtensionCommandContext): string | undefined => {
    const last = [...(tree(c).getBranch?.() ?? [])].reverse().find((e) => e.type === "message" && e.message?.role === "assistant");
    return (last?.message as { stopReason?: string } | undefined)?.stopReason === "aborted" ? last?.id : undefined;
  };

  /**
   * One fixes lap: open a fenced session seeded with the remaining findings and wait for its
   * pb_fix_done report. Returns the live lap session for chaining (like reviewNext: a session
   * that opened a new one is stale afterwards) plus the report — or no report when the lap
   * went silent (nudges unanswered) or its session never opened.
   */

  const runFixLap = async (
    ctx: ExtensionCommandContext,
    store: Store,
    spec: string,
    remaining: Finding[],
    lap: number,
    home: string | undefined,
    failure?: string,
    direction?: FixDirection,
  ): Promise<{ live: ExtensionCommandContext; report?: LapReport; ms: number } | undefined> => {
    const started = Date.now();
    const p = store.progress(spec);
    const seed = fixSeedPrompt(spec, remaining, loadSpec(store, spec) ? specRef(store, spec) : "", { base: p?.baseCommit, failure, direction });
    checkpointLap(ctx.cwd, store, spec, lap);
    let live: ExtensionCommandContext | undefined;
    // The lap owns only events appended after its own fix-start marker; `from` is the log
    // position captured right after that marker is written.
    let from = 0;
    // Every lap is a child of the session that ran /pb:fix, named by its lap: /resume lists them apart.
    const result = await ctx.newSession({
      parentSession: home ?? ctx.sessionManager.getSessionFile() ?? undefined,
      setup: async (sm) => {
        sm.appendSessionInfo(`fix: ${spec} · lap ${lap}`);
      },
      withSession: async (c) => {
        const cc = c as ExtensionCommandContext;
        live = cc;
        const lapFile = cc.sessionManager.getSessionFile() ?? undefined;
        if (lapFile) store.saveFixSession(lapFile, { spec, findings: remaining, ...unlockedSections(store, spec, remaining) });
        store.clearDraft(spec); // a fix lap edits the reviewed spec, never a draft refused before it
        store.event(spec, { type: "fix-start", findings: remaining.map((f) => f.title), ...(direction ? { direction: safeBlock(direction.text) } : {}) });
        from = readEvents(path.join(store.specDir(spec), "events.jsonl")).length;
        await c.sendMessage({ customType: "pb-fix", content: seed, display: true }, { triggerTurn: true });
        let nudges = 0;
        let announced: string | undefined;
        for (;;) {
          await cc.waitForIdle();
          if (!lapFile || !store.fixSession(lapFile)) return; // reported
          // Esc stopped the lap: whoever pressed it is here and decides what comes next. A nudge now would make
          // the model report work it hasn't done; the lap waits for them instead, however long that takes.
          const stoppedAt = abortedAt(cc);
          if (stoppedAt) {
            if (announced !== stoppedAt) {
              announced = stoppedAt;
              await c.sendMessage(
                {
                  customType: "pb",
                  content: `**Lap ${lap} paused** — Esc stopped it, and pb is waiting for you. Type \`continue\` to let it carry on, or tell it what to do instead (for example, to report what it has with pb_fix_done).`,
                  display: true,
                },
                { triggerTurn: false },
              );
            }
            await sleep(500);
            continue;
          }
          if (nudges === FIX_NUDGES) return; // silent: the loop escalates
          nudges++;
          await c.sendMessage({ customType: "pb-fix", content: fixNudgePrompt(), display: false }, { triggerTurn: true });
        }
      },
    }).catch(() => ({ cancelled: true as const }));
    if (result.cancelled || !live) return undefined;
    const report = lapReport(readEvents(path.join(store.specDir(spec), "events.jsonl")), from);
    if (!report) return { live, ms: Date.now() - started };
    return { live, ms: Date.now() - started, report };
  };

  /**
   * An undo point before a fix lap: the files and the spec as they were, so /pb:undo takes the lap back like a
   * build task. The lap runs in a session of its own, so the row carries no conversation point.
   */
  const checkpointLap = (cwd: string, store: Store, spec: string, lap: number) => {
    if (!store.config().checkpoints) return;
    const snap = snapshot(cwd, `pb: before ${spec} fix lap ${lap}`);
    const p = store.progress(spec);
    if (!snap || !p) return;
    const rows = store.checkpoints(spec);
    // Rows are looked up by id: a later /pb:fix run's lap 1 must not collide with an earlier one.
    let id = `fix${lap}`;
    for (let n = 2; rows.some((c) => c.id === id); n++) id = `fix${lap}-${n}`;
    const repos = repoSnapshots(cwd, store, spec, `pb: before ${spec} fix lap ${lap}`);
    const row: Checkpoint = { id, at: now(), ...snap, ...(repos.length ? { repos } : {}), head: gitHead(cwd), tasks: structuredClone(p.tasks), task: id, kind: "fix", spec: store.readSpec(spec) ?? "", phase: p.phase, summary: `the fixes in /pb:fix lap ${lap}` };
    if (appendCheckpoint(rows, row)) store.saveCheckpoints(spec, rows);
  };

  /**
   * What pb itself runs after a lap reports, in order: each reproducing test the lap saw fail (it must pass now),
   * then the project's checks — the same ones the build's final step runs (suite or compile, lint, extra checks).
   * The first failure stops it. A lap's report is its own claim; this is the fact.
   */
  const checkAfterLap = async (cwd: string, store: Store, spec: string, lap: number, reds: string[], claimed: string): Promise<{ ok: boolean; ran: string[]; failure?: string }> => {
    const loaded = loadSpec(store, spec);
    const cmds = commands(cwd, store);
    const cfg = cmds.cfg;
    const list = [...new Set([...reds, ...(loaded ? finalCheckCommands(loaded.spec, cmds) : [])])];
    // Said before the checks start, which can take minutes: the lap's own reply is not the end of /pb:fix.
    if (list.length)
      post(
        `**Checking the fixes** — the lap reports ${claimed}; none counts as fixed until these pass: ${list.map((c) => `\`${c}\``).join(", then ")}. The outcome and the next step come in your session when they finish.`,
      );
    const ran: string[] = [];
    for (const command of list) {
      const r = await withChecking(() => runVerify(command, cwd, cfg.verifyTimeoutSec, cfg.testOutputCap));
      ran.push(command);
      store.event(spec, { type: "check", task: "fix", attempt: lap, ok: r.ok !== false, command, notices: [] });
      if (r.ok === false) return { ok: false, ran, failure: `\`${command}\` failed:\n${r.summary}` };
    }
    return { ok: true, ran };
  };

  /**
   * The contract change the laps left, as the diff the human approves: computed once, with the exact text it shows,
   * so an edit made while the question is open is never approved unseen.
   */
  const contractReapproval = (store: Store, spec: string): { md: string; changes: ReturnType<typeof contractChanges> } | undefined => {
    const md = store.readSpec(spec);
    const approved = store.readApprovedSpec(spec);
    if (!md || !approved) return undefined;
    const dropped = removedLines(sectionOf(approved, "Decisions"), sectionOf(md, "Decisions"));
    const changes = contractChanges(approved, md, dropped);
    return changes.diff ? { md, changes } : undefined;
  };

  /**
   * Approve the contract the laps changed, without asking. You picked the spec findings by number, each carrying the
   * text to write, and a lap could edit only the sections they point at: a change confined to those sections is the
   * one you asked for, and a dialog would only hold an unattended run. Anything beyond them (a hand edit made
   * meanwhile, another session's) is not approved here: /pb:build shows it and asks. Approval goes through
   * approveSpec, the build's own path, for exactly the text the diff shows.
   */
  const reapprove = (store: Store, spec: string, shown: { md: string; changes: ReturnType<typeof contractChanges> }, allowed: string[]): { ok: true } | { ok: false; why: string } => {
    const beyond = shown.changes.keys.filter((k) => !allowed.includes(k));
    if (beyond.length) return { ok: false, why: `it also changed ${beyond.map((k) => (k === "header" ? "the header" : `## ${k.replace(/^section:/, "")}`)).join(", ")}, which no spec finding you picked points at` };
    const loaded = loadSpec(store, spec);
    const p = store.progress(spec);
    if (!loaded || !p || specHash(loaded.md) !== specHash(shown.md)) return { ok: false, why: "the spec changed while pb was reading it" };
    approveSpec(store, p, loaded.md, loaded.spec);
    store.saveProgress(p);
    return { ok: true };
  };

  /**
   * Unattended fix loop: lap until every finding is fixed (and pb's checks pass) or skipped-as-spec-revision,
   * up to FIX_LAPS, then come home with the outcome. The report names findings by the numbers the brief shows,
   * so no prose has to be matched back to one. A lap whose fixes leave a check red does not count: the next lap
   * gets the failure, and with no lap left the run stops on it.
   */

  const driveFix = async (ctx: ExtensionCommandContext, store: Store, spec: string, first: Finding[], allOpen: Finding[], direction?: string): Promise<void> => {
    const home = ctx.sessionManager.getSessionFile() ?? undefined;
    // Taken now: each lap replaces the session, and a replaced context must not be read again.
    const cwd = ctx.cwd;
    const numberOf = new Map(allOpen.map((f, i) => [f, i + 1] as const));
    // Read before any lap edits the spec: the findings' line numbers are the reviewed text's.
    const allowed = unlockedSections(store, spec, first).specSections ?? [];
    const specNumbers = first.filter((f) => isSpecFinding(f, spec)).map((f) => numberOf.get(f)!).join(" ");
    const label = (f: Finding) => `#${numberOf.get(f) ?? "?"} ${f.title}`;
    let live: ExtensionCommandContext = ctx;
    let remaining = first;
    const fixed: string[] = [];
    const skipped: string[] = [];
    let laps = 0;
    let ms = 0;
    let silent = false;
    let failure: string | undefined;
    let checked: string[] = [];
    while (remaining.length && laps < FIX_LAPS) {
      laps++;
      // Every lap carries the direction: a later lap fixes what the first left open, under the same instructions.
      const out = await runFixLap(live, store, spec, remaining, laps, home, failure, direction === undefined ? undefined : { text: direction, reviewNumbers: remaining.map((f) => numberOf.get(f) ?? 0) });
      if (!out) return; // its session never opened (cancelled): user is present, nothing to say
      live = out.live;
      ms += out.ms;
      const report = out.report;
      if (!report) {
        silent = true;
        break;
      }
      // The brief numbered `remaining` from 1: the report's numbers index it, never a title match.
      const at = (n: number) => remaining[n - 1];
      const skip = report.skipped.map(at).filter((f): f is Finding => !!f);
      const done = report.fixed.map(at).filter((f): f is Finding => !!f && !skip.includes(f));
      skipped.push(...skip.map(label));
      const claimed = done.length ? `${done.map((f) => `#${numberOf.get(f) ?? "?"}`).join(", ")} fixed` : "nothing fixed";
      const unfinished = report.open.map(at).filter((f): f is Finding => !!f);
      const ids = (fs: Finding[]) => fs.map((f) => `#${numberOf.get(f) ?? "?"}`).join(", ");
      const check = await checkAfterLap(cwd, store, spec, laps, report.reds, `${claimed}${skip.length ? `, ${ids(skip)} skipped` : ""}${unfinished.length ? `, ${ids(unfinished)} not finished (the next lap takes ${unfinished.length === 1 ? "it" : "them"})` : ""}`);
      checked = check.ran;
      if (!check.ok) {
        // Fixes that leave a check red are not fixes yet: they stay open for the next lap, with the failure.
        failure = check.failure;
        remaining = remaining.filter((f) => !skip.includes(f));
        continue;
      }
      failure = undefined;
      fixed.push(...done.map(label));
      remaining = remaining.filter((f) => !skip.includes(f) && !done.includes(f));
    }
    const open = remaining.map(label);
    const ids = remaining.flatMap((f) => (numberOf.has(f) ? [numberOf.get(f)!] : [])).join(" ");
    // Cap the lists: a long title per finding makes the evidence line a wall, and /pb:status has the detail.
    const list = (items: string[]) => (items.length <= 6 ? items.join(", ") : `${items.slice(0, 6).join(", ")}, +${items.length - 6} more`);
    // The fix may have revised the approved contract. Review judges the code against that
    // contract, so it cannot run until the human has re-approved whatever stands now.
    const drift = (() => {
      const p = store.progress(spec);
      return p ? approvalDrift(store, p) : undefined;
    })();
    const time = ms ? duration(ms) : "";
    // The title says what became of each finding, by its review number: "fixed" only once pb's checks passed.
    const numbers = (labels: string[]) => labels.map((l) => l.split(" ")[0]).join(", ");
    const outcome = [
      fixed.length ? `${numbers(fixed)} fixed${checked.length && !failure ? ", checks passed" : ""}` : "nothing fixed",
      skipped.length ? `${numbers(skipped)} skipped` : "",
      open.length ? `${numbers(open)} still open` : "",
    ];
    const lapCount = `${laps} lap${laps === 1 ? "" : "s"}`;
    const header = silent
      ? phaseHeader("❌", "Fixes stopped", spec, "no report", ...outcome, time)
      : failure
        ? phaseHeader("❌", "Fixes stopped", spec, "check failed", ...outcome, lapCount, time)
        : phaseHeader(open.length ? "❌" : "✅", open.length ? "Fixes stopped" : "Fixes complete", spec, ...outcome, lapCount, time);
    // A contract the laps changed is re-approved from its diff when the session the run ends in can ask; headless,
    // /pb:build does it. The summary says which, so it is built once that is known.
    const summaryFor = (reapproval?: ReturnType<typeof contractReapproval>, approval?: ReturnType<typeof reapprove>): string => {
      const approved = approval?.ok === true;
      const reviewStep = !drift || approved
        ? `\`/${cmd("review")}\` checks the delta.`
        : drift
          ? `\`/${cmd("build")} ${spec}\` re-approves the ${drift === "missing" ? "spec as it stands (its approved copy is missing or changed)" : "revised contract (the fix changed it)"}, then \`/${cmd("review")}\` can check the delta.`
          : "";
      const next = open.length
        ? `\`/${cmd("fix")}${ids ? ` ${ids}` : ""}\` (or fix them by hand), then ${reviewStep}`
        : skipped.length
          ? `revise the spec with \`/${cmd("spec")}\` for the skipped findings (or fix them by hand), then ${reviewStep}`
          : reviewStep;
      return [
        header,
        "",
        nextLine(next),
        evidenceLine(
          `fixed ${list(fixed) || "none"}`,
          skipped.length ? `skipped as needing a spec revision: ${list(skipped)}` : "",
          open.length ? `still open: ${list(open)}` : "",
          silent ? `no report after ${FIX_NUDGES} nudges` : "",
          !silent && checked.length && !failure ? `pb's checks passed: ${checked.map((c) => `\`${c}\``).join(", ")}` : "",
          !silent && !checked.length && !failure ? "no checks configured for this spec" : "",
        ),
        ...(failure ? ["", `**pb's check after the last lap failed**, so its fixes don't count yet:`, "", failure] : []),
        ...(reapproval && approval?.ok
          ? [
              "",
              `**Spec updated and re-approved: ${reapproval.changes.summary}.** These are the edits the spec findings you picked asked for, and the lap could change nothing else in the contract; the review judges the code against them:`,
              "",
              reapproval.changes.diff,
              "",
              "**If you don't agree with them:**",
              `- The wording only: \`/${cmd("fix")} ${spec} ${specNumbers || "<n>"} <how to word it>\` runs a short lap on the same finding${specNumbers.includes(" ") ? "s" : ""}; your text binds over the Fix, and the result is re-approved the same way.`,
              `- The whole fix run: \`/${cmd("undo")}\` puts back the spec and the code as they were before a lap.`,
              `- Anything else in the contract: edit it, then \`/${cmd("build")} ${spec}\` shows the change and re-approves it.`,
            ]
          : reapproval && approval && !approval.ok
            ? ["", `**The fix changed the approved contract, and pb did not approve it**: ${approval.why}. \`/${cmd("build")} ${spec}\` shows the change and re-approves it before \`/${cmd("review")}\` can run:`, "", reapproval.changes.diff]
            : drift
              ? ["", `**The fix changed the approved contract.** \`/${cmd("build")} ${spec}\` must re-approve it before \`/${cmd("review")}\` can run.`]
              : []),
        // Variants of the next step; a contract still waiting for approval has one move, already named above.
        ...(drift && !approved ? [] : ["", tip("fix.done", { spec, ...(open.length && ids ? { ids } : {}) })]),
      ].join("\n");
    };
    // The follow-up review is the next step whenever nothing is left open: offer it rather than leave it to memory.
    // A contract change still waiting for approval comes first; the review is offered once it is approved.
    const reviewable = !silent && !failure && !open.length;
    // The end of /pb:fix is the moment the human has walked away from: the summary alone goes unseen. A complete
    // run asks whether to review, and that question notifies with the outcome; a stopped one notifies here.
    const outcomeText = outcome.filter(Boolean).join(", ");
    const stopped = () => store.config().notify && notifyDesktop("pb: fixes stopped", `${spec}: ${outcomeText}`);
    try {
      if (!home) throw new Error("no home session");
      await live.switchSession(home, {
        withSession: async (c) => {
          // Headless, nothing is approved unseen: /pb:build does it, as before.
          const reapproval = drift === "changed" && c.hasUI ? contractReapproval(store, spec) : undefined;
          const approval = reapproval ? reapprove(store, spec, reapproval, allowed) : undefined;
          await c.sendMessage({ customType: "pb", content: summaryFor(reapproval, approval), display: true }, { triggerTurn: false });
          if (!reviewable || (drift && !approval?.ok)) return void stopped();
          // Like a finished build's offer: with nobody there, the review starts itself after reviewAfterBuildSec,
          // dispatched as the command you would type. It can't change your files, so starting unasked costs only time.
          const waitSec = store.config().reviewAfterBuildSec;
          const auto = waitSec > 0 && c.hasUI;
          const NOW = "Review the fixes now";
          const LATER = "Later";
          const title = `Fixes for ${spec} are done: ${outcomeText}. Review them now?${auto ? ` With no answer, pb starts the review in ${duration(waitSec * 1000)}.` : ""}`;
          if ((await choose(c, store, title, [NOW, LATER], auto ? NOW : LATER, undefined, auto ? waitSec : undefined)) !== NOW) return;
          if (auto) {
            void Promise.resolve(c.sendUserMessage(`/${cmd("review")} ${spec}`, { expandPromptTemplates: true })).catch(() => undefined);
            return;
          }
          c.ui.setEditorText(`/${cmd("review")} ${spec}`);
          c.ui.notify(`Press Enter to review ${spec}: the follow-up looks at the previous findings and what changed since.`, "info");
        },
      });
    } catch {
      // Home is gone: the summary still lands in the spec's events for the next session to find.
      stopped();
      store.event(spec, { type: "fix-summary", summary: summaryFor(), ms });
    }
  };

  pi.registerCommand(cmd("fix"), {
    description: "Fix review findings in a fresh fenced session: /pb:fix [spec] [finding ids] [direction]. No ids = all open findings: P0-P2, and any finding filed against the spec (a P3 in the code is never open: fix it by hand). A spec finding is fixed in the spec, and pb re-approves that edit, posting its diff. Text after the ids directs the fixes: it binds where it differs from a finding's Fix, and the rest take their Fix as written. Run /pb:review afterwards: it checks only those findings and what changed",
    getArgumentCompletions: fixCompletions,
    handler: async (args, ctx) => {
      const store = new Store(ctx.cwd);
      const session = ctx.sessionManager.getSessionFile();
      const text = args.trim();
      const first = text.split(/\s+/, 1)[0] ?? "";
      // Spec: named, else this session's. Findings and direction: read off the rest (parseFixRequest).
      let name = first && KEBAB_NAME.test(first) && store.readSpec(first) ? first : undefined;
      const rest = name ? text.slice(first.length) : text;
      if (!name) name = specOfSession(ctx).name;
      if (!name && session) {
        // A planning session that wrote the spec but never built it: its writtenIn names it.
        const mine = store.specNames().filter((n) => store.progress(n)?.writtenIn === session);
        if (mine.length === 1) name = mine[0];
        else if (mine.length > 1) return ctx.ui.notify(`Several specs here (${mine.join(", ")}): name one: \`/${cmd("fix")} <spec> [ids].`, "warning");
      }
      if (!name) return ctx.ui.notify(`No spec here: run /${cmd("fix")} from a build or review session, or name a spec.`, "warning");
      const open = store.progress(name)?.review?.findings ?? [];
      if (!open.length) return ctx.ui.notify(`\`${name}\` has no open review findings to fix.`, "info");
      const request = parseFixRequest(rest, open);
      if ("misses" in request) {
        return ctx.ui.notify(
          `No such finding${request.misses.length === 1 ? "" : "s"}: ${request.misses.join(", ")}. \`/pb:fix\` takes the numbered ids (a P3 in the code is never open: fix it by hand). Open findings for \`${name}\`:${open.map((f, i) => `\n${i + 1}. ${f.title}`).join("")}`,
          "warning",
        );
      }
      if (request.direction && request.direction.length > MAX_FIX_DIRECTION_CHARS) {
        return ctx.ui.notify(
          `The direction is ${request.direction.length} characters; a fix run takes at most ${MAX_FIX_DIRECTION_CHARS}. Shorten it to the instructions that differ from the findings' Fix lines.`,
          "warning",
        );
      }
      if (!ctx.isIdle()) return ctx.ui.notify("Pi is busy. Wait for the current turn to finish.", "warning");
      const cctx = ctx as ExtensionCommandContext;
      if (typeof cctx.newSession !== "function") return ctx.ui.notify("This Pi can't open sessions: fix the findings here instead.", "warning");
      await driveFix(cctx, store, name!, request.picked, open, request.direction);
    },
  });

  /* -------------------------------- stats -------------------------------- */
}
