/** The build loop: a task's handout, its checks and the step after them (pb_task_done, pb_tests_red, the coherence pass), and the running build's state. */
import * as path from "node:path";
import { StringEnum, Type } from "./schema.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { addedDeclarations, changedPaths, inspectChanges, snapshot, staleProseRefs } from "./checkpoint.ts";
import { tip } from "./help.ts";
import { buildMechanics, buildStateSummary, coherePrompt, fixText, reportRegister } from "./prompts.ts";
import { notifyDesktop } from "./notify.ts";
import { renderBuildToolCall, renderBuildToolResult } from "./render.ts";
import { type ParsedSpec, type SpecTask, buildTask, earlierProof, needsRed } from "./spec.ts";
import { buildTimeLabel, buildTiming } from "./stats.ts";
import { type Progress, COHERE_TASK_ID, Store, appendCheckpoint, diffStat, gitHead, now, readEvents } from "./store.ts";
import { runVerify } from "./verify.ts";
import { COHERE_MIN_TASKS, agree, approvalDrift, buildOfSession, changedFilesSection, checkCommand, cmd, commands, driftStop, evidenceLine, finalCheckCommands, loadBuildSpec, nextLine, pauseBuild, phaseHeader, post, redNotes, reply, resetLimit, retryCount, runtime, showProgress, specRef, repoSnapshots, specTasks, stepPrompt, stop, taskDoneCommands, taskLine, text, tree, withChecking } from "./kit.ts";
import { enterStep, finishBuild, lintsEachStep, nextStep } from "./phase.ts";

export const staleness = (updatedAt?: string): string => {
  const ms = updatedAt ? Date.now() - new Date(`${updatedAt.replace(" ", "T")}Z`).getTime() : NaN;
  if (!(ms >= 0)) return "with no recent activity";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "active just now";
  if (m < 60) return `active ${m} min ago`;
  const h = Math.floor(m / 60);
  return h < 48 ? `active ${h}h ago` : `active ${Math.floor(h / 24)}d ago`;
};

/**
 * Another session may own this spec's build: confirm before two agents race it.
 * The build command passes ["building"] (resuming a paused build is the normal path);
 * /pb:review passes ["building", "paused"] (its finish-time restore would revert even a
 * paused builder's files). Headless has no dialog: agree() goes on, as documented
 * recovery must work there.
 */

export const confirmLiveBuild = async (ctx: ExtensionContext, store: Store, name: string | undefined, phases: Array<"building" | "paused">, action: string): Promise<boolean> => {
  if (!name) return true;
  const session = ctx.sessionManager.getSessionFile();
  const pr = store.progress(name);
  if (!pr || !(phases as string[]).includes(pr.phase) || pr.session === session) return true;
  return agree(ctx, store, `\`${name}\` looks like it is building in another session (${staleness(pr.updatedAt)}). ${action}`);
};

/** The context share in use, rounded, for a reset event and notice; absent when the context is unknown. */
const contextPercent = (ctx: ExtensionContext): number | undefined => {
  const usage = ctx.getContextUsage();
  if (!usage) return undefined;
  if (usage.tokens != null && usage.contextWindow) return Math.round((100 * usage.tokens) / usage.contextWindow);
  return usage.percent != null ? Math.round(usage.percent) : undefined;
};

const pastCheckpoint = (ctx: ExtensionContext, store: Store) => {
  const cfg = store.config();
  const usage = ctx.getContextUsage();
  if (!cfg.checkpointAt || !usage || usage.tokens == null) return undefined;
  const limit = Math.min((usage.contextWindow * cfg.checkpointAt) / 100, resetLimit(usage.contextWindow));
  return usage.tokens >= limit ? contextPercent(ctx) : undefined;
};

/**
 * When a build resets its context at the next task boundary. "task" (the default) resets every
 * boundary: each later task starts from the spec, the done ledger and the code, not from the
 * finished tasks' conversation. "threshold" keeps the checkpointAt behaviour; "never" leaves it to Pi.
 */
