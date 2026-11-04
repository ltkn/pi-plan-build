/** The spec-to-build pipeline: pb_write_spec & co, the spec review, and the build machinery behind /pb:build and /pb:spec. */
import * as path from "node:path";
import { StringEnum, Type } from "./schema.ts";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext
 } from "@earendil-works/pi-coding-agent";
import { type Snapshot, changedPaths, cleanupIndexes, commitTime, dropCheckpoints, inWorktree, inspectChanges, restore, skippedLargeFiles, snapshot, staleProseRefs } from "./checkpoint.ts";
import { HELP_PATH, tip, topic, topics } from "./help.ts";
import { EXPLORER_SYSTEM, TRY_SYSTEM, approachPrompt, buildIntro, buildMechanics, buildStateSummary, checkpointPrompt, checkpointSummary, coherePrompt, reviewStateSummary, acceptanceDrift, designProvenance, continuePlanPrompt, continuePrompt, depsPrompt, explorerBrief, tryBrief, extraBlock, findingDetails, findingLine, finishSpecPrompt, fixText, isNone, nudgePrompt, planPrompt, PI_RESERVE_TOKENS, ATTACKER_SYSTEM, reviewSessionPrompt, REVIEW_DIFF_CHARS, reviewerBrief, reportRegister, specPrompt, specReviewBrief, specReference, SPEC_REVIEWER_SYSTEM, STRUCTURED_EDIT_RULE, taskPrompt } from "./prompts.ts";
import { REVIEW_TOOLS, acceptanceCoverage, fromProse, mergeFindings, normalizeAcceptance, sensitiveGround, unparsedReport, verdictOf, verifyFindings } from "./review.ts";
import { runFresh, usageOf } from "./runner.ts";
import { notifyDesktop } from "./notify.ts";
import { renderBuildToolCall, renderBuildToolResult } from "./render.ts";
import { type ParsedSpec, type SpecTask, acceptanceCriteria, addDecision, buildTask, commitMessage, contractHash, earlierProof, isAcceptanceLine, needsRed, parseSpec, redExemption, sectionHeading, sectionOf, setSection, setStatus, sharedTestCommands, specHash, specPathRefs, specTextBlocks, tokensOf } from "./spec.ts";
import { duration } from "./format.ts";
import { KEBAB_NAME } from "./names.ts";
import { buildTimeLabel, buildTiming, loadStats, renderAll, renderCard } from "./stats.ts";
import { type AcceptanceCheck, type Checkpoint, type Finding, type Progress, type ReviewLedgerEntry, type ReviewRun, type ReviewSessionState, type TaskProgress, type VerifyResult, COHERE_TASK_ID, PREFIX, Store, appendCheckpoint, cap, changedSince, diffStat, gitDiff, gitHead, gitRepo, ledgerFindings, now, readEvents, resolvesRevision, reviewLedger, untrackedText } from "./store.ts";
import { resolveBuild, resolveLint, resolveVerify, runVerify } from "./verify.ts";
import { COHERE_MIN_TASKS, P_ORDER, SYNTHETIC_TASKS, agree, appendDecision, appendEntry, approvalDrift, approveSpec, buildOfSession, changedFilesSection, checkCommand, choose, cmd, commands, commitBlock, driftStop, evidenceLine, finalExtras, findModel, instruct, liftPlanning, liveBuildOfSession, loadBuildSpec, loadSpec, mark, nextLine, nextTodo, normSpecArg, pauseBuild, phaseHeader, planningWriteNotes, post, recordedMs, redNotes, reply, resetLimit, retryCount, revertFreshRun, reviewPlanningChanges, rewriteWarning, runtime, safely, sessionGone, sessionModel, showProgress, sizeNote, sleep, specCompletions, specOfSession, specPathErrors, specStarted, specTasks, specWarnings, specWriting, standardsFor, stepPrompt, stop, suspiciousCommand, syncTasks, taskLine, text, timeSuffix, tree, unfinishedPhase, warnLater, watchable, withChecking } from "./kit.ts";

const DRY_RUN_TIMEOUT_SEC = 120;

/**
 * Each red-eligible task command, run once before the human approves the build: failing is expected
 * (nothing built yet), passing smells pre-existing behaviour, erroring smells a broken command. Advisory
 * only — small changes (other gates, no new tests, refactors) have no red-eligible commands and skip this.
 */

const dryRunTests = async (ctx: ExtensionContext, store: Store, name: string): Promise<string[]> => {
  const loaded = loadSpec(store, name);
  if (!loaded) return [];
  const cwd = ctx.cwd;
  const cfg = store.config();
  const commands = [...new Set(loaded.spec.tasks.filter((t) => needsRed(loaded.spec, t) && t.test).map((t) => t.test!))];
  if (!commands.length) return [];
  const started = Date.now();
  // The dry-run executes real Test: commands in the working copy: their artifacts (coverage,
  // caches) must not show up afterwards as planning changes, so put back whatever they wrote.
  const dryBefore = snapshot(cwd, "pb: before dry-run");
  // The human waits at the approval for up to DRY_RUN_TIMEOUT_SEC per command, so the widget
  // says which one is running and its elapsed seconds instead of leaving the session silent.
  let current: { command: string; n: string; since: number } | undefined;
  const paint = () => {
    const run = current; // one frame's view of what is running; the next frame repaints
    if (!run) return;
    safely(() =>
      ctx.ui.setWidget("pb-dry-run", [`pb dry-run ${name} (${run.n}/${commands.length}) — \`${run.command}\` · ${Math.round((Date.now() - run.since) / 1000)}s`]),
    );
  };
  const beat = watchable(ctx) ? setInterval(paint, 1000) : undefined;
  try {
    const results: Array<{ command: string; result: string; line: string }> = [];
    for (const [i, command] of commands.entries()) {
      if (suspiciousCommand(command)) {
        results.push({ command, result: "unknown", line: "not run here: chains shells or reaches the network — review before building" });
        continue;
      }
      current = { command, n: `${i + 1}`, since: Date.now() };
      paint();
      const r = await withChecking(() => runVerify(command, cwd, Math.min(cfg.verifyTimeoutSec, DRY_RUN_TIMEOUT_SEC), cfg.testOutputCap));
      const line = r.summary.split("\n")[0];
      const result = r.ok ? "pass" : /TIMEOUT|ENOENT|not found|No such file/i.test(r.summary) ? "unknown" : "fail";
      results.push({ command, result, line });
      current = undefined;
    }
    store.event(name, { type: "dryrun", results: results.map(({ command, result }) => ({ command, result })) });
    const describe: Record<string, (c: string, l: string) => string> = {
      fail: (c) => `✗ \`${c}\` fails (expected: nothing built yet — if it fails for the wrong reason, like no runner, fix the command)`,
      pass: (c) => `⚠ \`${c}\` passes before the build: the behaviour may already exist (re-slice?) or the tests don't cover it yet (carry on — the build still requires red)`,
      unknown: (c, l) => `? \`${c}\` couldn't run here (${l}) — unknown, not a verdict`,
    };
    return ["", `Test commands, run once before you approve (took ${duration(Date.now() - started)}):`, ...results.map((r) => `- ${describe[r.result](r.command, r.line)}`)];
  } finally {
    if (beat !== undefined) clearInterval(beat);
    safely(() => ctx.ui.setWidget("pb-dry-run", undefined));
    revertFreshRun(cwd, (m) => warnLater(ctx, m), "the dry-run", dryBefore, snapshot(cwd, "pb: after dry-run"));
  }
};

