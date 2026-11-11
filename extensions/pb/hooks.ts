/** Pi's event hooks: session lifecycle, compaction, and the planning protections. */
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext
} from "@earendil-works/pi-coding-agent";
import { changedPaths, cleanupIndexes, snapshot } from "./checkpoint.ts";
import { PLANNER_ROLE, PLANNER_SECTION, checkpointPrompt, checkpointSummary, extraBlock, reviewStateSummary, nudgePrompt } from "./prompts.ts";
import { tokensOf } from "./spec.ts";
import { Store, now } from "./store.ts";
import { COMPACT_STALL_LIMIT, REPAIR_SESSION_TOOLS, REVIEW_SESSION_TOOLS, checkpointQuiet, checkpointing, cmd, compactStalls, contentText, findModel, instruct, liveBuildOfSession, longCommandSec, longCommands, pauseBuild, pruneSession, refreshWhere, rememberStall, resetLimit, runtime, specOfSession, tree } from "./kit.ts";
import { whereHere } from "./next.ts";
import { TIMED_OUT, commandCap, isLongCommand, remoteWriteRefusal, timeoutNote } from "./command-guard.ts";
import { siblingRepoOf } from "./repos.ts";
import { unfinishedPhase } from "./phase.ts";
import { buildResetDue, stateSummary } from "./flow.ts";