export const buildResetDue = (ctx: ExtensionContext, store: Store): { percent?: number } | undefined => {
  const mode = store.config().buildReset;
  if (mode === "never") return undefined;
  if (mode === "threshold") {
    const percent = pastCheckpoint(ctx, store);
    return percent === undefined ? undefined : { percent };
  }
  return { percent: contextPercent(ctx) };
};

/** The build's state as a summary, for a reset at a task boundary or a compaction in the middle of a task. */
export const stateSummary = (ctx: ExtensionContext, store: Store, p: Progress, reason: "reset" | "compaction", extra: { changed?: string[]; read?: string[]; previous?: string } = {}) => {
  const loaded = loadBuildSpec(store, p);
  const { cfg, buildCmd } = commands(ctx.cwd, store);
  const each = cfg.taskChecks === "each";
  const tp = p.tasks.find((t) => t.id === p.current);
  const task = loaded ? buildTask(loaded.spec, p.current) : undefined;
  const finalFiles = p.current === "final" ? changedFilesSection(store, p) : "";
  const current =
    p.current === "final"
      ? fixText("final", `\`${p.lastVerify?.command ?? "the full suite"}\``, p.lastVerify?.summary ?? "", tp?.attempts ?? 1, cfg.maxAttempts, false) + (finalFiles ? `\n${finalFiles}` : "")
      : p.current === COHERE_TASK_ID
        ? coherePrompt(p.baseCommit, tp?.attempts ?? 1, cfg.maxAttempts)
        : task && loaded
          ? stepPrompt(ctx, store, loaded.spec, p, task, tp?.attempts ?? 1)
          : `Carry on with ${p.current ?? "the build"}; finish it with pb_task_done.`;
  return buildStateSummary({ p, markdown: loaded?.md, mechanics: loaded ? buildMechanics(loaded.spec, buildCmd, each, store.extra("build")) : "", current, reason, ...extra });
};


export const beginTask = (
  ctx: ExtensionContext,
  store: Store,
  p: Progress,
  taskId: string,
  o: { inTool?: boolean; countAttempt?: boolean; intro?: boolean } = {},
): { marker: string; prompt: string; task: SpecTask } | undefined => {
  const loaded = loadBuildSpec(store, p);
  const task = loaded ? buildTask(loaded.spec, taskId) : undefined;
  const tp = p.tasks.find((t) => t.id === taskId);
  if (!loaded || !task || !tp) return;
  const { cfg } = commands(ctx.cwd, store);
  if (tp.status === "todo" && cfg.checkpoints) {
    const snap = snapshot(ctx.cwd, `pb: before ${p.spec} ${taskId}`);
    if (snap) {
      const list = store.checkpoints(p.spec);
      // Mid-run starts record a fallback entry now (crash before turn_end still rewinds somewhere);
      // turn_end refines it to the end-of-turn leaf once the handover settles.
      const where = o.inTool
        ? { entry: tree(ctx).getLeafId?.() ?? undefined, pendingEntry: true as const, intro: o.intro || undefined }
        : { entry: tree(ctx).getLeafId?.() ?? undefined, intro: o.intro || undefined };
      const repos = repoSnapshots(ctx.cwd, store, p.spec, `pb: before ${p.spec} ${taskId}`);
      if (appendCheckpoint(list, { id: taskId, at: now(), ...snap, ...(repos.length ? { repos } : {}), head: gitHead(ctx.cwd), tasks: structuredClone(p.tasks), task: taskId, ...where })) store.saveCheckpoints(p.spec, list);
    }
    // Outside git snapshot() is undefined: no undo point, and /pb:undo already says so. No silent failure.
  }
  tp.status = "doing";
  if (o.countAttempt ?? true) tp.attempts += 1;
  tp.attempts = Math.max(tp.attempts, 1);
  enterStep(p, taskId);
  store.saveProgress(p);
  showProgress(ctx, p);
  return {
    task,
    marker: `▶ ${taskId}: ${task.title}${tp.attempts > 1 ? ` (attempt ${tp.attempts})` : ""}`,
    prompt: stepPrompt(ctx, store, loaded.spec, p, task, tp.attempts),
  };
};