const assumptionsOf = (md: string) => {
  const decisions = md.split(sectionHeading("Decisions"))[1]?.split(/^##\s+(?!#)/m)[0] ?? "";
  return [...decisions.matchAll(/^\s*-\s*(Assumption(?! \(build)[^\n]*)/gm)].map((m) => m[1].trim());
};

const readySpecs = (store: Store, session: string | undefined, since = "") => {
  const names = store
    .specNames()
    .map((n) => ({ n, p: store.progress(n) }))
    .filter((x) => x.p?.writtenIn === session && x.p?.phase === "written" && x.p.updatedAt >= since && loadSpec(store, x.n)?.spec.status === "ready")
    .sort((a, b) => b.p!.updatedAt.localeCompare(a.p!.updatedAt))
    .map((x) => x.n);
  return names.sort((a, b) => Number(names.includes(loadSpec(store, a)?.spec.dependsOn ?? "")) - Number(names.includes(loadSpec(store, b)?.spec.dependsOn ?? "")));
};

/**
 * /pb:build before there's a (ready) spec. Everything that needs you is asked now, while you're here:
 * files changed while planning, a red baseline, where to build, and whether to see the spec first. Then
 * Pi writes the spec and, unless you wanted to see it, this command waits for it and starts the build
 * itself: from a command, a fresh session can be opened too. Nothing waits on you after this point
 * except pb_ask questions, which go on with the recommendation after askTimeoutSec.
 */

const showSpec = (store: Store, name: string, o: { names?: string[]; next: string; extra?: string[] }) => {
  const loaded = loadSpec(store, name);
  if (!loaded) return;
  const names = o.names ?? [name];
  const specMs = recordedMs(store, name, "spec");
  const criteria = acceptanceCriteria(loaded.md, loaded.spec).length;
  const assumptions = assumptionsOf(loaded.md);
  const others = names.filter((n) => n !== name);
  post(
    [
      phaseHeader("✅", "Spec written", name, `${loaded.spec.tasks.length} task${loaded.spec.tasks.length === 1 ? "" : "s"}`, criteria ? `${criteria} criteri${criteria === 1 ? "on" : "a"}` : "", specMs !== undefined ? duration(specMs) : ""),
      "",
      nextLine(o.next),
      evidenceLine(store.rel("specs", name, "spec.md"), `verification ${loaded.spec.gate}${loaded.spec.newTests ? "" : " · no new tests"}`, assumptions.length ? `${assumptions.length} assumption${assumptions.length === 1 ? "" : "s"} recorded` : "", others.length ? `also: ${others.join(", ")}` : ""),
      "",
      ...loaded.spec.tasks.map((t) => `- ${t.id}: ${t.title}${t.test ? ` · \`${t.test}\`` : ""}`),
      ...assumptions.map((a, i) => `${i ? "" : "\nSettled without asking you (the review checks them):\n"}- ${a}`),
      ...(o.extra?.length ? o.extra : []),
    ].join("\n"),
  );
  appendEntry("pb-spec", { name, markdown: loaded.md });
};

/** The spec's recorded assumptions (Decisions lines starting "Assumption"), as written while writing it. */

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

export const pastCheckpoint = (ctx: ExtensionContext, store: Store) => {
  const cfg = store.config();
  const usage = ctx.getContextUsage();
  if (!cfg.checkpointAt || !usage || usage.tokens == null) return undefined;
  const limit = Math.min((usage.contextWindow * cfg.checkpointAt) / 100, resetLimit(usage.contextWindow));
  return usage.tokens >= limit ? Math.round((100 * usage.tokens) / usage.contextWindow) : undefined;
};

/** The build's state as a summary, for a reset at a task boundary or a compaction in the middle of a task. */
export const stateSummary = (ctx: ExtensionContext, store: Store, p: Progress, reason: "reset" | "compaction", extra: { changed?: string[]; read?: string[]; previous?: string } = {}) => {
  const loaded = loadBuildSpec(store, p);
  const { cfg, testCmd, buildCmd } = commands(ctx.cwd, store);
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

/** When a build session should be reset at a task boundary: past checkpointAt, always before Pi would compact. */

import { offerStandards } from "./plan.ts";

export function registerFlow(pi: ExtensionAPI) {
  pi.registerTool({
    name: "pb_write_spec",
    label: "Write spec",
    description:
      "Write or rewrite a pb feature spec (.pi/pb/specs/<name>/spec.md). Use it when the user runs /pb:spec or /pb:build asks for the spec. The content must follow the spec format the user's instructions give; the tool rejects a spec that doesn't parse and says why.",
    parameters: Type.Object({
      name: Type.String({ description: "short kebab-case spec name (the folder under .pi/pb/specs/, not a path), e.g. order-cancellation" }),
      content: Type.String({ description: "the complete spec in markdown" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!KEBAB_NAME.test(params.name)) throw new Error(`"${params.name}" is not a valid name: use short kebab-case, e.g. order-cancellation`);
      if (params.name === "off") throw new Error(`"off" is reserved (/${cmd("plan")} off ends planning): pick another spec name.`);
      const store = new Store(ctx.cwd);
      const session = ctx.sessionManager.getSessionFile();
      const building = liveBuildOfSession(ctx, store);
      if (building)
        throw new Error(
          `The build of ${building.spec} is running: its approved spec can't be rewritten. Only its Design and Decisions may change (pb_update_spec). If the contract itself must change, stop the task with pb_task_done status blocked and say why; the human then revises it and /${cmd("build")} re-approves the revision.`,
        );
      const { spec, errors } = parseSpec(params.content);
      if (!spec) throw new Error(`The spec doesn't parse:\n- ${errors.join("\n- ")}\nFix it and call pb_write_spec again.`);
      const pathErrs = spec.status === "ready" ? specPathErrors(params.content, ctx.cwd) : [];
      if (pathErrs.length) throw new Error(`The spec points at code that isn't there:\n- ${pathErrs.join("\n- ")}\nFix the path, line or citation; new files need no line number.`);
      const prev = store.progress(params.name);
      // Everything the answer needs is settled first: from the write down, the only work left is the
      // spec file and its two ledger records, so a failing note can't report an error over a spec
      // that was actually written, and the file never lands without its record.
      const what = spec.status === "planning" ? "status planning" : `${spec.tasks.length} tasks, verification ${spec.gate}${spec.newTests ? "" : ", no new tests"}`;
      const warnings = specWarnings(params.content, spec);
      const rw = rewriteWarning(params.name, prev, spec);
      if (rw) warnings.push(rw);
      const notes = warnings.map((w) => `\nNote: ${w}.`);
      const started = session ? specStarted.get(session) : undefined;
      const specMs = spec.status === "ready" && started !== undefined ? Math.max(0, Date.now() - started) : undefined;
      store.writeSpec(params.name, params.content);
      if (specMs !== undefined && session) specStarted.delete(session);
      store.saveProgress({
        ...(prev ?? { spec: params.name, phase: "written" }),
        spec: params.name,
        tasks: syncTasks(spec, prev?.tasks),
        writtenIn: session,
        edited: false,
        updatedAt: now(),
      });
      store.event(params.name, { type: "spec", tasks: spec.tasks.length, gate: spec.gate, newTests: spec.newTests, status: spec.status, tokens: tokensOf(params.content), ...(specMs !== undefined ? { ms: specMs } : {}) });
      return reply(`✅ Wrote ${store.rel("specs", params.name, "spec.md")}: "${spec.title}", ${what}${spec.dependsOn ? `, depends on ${spec.dependsOn}` : ""}; ${sizeNote(tokensOf(params.content))}${timeSuffix(specMs)}.${notes.join("")}`);
    },
  });

  pi.registerTool({
    name: "pb_update_spec",
    label: "Update spec",
    description:
      "Change part of an existing pb spec instead of rewriting it: replace or append to one section (e.g. Findings, Decisions, Design, Tasks), and/or set its Status (planning | ready). The result must still parse, or nothing is written. A replace whose body is blank is refused — a section with nothing to say is one line, \"none — <why>\".",
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "the spec's name; the one this session is building or writing, if omitted" })),
      section: Type.Optional(Type.String({ description: 'the "## " section to change, e.g. Decisions; created if missing' })),
      content: Type.Optional(Type.String({ description: "the section's new body (without its heading), or the lines to append" })),
      mode: Type.Optional(StringEnum(["replace", "append"])),
      status: Type.Optional(StringEnum(["planning", "ready"])),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const store = new Store(ctx.cwd);
      const session = ctx.sessionManager.getSessionFile();
      const mine = store.specForSession(ctx.sessionManager.getSessionFile());
      const live = mine ? store.progress(mine) : undefined;
      const building = live?.phase === "building" ? live : undefined;
      const name = params.name ?? mine;
      if (!name) throw new Error("Which spec? Give its name.");
      if (building) {
        if (name !== building.spec)
          throw new Error(`The build of ${building.spec} is running in this session: only its Design and Decisions may change, not ${name}.`);
        if (params.status)
          throw new Error(`The build of ${building.spec} is running: its status can't change. Only its Design and Decisions may change; a contract change pauses the build and /${cmd("build")} re-approves the revision.`);
        const sectionName = params.section?.replace(/^#+\s*/, "").trim().toLowerCase();
        if (sectionName !== "design" && sectionName !== "decisions")
          throw new Error(
            `The build of ${building.spec} is running: only its Design and Decisions may change, not ${sectionName ? `"${params.section!.replace(/^#+\s*/, "").trim()}"` : "the spec"}. A contract change pauses the build and /${cmd("build")} re-approves the revision.`,
          );
      }
      let md = store.readSpec(name);
      if (!md) throw new Error(`No spec "${name}": write it with pb_write_spec.`);
      if (params.section) {
        if (params.content === undefined) throw new Error("content is required with section.");
        // An empty body under replace would leave the heading standing over nothing, and an empty
        // section answers every evidence gate by deleting what the gate inspects.
        if ((params.mode ?? "replace") !== "append" && !params.content.trim())
          throw new Error(`Not written: replacing ${params.section.replace(/^#+\s*/, "").trim()} with nothing leaves it empty — a section with nothing to say is one line, "none — <why>".`);
        md = setSection(md, params.section, params.content, (params.mode as "replace" | "append" | undefined) ?? "replace");
      }
      if (params.status) md = setStatus(md, params.status as "planning" | "ready");
      const { spec, errors } = parseSpec(md);
      if (!spec) throw new Error(`Not written: the spec wouldn't parse:\n- ${errors.join("\n- ")}`);
      const sectionName = params.section?.replace(/^#+\s*/, "").trim().toLowerCase() ?? "";
      // A path:line is a claim about the code the spec was written against. Check it on every
      // ready write except Design, which the build writes and may legitimately describe new code.
      if (spec.status === "ready" && sectionName !== "design") {
        const pathErrs = specPathErrors(md, ctx.cwd);
        if (pathErrs.length) throw new Error(`Not written: the spec points at code that isn't there:\n- ${pathErrs.join("\n- ")}\nFix the path, line or citation; new files need no line number.`);
      }
      const prev = store.progress(name);
      const isTasks = sectionName === "tasks";
      const rw = isTasks ? rewriteWarning(name, prev, spec) : undefined;
      const notes = (isTasks ? [...specWarnings(md, spec), ...(rw ? [rw] : [])] : []).map((w) => `\nNote: ${w}.`);
      const started = session ? specStarted.get(session) : undefined;
      const specMs = !building && spec.status === "ready" && started !== undefined ? Math.max(0, Date.now() - started) : undefined;
      // Answer built from pre-write values above; what follows is the file and its two ledger records.
      store.writeSpec(name, md);
      if (specMs !== undefined && session) specStarted.delete(session);
      // A live build's task list is its approved one: a Design or Decisions edit never resyncs it
      // from the live file, and the build that owns the spec keeps its writtenIn.
      const buildingNow = !!building;
      store.saveProgress({
        ...(prev ?? { spec: name, phase: "written" }),
        spec: name,
        tasks: buildingNow ? (prev?.tasks ?? []) : syncTasks(spec, prev?.tasks),
        writtenIn: buildingNow ? prev?.writtenIn : session,
        updatedAt: now(),
      });
      store.event(name, { type: "spec", update: params.section ?? "status", status: spec.status, tokens: tokensOf(md), ...(specMs !== undefined ? { ms: specMs } : {}) });
      return reply(`✅ Updated ${store.rel("specs", name, "spec.md")}${params.section ? ` (${params.section})` : ""}: status ${spec.status}; ${sizeNote(tokensOf(md))}${timeSuffix(specMs)}.${notes.join("")}`);
    },
  });

  pi.registerTool({
    name: "pb_record_decision",
    label: "Record decision",
    description:
      "In a pb build session: record in the spec's Decisions a decision the human just made, or (assumption: true) a choice you made where the spec was ambiguous or didn't match the code, so it survives compaction and reaches the reviewer.",
    parameters: Type.Object({
      decision: Type.String({ description: "the decision or choice, self-contained, with its reason, in one or two sentences" }),
      assumption: Type.Optional(Type.Boolean({ description: "true when it is your choice, not the human's" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const { store, name, progress } = specOfSession(ctx);
      const md = name ? store.readSpec(name) : undefined;
      if (!name || !md || !progress) throw new Error("This is not a pb build session. In planning, decisions stay in the discussion and enter the spec via /pb:spec or /pb:build — carry on.");
      const entry = params.assumption ? `Assumption (build${progress.current ? `, ${progress.current}` : ""}): ${params.decision}` : params.decision;
      const refused = appendDecision(store, name, entry);
      if (refused) throw new Error(`Not recorded: ${refused}. Fix the spec (pb_update_spec) and record the decision again.`);
      if (params.assumption) {
        progress.assumptions = [...(progress.assumptions ?? []), entry];
        store.saveProgress(progress);
      }
      return reply("Recorded in the spec's Decisions.");
    },
  });

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

  pi.registerCommand(cmd("spec"), {
    description: "Write the spec for what we planned (one per feature); run it again to revise. Optional: which feature",
    getArgumentCompletions: specCompletions,
    handler: async (args, ctx) => {
      const store = new Store(ctx.cwd);
      const which = args.trim();
      const md = which && KEBAB_NAME.test(which) ? store.readSpec(which) : undefined;
      const session = ctx.sessionManager.getSessionFile();
      if (session) specStarted.set(session, Date.now());
      instruct(`▶ /${cmd("spec")}${which ? ` — ${which}` : ""}`, specPrompt(which, store.specNames(), md ? { name: which, markdown: md } : undefined, store.extra("spec")));
    },
  });

  /** Let the human edit a spec in the editor; it's saved only when it still parses. */

  const editSpec = async (ctx: ExtensionContext, store: Store, name: string) => {
    let md = store.readSpec(name) ?? "";
    for (;;) {
      const edited = await ctx.ui.editor(`Edit ${name} (it must keep the spec format)`, md);
      if (edited === undefined || edited === md) return;
      const { spec, errors } = parseSpec(edited);
      if (!spec) {
        ctx.ui.notify(`Not saved, the spec doesn't parse: ${errors.join("; ")}`, "warning");
        md = edited;
        continue;
      }
      store.writeSpec(name, edited);
      const prev = store.progress(name);
      if (prev) store.saveProgress({ ...prev, tasks: syncTasks(spec, prev.tasks), edited: true });
      // Human edits save on parse alone: the human is the guardrail here, not the model.
      store.event(name, { type: "spec", tasks: spec.tasks.length, gate: spec.gate, newTests: spec.newTests, by: "human" });
      return ctx.ui.notify(`Saved ${store.rel("specs", name, "spec.md")}.`, "info");
    }
  };

  /* --------------------------------- build ------------------------------- */

  /**
   * Snapshot and mark a task as started (a new task gets an undo entry); returns what to tell the agent.
   * inTool: started from pb_task_done, mid-run: the rewind point is set at the end of the turn.
   */

  const beginTask = (
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
        if (appendCheckpoint(list, { id: taskId, at: now(), ...snap, head: gitHead(ctx.cwd), tasks: structuredClone(p.tasks), task: taskId, ...where })) store.saveCheckpoints(p.spec, list);
      }
      // Outside git snapshot() is undefined: no undo point, and /pb:undo already says so. No silent failure.
    }
    tp.status = "doing";
    if (o.countAttempt ?? true) tp.attempts += 1;
    tp.attempts = Math.max(tp.attempts, 1);
    p.current = taskId;
    p.pause = undefined;
    p.phase = "building";
    store.saveProgress(p);
    showProgress(ctx, p);
    return {
      task,
      marker: `▶ ${taskId}: ${task.title}${tp.attempts > 1 ? ` (attempt ${tp.attempts})` : ""}`,
      prompt: stepPrompt(ctx, store, loaded.spec, p, task, tp.attempts),
    };
  };

  /** Coherence pays off once slices can drift: single- and two-task builds skip the pass. */

  const needsCohere = (spec: ParsedSpec) => spec.tasks.length >= COHERE_MIN_TASKS;

  /**
   * Open the coherence pass: snapshot for undo (replacing any stale checkpoint from an undone pass),
   * record the synthetic step, and mark the turn boundary. Callers compose the marker and prompt.
   */

  const beginCohereEntry = (ctx: ExtensionContext, store: Store, p: Progress): void => {
    const { cfg } = commands(ctx.cwd, store);
    if (cfg.checkpoints) {
      const kept = store.checkpoints(p.spec).filter((c) => c.id !== COHERE_TASK_ID);
      const snap = snapshot(ctx.cwd, `pb: before ${p.spec} cohere`);
      if (snap) {
        if (appendCheckpoint(kept, { id: COHERE_TASK_ID, at: now(), ...snap, head: gitHead(ctx.cwd), tasks: structuredClone(p.tasks), task: COHERE_TASK_ID, entry: tree(ctx).getLeafId?.() ?? undefined, pendingEntry: true })) store.saveCheckpoints(p.spec, kept);
      }
    }
    p.tasks.push({ id: COHERE_TASK_ID, title: "Coherence pass: consolidate what slicing split apart", status: "doing", attempts: 1 });
    p.current = COHERE_TASK_ID;
    p.phase = "building";
    p.pause = undefined;
    store.saveProgress(p);
    showProgress(ctx, p);
    runtime.boundary = true;
  };

  const COHERE_MARKER = "▶ coherence pass";

/**
 * A resume buys an exhausted step a fresh set of attempts; any other pause keeps its count.
 * Resets and returns true only when the step had exhausted its budget; the next handout
 * counts the new attempt.
 */
const resetExhausted = (tp: { attempts: number } | undefined, max: number): boolean => {
    const exhausted = (tp?.attempts ?? 0) >= max;
    if (exhausted && tp) tp.attempts = 0;
    return exhausted;
  };

  /**
   * What a task did to existing tests (deleted, fewer cases, new skips) and to earlier tasks' files.
   * Nothing here fails a task: a refactor legitimately moves and merges tests. Test changes are listed
   * at the end of the build and handed to the reviewer, who judges whether each was justified.
   */

  const inspectTask = (ctx: ExtensionContext, store: Store, p: Progress): string[] => {
    const cps = store.checkpoints(p.spec);
    const entry = cps.find((c) => c.id === p.current);
    const start = cps[0];
    const after = entry && store.config().checkpoints ? snapshot(ctx.cwd, `pb: after ${p.spec} ${p.current}`) : undefined;
    if (!entry || !start || !after) return [];
    const others = new Set(cps.filter((c) => c.task && c.task !== p.current).flatMap((c) => c.files ?? []));
    const flags = inspectChanges(ctx.cwd, entry, after, start, others);
    entry.files = changedPaths(ctx.cwd, entry.commit, after.commit);
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
      return stop(withFiles(fixText(p.current!, what, failure, attempts, cfg.maxAttempts, true, specReference(p.spec))));
    }
    if (tp) tp.attempts += 1;
    store.saveProgress(p);
    showProgress(ctx, p);
    return reply(withFiles(fixText(p.current!, what, failure, attempts + 1, cfg.maxAttempts, false, specReference(p.spec))));
  };

  const checkAndAdvance = async (
    ctx: ExtensionContext,
    store: Store,
    p: Progress,
    spec: ParsedSpec,
    signal: AbortSignal | undefined,
    o: { suiteDone?: boolean } = {},
  ): Promise<ReturnType<typeof reply> | ReturnType<typeof stop>> => {
    const final = p.current === "final";
    const { cfg, testCmd, buildCmd, lintCmd, extraCmds } = commands(ctx.cwd, store);
    const each = cfg.taskChecks === "each";
    const task = spec.tasks.find((t) => t.id === p.current);
    const tp = p.tasks.find((t) => t.id === p.current);
    const found = final ? [] : inspectTask(ctx, store, p);

    let failure: string | undefined;
    let what = "";
    // o.suiteDone: the suite passed as the previous step's own check with no work since (the
    // final step was pushed because the last task already ran it) — run only the extra gates.
    // Inferred from lastVerify instead would go stale across later tasks, so callers say so.
    const ran = checkCommand(spec, task, testCmd, buildCmd, final, each);
    const suiteDone = !!final && !!ran && !!o.suiteDone;
    if (ran && !suiteDone) {
      showProgress(ctx, p, `checking ${final ? "everything" : p.current}: ${ran}`);
      p.lastVerify = await withChecking(() => runVerify(ran, ctx.cwd, cfg.verifyTimeoutSec, cfg.testOutputCap, signal));
      store.saveProgress(p);
      if (signal?.aborted) {
        pauseBuild(ctx, store, p, `you stopped the check of ${p.current}.`, "build.paused", "stopped");
        return stop("The check was stopped: the build is paused. Stop here.");
      }
      if (p.lastVerify.ok === false) {
        failure = p.lastVerify.summary;
        what = `\`${ran}\``;
      }
    }
    if (!failure && final) {
      // Lint and the project's own checks gate the end of the build, after the suite: a style,
      // unused or type finding then fails the final check like any other failure. lastVerify
      // keeps the suite's result, so the completion summary still names it.
      for (const cmd of finalExtras(lintCmd, extraCmds)) {
        showProgress(ctx, p, `checking final: ${cmd}`);
        const r = await withChecking(() => runVerify(cmd, ctx.cwd, cfg.verifyTimeoutSec, cfg.testOutputCap, signal));
        if (signal?.aborted) {
          pauseBuild(ctx, store, p, `you stopped the check of ${p.current}.`, "build.paused", "stopped");
          return stop("The check was stopped: the build is paused. Stop here.");
        }
        store.event(p.spec, { type: "check", task: "final", attempt: tp?.attempts ?? 1, ok: r.ok !== false, command: cmd, notices: [] });
        if (r.ok === false) {
          p.lastVerify = r;
          store.saveProgress(p);
          failure = r.summary;
          what = `\`${cmd}\``;
          break;
        }
      }
    }
    store.event(p.spec, { type: "check", task: p.current, attempt: tp?.attempts ?? 1, ok: !failure, command: ran, notices: found });

    if (failure) return failedCheck(ctx, store, p, what, failure);
    return advanceAfterCheck(ctx, store, p, spec, signal, found, ran);
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
    ran: string | null,
  ): Promise<ReturnType<typeof reply> | ReturnType<typeof stop>> => {
    const { cfg, testCmd, buildCmd } = commands(ctx.cwd, store);
    const each = cfg.taskChecks === "each";
    const final = p.current === "final";
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
    const passed = `✓ ${p.current} ${ran ? `passed (\`${ran}\`)` : spec.gate === "none" ? "done (no checks for this feature)" : each ? "done (no check for this task)" : "done (checked after the last task)"}${notices}`;

    // A hand edit to the contract while the check ran: the task stays done, but the build
    // neither hands out another task nor closes against a spec nobody approved.
    const drift = approvalDrift(store, p);
    if (drift) {
      driftStop(ctx, store, p, drift);
      return stop(`${passed}\n\nThe spec's contract changed while ${p.current} was checked: the build is paused. Stop here.`);
    }

    const next = nextTodo(p);
    if (next) {
      const t = beginTask(ctx, store, p, next.id, { inTool: true });
      if (!t) {
        pauseBuild(ctx, store, p, `${store.rel("specs", p.spec, "spec.md")} no longer parses; fix it, then /${cmd("build")}.`, "build.paused", "spec");
        return stop("The spec no longer parses: the build is paused. Stop here.");
      }
      runtime.boundary = true;
      return reply(`${passed}\n\n${t.prompt}`);
    }
    // Every spec task done: on builds big enough to drift, one coherence pass before the final check.
    if (!final && p.current !== COHERE_TASK_ID && !p.tasks.some((t) => t.id === COHERE_TASK_ID) && needsCohere(spec)) {
      beginCohereEntry(ctx, store, p);
      return reply(`${passed}\n\n${COHERE_MARKER}\n\n${coherePrompt(p.baseCommit, 1, cfg.maxAttempts, specReference(p.spec))}`);
    }
    // Every task done: one full check, unless the last task's check was that already.
    // With extra final gates (lint, project checks) the final step still runs even then.
    const endCmd = checkCommand(spec, undefined, testCmd, buildCmd, true, each);
    const { lintCmd, extraCmds } = commands(ctx.cwd, store);
    const extras = finalExtras(lintCmd, extraCmds);
    if (!final && ((endCmd && ran !== endCmd) || extras.length)) {
      p.current = "final";
      p.tasks.push({ id: "final", title: `Final check: ${spec.gate === "tests" ? "full suite" : "compile"}`, status: "doing", attempts: 1 });
      store.saveProgress(p);
      const suiteDone = !!endCmd && ran === endCmd;
      const r = await checkAndAdvance(ctx, store, p, spec, signal, { suiteDone });
      return { ...r, content: text(`${passed}\nRunning \`${endCmd ?? extras[0]}\`…\n\n${r.content[0].text}`) };
    }
    p.tasks = p.tasks.filter((t) => t.id !== "final");
    p.phase = "built";
    p.current = undefined;
    p.nudged = undefined;
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
        commitBlock(commitMessage(store.readSpec(p.spec) ?? "")),
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

  const preBuildChecks = async (
    ctx: ExtensionContext,
    store: Store,
    name: string,
    o: { checked?: boolean; notes?: string[] },
  ) => {
    const notes = o.notes ?? [];
    const loaded = loadSpec(store, name);
    if (!loaded) {
      ctx.ui.notify(`${store.rel("specs", name, "spec.md")} doesn't parse. Rewrite it with /${cmd("spec")} ${name}.`, "error");
      return undefined;
    }
    const { spec, md } = loaded;
    if (spec.status === "planning") {
      ctx.ui.notify(`${name} is still being planned: /${cmd("build")} ${name} finishes it first.`, "warning");
      return undefined;
    }
    const { cfg, testCmd, buildCmd } = commands(ctx.cwd, store);
    if (spec.gate === "tests" && !testCmd) {
      ctx.ui.notify(`Verification is "tests" but no test command is set: set "verify" in ${store.rel("config.json")}, or use Verification: build/none in the spec.`, "warning");
      return undefined;
    }
    if (spec.gate === "build" && !buildCmd) {
      ctx.ui.notify(`Verification is "build" but no build command is set: set "build" in ${store.rel("config.json")}.`, "warning");
      return undefined;
    }
    if (spec.dependsOn) {
      const dep = store.progress(spec.dependsOn)?.phase;
      if (dep !== "built" && dep !== "reviewed") {
        if (!(await agree(ctx, store, `${name} depends on ${spec.dependsOn}, which isn't built yet. Build ${name} anyway?`, notes))) return undefined;
      }
    }
    if (!o.checked && spec.gate === "tests" && baselineApplies(ctx, store, testCmd)) {
      if (!(await agree(ctx, store, baselineQuestion(store.baseline(ctx.sessionManager.getSessionFile() ?? undefined)!), notes))) return undefined;
    }
    if (!o.checked) baselineExtraWarning(ctx, store, testCmd);
    if (!o.checked && !(await reviewPlanningChanges(ctx, store, notes))) return undefined;
    if (!cfg.checkpoints) ctx.ui.notify("Checkpoints are off: this build runs without undo points, and without the test-tampering checks.", "warning");
    return { spec, md, cfg, buildCmd };
  };

  /**
   * Fresh progress for (re)starting a build: finished tasks stay done with their proofs,
   * everything else goes back to todo — attempts included, so a crash grants no fresh budget.
   * Returns the progress and the first unfinished step, or undefined when nothing is left.
   */

  const initBuildProgress = (ctx: ExtensionContext, store: Store, name: string, spec: ParsedSpec, notes: string[]) => {
    const prev = store.progress(name);
    const restart = !!prev && unfinishedPhase(prev.phase);
    const p: Progress = {
      ...prev,
      spec: name,
      phase: "building",
      baseCommit: restart ? (prev!.baseCommit ?? gitHead(ctx.cwd)) : gitHead(ctx.cwd),
      // A task's tests seen failing stay proven: only /pb:undo takes that back, with the files.
      // Attempts are preserved on restart: a crash must not grant a fresh budget. A fresh set comes
      // only from answering an exhausted task via /pb:build guidance (see the build command below).
      tasks: syncTasks(spec, prev?.tasks).map((t) => (t.status === "done" ? t : { ...t, status: "todo" as const })),
      current: undefined,
      pause: undefined,
      nudged: undefined,
      needsIntro: prev?.needsIntro,
      detached: undefined,
      unattended: notes.length ? notes : undefined,
      updatedAt: now(),
    };
    const first = p.tasks.find((t) => t.status !== "done")?.id ?? (needsCohere(spec) && !prev?.tasks.some((t) => t.id === COHERE_TASK_ID && t.status === "done") ? COHERE_TASK_ID : undefined);
    if (!first) {
      ctx.ui.notify(`Every task of ${name} is done. Next: /${cmd("review")} ${name}.`, "info");
      return undefined;
    }
    return { p, first, restart };
  };

  /** The start-of-build undo point, in the session that builds. */

  const saveStartCheckpoint = (c: ExtensionContext, store: Store, name: string, p: Progress, checkpoints: boolean, restart: boolean) => {
    if (!checkpoints || (restart && store.checkpoints(name).length)) return;
    const snap = snapshot(c.cwd, `pb: start of ${name}`);
    const entry = tree(c).getLeafId?.() ?? undefined;
    store.saveCheckpoints(name, snap ? [{ id: "start", at: now(), ...snap, head: p.baseCommit, tasks: structuredClone(p.tasks), entry, intro: true }] : []);
  };

  interface LaunchBuild {
    ctx: ExtensionContext;
    store: Store;
    name: string;
    spec: ParsedSpec;
    md: string;
    p: Progress;
    first: string;
    restart: boolean;
    buildModel: unknown;
    switching: boolean;
    session: string | undefined;
  }

  /** Same session: lift the planning protection, send the build instructions and the first task. */

  const launchBuildHere = async (o: LaunchBuild): Promise<void> => {
    const { ctx, store, name, spec, md, p, first, restart, buildModel, switching, session } = o;
    const { cfg, buildCmd } = commands(ctx.cwd, store);
    if (buildModel && switching) await pi.setModel(buildModel as Parameters<typeof pi.setModel>[0]);
    p.session = session;
    if (!(await liftPlanning(ctx, store))) return;
    // The approval is recorded only once the launch is certain: a failed lift leaves the spec as it was.
    const reapproved = approveSpec(store, p, md, spec);
    store.saveProgress(p);
    saveStartCheckpoint(ctx, store, name, p, cfg.checkpoints, restart);
    store.event(name, { type: "build-start", tasks: spec.tasks.length, gate: spec.gate, fresh: false, taskTexts: spec.tasks.map((t) => t.text) });
    if (reapproved) post(`**Spec re-approved** — ${name}'s contract changed since its build was approved; the build now runs against the revised spec. Tasks already done stay done.`);
    const cohereFirst = first === COHERE_TASK_ID;
    if (cohereFirst) beginCohereEntry(ctx, store, p);
    const task = cohereFirst ? null : beginTask(ctx, store, p, first, { intro: true });
    if (!task && !cohereFirst) return ctx.ui.notify(`${store.rel("specs", name, "spec.md")} no longer parses. Fix it (or /${cmd("spec")} ${name}), then /${cmd("build")}.`, "error");
    const marker = cohereFirst ? COHERE_MARKER : task!.marker;
    const prompt = cohereFirst ? coherePrompt(p.baseCommit, 1, cfg.maxAttempts, specReference(name)) : task!.prompt;
    instruct(
      `▶ Building **${name}** here${switching ? ` on ${cfg.buildModel}` : ""}.\n${marker}`,
      `${buildIntro(name, spec, buildCmd, cfg.taskChecks === "each", standardsFor(ctx), store.extra("build"))}\n\n${prompt}`,
    );
  };

  /** Fresh session: seeded with the spec, on the model and thinking level you planned with. */

  const launchBuildFresh = async (o: LaunchBuild): Promise<void> => {
    const { ctx, store, name, spec, md, p, first, restart, buildModel, switching, session } = o;
    const { cfg, buildCmd } = commands(ctx.cwd, store);
    const cctx = ctx as ExtensionCommandContext;
    const carried = { model: buildModel ? cfg.buildModel : sessionModel(ctx), thinking: pi.getThinkingLevel() as string | undefined };
    store.setCarry({ ...carried, spec: name, parent: session ?? undefined });
    // A new session loads AGENTS.md itself: the standards needn't come along.
    const intro = buildIntro(name, spec, buildCmd, cfg.taskChecks === "each", "", store.extra("build"));
    const result = await cctx.newSession({
      parentSession: session,
      setup: async (sm) => {
        sm.appendSessionInfo(`build: ${name}`);
      },
      withSession: async (c) => {
        // Only `c` from here on: the captured pi and ctx belong to the replaced session.
        // The new session gets a fresh runtime with the default tools, so editing is on.
        p.session = c.sessionManager.getSessionFile();
        const reapproved = approveSpec(store, p, md, spec);
        store.saveProgress(p);
        saveStartCheckpoint(c, store, name, p, cfg.checkpoints, restart);
        if (!cfg.checkpoints) c.ui.notify("Checkpoints are off: this build runs without undo points, and without the test-tampering checks.", "warning");
        store.event(name, { type: "build-start", tasks: spec.tasks.length, gate: spec.gate, fresh: true, taskTexts: spec.tasks.map((t) => t.text) });
        if (reapproved)
          await c.sendMessage(
            { customType: "pb", content: `**Spec re-approved** — ${name}'s contract changed since its build was approved; the build now runs against the revised spec. Tasks already done stay done.`, display: true },
            { triggerTurn: false },
          );
        const cohereFirst = first === COHERE_TASK_ID;
        if (cohereFirst) beginCohereEntry(c, store, p);
        const task = cohereFirst ? null : beginTask(c, store, p, first, { intro: true });
        if (!task && !cohereFirst) {
          pauseBuild(c, store, p, `${store.rel("specs", name, "spec.md")} no longer parses; fix it, then /${cmd("build")}.`, "build.paused", "spec", {}, (content) =>
            c.sendMessage({ customType: "pb", content, display: true }, { triggerTurn: false }),
          );
          return;
        }
        const prompt = cohereFirst ? coherePrompt(p.baseCommit, 1, cfg.maxAttempts, specReference(name)) : task!.prompt;
        await c.sendMessage(
          {
            customType: "pb",
            content: `▶ Building **${name}** from ${store.rel("specs", name, "spec.md")}${carried.model ? `, on ${carried.model}` : ""}${carried.thinking ? `, thinking ${carried.thinking}` : ""}.\nThis session: "build: ${name}" · back to it with /resume, or \`pi --session ${c.sessionManager.getSessionId()}\`\n${cohereFirst ? COHERE_MARKER : task!.marker}`,
            display: true,
          },
          { triggerTurn: false },
        );
        // Not awaited: the build runs on in this session while the command returns.
        void c.sendMessage({ customType: "pb-instruction", content: `${intro}\n\n${prompt}`, display: false }, { triggerTurn: true });
      },
    }).catch((e) => {
      store.clearCarry(); // a throw must not leave the handover behind either
      throw e;
    });
    if (result.cancelled) {
      store.clearCarry(); // its handover must not leak into a later, unrelated new session
      if (!sessionGone(ctx)) ctx.ui.notify("Build cancelled.", "info");
    }
  };

  /**
   * Fresh eyes on the plan before the first task: one independent pass over the frozen draft that
   * attacks Decisions, re-tests rejected alternatives and flags unmeasured claims. The pass records
   * the hash of exactly the text it saw; only a P0 blocks, and a later start reuses that verdict
   * until the spec text changes.
   */

  const runSpecReview = async (ctx: ExtensionContext, store: Store, name: string, md: string): Promise<{ findings: Finding[]; block: boolean; session?: string; prose?: string; ms: number }> => {
    const cfg = store.config();
    const reviewModel = cfg.specReviewer.model ?? sessionModel(ctx);
    const cwd = ctx.cwd;
    const reviewBefore = snapshot(cwd, "pb: before spec-review");
    post(`▶ **Spec review** — one fresh reviewer checks **${name}** before T1; the verdict lands here.`);
    const started = Date.now();
    let lastStep: string | undefined;
    const paint = () => safely(() => ctx.ui.setWidget("pb-spec-review", [`pb spec-review ${name} · ${Math.round((Date.now() - started) / 1000)}s`, ...(lastStep ? [`  ↳ ${lastStep}`] : [])]));
    paint();
    const beat = watchable(ctx) ? setInterval(paint, 1000) : undefined;
    let res: Awaited<ReturnType<typeof runFresh>>;
    try {
      res = await runFresh({
        cwd,
        role: "spec-review",
        systemPrompt: SPEC_REVIEWER_SYSTEM,
        brief: specReviewBrief(name, md),
        prompt: "Review the spec in the attached file.",
        // `--tools` is the whole selection, extension tools included: without report_findings named
        // here the reviewer has no way to report and every pass fails closed.
        tools: ["read", "grep", "find", "ls", "report_findings"],
        extensions: [REVIEW_TOOLS],
        model: reviewModel,
        thinking: cfg.specReviewer.thinking,
        maxConcurrent: cfg.maxConcurrent,
        sessionDir: store.sessionsDir("spec-review"),
        onActivity: (line) => {
          lastStep = line;
          paint();
        },
      });
    } finally {
      if (beat !== undefined) clearInterval(beat);
      safely(() => ctx.ui.setWidget("pb-spec-review", undefined));
      revertFreshRun(cwd, (m) => warnLater(ctx, m), "the spec reviewer", reviewBefore, snapshot(cwd, "pb: after spec-review"));
    }
    const call = res.toolCalls.filter((c) => c.name === "report_findings").at(-1);
    const raw = call && Array.isArray(call.arguments.findings) ? call.arguments.findings : undefined;
    const findings: Finding[] = (raw ?? []).flatMap((item) => {
      const f = item as { priority?: unknown; title?: unknown; file?: unknown; line?: unknown; fix?: unknown };
      if (typeof f.title !== "string" || !f.title.trim() || (f.priority !== "P0" && f.priority !== "P1" && f.priority !== "P2" && f.priority !== "P3")) return [];
      return [{
        priority: f.priority,
        title: f.title.trim(),
        ...(typeof f.file === "string" && f.file.trim() ? { file: f.file.trim() } : {}),
        ...(typeof f.line === "number" && Number.isFinite(f.line) ? { line: f.line } : {}),
        ...(typeof f.fix === "string" && f.fix.trim() ? { fix: f.fix.trim() } : {}),
      }];
    });
    const session = res.sessionFile;
    if (raw === undefined) {
      const prose = cap(res.text || res.error || "the reviewer returned no findings", 12000);
      store.event(name, { type: "spec-review", verdict: "error", hash: specHash(md), findings: 0, reported: [], model: reviewModel, thinking: cfg.specReviewer.thinking, session, prose, ms: res.ms });
      // The reviewer's own words are the only thing the human can act on: a pass that wrote its whole
      // report as prose did the work, and losing it would leave a dead end with nothing to read.
      return { findings: [], block: true, session, ms: res.ms, ...(prose.trim() ? { prose: cap(prose.trim(), 2000) } : {}) };
    }
    const block = findings.some((f) => f.priority === "P0");
    store.event(name, { type: "spec-review", verdict: block ? "block" : "pass", hash: specHash(md), findings: findings.length, reported: findings, model: reviewModel, thinking: cfg.specReviewer.thinking, session, ms: res.ms });
    return { findings, block, session, ms: res.ms };
  };

  /**
   * One review pass per spec text: a pass or block on this hash is reused; editing the spec makes
   * the next build start review the new text. Only P0 blocks; P1-P3 are advisory.
   */

  const ensureSpecReviewed = async (ctx: ExtensionContext, store: Store, name: string, md: string): Promise<boolean> => {
    const hash = specHash(md);
    const parsed = parseSpec(md).spec;
    const criteria = acceptanceCriteria(md, parsed).length;
    const assumptions = assumptionsOf(md).length;
    const scope = [parsed ? `${parsed.tasks.length} task${parsed.tasks.length === 1 ? "" : "s"}` : "", criteria ? `${criteria} acceptance line${criteria === 1 ? "" : "s"}` : "", assumptions ? `${assumptions} assumption${assumptions === 1 ? "" : "s"}` : ""];
    const last = readEvents(path.join(store.specDir(name), "events.jsonl"))
      .filter((e) => e.type === "spec-review" && (e.verdict === "pass" || e.verdict === "block") && e.hash === hash)
      .at(-1);
    if (last?.verdict === "block") {
      const findings = Array.isArray(last.reported) ? (last.reported as Finding[]) : [];
      const p0 = findings.filter((f) => f.priority === "P0").length;
      post([
        phaseHeader("❌", "Spec review", name, "FAIL", p0 ? `P0 ${p0}` : "", typeof last.ms === "number" ? duration(last.ms) : ""),
        "",
        nextLine(`fix the spec with \`/${cmd("spec")} ${name}\`, then \`/${cmd("build")}\`.`),
        evidenceLine("the P0 blocks T1; nothing was built", "the recorded pass covers this text"),
        "",
        ...(findings.length ? findings.map((f) => findingLine(f)) : ["The reviewer's answer could not be read as findings."]),
      ].join("\n"));
      ctx.ui.notify("❌ Spec review blocks T1 on a P0: fix the spec — the changed contract is reviewed again — or stop here.", "warning");
      return false;
    }
    if (last?.verdict === "pass") return true;
    const review = await runSpecReview(ctx, store, name, md);
    if (sessionGone(ctx)) return false;
    if (store.readSpec(name) !== md) {
      ctx.ui.notify(`The spec changed while it was under review: run /${cmd("build")} again and the new text will be reviewed.`, "warning");
      return false;
    }
    const sessionNote = review.session ? `The whole run: \`pi --session ${path.relative(ctx.cwd, review.session)}\`.` : "";
    if (review.block && !review.findings.length) {
      post([
        phaseHeader("❌", "Spec review", name, "FAIL", "no report", review.ms !== undefined ? duration(review.ms) : ""),
        "",
        nextLine(`\`/${cmd("build")}\` to try again, or point the reviewer at a model that reports: \`"specReviewer": {"model": "provider/id"}\` in ${store.rel("config.json")}.`),
        evidenceLine("the reviewer returned no findings through its tool", "nothing was recorded"),
        ...(review.prose ? ["", `What it wrote instead:\n\n${review.prose}`] : []),
        ...(sessionNote ? ["", sessionNote] : []),
      ].join("\n"));
      ctx.ui.notify("❌ Spec review did not report; nothing was recorded. Run the build again, or point specReviewer.model at a model that reports.", "warning");
      return false;
    }
    if (review.findings.length) {
      const p0 = review.findings.filter((f) => f.priority === "P0");
      const rest = review.findings.filter((f) => f.priority !== "P0");
      const counts = P_ORDER.map((k) => review.findings.filter((f) => f.priority === k).length);
      const tally = counts.map((c, n) => `P${n} ${c}`).join(" · ");
      const sections = [
        phaseHeader(review.block ? "❌" : "✅", "Spec review", name, review.block ? "FAIL" : "PASS", tally, review.ms !== undefined ? duration(review.ms) : ""),
        "",
        nextLine(review.block ? `fix the spec with \`/${cmd("spec")} ${name}\`, then \`/${cmd("build")}\`.` : "T1 starts next."),
        evidenceLine(...scope, review.block ? "the P0 blocks T1; nothing was built" : "the recorded pass covers this text; P1-P3 do not block"),
      ];
      if (p0.length) sections.push("", "**P0**", "", ...p0.map((f) => findingLine(f)));
      if (rest.length) sections.push("", "**Advisory**", "", ...rest.map((f) => findingLine(f)));
      if (sessionNote) sections.push("", sessionNote);
      post(sections.join("\n"));
    } else {
      post([
        phaseHeader("✅", "Spec review", name, "PASS", "no findings", review.ms !== undefined ? duration(review.ms) : ""),
        "",
        nextLine("T1 starts next."),
        evidenceLine(...scope, "the recorded pass covers this text"),
        ...(sessionNote ? ["", sessionNote] : []),
      ].join("\n"));
    }
    if (review.block) {
      ctx.ui.notify("❌ Spec review blocks T1 on a P0: fix the spec — the changed contract is reviewed again — or stop here.", "warning");
      return false;
    }
    if (review.findings.length) ctx.ui.notify(`✅ Spec review passed with ${review.findings.length} advisory finding${review.findings.length === 1 ? "" : "s"} (shown above); building now.`, "info");
    return true;
  };

  /**
   * Start building a spec. In this session by default: the conversation that planned it
   * stays, and the prompt cache with it. `fresh` opens a new session seeded with the spec
   * instead (command context only: sessions can't be replaced from event handlers).
   * decided: the human already chose where (the spec-approval dialog).
   */

  const startBuild = async (
    ctx: ExtensionContext,
    store: Store,
    name: string,
    fresh: boolean,
    o: { decided?: boolean; checked?: boolean; notes?: string[] } = {},
  ): Promise<void> => {
    // An explicit build consumes the pending offer either way: a record that survived it would
    // keep agent_settled's stop-pause from firing for this session until the record expired.
    const here = ctx.sessionManager.getSessionFile();
    if (here) store.clearPendingBuild(here);
    const notes = o.notes ?? [];
    const checked = await preBuildChecks(ctx, store, name, o);
    if (!checked) return;
    const { spec, md, cfg } = checked;

    if (!(await ensureSpecReviewed(ctx, store, name, md))) return;
    const buildModel = cfg.buildModel ? findModel(ctx, cfg.buildModel) : undefined;
    const switching = !!buildModel && cfg.buildModel !== sessionModel(ctx);
    const canOpenSession = typeof (ctx as Partial<ExtensionCommandContext>).newSession === "function";
    if (!fresh && !o.decided) {
      const usage = ctx.getContextUsage()?.percent;
      const full = usage != null && usage > cfg.freshAbove;
      if ((full || switching) && ctx.hasUI) {
        const why = switching ? `building on ${cfg.buildModel} here sends this whole conversation to it again, uncached` : `this session is ${Math.round(usage!)}% full`;
        const FRESH = "Build in a fresh session, from the spec (recommended)";
        const HERE = "Build here anyway";
        const choice = await choose(ctx, store, `Build ${name}: ${why}`, [FRESH, HERE], canOpenSession ? FRESH : HERE, notes);
        if (!choice) return;
        fresh = choice === FRESH;
      } else if (switching) fresh = true;
    }
    if (fresh && !canOpenSession) {
      ctx.ui.setEditorText(`/${cmd("build")} ${name} --fresh`);
      return ctx.ui.notify(`Press Enter to build ${name} in a fresh session.`, "info");
    }

    const session = ctx.sessionManager.getSessionFile();
    // The review covered the text it read, and the placement dialog can take a while: approve
    // only the text that was reviewed, so an edit in between starts a new review instead of
    // riding in on the old one. (The seconds between here and a fresh session's approval stay
    // uncovered; the dialog is the window a human edit actually needs.)
    const reviewed = store.readSpec(name);
    if (reviewed === undefined || specHash(reviewed) !== specHash(md)) {
      return ctx.ui.notify(`The spec changed while it was under review: run /${cmd("build")} again and the new text will be reviewed.`, "warning");
    }
    const init = initBuildProgress(ctx, store, name, spec, notes);
    if (!init) {
      // Nothing left to build: /pb:build still re-approves a revised contract, so the review
      // that follows judges the code against the spec as it stands.
      const prev = store.progress(name);
      if (prev) {
        const reapproved = approveSpec(store, prev, md, spec);
        store.saveProgress({ ...prev, updatedAt: now() });
        if (reapproved)
          post(`**Spec re-approved** — ${name}'s contract changed since its build was approved; nothing is left to build, and the review now judges the code against the spec as it stands.`);
      }
      return;
    }
    const launch = { ctx, store, name, spec, md, p: init.p, first: init.first, restart: init.restart, buildModel, switching, session };
    if (!fresh) return launchBuildHere(launch);
    return launchBuildFresh(launch);
  };

  /** The spec that was just written: its tasks in the session, the whole of it as a view (not sent to the model: it wrote it). */
  /** A commit message to paste, shown wherever the work may end: after the build, the review and the archive. */

  const baselineApplies = (ctx: ExtensionContext, store: Store, testCmd: string | null | undefined) => {
    const b = store.baseline(ctx.sessionManager.getSessionFile() ?? undefined);
    // A red baseline blocks the build only when it describes this commit; a newer HEAD may already have fixed it.
    // No head (outside git): nothing to compare against, so block conservatively.
    return b?.ok === false && b.command === testCmd && (!b.head || b.head === gitHead(ctx.cwd));
  };

  const baselineQuestion = (b: { summary: string; at: string }) =>
    `The test suite already failed when planning began (${b.summary.split("\n")[0]}, ${b.at}): the final check runs it, so it fails too unless that's fixed. Build anyway?`;

  /**
   * Lint/project checks red at baseline warn only, never block: the baseline alone must not stop
   * a build — only an actual final-gate failure sends the agent back. Same-commit only, like the suite.
   */

  const baselineExtraWarning = (ctx: ExtensionContext, store: Store, testCmd: string | null | undefined) => {
    const b = store.baseline(ctx.sessionManager.getSessionFile() ?? undefined);
    if (!b || b.command !== testCmd || (b.head && b.head !== gitHead(ctx.cwd))) return;
    const red = [...(b.lint && b.lint.ok === false ? [`lint \`${b.lint.command}\` (${b.lint.summary.split("\n")[0]})`] : []), ...(b.extra ?? []).filter((e) => e.ok === false).map((e) => `\`${e.command}\` (${e.summary.split("\n")[0]})`)];
    if (red.length) ctx.ui.notify(`Lint/project checks already failed when planning began (${red.join("; ")}): the final gate runs them too, so it fails until that's fixed.`, "warning");
  };

  /** The specs this session has written, ready to build, first those nothing else among them depends on. */

  /**
   * The reply's last block is a contract ("End your reply with this block, verbatim"), so the
   * stop-instruction goes before it, never after — a prompt must not end by contradicting itself.
   */

  const withStopBeforeTip = (prompt: string, stop: string): string => {
    const key = tip("spec.next");
    const at = key ? prompt.lastIndexOf(key) : -1;
    return at > 0 ? `${prompt.slice(0, at)}${stop}\n\n${prompt.slice(at)}` : `${prompt}\n\n${stop}`;
  };

  const specThenBuild = async (ctx: ExtensionCommandContext, store: Store, marker: string, prompt: string) => {
    const session = ctx.sessionManager.getSessionFile();
    const { cfg, testCmd } = commands(ctx.cwd, store);
    const notes: string[] = [];
    if (!(await reviewPlanningChanges(ctx, store, notes))) return;
    const baseline = store.baseline(session ?? undefined);
    if (baselineApplies(ctx, store, testCmd) && !(await agree(ctx, store, baselineQuestion(baseline!), notes))) return;

    const usage = ctx.getContextUsage()?.percent;
    const switching = !!cfg.buildModel && cfg.buildModel !== sessionModel(ctx) && !!findModel(ctx, cfg.buildModel);
    const preferFresh = switching || (usage != null && usage > cfg.freshAbove);
    const HERE = "Build here as soon as the spec is written (keeps our discussion; the cache stays warm)";
    const FRESH = `Build in a fresh session as soon as the spec is written (${switching ? `on ${cfg.buildModel}, ` : ""}lean context)`;
    const SHOW = "Show me the spec first";
    const options = preferFresh ? [FRESH, HERE, SHOW] : [HERE, FRESH, SHOW];
    const choice = await choose(ctx, store, "Pi writes the spec first. Then?", options, options[0], notes);
    if (!choice) return;
    if (choice === SHOW) {
      if (session) specStarted.set(session, Date.now());
      store.setPendingBuild(session);
      return instruct(marker, withStopBeforeTip(prompt, "After writing it, stop: the harness shows it to me and asks whether to build."));
    }

    const since = now();
    if (session) specWriting.add(session);
    if (session) specStarted.set(session, Date.now());
    instruct(marker, withStopBeforeTip(prompt, "After writing it, stop: the build starts by itself."));
    // Wait for the spec here, in the command: the run starts right after this handler hands it over.
    // Capped: on timeout the pending offer below picks the spec up once it is written.
    // The human may move on while waiting: a dead session ends the wait quietly (nothing is
    // consumed, so a later /pb:build still offers the spec).
    try {
      for (let i = 0; i < 40 && ctx.isIdle(); i++) await new Promise((r) => setTimeout(r, 50));
      if (cfg.specWaitSec > 0) await Promise.race([ctx.waitForIdle(), sleep(cfg.specWaitSec * 1000)]);
      else await ctx.waitForIdle();
    } catch (e) {
      if (!sessionGone(ctx)) throw e;
    } finally {
      if (session) specWriting.delete(session);
    }
    if (sessionGone(ctx)) return;
    const ready = readySpecs(store, session, since);
    if (!ready.length) {
      // A question in chat, or the spec isn't ready yet: pb offers the build once it is.
      store.setPendingBuild(session);
      const finished = store.specNames().filter((n) => {
        const p = store.progress(n);
        return !!p && p.writtenIn === session && ["built", "reviewed"].includes(p.phase ?? "");
      });
      const hint = finished.length
        ? ` Note: ${finished.map((n) => `\`${n}\` is already ${store.progress(n)?.phase}`).join("; ")} — to change it again, write a new spec: rewriting a finished spec keeps its done state.`
        : "";
      return post(`No spec ready to build yet. Answer Pi's questions; once the spec is written, pb shows it and asks how to build.${hint}`);
    }
    const dry = await dryRunTests(ctx, store, ready[0]);
    if (sessionGone(ctx)) return; // replaced during the dry run: a later /pb:build still offers the spec
    showSpec(store, ready[0], {
      names: ready,
      next: choice === FRESH ? "the build starts in a fresh session; one fresh reviewer checks the spec before T1." : "the build starts here; one fresh reviewer checks the spec before T1.",
      extra: dry,
    });
    await startBuild(ctx, store, ready[0], choice === FRESH, { decided: true, checked: true, notes });
  };

  /** After /pb:build asked for the spec: once it's written, show it and ask how to go on. */

  const recordGuidance = (store: Store, name: string, text: string): boolean => {
    if (!text.trim()) return true;
    return !appendDecision(store, name, text.trim(), "guidance");
  };

  /** "3h ago" style staleness for a progress updatedAt ("2026-10-01 10:00:00", UTC like Store.now()). */

  const offerPendingBuild = async (ctx: ExtensionContext): Promise<boolean> => {
    const store = new Store(ctx.cwd);
    const session = ctx.sessionManager.getSessionFile();
    if (!store.pendingBuild(session)) return false;
        const names = readySpecs(store, session);
    if (!names.length) return true; // still talking (e.g. a question before writing): keep waiting
    if (session) store.clearPendingBuild(session);
    const name = names[0];
    const loaded = loadSpec(store, name);
    if (!loaded) return true;
    const { spec } = loaded;
    const dry = await dryRunTests(ctx, store, name);
    if (sessionGone(ctx)) {
      // Replaced during the dry run: offer again on a later turn instead of dying mid-offer.
      if (session) store.setPendingBuild(session);
      return true;
    }
    showSpec(store, name, {
      names,
      next: ctx.hasUI ? "choose how to build: here or in a fresh session — or edit the spec first." : `\`/${cmd("build")} ${name}\` builds it here.`,
      extra: dry,
    });
    if (!ctx.hasUI) {
      post(tip("spec.next"));
      return true;
    }
    const cfg = store.config();
    const usage = ctx.getContextUsage()?.percent;
    const switching = !!cfg.buildModel && cfg.buildModel !== sessionModel(ctx) && !!findModel(ctx, cfg.buildModel);
    const preferFresh = switching || (usage != null && usage > cfg.freshAbove);
    const HERE = "Build here (keeps our discussion; the cache stays warm)";
    const FRESH = `Build in a fresh session, from the spec (${switching ? `on ${cfg.buildModel}, ` : ""}lean context)`;
    const EDIT = "Edit the spec first";
    const LATER = "Not now";
    const notes: string[] = [];
    for (;;) {
      // Unanswered, it builds here: a fresh session can't be opened from here, only from a command.
      const choice = await choose(ctx, store, `Build ${name} now? ${spec.tasks.length} tasks`, preferFresh ? [FRESH, HERE, EDIT, LATER] : [HERE, FRESH, EDIT, LATER], HERE, notes);
      if (sessionGone(ctx)) {
        // Replaced while deciding: offer again on a later turn instead of dying mid-offer.
        if (session) store.setPendingBuild(session);
        return true;
      }
      if (choice === EDIT) {
        await editSpec(ctx, store, name);
        continue;
      }
      if (choice === HERE) await startBuild(ctx, store, name, false, { decided: true, notes });
      else if (choice === FRESH) await startBuild(ctx, store, name, true, { decided: true, notes });
      else post(tip("spec.next"));
      return true;
    }
  };

  /**
   * Leave planning mode for a build (or for good): show files bash wrote while planning,
   * then clear the planning state and its widget. False = the human cancelled.
   */

  pi.on("agent_settled", async (_e, ctx) => {
    if (await offerPendingBuild(ctx)) return;
    const { store, progress: p } = specOfSession(ctx);
    if (p?.phase === "building") pauseBuild(ctx, store, p, "the agent stopped without finishing its task (you stopped it, or it stopped again after a reminder).", "build.paused", "stopped");
    // bash can write where edit and write are blocked: say what changed as soon as the turn ends,
    // not only when planning stops, so a stray write is caught while its cause is still fresh.
    const session = ctx.sessionManager.getSessionFile();
    const snapshotAtStart = session && store.planningSessions().includes(session) ? store.planning(session)?.snapshot : undefined;
    if (!session || !snapshotAtStart) return;
    const current = snapshot(ctx.cwd, "pb: planning turn");
    const files = current ? changedPaths(ctx.cwd, snapshotAtStart, current.commit) : [];
    const key = [...files].sort().join("\n");
    if (files.length && planningWriteNotes.get(session) !== key) {
      planningWriteNotes.set(session, key);
      const list = `${files.slice(0, 10).join(", ")}${files.length > 10 ? ` … (+${files.length - 10})` : ""}`;
      post(`**Changed while planning** — these project files differ from when planning began: ${list}\n\nCommands may write where edits are blocked. Nothing is lost: \`/${cmd("plan")} off\` or the build start offers to keep or restore them.`);
    } else if (!files.length) planningWriteNotes.delete(session);
  });

  /*
   * At the end of a turn: rewind points for tasks started mid-run, and the build's reset. Right after a task
   * passed and the next was handed out, past checkpointAt, the session is reset to the build's state: the
   * finished task is done and summarized, the next hasn't started, so nothing half-done is lost (unlike a
   * compaction in the middle of a task). No summarizing model call.
   */

  /**
   * What the resume confirm shows the human: every block the contract binds — everything but
   * Design and Decisions, which the build itself may change — as it was approved and as it
   * stands now, each side capped so the dialog stays readable.
   */

  const contractDiff = (store: Store, name: string, md: string): string => {
    const approved = store.readApprovedSpec(name);
    if (approved === undefined) return `No approved copy on file: the build would run against ${store.rel("specs", name, "spec.md")} as it stands now.`;
    const label = (key: string) => (key === "header" ? "the header (Status, Depends on)" : `## ${key.replace(/^section:/, "")}`);
    const was = new Map(specTextBlocks(approved).map((b) => [b.key, b.text]));
    const changed = specTextBlocks(md).filter((b) => b.key !== "section:design" && b.key !== "section:decisions" && was.get(b.key) !== b.text);
    const body = changed
      .map((b) => [label(b.key), "--- approved ---", cap(was.get(b.key) ?? "(absent)", 700), "--- now ---", cap(b.text, 700)].join("\n"))
      .join("\n\n");
    return `${changed.map((b) => label(b.key)).join(", ")}\n\n${body}`;
  };

  pi.registerCommand(cmd("build"), {
    description: "Build the planned feature here, task by task (the full check runs after the last task; writes the spec first if there isn't one). --fresh builds in a new session. In a paused build: continue, optionally with guidance",
    getArgumentCompletions: (prefix: string) => [{ value: "--fresh", label: "--fresh" }, ...specCompletions(prefix)].filter((c) => c.value.startsWith(prefix)),
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) return ctx.ui.notify("Pi is busy. Wait for the current turn to finish.", "warning");
      const store = new Store(ctx.cwd);
      const fresh = /(^|\s)--fresh(\s|$)/.test(args);
      const words = args.replace(/(^|\s)--fresh(?=\s|$)/g, " ").trim().split(/\s+/).filter(Boolean);
      const session = ctx.sessionManager.getSessionFile();
      const { cfg, buildCmd } = commands(ctx.cwd, store);

      // The name is the only user string that reaches path.join, and store.specDir refuses anything
      // that isn't a valid spec name (or a folder already under specs/). Here the arg counts as a
      // name only when valid; a path-like or legacy-named arg is refused, not read or reinterpreted.
      if (words[0] && !KEBAB_NAME.test(words[0])) {
        const near = normSpecArg(words[0]);
        const hit = near !== "off" && KEBAB_NAME.test(near) ? store.specNames().filter((n) => n === near) : [];
        if (hit.length === 1 && store.readSpec(hit[0])) {
          return ctx.ui.notify(
            `\`${words[0]}\` isn't a spec name (spec names are lowercase with hyphens). Did you mean \`${hit[0]}\`? \`/${cmd("build")} ${hit[0]}\` continues it; to start something else, describe it without a leading name.`,
            "warning",
          );
        }
        if (/[/\\]/.test(words[0]) || store.readSpec(words[0])) {
          return ctx.ui.notify(`\`${words[0]}\` isn't a valid spec name (spec names are lowercase with hyphens). To build, name a spec exactly as written.`, "warning");
        }
      }

      // This session has an unfinished build: continue it — unless a different spec was named.
      const here = specOfSession(ctx);
      const named = words[0] && KEBAB_NAME.test(words[0]) && store.readSpec(words[0]) ? words[0] : undefined;
      if (here.name && here.progress && unfinishedPhase(here.progress.phase) && (!named || named === here.name)) {
        const p = here.progress;
        if (fresh) ctx.ui.notify("`--fresh` only applies when starting a build: continuing here instead.", "warning");
        // Resuming lifts planning protection: a /pb:plan or /pb:deps after the pause turned it back on.
        if (!(await liftPlanning(ctx, store))) return;
        // The spec name itself isn't guidance: only what follows it is.
        const guidance = (named ? words.slice(1) : words).join(" ");
        if (guidance && !recordGuidance(store, p.spec, guidance)) {
          ctx.ui.notify("Guidance not recorded: it would leave the spec unparseable.", "warning");
        }
        const from = guidance ? `\n\nFrom the human: ${guidance}` : "";
        // A resume approves the spec as it stands — but only a revision the human has seen. The
        // model gets turns while paused too, so "a contract edited while paused is the human's
        // revision" was an assumption: show what changed and ask, instead of inheriting it.
        const live = loadSpec(store, p.spec);
        if (!live) return ctx.ui.notify(`${store.rel("specs", p.spec, "spec.md")} doesn't parse. Fix it (or /${cmd("spec")} ${p.spec}), then /${cmd("build")}.`, "error");
        if (p.approval && contractHash(live.md) !== p.approval.contractHash && ctx.hasUI) {
          if (!(await ctx.ui.confirm(`${p.spec}'s contract changed while the build was paused`, contractDiff(store, p.spec, live.md)))) {
            return ctx.ui.notify("Not re-approved: the build stays paused. Edit the spec (or /" + cmd("spec") + ` ${p.spec}), then /${cmd("build")} again.`, "warning");
          }
        }
        const reapproved = approveSpec(store, p, live.md, live.spec);
        store.saveProgress(p);
        if (reapproved) post(`**Spec re-approved** — ${p.spec}'s contract changed while the build was paused; it now runs against the revised spec. Tasks already done stay done.`);
        if (p.current === "final") {
          const fin = p.tasks.find((t) => t.id === "final");
          resetExhausted(fin, cfg.maxAttempts);
          const attempt = (fin?.attempts ?? 0) + 1;
          if (fin) fin.attempts = attempt;
          p.phase = "building";
          p.pause = undefined;
          store.saveProgress(p);
          showProgress(ctx, p);
          const finalFiles = changedFilesSection(store, p);
          return instruct("▶ final check", fixText("final", `\`${p.lastVerify?.command ?? "the full suite"}\``, p.lastVerify?.summary ?? "", attempt, cfg.maxAttempts, false, specReference(p.spec)) + (finalFiles ? `\n${finalFiles}` : "") + from);
        }
        if (p.current === COHERE_TASK_ID) {
          const cc = p.tasks.find((t) => t.id === COHERE_TASK_ID);
          if (!cc) {
            beginCohereEntry(ctx, store, p);
            return instruct(COHERE_MARKER, `${coherePrompt(p.baseCommit, 1, cfg.maxAttempts, specReference(p.spec))}${from}`);
          }
          resetExhausted(cc, cfg.maxAttempts);
          const attempt = cc.attempts + 1;
          cc.attempts = attempt;
          p.phase = "building";
          p.pause = undefined;
          store.saveProgress(p);
          showProgress(ctx, p);
          return instruct("▶ coherence pass", `${coherePrompt(p.baseCommit, attempt, cfg.maxAttempts, specReference(p.spec))}${from}`);
        }
        // p.current can name a task the list no longer has: a spec rewrite or human edit renamed
        // it. Only a live, undone task keeps its claim; anything else resumes at the next todo,
        // so a stale id reads as "continue", not as "nothing left to build".
        const claimed = p.current !== undefined && p.tasks.some((t) => t.id === p.current && t.status !== "done");
        const cur = claimed ? p.current : nextTodo(p)?.id;
        const tp = p.tasks.find((t) => t.id === cur);
        const loaded = live;
        // Undone past the coherence pass (or a restart that dropped it): all spec tasks done, pass pending.
        if ((!cur || !tp) && needsCohere(loaded.spec) && !p.tasks.some((t) => t.id === COHERE_TASK_ID)) {
          beginCohereEntry(ctx, store, p);
          return instruct(COHERE_MARKER, `${coherePrompt(p.baseCommit, 1, cfg.maxAttempts, specReference(p.spec))}${from}`);
        }
        if (!cur || !tp) return ctx.ui.notify("Nothing left to build here.", "info");
        // Your answer to a task that kept failing buys it a fresh set of attempts; other pauses cost none.
        const exhausted = resetExhausted(tp, cfg.maxAttempts);
        const again = exhausted || tp.status === "todo";
        const intro = !!p.needsIntro;
        p.needsIntro = undefined;
        const t = beginTask(ctx, store, p, cur, { countAttempt: again, intro });
        if (!t) return ctx.ui.notify(`${store.rel("specs", p.spec, "spec.md")} doesn't parse. Fix it (or /${cmd("spec")} ${p.spec}), then /${cmd("build")}.`, "error");
        const body = intro
          ? `${buildIntro(p.spec, loaded.spec, buildCmd, cfg.taskChecks === "each", standardsFor(ctx), store.extra("build"))}\n\n${t.prompt}`
          : again
            ? t.prompt
            : continuePrompt(t.task);
        return instruct(t.marker, body + from);
      }

      // Building without a /pb:plan first: the standards are offered here instead.
      await offerStandards(ctx, store);

      // Which spec: a named one; else the ones this session wrote; else any ready one.
      const phaseOf = (n: string) => store.progress(n)?.phase ?? "written";
      const offered = store.specNames().filter((n) => phaseOf(n) === "written" || unfinishedPhase(phaseOf(n)));
      let name = words[0] && KEBAB_NAME.test(words[0]) && store.readSpec(words[0]) ? words[0] : undefined;
      if (!name) {
        const mine = offered.filter((n) => store.progress(n)?.writtenIn === session);
        const planning = !!session && store.planningSessions().includes(session);
        if (!mine.length && (planning || !offered.length)) {
          // No spec from this discussion yet: write it first, then build it.
          return specThenBuild(ctx, store, `▶ /${cmd("build")} — writing the spec first`, specPrompt(words.join(" "), store.specNames(), undefined, store.extra("spec")));
        }
        const pool = mine.length ? mine : offered;
        const labelOf = (n: string) => {
          const bits: string[] = [];
          const owner = store.progress(n)?.session ?? store.progress(n)?.writtenIn;
          if (owner && owner !== session) bits.push("from another session");
          if (unfinishedPhase(phaseOf(n))) bits.push("restart the build, finished tasks stay done");
          return bits.length ? `${n} (${bits.join("; ")})` : n;
        };
        if (pool.length === 1 || !ctx.hasUI) name = pool[0];
        else {
          const labels = pool.map(labelOf);
          const choice = await ctx.ui.select("Build which spec?", labels);
          name = choice ? pool[labels.indexOf(choice)] : undefined;
        }
        if (!name) return;
      }
      if (!(await confirmLiveBuild(ctx, store, name, ["building"], "Restart it here — finished tasks stay done?"))) return;
      if (loadSpec(store, name)?.spec.status === "planning") {
        // A checkpoint of an unfinished discussion: finish it (tasks, verification), then build it.
        return specThenBuild(ctx, store, `▶ /${cmd("build")} — finishing the spec ${name} first`, finishSpecPrompt(name, store.extra("spec")).replace(/\s*After writing it, stop:[^\n]*/, ""));
      }
      if (words[0] === name && words.length > 1) {
        // Trailing words with a named spec are guidance (as on resume); without a name
        // they are the new spec's topic, not guidance.
        if (!recordGuidance(store, name, words.slice(1).join(" "))) {
          ctx.ui.notify("Guidance not recorded: it would leave the spec unparseable.", "warning");
        }
      }
      await startBuild(ctx, store, name, fresh);
    },
  });

  /* -------------------------------- review ------------------------------- */
}