export function registerHooks(pi: ExtensionAPI) {
  /**
   * A path in every spelling: resolved through symlinks (and other names for the same directory,
   * such as macOS's /tmp vs /private/tmp), falling back to the real parent for a file that does
   * not exist yet, and to the path as given when nothing resolves. Guards compare both the raw
   * and the real form so a target cannot slip a block by being spelled another way.
   */
  const realPath = (p: string): string => {
    try {
      return fs.realpathSync(p);
    } catch {}
    try {
      return path.join(fs.realpathSync(path.dirname(p)), path.basename(p)); // a file that does not exist yet
    } catch {}
    return p;
  };
  /** `target` is `dir` itself or below it. */
  const under = (target: string, dir: string) => target === dir || target.startsWith(dir + path.sep);

  // The planner's role is a system-prompt section on every turn of a planning session, not a paragraph
  // of its first message: it holds through a long discussion and a checkpoint reset, and leaves with
  // planning. Pi patches only a changed section, so the cached prefix survives.
  pi.on("before_agent_start", (e, ctx) => {
    const sections = e.systemPromptOptions.sections;
    const session = ctx.sessionManager.getSessionFile();
    const store = new Store(ctx.cwd);
    if (session && store.planningSessions().includes(session)) sections[PLANNER_SECTION] = PLANNER_ROLE + extraBlock(store.extra("plan"));
    else delete sections[PLANNER_SECTION];
  });

  /** which limit governs each shell call in flight, so a timeout names the one that fired */
  const shellLimitKeys = new Map<string, string>();

  // A command stopped at its limit says which limit and how to raise it, instead of a bare "timed out".
  pi.on("tool_result", (ev, ctx) => {
    if (ev.toolName !== "bash" && ev.toolName !== "powershell") return;
    const key = shellLimitKeys.get(ev.toolCallId) ?? "commandTimeoutSec";
    shellLimitKeys.delete(ev.toolCallId);
    if (!TIMED_OUT.test(ev.content.map((c) => (c.type === "text" ? c.text : "")).join(""))) return;
    return { content: [...ev.content, { type: "text" as const, text: `\n${timeoutNote(key, new Store(ctx.cwd).rel("config.json"))}` }] };
  });

  pi.on("tool_call", (e, ctx) => {
    const ev = e as { toolName: string; toolCallId?: string; input: { path?: string; command?: string; timeout?: unknown } };
    const session = ctx.sessionManager.getSessionFile();
    const store = new Store(ctx.cwd);
    // Pi's shell tools have no default timeout, so one unbounded command (a probe loop, a hung
    // install) holds the session for hours. pb caps every shell call before Pi runs it: a shorter
    // timeout the model asked for stays, a longer one is clamped, and 0 turns the cap off. The project's
    // own long commands (suite, compile, lint, Test: lines) get the long limit, never a shorter one.
    if (ev.toolName === "bash" || ev.toolName === "powershell") {
      const cfg = store.config();
      const command = String(ev.input.command ?? "");
      const longs = longCommands(ctx.cwd, store);
      const long = isLongCommand(command, longs);
      const cap = commandCap({ command, asked: typeof ev.input.timeout === "number" ? ev.input.timeout : undefined, shellSec: cfg.commandTimeoutSec, longSec: longCommandSec(cfg), longCommands: longs });
      if (cap !== undefined) ev.input.timeout = cap;
      if (ev.toolCallId) shellLimitKeys.set(ev.toolCallId, long && cfg.verifyTimeoutSec > cfg.commandTimeoutSec ? "verifyTimeoutSec" : "commandTimeoutSec");
    }
    // The review session's tool set is the allowlist itself, not a hope that Pi's active-tool
    // state matches it: a late-connecting MCP server registers its tools after session_start and
    // they activate on registration (or on resume), so anything off the list is blocked.
    if (session && store.reviewSession(session)) {
      if (!REVIEW_SESSION_TOOLS.includes(ev.toolName))
        return { block: true, reason: "This is a review session: read-only. Report what should change with pb_report_findings." };
      return;
    }
    // A repair lap gets the spec's pen, nothing else: read, probe through pb_try (itself read-only),
    // ask, and write the one spec with the spec tools. A lap that could edit the project or run a
    // shell is a build without its gates.
    if (session) {
      const repair = store.fixOfSession(session);
      if (repair && !REPAIR_SESSION_TOOLS.includes(ev.toolName))
        return {
          block: true,
          reason: `A repair lap for ${repair.name} is open in this session: read and probe with pb_try, ask with pb_ask, and change only that spec through pb_write_spec or pb_update_spec. Stop the project edits and report the lap with pb_spec_fix_done.`,
        };
    }
    // Planning changes nothing outside this machine either: a shell command that writes to a database, a cluster,
    // a cloud or an API is refused, as in a probe (the same rule, command-guard.ts). Reads stay allowed.
    if ((ev.toolName === "bash" || ev.toolName === "powershell") && session && store.planningSessions().includes(session)) {
      const refused = remoteWriteRefusal(String(ev.input.command ?? ""));
      if (refused)
        return {
          block: true,
          reason: `Planning mode changes nothing — not the project, and not a system outside this machine — and this looks like ${refused}. Reads are fine; a change like this belongs in the build, or is the human's to run.`,
        };
    }
    if (ev.toolName !== "edit" && ev.toolName !== "write") return;
    const building = liveBuildOfSession(ctx, store);
    if (building) {
      const specs = path.join(ctx.cwd, ".pi", "pb", "specs");
      const target = path.resolve(ctx.cwd, ev.input.path ?? "");
      // Both spellings count: a symlink under .pi (e.g. specs-link -> pb/specs) must not read as
      // an unrelated path and reach the approved spec the build may not rewrite.
      if (under(target, specs) || under(realPath(target), realPath(specs)))
        return {
          block: true,
          reason: `The build of ${building.spec} is running: its approved spec is read-only. Record a shape in Design or a decision in Decisions with pb_update_spec; if the contract itself must change, stop the task with pb_task_done status blocked, then revise it and /${cmd("build")} re-approves the revision.`,
        };
    }
    if (!session || !store.planningSessions().includes(session)) return;
    // Either pairing counts as inside: the raw one covers relative paths whose target may not
    // exist yet, the resolved one covers a different spelling of the same directory.
    const inside = (target: string, cwd: string) => target !== cwd && under(target, cwd);
    const target = path.resolve(ctx.cwd, ev.input.path ?? "");
    // A sibling repository (a frontend beside its backend) is the change's too: planning leaves it untouched as well.
    const sibling = siblingRepoOf(ctx.cwd, target);
    if (!sibling && !inside(realPath(target), realPath(ctx.cwd)) && !inside(target, ctx.cwd)) return; // outside every repository: scratch files are fine
    return {
      block: true,
      reason: `Planning mode: ${sibling ? `the sibling repository ${path.basename(sibling)}` : "the project's files"} stay${sibling ? "s" : ""} untouched until /${cmd("build")}. Put scratch files outside every repository (e.g. in a mktemp -d directory), or say what you would change.`,
    };
  });

  /* --------------------------------- spec -------------------------------- */

  pi.on("session_start", async (e, ctx) => {
    const store = new Store(ctx.cwd);
    const session = ctx.sessionManager.getSessionFile();
    const ev = e as { reason?: string; previousSessionFile?: string };
    const carry = ev.reason === "new" ? store.takeCarry(ev.previousSessionFile) : undefined;
    if (carry?.review && session) store.saveReviewSession(session, carry.review);
    // A review session's model reads and reports only; everywhere else pb_report_findings isn't offered.
    const active = pi.getActiveTools();
    if (store.reviewSession(session)) {
      pi.setActiveTools(REVIEW_SESSION_TOOLS);
      if (store.reviewRunForSession(session)?.interrupted?.session === session) ctx.ui.notify(`This review was interrupted: \`/${cmd("review")} continue\` picks it up where it was.`, "info");
    }
    else if (active.includes("pb_report_findings")) pi.setActiveTools(active.filter((t) => t !== "pb_report_findings"));
    refreshWhere(ctx);
    // Starting Pi on work in progress: say once where it stands and what's next. Only at startup: pb's own
    // session switches (back from a review or a fix lap) arrive as "resume" and post their own result, and
    // the footer already carries the same line everywhere else.
    if (ev.reason === "startup" && ctx.hasUI && !store.reviewSession(session) && !store.fixSession(session)) {
      const where = whereHere(store, session ?? undefined);
      if (where?.spec) ctx.ui.notify(`pb · ${where.spec}: ${where.state} — next: ${where.next}${where.command ? ` (alt+n puts \`${where.command}\` in the editor)` : ""}.`, "info");
    }
    // A mistyped or invalid setting falls back to its default without a word otherwise: say so once, at startup.
    if (ev.reason === "startup" && ctx.hasUI) {
      const problems = store.configProblems();
      if (problems.length) ctx.ui.notify(`pb config — these settings are ignored or replaced:\n${problems.map((x) => `- ${x}`).join("\n")}`, "warning");
    }
    if (!carry) return;
    if (carry.model) {
      const model = findModel(ctx, carry.model);
      if (model) await pi.setModel(model as Parameters<typeof pi.setModel>[0]);
    }
    if (carry.thinking) pi.setThinkingLevel(carry.thinking as Parameters<typeof pi.setThinkingLevel>[0]);
  });

  // Like a stop hook: an agent that ends its run mid-task gets one reminder per attempt before the build pauses.

  pi.on("agent_before_settle", (e, ctx) => {
    if ((e as { outcome?: string }).outcome !== "completed") return;
    const { store, progress: p } = specOfSession(ctx);
    if (!p || p.phase !== "building" || !p.current) return;
    const key = `${p.current}#${p.tasks.find((t) => t.id === p.current)?.attempts ?? 0}`;
    if (p.nudged === key) return;
    p.nudged = key;
    store.saveProgress(p);
    store.event(p.spec, { type: "nudge", task: p.current });
    return { entries: [{ type: "custom_message" as const, customType: "pb-instruction", content: nudgePrompt(p.current), display: false }], continue: true };
  });

  /*
   * The planning checkpoint. Past checkpointAt (and always before Pi would compact), the model writes the
   * plan to its spec while it still has the whole discussion; at the end of that run pb resets the session
   * to the spec: a compaction whose summary is the spec, keeping nothing else. No summarizing model call,
   * and the spec is the smarter summary: what was found, decided and rejected, and what is still open.
   */

  const lastExchange = (ctx: ExtensionContext) => {
    const branch = tree(ctx).getBranch?.() ?? [];
    let human: string | undefined;
    let answer: string | undefined;
    for (let i = branch.length - 1; i >= 0 && !human; i--) {
      const e = branch[i];
      if (e.type !== "message") continue;
      const t = contentText(e.message?.content).trim();
      if (!t) continue;
      if (e.message?.role === "assistant" && !answer) answer = t;
      else if (e.message?.role === "user") human = t;
    }
    return { human, answer };
  };

  /** Ask for the checkpoint now: the spec is written in this run, and the reset follows when it settles. */

  const requestCheckpoint = (ctx: ExtensionContext, store: Store, session: string, manual = false) => {
    const usage = ctx.getContextUsage();
    const percent = usage?.tokens != null ? Math.round((100 * usage.tokens) / usage.contextWindow) : Math.round(usage?.percent ?? 0);
    checkpointing.set(session, { since: now(), percent, last: lastExchange(ctx), ...(manual ? { manual: true } : {}) });
    return checkpointPrompt(percent, store.specsOfPlanning(session));
  };

  pi.registerCommand(cmd("compact"), {
    description:
      "pb's compaction. Planning: write the plan to its spec, then reset the session to it (e.g. before quitting). Build: compact to the build's state, no summarizing model call",
    handler: async (_args, ctx) => {
      if (!ctx.isIdle()) return ctx.ui.notify("Pi is busy. Wait for the current turn to finish.", "warning");
      const store = new Store(ctx.cwd);
      const session = ctx.sessionManager.getSessionFile();
      const build = specOfSession(ctx).progress;
      if (session && build && unfinishedPhase(build.phase)) {
        // A build: Pi compacts, with the summary pb writes from the build's state (session_before_compact).
        return ctx.compact({
          onComplete: () => ctx.ui.notify("Compacted to the build's state: tasks, the current task and what it changed, the spec.", "info"),
          onError: (e) => ctx.ui.notify(`Compaction failed: ${e.message}`, "error"),
        });
      }
      if (!session || !store.planningSessions().includes(session))
        return ctx.ui.notify(`/${cmd("compact")} is for planning and build sessions; elsewhere, Pi's /compact.`, "warning");
      return instruct(`▶ /${cmd("compact")} — writing the plan to its spec, then resetting to it`, requestCheckpoint(ctx, store, session, true));
    },
  });

  pi.on("agent_before_settle", (e, ctx) => {
    if ((e as { outcome?: string }).outcome !== "completed") return;
    const session = ctx.sessionManager.getSessionFile();
    if (!session) return;
    const store = new Store(ctx.cwd);
    if (!store.planningSessions().includes(session)) return;
    const cfg = store.config();
    const usage = ctx.getContextUsage();
    const pending = checkpointing.get(session);
    if (pending) {
      checkpointing.delete(session);
      const planned = store.specsOfPlanning(session);
      // A manual /pb:compact asks for the reset, not for a write: a spec that is already
      // current (nothing left to change, so no write happened since the request) counts as
      // written, or the command could never succeed — every retry stamped a later `since`.
      const current = !!pending.manual && planned.length > 0 && planned.every((n) => (store.readSpec(n) ?? "").trim());
      if (!planned.some((n) => (store.progress(n)?.updatedAt ?? "") >= pending.since) && !current) {
        checkpointQuiet.set(session, usage?.tokens ?? 0);
        return { entries: [{ type: "custom_message" as const, customType: "pb", content: "pb: the plan wasn't written to a spec, so the conversation goes on as it is (Pi compacts it when it's full).", display: true }] };
      }
      const specs = planned.map((n) => ({ name: n, markdown: store.readSpec(n) ?? "" }));
      for (const n of planned) store.event(n, { type: "checkpoint", tokensBefore: usage?.tokens, percent: pending.percent });
      return {
        entries: [
          { type: "compaction" as const, summary: checkpointSummary(specs, pending.last, store.planning(session)?.request), firstKeptEntryId: null, details: { pb: "checkpoint", specs: planned } },
          {
            type: "custom_message" as const,
            customType: "pb",
            content: `**Plan checkpointed** to ${planned.map((n) => store.rel("specs", n, "spec.md")).join(", ")}: the conversation was reset to it (it was ${pending.percent}% full). Carry on; \`/${cmd("build")}\` when ready.`,
            display: true,
          },
        ],
      };
    }
    if (!cfg.checkpointAt || !usage || usage.tokens == null) return;
    const specTokens = store.specsOfPlanning(session).reduce((n, name) => n + tokensOf(store.readSpec(name) ?? ""), 0);
    // A planning reset writes the spec itself, so its room is the whole spec's, not a view of it.
    const limit = Math.min((usage.contextWindow * cfg.checkpointAt) / 100, resetLimit(usage.contextWindow, specTokens));
    if (usage.tokens < limit) return;
    const quietUntil = checkpointQuiet.get(session);
    if (quietUntil !== undefined && usage.tokens < quietUntil + usage.contextWindow * 0.05) return; // don't insist every turn
    return { entries: [{ type: "custom_message" as const, customType: "pb-instruction", content: requestCheckpoint(ctx, store, session), display: false }], continue: true };
  });

  /** The last planning change set posted per session, so a note is not repeated on every settle. */

  // A turn or a run that ends may have moved the spec (a task done, a lap reported): the footer follows.
  pi.on("agent_settled", (_e, ctx) => refreshWhere(ctx));

  // While a dialog waits on you, the footer says so — seen from another window or pane, "running" and
  // "waiting for you" look the same otherwise. The prompt's end puts the next step back.
  pi.on("ui_prompt_start", (e, ctx) => {
    if (!ctx.hasUI) return;
    const title = String((e as { title?: unknown }).title ?? "").split("\n")[0].slice(0, 80);
    try {
      ctx.ui.setStatus("pb", `pb · waiting for your answer${title ? `: ${title}` : ""}`);
    } catch {
      // the session was replaced: nothing to draw on
    }
  });
  pi.on("ui_prompt_end", (_e, ctx) => refreshWhere(ctx));

  pi.on("turn_end", (_e, ctx) => {
    refreshWhere(ctx);
    const { store, name, progress: p } = specOfSession(ctx);
    const wasBoundary = runtime.boundary;
    runtime.boundary = false;
    if (!name || !p) return;
    const leaf = tree(ctx).getLeafId?.() ?? undefined;
    const cps = store.checkpoints(name);
    let changed = false;
    // A reset in the last turn: the task it handed out starts at that reset (undo goes back to it).
    const branch = tree(ctx).getBranch?.() ?? [];
    const lastReset = [...branch].reverse().find((x) => x.type === "compaction")?.id;
    for (const c of cps.filter((c) => c.pendingReset)) {
      if (!lastReset) continue; // no reset happened: keep pending for the next turn
      c.entry = lastReset;
      delete c.pendingReset;
      changed = true;
    }
    for (const c of cps.filter((c) => c.pendingEntry)) {
      c.entry = leaf;
      delete c.pendingEntry;
      changed = true;
    }
    if (changed) store.saveCheckpoints(name, cps);

    if (!wasBoundary || p.phase !== "building" || !p.current) return;
    const due = buildResetDue(ctx, store);
    if (!due) return;
    const cp = cps.find((c) => c.id === p.current);
    if (cp) {
      cp.pendingReset = true;
      store.saveCheckpoints(name, cps);
    }
    const when = due.percent === undefined ? "" : ` (it was ${due.percent}% full)`;
    store.event(name, { type: "reset", task: p.current, ...(due.percent === undefined ? {} : { percent: due.percent }) });
    return {
      entries: [
        { type: "compaction" as const, summary: stateSummary(ctx, store, p, "reset"), firstKeptEntryId: null, details: { pb: "build-reset", task: p.current } },
        { type: "custom_message" as const, customType: "pb", content: `**Context reset** before ${p.current}${when}: the build goes on from its state and the spec.`, display: true },
      ],
    };
  });

  // Stats: every model turn in a build session, with its tokens and cache use.

  pi.on("message_end", (e, ctx) => {
    const m = (e as { message?: { role?: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } } } }).message;
    if (m?.role !== "assistant" || !m.usage) return;
    const review = new Store(ctx.cwd).reviewSession(ctx.sessionManager.getSessionFile());
    if (review) {
      // A review session's turns count as the review's cost, for the spec it reviews.
      const u = m.usage;
      if (review.spec) new Store(ctx.cwd).event(review.spec, { type: "review-usage", role: review.role, input: u.input ?? 0, output: u.output ?? 0, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0, cost: u.cost?.total ?? 0 });
      return;
    }
    const { store, name, progress } = specOfSession(ctx);
    if (!name || !progress) return;
    const u = m.usage;
    store.event(name, {
      type: "usage",
      task: progress.current ?? "chat",
      input: u.input ?? 0,
      output: u.output ?? 0,
      cacheRead: u.cacheRead ?? 0,
      cacheWrite: u.cacheWrite ?? 0,
      cost: u.cost?.total ?? 0,
      window: (ctx.model as { contextWindow?: number } | undefined)?.contextWindow,
    });
  });

  /*
   * Compaction without another model call. A build session: the summary comes from the build's state.
   * A planning session with a spec: the spec is the summary (normally the checkpoint below resets the
   * session before Pi compacts; this covers a single turn that overshoots). Anywhere else Pi summarizes,
   * and the specs this session wrote are no longer in its context word for word.
   */

  pi.on("session_before_compact", (e, ctx) => {
    const { store, name, progress: p } = specOfSession(ctx);
    const ev = e as { preparation: { firstKeptEntryId: string; tokensBefore: number; previousSummary?: string }; reason?: string };
    if (!name || !p || !unfinishedPhase(p.phase)) {
      const session = ctx.sessionManager.getSessionFile();
      const review = store.reviewSession(session);
      const run = review ? store.reviewRunForSession(session) : undefined;
      if (review && run) {
        // A review session: reset to its role, the brief verbatim, the findings so far, and the
        // files read — plus a wrap-up directive when compactions repeat with nothing new read.
        const ops = (ev.preparation as { fileOps?: { read?: Iterable<string>; edited?: Iterable<string>; written?: Iterable<string> } }).fileOps;
        const read = ops?.read ? [...ops.read] : undefined;
        const tokens = ev.preparation.tokensBefore;
        // Findings and acceptance results reported between two compactions are progress too: the end
        // of a review is reading done, writing results and running checks, which reads nothing new.
        const findings = [...run.passes.flatMap((x) => x.findings), ...(review.findings ?? [])].length;
        const acceptance = [...run.passes.flatMap((x) => x.acceptance ?? []), ...(review.acceptance ?? [])];
        const checks = acceptance.length;
        const prev = session ? compactStalls.get(session) : undefined;
        const progressed =
          !prev || (read?.some((f) => !prev.read.includes(f)) ?? false) || findings > (prev.findings ?? 0) || checks > (prev.checks ?? 0) || tokens < prev.tokens;
        const strikes = progressed ? 0 : (prev?.strikes ?? 0) + 1;
        if (session) rememberStall(session, { task: `review:${review.role}`, changed: [], read: read ?? [], tokens, strikes, findings, checks });
        const wrapUp = strikes >= COMPACT_STALL_LIMIT;
        if (run.name) store.event(run.name, { type: "compact", reason: ev.reason, tokensBefore: ev.preparation.tokensBefore, review: review.role, ...(run.id ? { run: run.id } : {}), ...(wrapUp ? { thrash: true } : {}) });
        return {
          compaction: {
            summary: reviewStateSummary({
              label: run.label,
              role: review.role,
              brief: run.brief,
              findings: [...run.passes.flatMap((x) => x.findings), ...(review.findings ?? [])],
              acceptance,
              read,
              wrapUp,
            }),
            firstKeptEntryId: ev.preparation.firstKeptEntryId,
            tokensBefore: ev.preparation.tokensBefore,
          },
        };
      }
      const planned = session ? store.specsOfPlanning(session) : [];
      if (session && planned.length && store.planningSessions().includes(session)) {
        for (const n of planned) store.event(n, { type: "compact", reason: ev.reason, tokensBefore: ev.preparation.tokensBefore, planning: true });
        return {
          compaction: {
            summary: checkpointSummary(planned.map((n) => ({ name: n, markdown: store.readSpec(n) ?? "" })), undefined, store.planning(session)?.request),
            firstKeptEntryId: ev.preparation.firstKeptEntryId,
            tokensBefore: ev.preparation.tokensBefore,
          },
        };
      }
      return;
    }
    store.event(name, { type: "compact", reason: ev.reason, tokensBefore: ev.preparation.tokensBefore, task: p.current });
    // What the current task has done so far, from git: the files it changed since its undo point.
    const cp = store.checkpoints(name).find((c) => c.id === p.current);
    const now_ = cp ? snapshot(ctx.cwd, `pb: compaction during ${p.current}`) : undefined;
    const changed = cp && now_ ? changedPaths(ctx.cwd, cp.commit, now_.commit) : undefined;
    const ops = (ev.preparation as { fileOps?: { read?: Iterable<string>; edited?: Iterable<string>; written?: Iterable<string> } }).fileOps;
    const read = ops?.read ? [...ops.read].filter((f) => !changed?.includes(f)) : undefined;
    // The thrash guard: compacting the same task over and over with nothing new changed, read, or
    // shrunk is stuck, not long (a giant output refilling the context, or a loop). Pause with the
    // likely causes instead of compacting forever; any one sign of progress resets the count.
    const session = ctx.sessionManager.getSessionFile();
    const tokens = ev.preparation.tokensBefore;
    const prev = session ? compactStalls.get(session) : undefined;
    const progressed =
      !prev || prev.task !== p.current || (changed?.some((f) => !prev.changed.includes(f)) ?? false) || (read?.some((f) => !prev.read.includes(f)) ?? false) || tokens < prev.tokens;
    const strikes = progressed ? 0 : (prev?.strikes ?? 0) + 1;
    if (session) rememberStall(session, { task: p.current, changed: changed ?? [], read: read ?? [], tokens, strikes });
    if (strikes >= COMPACT_STALL_LIMIT && p.phase === "building") {
      pauseBuild(
        ctx,
        store,
        p,
        `compacted ${strikes} times during ${p.current ?? "the build"} without getting anywhere (no new files read or changed, context not shrinking). Something is stuck: one giant tool output refilling the context (a verbose Test: command? \`testOutputCap\` trims to ${store.config().testOutputCap} chars), an oversized spec, or the task looping. Look at the session, then /${cmd("build")} to go on, /${cmd("undo")} ${p.current ?? "start"} to throw it away, or /${cmd("spec")} ${p.spec} to split the task.`,
        "build.paused",
        "thrash",
      );
      // The pause is the whole answer: a compaction here would hand the model a step prompt for a
      // build the harness now refuses to continue. A resume starts the guard over.
      if (session) compactStalls.delete(session);
      return { cancel: true };
    }
    return {
      compaction: {
        summary: stateSummary(ctx, store, p, "compaction", { changed, read, previous: ev.preparation.previousSummary }),
        firstKeptEntryId: ev.preparation.firstKeptEntryId,
        tokensBefore: ev.preparation.tokensBefore,
      },
    };
  });

  pi.on("session_before_tree", () => (runtime.undoSummary ? { summary: { summary: runtime.undoSummary } } : undefined));

  // Best-effort: this process's private index files are inert but not git's business to keep, and a
  // replaced session's in-memory entries would otherwise live as long as the process itself.

  pi.on("session_shutdown", (_e, ctx) => {
    cleanupIndexes(ctx.cwd);
    const session = ctx.sessionManager.getSessionFile();
    if (session) pruneSession(session);
  });

  // Keep the cache warm while a check runs: the agent certainly continues afterwards.

  pi.on("cache_warming_decision", () => (runtime.checking > 0 ? { action: "warm" as const } : undefined));

  /**
   * Everything that must hold before a build starts: a parseable, finished spec, a check
   * command for its gate, the dependency built, a green (or accepted red) baseline, and
   * planning changes reviewed. Returns the loaded spec and its build command, or undefined
   * after telling the human why not.
   */
}