/** Coherence pays off once slices can drift: single- and two-task builds skip the pass. */

export const needsCohere = (spec: ParsedSpec) => spec.tasks.length >= COHERE_MIN_TASKS;

/**
 * Open the coherence pass: snapshot for undo (replacing any stale checkpoint from an undone pass),
 * record the synthetic step, and mark the turn boundary. Callers compose the marker and prompt.
 */

export const beginCohereEntry = (ctx: ExtensionContext, store: Store, p: Progress): void => {
  const { cfg } = commands(ctx.cwd, store);
  if (cfg.checkpoints) {
    const kept = store.checkpoints(p.spec).filter((c) => c.id !== COHERE_TASK_ID);
    const snap = snapshot(ctx.cwd, `pb: before ${p.spec} cohere`);
    if (snap) {
      const repos = repoSnapshots(ctx.cwd, store, p.spec, `pb: before ${p.spec} coherence`);
      if (appendCheckpoint(kept, { id: COHERE_TASK_ID, at: now(), ...snap, ...(repos.length ? { repos } : {}), head: gitHead(ctx.cwd), tasks: structuredClone(p.tasks), task: COHERE_TASK_ID, entry: tree(ctx).getLeafId?.() ?? undefined, pendingEntry: true })) store.saveCheckpoints(p.spec, kept);
    }
  }
  p.tasks.push({ id: COHERE_TASK_ID, title: "Coherence pass: consolidate what slicing split apart", status: "doing", attempts: 1 });
  enterStep(p, COHERE_TASK_ID);
  store.saveProgress(p);
  showProgress(ctx, p);
  runtime.boundary = true;
};

export const COHERE_MARKER = "▶ coherence pass";

const inspectTask = (ctx: ExtensionContext, store: Store, p: Progress): string[] => {
  const cps = store.checkpoints(p.spec);
  const entry = cps.find((c) => c.id === p.current);
  const start = cps[0];
  const after = entry && store.config().checkpoints ? snapshot(ctx.cwd, `pb: after ${p.spec} ${p.current}`) : undefined;
  if (!entry || !start || !after) return [];
  const others = new Set(cps.filter((c) => c.task && c.task !== p.current).flatMap((c) => c.files ?? []));
  const flags = inspectChanges(ctx.cwd, entry, after, start, others);
  entry.files = changedPaths(ctx.cwd, entry.commit, after.commit);
  entry.declarations = addedDeclarations(ctx.cwd, entry.commit, after.commit);
  store.saveCheckpoints(p.spec, cps);
  const tests = flags.filter((f) => f.kind === "tampering").map((f) => `${p.current}: ${f.detail}`);
  if (tests.length) p.testChanges = [...(p.testChanges ?? []).filter((c) => !c.startsWith(`${p.current}: `)), ...tests];
  return flags.map((f) => `${f.kind === "tampering" ? "existing tests changed (the review checks them)" : f.kind}: ${f.detail}`);
};

/**
 * pb_task_done said "done": check the current task inside the tool call, so the run (and with it
 * the prompt cache) stays alive. A failure goes back as the tool result; a pass hands out the next
 * task, the final check, or ends the build.
 */
/** A check of the current step failed: back to the agent with a new attempt, or paused after the last one. */

const failedCheck = (ctx: ExtensionContext, store: Store, p: Progress, what: string, failure: string) => {
  const cfg = store.config();
  const tp = p.tasks.find((t) => t.id === p.current);
  const attempts = tp?.attempts ?? 1;
  // The final check has no next task whose prompt would carry the file context, so the
  // failure brief carries it: per-task changed files, harness-computed from checkpoints.
  const finalFiles = p.current === "final" ? changedFilesSection(store, p) : "";
  const withFiles = (t: string) => (finalFiles ? `${t}\n${finalFiles}` : t);
  if (attempts >= cfg.maxAttempts) {
    if (tp) tp.status = "doing";
    pauseBuild(ctx, store, p, `${p.current} still fails after ${attempts} attempts.`, "build.paused-attempts", "attempts", { task: p.current ?? "" });
    return stop(withFiles(fixText(p.current!, what, failure, attempts, cfg.maxAttempts, true, specRef(store, p.spec))));
  }
  if (tp) tp.attempts += 1;
  store.saveProgress(p);
  showProgress(ctx, p);
  return reply(withFiles(fixText(p.current!, what, failure, attempts + 1, cfg.maxAttempts, false, specRef(store, p.spec))));
};

const checkAndAdvance = async (
  ctx: ExtensionContext,
  store: Store,
  p: Progress,
  spec: ParsedSpec,
  signal: AbortSignal | undefined,
  o: { suiteDone?: boolean; lintDone?: boolean } = {},
): Promise<ReturnType<typeof reply> | ReturnType<typeof stop>> => {
  const final = p.current === "final";
  const { cfg, testCmd, buildCmd, lintCmd, extraCmds } = commands(ctx.cwd, store);
  const each = cfg.taskChecks === "each";
  const task = spec.tasks.find((t) => t.id === p.current);
  const tp = p.tasks.find((t) => t.id === p.current);
  const found = final ? [] : inspectTask(ctx, store, p);

  let failure: string | undefined;
  let what = "";
  // The step's own check: a task's from taskDoneCommands (its check, then its own Test: when it proved
  // itself red), the final step's suite from finalCheckCommands — the list the review and fix laps run too.
  // o.suiteDone: the suite passed as the previous step's own check with no work since (the final step was
  // pushed because the last task already ran it) — run only the extra gates. Inferred from lastVerify
  // instead would go stale across later tasks, so callers say so.
  const suite = final ? checkCommand(spec, undefined, testCmd, buildCmd, true, each) : null;
  const finalList = final ? finalCheckCommands(spec, { testCmd, buildCmd, lintCmd: o.lintDone ? null : lintCmd, extraCmds }) : [];
  const own = final ? (suite && !o.suiteDone ? [suite] : []) : taskDoneCommands(spec, task, testCmd, buildCmd, each);
  for (const cmd of own) {
    showProgress(ctx, p, `checking ${final ? "everything" : p.current}: ${cmd}`);
    p.lastVerify = await withChecking(() => runVerify(cmd, ctx.cwd, cfg.verifyTimeoutSec, cfg.testOutputCap, signal));
    store.saveProgress(p);
    if (signal?.aborted) {
      pauseBuild(ctx, store, p, `you stopped the check of ${p.current}.`, "build.paused", "stopped");
      return stop("The check was stopped: the build is paused. Stop here.");
    }
    if (p.lastVerify.ok === false) {
      failure = p.lastVerify.summary;
      what = `\`${cmd}\``;
      break;
    }
  }
  const ran = final ? suite : own.join(" then ") || null;
  // Lint gates every step after its own check, so a style, unused-code or type finding fails the
  // task that caused it while that task's context is still loaded. The final step adds the
  // project's own checks, and skips lint when the step it follows just passed it (o.lintDone).
  // lastVerify keeps the step's own check, so the completion summary still names it.
  const gates = final ? finalList.filter((c) => c !== suite) : lintCmd && lintsEachStep(p) ? [lintCmd] : [];
  let lint: boolean | undefined;
  for (const cmd of failure ? [] : gates) {
    showProgress(ctx, p, `checking ${final ? "final" : p.current}: ${cmd}`);
    const r = await withChecking(() => runVerify(cmd, ctx.cwd, cfg.verifyTimeoutSec, cfg.testOutputCap, signal));
    if (signal?.aborted) {
      pauseBuild(ctx, store, p, `you stopped the check of ${p.current}.`, "build.paused", "stopped");
      return stop("The check was stopped: the build is paused. Stop here.");
    }
    if (cmd === lintCmd) lint = r.ok !== false;
    if (final) store.event(p.spec, { type: "check", task: "final", attempt: tp?.attempts ?? 1, ok: r.ok !== false, command: cmd, notices: [] });
    if (r.ok === false) {
      p.lastVerify = r;
      store.saveProgress(p);
      failure = r.summary;
      what = `\`${cmd}\``;
      break;
    }
  }
  // A task records one event per attempt (stats count attempts from them); its lint result rides along.
  store.event(p.spec, { type: "check", task: p.current, attempt: tp?.attempts ?? 1, ok: !failure, command: ran, notices: found, ...(!final && lint !== undefined ? { lint } : {}) });

  if (failure) return failedCheck(ctx, store, p, what, failure);
  return advanceAfterCheck(ctx, store, p, spec, signal, found, own, ran);
};

/**
 * A check passed: close the finished step, then hand out the next task, open the
 * coherence pass, run the final check, or finish the build — the build's state machine.
 */

const advanceAfterCheck = async (
  ctx: ExtensionContext,
  store: Store,
  p: Progress,
  spec: ParsedSpec,
  signal: AbortSignal | undefined,
  found: string[],
  own: string[],
  ran: string | null,
): Promise<ReturnType<typeof reply> | ReturnType<typeof stop>> => {
  const { cfg, testCmd, buildCmd } = commands(ctx.cwd, store);
  const each = cfg.taskChecks === "each";
  const tp = p.tasks.find((t) => t.id === p.current);
  // Passed: close the task and move on.
  if (tp) tp.status = "done";
  const cps = store.checkpoints(p.spec);
  const cp = cps.find((c) => c.id === p.current);
  if (cp) {
    cp.summary = `${p.current} ✓ · ${(cp.files ?? []).length} files · ${(tp?.changed ?? tp?.summary ?? "").replace(/\s+/g, " ")}`;
    store.saveCheckpoints(p.spec, cps);
  }
  const notices = found.length ? `\n⚠ ${found.join("\n⚠ ")}` : "";
  const shownRuns = own.length ? own : ran ? [ran] : [];
  const passed = `✓ ${p.current} ${shownRuns.length ? `passed (${shownRuns.map((c) => `\`${c}\``).join(" then ")})` : spec.gate === "none" ? "done (no checks for this feature)" : each ? "done (no check for this task)" : "done (checked after the last task)"}${notices}`;

  // A hand edit to the contract while the check ran: the task stays done, but the build
  // neither hands out another task nor closes against a spec nobody approved.
  const drift = approvalDrift(store, p);
  if (drift) {
    driftStop(ctx, store, p, drift);
    return stop(`${passed}\n\nThe spec's contract changed while ${p.current} was checked: the build is paused. Stop here.`);
  }

  const endCmd = checkCommand(spec, undefined, testCmd, buildCmd, true, each);
  const { lintCmd, extraCmds } = commands(ctx.cwd, store);
  // Lint left to the end is a final-gate check like the project's own.
  const lintAtEnd = !!lintCmd && !lintsEachStep(p);
  // The suite counts as run by this step when it was one of the step's own commands.
  const step = nextStep(p, { cohere: needsCohere(spec), endCommand: endCmd, ran: endCmd && own.includes(endCmd) ? endCmd : ran, extraChecks: extraCmds.length > 0 || lintAtEnd });
  if (step.kind === "task") {
    const t = beginTask(ctx, store, p, step.id, { inTool: true });
    if (!t) {
      pauseBuild(ctx, store, p, `${store.rel("specs", p.spec, "spec.md")} no longer parses; fix it, then /${cmd("build")}.`, "build.paused", "spec");
      return stop("The spec no longer parses: the build is paused. Stop here.");
    }
    runtime.boundary = true;
    return reply(`${passed}\n\n${t.prompt}`);
  }
  if (step.kind === "cohere") {
    beginCohereEntry(ctx, store, p);
    return reply(`${passed}\n\n${COHERE_MARKER}\n\n${coherePrompt(p.baseCommit, 1, cfg.maxAttempts, specRef(store, p.spec))}`);
  }
  if (step.kind === "final") {
    // The project's own checks still run; lint only when it was left to the end (the passed step ran it otherwise).
    p.tasks.push({ id: "final", title: `Final check: ${spec.gate === "tests" ? "full suite" : "compile"}`, status: "doing", attempts: 1 });
    enterStep(p, "final");
    store.saveProgress(p);
    const r = await checkAndAdvance(ctx, store, p, spec, signal, { suiteDone: step.suiteDone, lintDone: !lintAtEnd });
    return { ...r, content: text(`${passed}\nRunning \`${endCmd ?? (lintAtEnd ? lintCmd : extraCmds[0])}\`…\n\n${r.content[0].text}`) };
  }
  finishBuild(p);
  store.saveProgress(p);
  store.event(p.spec, { type: "built" });
  showProgress(ctx, p);
  // The plan may have been split into several specs: the others are still waiting.
  const rest = p.writtenIn ? store.specsOfPlanning(p.writtenIn) : [];
  const stale = staleProseRefs(ctx.cwd, p.baseCommit);
  const changedFiles = changedFilesSection(store, p);
  const events = readEvents(path.join(store.specDir(p.spec), "events.jsonl"));
  const timing = buildTiming(events);
  const tasks = specTasks(p);
  const done = tasks.filter((t) => t.status === "done").length;
  // The final gate's commands, in the order they ran; a suite run the last task already did
  // still records a final event, so the list is complete without a second run.
  const gates = new Map<string, boolean>();
  for (const e of events) {
    if (e.type === "check" && e.task === "final" && typeof e.command === "string") gates.set(e.command, e.ok === true);
  }
  // Lint passed on the last step and was not run again at the end: that step's result is the gate's.
  const lastLint = events.filter((e) => e.type === "check" && typeof e.lint === "boolean").at(-1);
  if (lintCmd && !gates.has(lintCmd) && lastLint) gates.set(lintCmd, lastLint.lint === true);
  if (p.lastVerify?.command && p.lastVerify.ok !== null) gates.set(p.lastVerify.command, p.lastVerify.ok);
  const gateLabel = (c: string) => (c === testCmd ? "suite" : c === buildCmd ? "build" : c === lintCmd ? "lint" : `\`${c}\``);
  const gateFacts = [...gates].map(([c, ok]) => `${gateLabel(c)} ${ok ? "PASS" : "FAIL"}`);
  const checks = events.filter((e) => e.type === "check" && e.task !== "final" && e.task !== COHERE_TASK_ID && e.task !== "skeleton").length;
  const retries = retryCount(p);
  const stat = diffStat(ctx.cwd, p.baseCommit).split("\n").map((l) => l.trim()).filter(Boolean).at(-1);
  post(
    [
      phaseHeader("✅", "Build complete", p.spec, tasks.length ? `${done}/${tasks.length} tasks` : "", timing.activeMs || timing.wallMs ? buildTimeLabel(timing) : ""),
      "",
      nextLine(`\`/${cmd("review")}\` here in this session, then commit and \`/${cmd("archive")}\`.`),
      evidenceLine(...gateFacts, checks ? `${checks} check${checks === 1 ? "" : "s"}` : "", retries ? `${retries} retr${retries === 1 ? "y" : "ies"}` : "", stat),
      ...(notices ? [notices.trim()] : []),
      "",
      "```",
      ...p.tasks.map(taskLine),
      "```",
      p.assumptions?.length ? `\nChoices the build made where the spec was unclear (in the spec's Decisions; the review checks them):\n${p.assumptions.map((a) => `- ${a}`).join("\n")}` : "",
      p.unattended?.length ? `\nDecided without you (no answer in time):\n${p.unattended.map((c) => `- ${c}`).join("\n")}` : "",
      p.testChanges?.length ? `\nExisting tests the build changed (the review checks whether each was justified):\n${p.testChanges.map((c) => `- ${c}`).join("\n")}` : "",
      changedFiles ? `\n${changedFiles}` : "",
      redNotes(spec, p).length ? `\nNew tests never seen failing (the review judges each):\n${redNotes(spec, p).map((n) => `- ${n}`).join("\n")}` : "",
      stale.length ? `\nPossibly stale prose references (renamed or deleted identifiers still cited — intentional history is fine):\n${stale.map((s) => `- ${s.symbol}: ${s.referrers.join(", ")}`).join("\n")}` : "",
      "",
      tip("build.done", { spec: p.spec }),
      ...rest.map((n, i) => `${i ? "" : "\nStill to build, from the same plan:\n"}- ${n}: \`/${cmd("build")} ${n}\``),
    ].join("\n"),
  );
  // The completion is the other moment the human is reliably away from the terminal.
  if (cfg.notify) notifyDesktop("pb: build complete", `${p.spec}: ${done}/${tasks.length} tasks done, every check passed`);
  return stop(`${passed}\n\nBuild complete: every check passed. Stop here; the harness shows the summary.`);
};

// The build session's own instance applies the carried-over model and thinking level before its first turn.

export function registerBuildLoop(pi: ExtensionAPI) {
  pi.registerTool({
    name: "pb_task_done",
    label: "Task done",
    description:
      'In a pb build: finish the task the harness gave you. status done: the harness runs the task\'s check and answers with the failure to fix, or the next task — report changed (what you changed), caveat (what the next task must respect), rejected (what you tried and discarded) and open (what is still unchecked), each required, "none" where there is genuinely nothing. status blocked: the Goal or a Contract cannot be built as written (summary says why, with the evidence); the build stops for a revised spec and a new approval. ' + reportRegister,
    parameters: Type.Object({
      task: Type.String({ description: 'the task id, e.g. "T2" (or "final" for the final check)' }),
      status: StringEnum(["done", "blocked"]),
      summary: Type.Optional(Type.String({ description: 'blocked only: which Goal or Contract cannot be built as written, and the evidence' })),
      changed: Type.Optional(Type.String({ description: "done only: what you changed" })),
      caveat: Type.Optional(Type.String({ description: 'done only: what the next task must respect ("none" when nothing)' })),
      rejected: Type.Optional(Type.String({ description: 'done only: what you tried and discarded ("none" when nothing)' })),
      open: Type.Optional(Type.String({ description: 'done only: what is still unchecked ("none" when nothing)' })),
    }),
    executionMode: "sequential",
    // The row is the verdict line the harness replies with; the next handout stays one expand away.
    renderCall: (args, theme) => renderBuildToolCall("pb_task_done", args, theme),
    renderResult: (result, opts, theme) => renderBuildToolResult(result as { content: { type: string; text?: string }[] }, opts, theme),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { store, progress: p } = buildOfSession(ctx);
      if (params.task !== p.current) throw new Error(`The current task is ${p.current ?? "none"}, not ${params.task}.`);
      const tp = p.tasks.find((t) => t.id === p.current);
      const blank = (v: unknown) => typeof v !== "string" || !v.trim();
      if (params.status === "blocked") {
        if (blank(params.summary)) throw new Error(`status "blocked" needs summary: which Goal or Contract cannot be built as written, and the evidence.`);
        if (tp) tp.summary = (params.summary as string).trim();
      } else {
        const missing = (["changed", "caveat", "rejected", "open"] as const).filter((k) => blank(params[k]));
        if (missing.length)
          throw new Error(
            `status "done" needs ${missing.join(", ")}: report what changed, what the next task must respect, what was tried and discarded, and what is still unchecked (write "none" where there is genuinely nothing).`,
          );
        if (tp) {
          tp.changed = (params.changed as string).trim();
          tp.caveat = (params.caveat as string).trim();
          tp.rejected = (params.rejected as string).trim();
          tp.open = (params.open as string).trim();
        }
      }
      if (params.status === "blocked") {
        pauseBuild(ctx, store, p, `${params.task} cannot be built as written: ${params.summary}`, "build.contract", "contract");
        return stop("The build stopped: the Goal or a Contract cannot be built as written. The human revises the spec and /pb:build re-approves it. Stop here.");
      }
      const drift = approvalDrift(store, p);
      if (drift) return driftStop(ctx, store, p, drift);
      const loaded = loadBuildSpec(store, p);
      if (!loaded) {
        pauseBuild(ctx, store, p, `${store.rel("specs", p.spec, "spec.md")} no longer parses; fix it, then /${cmd("build")}.`, "build.paused", "spec");
        return stop("The spec no longer parses: the build is paused. Stop here.");
      }
      const task = loaded.spec.tasks.find((t) => t.id === p.current);
      if (tp && task && needsRed(loaded.spec, task) && !tp.redCommand && !earlierProof(loaded.spec, p.tasks, task)) {
        // Nothing is checked here, so this is not an attempt: the refusal is the rescue for a model
        // that implemented before writing the failing test. A run that passes costs the attempt.
        store.saveProgress(p);
        return reply(`${p.current}'s new tests were never seen failing, so nothing shows they test the change. Call pb_tests_red: if you already made the change, set it aside first (the tests must fail without it), then put it back.`);
      }
      return await checkAndAdvance(ctx, store, p, loaded.spec, signal);
    },
  });

  pi.registerTool({
    name: "pb_tests_red",
    label: "Tests fail first",
    description:
      "In a pb build, for a task with a Test: line: after writing its tests and before the change, the harness runs the task's test command and requires it to FAIL, proving the tests check the behaviour that is missing. pb_task_done for that task needs it. Call it again after changing the tests: only the latest failed run counts.",
    parameters: Type.Object({
      task: Type.String({ description: 'the task id, e.g. "T2"' }),
    }),
    executionMode: "sequential",
    renderCall: (args, theme) => renderBuildToolCall("pb_tests_red", args, theme),
    renderResult: (result, opts, theme) => renderBuildToolResult(result as { content: { type: string; text?: string }[] }, opts, theme),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { store, progress: p } = buildOfSession(ctx);
      if (params.task !== p.current) throw new Error(`The current task is ${p.current ?? "none"}, not ${params.task}.`);
      const drift = approvalDrift(store, p);
      if (drift) return driftStop(ctx, store, p, drift);
      const spec = loadBuildSpec(store, p)?.spec;
      const task = spec?.tasks.find((t) => t.id === p.current);
      const tp = p.tasks.find((t) => t.id === p.current);
      if (!spec || !task?.test || !tp || !needsRed(spec, task)) return reply(`${params.task} doesn't need this: finish it with pb_task_done.`);
      const earlier = earlierProof(spec, p.tasks, task);
      if (earlier)
        return reply(
          `\`${task.test}\` cannot fail again: ${earlier.id} (done) proved this command and its change satisfies it. Finish ${params.task} with pb_task_done — this run proves nothing of its own tests, and the reviewer is told.`,
        );
      const cfg = store.config();
      const testCmd = task.test;
      showProgress(ctx, p, `${p.current}: its tests must fail first: ${testCmd}`);
      const r = await withChecking(() => runVerify(testCmd, ctx.cwd, cfg.verifyTimeoutSec, cfg.testOutputCap, signal));
      store.event(p.spec, { type: "red", task: p.current, ok: r.ok === false, command: testCmd });
      if (r.ok !== false) {
        // A green run cannot stand on an earlier failure: the tests changed, or the command no longer
        // runs them. Clear the proof; the task cannot finish until a run fails, and the way out is the
        // human's: a command that cannot fail needs a revised Test: line.
        tp.redCommand = undefined;
        store.saveProgress(p);
        return reply(
          `\`${testCmd}\` passes without the change, so these tests don't check it (or that command doesn't run them). If you already made the change, set it aside first (the tests must fail without it), then put it back; otherwise make them fail for the behaviour that is missing. If the behaviour already exists and the command cannot fail, stop with pb_task_done status "blocked" and say the Test: command needs revising.\n\n${r.summary}`,
        );
      }
      tp.redCommand = testCmd;
      store.saveProgress(p);
      return reply(
        `Seen failing: \`${testCmd}\`\n\n${r.summary}\n\nCheck that each fails for the reason you expect (the missing behaviour, not a typo or an unrelated error). If you edit the tests after this, call pb_tests_red again: only the latest failed run counts. Then make the change and finish with pb_task_done.`,
      );
    },
  });
}
