/**
 * pi-plan-build (pb): plan a feature with Pi, turn it into a spec, build it task by task
 * behind checks the harness runs, and have it reviewed with fresh eyes.
 *
 *   /pb:plan <what you want> plan together; the project's files stay untouched (/pb:plan <spec>: continue one)
 *   /pb:compact [undo]     planning: write the plan to its spec and reset to it; build: compact to the build's state
 *   /pb:spec [which]       write or revise the spec(s) from the discussion
 *   /pb:build [name]       build a spec here (--fresh: in a new session); resumes after a pause
 *   /pb:review [focus]     fresh, independent review against the spec, or of any uncommitted change
 *   /pb:deps [scope]       check dependencies and propose upgrades, as a change of their own
 *   /pb:undo [id]          restore the files, and rewind the conversation, to before a task
 *   /pb:stats [all]        tasks, attempts, checks, tokens and cache per spec
 *   /pb:archive [name]     move a finished spec out of the way
 *   /pb:status             every spec and where it stands
 *   /pb:help [topic]       what to do next
 *
 * Inspired by GVS5H (Gao et al., arXiv:2608.26480): small tasks, a verifier that
 * outranks the model's own "done", and fresh eyes against anchoring. pb has since
 * deviated far from it; see the README's credits.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { changedPaths, dropCheckpoints, inWorktree, inspectChanges, restore, snapshot } from "./checkpoint.ts";
import { HELP_PATH, tip, topic, topics } from "./help.ts";
import {
  EXPLORER_SYSTEM,
  buildIntro,
  buildMechanics,
  buildStateSummary,
  checkpointPrompt,
  checkpointSummary,
  continuePlanPrompt,
  continuePrompt,
  depsPrompt,
  explorerBrief,
  findingLine,
  finishSpecPrompt,
  reviewSessionPrompt,
  fixText,
  nudgePrompt,
  planPrompt,
  reviewerBrief,
  specPrompt,
  taskPrompt,
} from "./prompts.ts";
import { CARTOGRAPHER_SYSTEM, cartographerBrief, findingsOf, mapDiff, mapTokens, missingPaths, normalizeMap, readMap, unresolvedPaths, writeMap } from "./map.ts";
import { type ExploreDetails, registerRenderers, renderExploreCall, renderExploreResult } from "./render.ts";
import { REVIEW_TOOLS, fromProse, sensitiveGround, verdictOf, verifyFindings } from "./review.ts";
import { runFresh, usageOf } from "./runner.ts";
import { type ParsedSpec, SPEC_NAME, type SpecTask, addDecision, parseSpec, setSection, setStatus, tokensOf } from "./spec.ts";
import { addStandards, agentDir, findStandards, projectStack, standardsLoaded } from "./standards.ts";
import { loadStats, renderAll, renderCard } from "./stats.ts";
import { type Checkpoint, type Finding, type Progress, type ReviewRun, type ReviewSessionState, type TaskProgress, PREFIX, Store, changedSince, diffStat, gitDiff, gitHead, now, untrackedText } from "./store.ts";
import { resolveBuild, resolveVerify, runVerify } from "./verify.ts";

const cmd = (verb: string) => `${PREFIX}:${verb}`;

/** Pi compacts at the context window minus this reserve (its default reserveTokens): a checkpoint must come earlier. */
const PI_RESERVE_TOKENS = 16384;
/** Above this, a spec gets a gentle note about its size; never a rejection. */
const LONG_SPEC_TOKENS = 12000;

/** What the model is told about a spec's size after writing it. */
const sizeNote = (tokens: number) =>
  `~${tokens} tokens${tokens > LONG_SPEC_TOKENS ? ". That's long: if it copies code or repeats facts, pointing to the code and stating each fact once would help the next reader; if it's all needed, keep it" : ""}`;

/** Spec names for argument completion (completions run without a ctx, in Pi's working directory). */
const specCompletions = (prefix: string) =>
  new Store(process.cwd())
    .specNames()
    .filter((n) => n.startsWith(prefix))
    .map((n) => ({ value: n, label: n }));

type Entry = { id: string; parentId: string | null; type: string; message?: { role?: string; content?: unknown } };
type Tree = { getLeafId?(): string | null; getEntry?(id: string): Entry | undefined; getSessionName?(): string | undefined; getBranch?(): Entry[] };
const contentText = (c: unknown) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((x: { type?: string; text?: string }) => (x.type === "text" ? (x.text ?? "") : "")).join("") : "");
const tree = (ctx: ExtensionContext) => ctx.sessionManager as unknown as Tree;

const text = (t: string) => [{ type: "text" as const, text: t }];
/** A tool result the agent carries on from. */
const reply = (t: string) => ({ content: text(t), details: undefined });
/** The last few non-empty lines of a text being written, for a live view. */
const tail = (t: string, n = 3) =>
  t
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim())
    .slice(-n);

/** A UI update from a callback that may outlive its session (you switched away): skipped instead of crashing Pi. */
const safely = (f: () => void) => {
  try {
    f();
  } catch {
    // the session was replaced: there's nothing to draw on any more
  }
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The context Pi hands over after a session switch (newSession/switchSession's withSession). */
type ReplacedSessionContext = Parameters<NonNullable<Parameters<ExtensionCommandContext["newSession"]>[0]>["withSession"] & {}>[0];

/** The tools a review session's model gets: read-only, plus the one it reports with. */
const REVIEW_SESSION_TOOLS = ["read", "grep", "find", "ls", "bash", "pb_report_findings"];

/** A tool result that ends the agent's run: the build paused or finished. */
const stop = (t: string) => ({ content: text(t), details: undefined, terminate: true });

export default function pb(pi: ExtensionAPI) {
  /* ------------------------------- helpers ------------------------------- */

  /** Visible in the session, and part of its context so you can discuss it (during a run, Pi adds it at the end of the turn). */
  const post = (content: string) => pi.sendMessage({ customType: "pb", content, display: true }, { triggerTurn: false });
  /** A short visible marker plus full instructions that start a turn. */
  const instruct = (marker: string, prompt: string) => {
    post(marker);
    pi.sendMessage({ customType: "pb-instruction", content: prompt, display: false }, { triggerTurn: true, deliverAs: "followUp" });
  };

  const commands = (cwd: string, store: Store) => {
    const cfg = store.config();
    return { cfg, testCmd: resolveVerify(cfg.verify, cwd), buildCmd: resolveBuild(cfg.build, cwd) };
  };

  const loadSpec = (store: Store, name: string): { md: string; spec: ParsedSpec } | undefined => {
    const md = store.readSpec(name);
    const spec = md ? parseSpec(md).spec : undefined;
    return md && spec ? { md, spec } : undefined;
  };

  /** Keep task statuses by id when a spec is (re)written; new tasks start as todo. */
  const syncTasks = (spec: ParsedSpec, old: TaskProgress[] = []): TaskProgress[] =>
    spec.tasks.map((t) => {
      const prev = old.find((o) => o.id === t.id);
      return { id: t.id, title: t.title, status: prev?.status ?? "todo", attempts: prev?.attempts ?? 0, summary: prev?.summary };
    });

  const mark = (t: TaskProgress) => (t.status === "done" ? "✓" : t.status === "doing" ? "▸" : t.status === "blocked" ? "✗" : "·");
  const taskLine = (t: TaskProgress) => `${mark(t)} ${t.id} ${t.title}${t.attempts > 1 ? ` (${t.attempts} attempts)` : ""}`;

  /** The standards to put in a message: none when this session already loaded them from AGENTS.md. */
  const standardsFor = (ctx: ExtensionContext): string => {
    const found = findStandards(ctx.cwd);
    if (!found) return "";
    const opts = (ctx as Partial<ExtensionCommandContext>).getSystemPromptOptions?.();
    return opts && standardsLoaded(opts.contextFiles) ? "" : found.text;
  };

  const sessionModel = (ctx: ExtensionContext) => (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
  const findModel = (ctx: ExtensionContext, spec: string) => {
    const slash = spec.indexOf("/");
    return (ctx as { modelRegistry?: { find(p: string, id: string): unknown } }).modelRegistry?.find(spec.slice(0, slash), spec.slice(slash + 1));
  };

  const specOfSession = (ctx: ExtensionContext) => {
    const store = new Store(ctx.cwd);
    const name = store.specForSession(ctx.sessionManager.getSessionFile());
    return { store, name, progress: name ? store.progress(name) : undefined };
  };

  const unfinishedPhase = (phase?: string) => ["building", "paused"].includes(phase ?? "");
  const nextTodo = (p: Progress) => p.tasks.find((t) => t.status === "doing" || t.status === "todo");

  /** The build's task list above the editor while it runs. */
  const showProgress = (ctx: ExtensionContext, p: Progress | undefined, note?: string) => {
    if (!ctx.hasUI) return;
    if (!p || !unfinishedPhase(p.phase)) return ctx.ui.setWidget("pb", undefined);
    const status = note ?? (p.phase === "paused" ? "paused" : "");
    ctx.ui.setWidget("pb", [`pb ${p.spec}  ${p.tasks.map((t) => `${mark(t)}${t.id}`).join(" ")}${status ? `  · ${status}` : ""}`]);
  };

  /**
   * A dialog that goes on without you: after askTimeoutSec (with a countdown), `fallback` is taken and noted
   * in `notes`, so a build started before you walk away doesn't wait all night. Esc still cancels (undefined).
   */
  const choose = async (ctx: ExtensionContext, store: Store, title: string, options: string[], fallback: string, notes?: string[]): Promise<string | undefined> => {
    if (!ctx.hasUI) return fallback;
    const ms = store.config().askTimeoutSec * 1000;
    const asked = Date.now();
    const choice = await ctx.ui.select(title, options, ms > 0 ? { timeout: ms } : undefined);
    if (choice !== undefined) return choice;
    if (ms > 0 && Date.now() - asked >= ms - 1000) {
      notes?.push(`${title} → ${fallback} (no answer within ${Math.max(1, Math.round(ms / 60_000))} min)`);
      return fallback;
    }
    return undefined;
  };
  /** A yes/no that goes on (yes) without you. */
  const agree = async (ctx: ExtensionContext, store: Store, title: string, notes?: string[]) => {
    const GO = "Yes, go on";
    return (await choose(ctx, store, title, [GO, "No, stop here"], GO, notes)) === GO;
  };

  /**
   * Where to rewind the conversation to for an entry: navigating to a user or custom message would
   * move its text into the editor, so step back to the entry before it. keepUser: stop at your own
   * message (going back to a branch, its text returns to the editor instead of being lost).
   */
  const rewindPoint = (ctx: ExtensionContext, from: string | undefined, keepUser = false): string | undefined => {
    const sm = tree(ctx);
    let id: string | undefined = from;
    while (id) {
      const e = sm.getEntry?.(id);
      if (!e) return undefined;
      const userLike = e.type === "custom_message" || (!keepUser && e.type === "message" && e.message?.role === "user");
      if (!userLike) return id;
      id = e.parentId ?? undefined;
    }
    return undefined;
  };

  /**
   * The command that checks a task. The final check: the full suite (a compile for the build gate). Per task,
   * only with taskChecks "each": its Test: line, else a compile.
   */
  const checkCommand = (spec: ParsedSpec, task: SpecTask | undefined, testCmd: string | null, buildCmd: string | null, final: boolean, each: boolean) => {
    if (spec.gate === "none") return null;
    if (final) return spec.gate === "tests" ? testCmd : buildCmd;
    if (!each) return null;
    return spec.gate === "tests" ? (task?.test ?? buildCmd) : buildCmd;
  };

  // Set while a check runs inside pb_task_done: the prompt cache is certain to be needed afterwards.
  let checking = false;
  // Set by /pb:undo while it rewinds the conversation: the branch summary pb supplies instead of an LLM's.
  let undoSummary: string | undefined;
  // A task boundary happened in this turn: the moment pruning is allowed.
  let boundary = false;
  let baselineRunning = false;

  registerRenderers(pi);

  /* -------------------------------- tools -------------------------------- */

  pi.registerTool({
    name: "pb_write_spec",
    label: "Write spec",
    description:
      "Write or rewrite a pb feature spec (.pi/pb/specs/<name>/spec.md). Use it when the user runs /pb:spec or /pb:build asks for the spec. The content must follow the spec format the user's instructions give; the tool rejects a spec that doesn't parse and says why.",
    parameters: Type.Object({
      name: Type.String({ description: "short kebab-case name, e.g. order-cancellation" }),
      content: Type.String({ description: "the complete spec in markdown" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!SPEC_NAME.test(params.name)) throw new Error(`"${params.name}" is not a valid name: use short kebab-case, e.g. order-cancellation`);
      const { spec, errors } = parseSpec(params.content);
      if (!spec) throw new Error(`The spec doesn't parse:\n- ${errors.join("\n- ")}\nFix it and call pb_write_spec again.`);
      const store = new Store(ctx.cwd);
      const prev = store.progress(params.name);
      store.writeSpec(params.name, params.content);
      store.saveProgress({
        ...(prev ?? { spec: params.name, phase: "written" }),
        spec: params.name,
        tasks: syncTasks(spec, prev?.tasks),
        writtenIn: ctx.sessionManager.getSessionFile(),
        edited: false,
        compacted: false,
        updatedAt: now(),
      });
      store.event(params.name, { type: "spec", tasks: spec.tasks.length, gate: spec.gate, newTests: spec.newTests, status: spec.status, tokens: tokensOf(params.content) });
      const what = spec.status === "planning" ? "status planning" : `${spec.tasks.length} tasks, verification ${spec.gate}${spec.newTests ? "" : ", no new tests"}`;
      return reply(`Wrote ${store.rel("specs", params.name, "spec.md")}: "${spec.title}", ${what}${spec.dependsOn ? `, depends on ${spec.dependsOn}` : ""}; ${sizeNote(tokensOf(params.content))}.`);
    },
  });

  pi.registerTool({
    name: "pb_update_spec",
    label: "Update spec",
    description:
      "Change part of an existing pb spec instead of rewriting it: replace or append to one section (e.g. Findings, Decisions, Open questions, Tasks), and/or set its Status (planning | ready). The result must still parse, or nothing is written.",
    parameters: Type.Object({
      name: Type.String({ description: "the spec's name" }),
      section: Type.Optional(Type.String({ description: 'the "## " section to change, e.g. Decisions; created if missing' })),
      content: Type.Optional(Type.String({ description: "the section's new body (without its heading), or the lines to append" })),
      mode: Type.Optional(StringEnum(["replace", "append"])),
      status: Type.Optional(StringEnum(["planning", "ready"])),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const store = new Store(ctx.cwd);
      let md = store.readSpec(params.name);
      if (!md) throw new Error(`No spec "${params.name}": write it with pb_write_spec.`);
      if (params.section) {
        if (params.content === undefined) throw new Error("content is required with section.");
        md = setSection(md, params.section, params.content, (params.mode as "replace" | "append" | undefined) ?? "replace");
      }
      if (params.status) md = setStatus(md, params.status as "planning" | "ready");
      const { spec, errors } = parseSpec(md);
      if (!spec) throw new Error(`Not written: the spec wouldn't parse:\n- ${errors.join("\n- ")}`);
      store.writeSpec(params.name, md);
      const prev = store.progress(params.name);
      store.saveProgress({ ...(prev ?? { spec: params.name, phase: "written" }), spec: params.name, tasks: syncTasks(spec, prev?.tasks), writtenIn: ctx.sessionManager.getSessionFile(), updatedAt: now() });
      store.event(params.name, { type: "spec", update: params.section ?? "status", status: spec.status, tokens: tokensOf(md) });
      return reply(`Updated ${store.rel("specs", params.name, "spec.md")}${params.section ? ` (${params.section})` : ""}: status ${spec.status}; ${sizeNote(tokensOf(md))}.`);
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
      if (!name || !md || !progress) throw new Error("This is not a pb build session.");
      const entry = params.assumption ? `Assumption (build${progress.current ? `, ${progress.current}` : ""}): ${params.decision}` : params.decision;
      store.writeSpec(name, addDecision(md, entry));
      if (params.assumption) {
        progress.assumptions = [...(progress.assumptions ?? []), entry];
        store.saveProgress(progress);
      }
      return reply("Recorded in the spec's Decisions.");
    },
  });

  pi.registerTool({
    name: "pb_ask",
    label: "Ask",
    description:
      "Ask the human one question and wait for the answer, without stopping your work: a choice between options, or an open question. In a pb build the answer is recorded in the spec's Decisions. Ask only what you can't sensibly decide yourself. Ask independent questions together; ask a question that depends on another's answer only after you have that answer.",
    parameters: Type.Object({
      question: Type.String({ description: "one precise question" }),
      options: Type.Optional(Type.Array(Type.String(), { description: "2 to 4 answers to choose from; the human can always type another" })),
      recommended: Type.Optional(Type.String({ description: "your recommendation: one of the options, or a suggested answer" })),
    }),
    // One dialog at a time: Pi shows a single dialog, and a second one opened in parallel dismisses the first.
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const { store, name, progress: p } = specOfSession(ctx);
      const building = !!name && !!p && p.phase === "building";
      const session = ctx.sessionManager.getSessionFile() ?? "";
      if (checkpointing.has(session)) return reply("Not now: this is a checkpoint. Write the question under Open questions in the spec instead.");
      // The human may have walked away: during a build, while /pb:build writes the spec, and while planning.
      const planning = store.planningSessions().includes(session);
      const unattended = building || specWriting.has(session) || store.pendingBuild(session) || planning;
      if (!ctx.hasUI) {
        if (building) {
          pauseBuild(ctx, store, p!, `${p!.current} question: ${params.question}`, "build.paused", "question");
          return stop("No one can answer here: the build is paused with your question. Stop here.");
        }
        return reply("No one can answer right now: take the sensible reading, say which one you took, and carry on.");
      }
      // During a build the human may be away: after askTimeoutSec it goes on with the recommendation.
      const timeoutMs = unattended ? store.config().askTimeoutSec * 1000 : 0;
      const opts = timeoutMs > 0 ? { timeout: timeoutMs } : undefined;
      const asked = Date.now();
      let answer: string | undefined;
      const OTHER = "Something else (type it)";
      if (params.options?.length) {
        const labels = params.options.map((o) => (o === params.recommended ? `${o} (recommended)` : o));
        const choice = await ctx.ui.select(params.question, [...labels, OTHER], opts);
        answer = choice === OTHER ? await ctx.ui.input(params.question, undefined, opts) : choice ? params.options[labels.indexOf(choice)] : undefined;
      } else answer = await ctx.ui.input(params.question, params.recommended, opts);
      if (!answer?.trim()) {
        const timedOut = timeoutMs > 0 && Date.now() - asked >= timeoutMs - 1000;
        if (timedOut && building && params.recommended) {
          const minutes = Math.round(timeoutMs / 60_000);
          const entry = `Assumption (build, ${p!.current}, no answer within ${minutes} min): ${params.question.replace(/\s+$/, "")} → ${params.recommended}`;
          const md = store.readSpec(name!);
          if (md) store.writeSpec(name!, addDecision(md, entry));
          p!.assumptions = [...(p!.assumptions ?? []), entry];
          store.saveProgress(p!);
          store.event(name!, { type: "ask", task: p!.current, timedOut: true });
          return reply(`No answer within ${minutes} min: go on with your recommendation (${params.recommended}); it's recorded as an assumption for the review.`);
        }
        const record = building
          ? ", record it with pb_record_decision (assumption: true)"
          : specWriting.has(session) || store.pendingBuild(session)
            ? `, write it into the spec's Decisions as "Assumption: … because …"`
            : planning
              ? ", and tell the human it's an assumption to confirm (under open questions once there's a spec)"
              : "";
        return reply(`${timedOut ? "No answer in time" : "The human dismissed the question"}: take the sensible reading${timedOut && params.recommended ? ` (your recommendation: ${params.recommended})` : ""}${record} and carry on.`);
      }
      if (building) {
        const md = store.readSpec(name!);
        if (md) store.writeSpec(name!, addDecision(md, `${params.question.replace(/\s+$/, "")} → ${answer.trim()}`));
        store.event(name!, { type: "ask", task: p!.current });
      }
      return reply(`The human answered: ${answer.trim()}${building ? " (recorded in the spec's Decisions)" : ""}`);
    },
  });

  pi.registerTool({
    name: "pb_explore",
    label: "Explore",
    description:
      "Answer a question about the code from a separate, read-only context and get back only the answer: where things live, how a similar feature is built, the conventions, what calls what. Use it for broad questions when you need the conclusion, not the file contents; read files yourself when you need exact lines. Several calls can run in parallel.",
    parameters: Type.Object({
      question: Type.String({ description: "what to find out, specific enough to answer in a short report" }),
    }),
    executionMode: "parallel",
    // What it's doing, from the explorer's own steps: shown to you, never sent to the model.
    renderCall: (args, theme) => renderExploreCall(args, theme),
    renderResult: (result, opts, theme, context) => renderExploreResult(result as { content: { type: string; text?: string }[]; details?: ExploreDetails }, opts, theme, context?.isError),
    async execute(_id, params, signal, onUpdate, ctx) {
      const store = new Store(ctx.cwd);
      const cfg = store.config();
      const name = tree(ctx).getSessionName?.();
      const started = Date.now();
      const steps: string[] = [];
      const files = new Set<string>();
      let writing = "";
      const details = (): ExploreDetails => ({ steps: steps.slice(-3), count: steps.length, files: [...files], started, writing: tail(writing, 2) });
      const res = await runFresh({
        cwd: ctx.cwd,
        role: "explorer",
        systemPrompt: EXPLORER_SYSTEM,
        brief: explorerBrief(params.question, name?.startsWith("plan: ") ? name.slice(6) : undefined),
        prompt: "Answer the question in the attached file.",
        tools: ["read", "grep", "find", "ls", "bash"],
        model: cfg.explorer.model ?? sessionModel(ctx),
        thinking: cfg.explorer.thinking ?? "max",
        signal,
        onActivity: (line, call) => {
          steps.push(line);
          const p = call.arguments.path ?? call.arguments.file_path;
          if (call.name === "read" && typeof p === "string") files.add(p);
          onUpdate?.({ content: text(`↳ ${line}`), details: details() });
        },
        onText: (t) => {
          writing = t;
          onUpdate?.({ content: text(""), details: details() });
        },
        sessionDir: store.sessionsDir("explorer"),
      });
      store.exploreEvent({ session: ctx.sessionManager.getSessionFile(), ...res.tokens, cost: res.cost, ms: res.ms });
      if (res.aborted) throw new Error("Exploration stopped.");
      if (!res.text.trim()) throw new Error(`The explorer produced no answer${res.error ? `: ${res.error}` : ""}`);
      const t = res.tokens;
      const session = res.sessionFile ? path.relative(ctx.cwd, res.sessionFile) : undefined;
      return { content: text(res.text.trim()), details: { ...details(), writing: [], ms: res.ms, tokens: t.input + t.output + t.cacheRead + t.cacheWrite, session }, usage: usageOf(res) };
    },
  });

  pi.registerTool({
    name: "pb_report_findings",
    label: "Report findings",
    description:
      "In a pb review session: report the review's findings, one call with all of them (an empty list when there are none). Call it again if they change.",
    parameters: Type.Object({
      findings: Type.Array(
        Type.Object({
          priority: StringEnum(["P0", "P1", "P2", "P3"]),
          file: Type.Optional(Type.String({ description: "path relative to the repository root" })),
          line: Type.Optional(Type.Number()),
          title: Type.String({ description: "the problem, in one sentence" }),
          fix: Type.Optional(Type.String({ description: "a concrete fix" })),
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const store = new Store(ctx.cwd);
      const session = ctx.sessionManager.getSessionFile();
      const state = store.reviewSession(session);
      if (!session || !state) throw new Error("This is not a pb review session.");
      const findings = (params.findings as Finding[]).filter((f) => /^P[0-3]$/.test(f.priority) && f.title);
      store.saveReviewSession(session, { ...state, findings });
      return reply(`Recorded ${findings.length} finding(s). Now reply briefly${state.role === "review" ? " (the acceptance checklist, and anything worth knowing that isn't a finding)" : ""}, then stop.`);
    },
  });

  pi.registerTool({
    name: "pb_task_done",
    label: "Task done",
    description:
      'In a pb build: finish the task the harness gave you. status done: the harness runs the task\'s check and answers with the failure to fix, or the next task. status blocked: it can\'t be done properly (say why); the build pauses for the human.',
    parameters: Type.Object({
      task: Type.String({ description: 'the task id, e.g. "T2" (or "final" for the final check)' }),
      status: StringEnum(["done", "blocked"]),
      summary: Type.String({ description: "what you changed and why, and what you checked with what result" }),
    }),
    executionMode: "sequential",
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { store, progress: p } = specOfSession(ctx);
      if (!p || p.phase !== "building") throw new Error("No pb build is running in this session.");
      if (params.task !== p.current) throw new Error(`The current task is ${p.current ?? "none"}, not ${params.task}.`);
      const tp = p.tasks.find((t) => t.id === p.current);
      if (tp) tp.summary = params.summary;
      const loaded = loadSpec(store, p.spec);
      if (!loaded) {
        pauseBuild(ctx, store, p, `${store.rel("specs", p.spec, "spec.md")} no longer parses; fix it, then /${cmd("build")}.`, "build.paused", "spec");
        return stop("The spec no longer parses: the build is paused. Stop here.");
      }
      if (params.status === "blocked") {
        pauseBuild(ctx, store, p, `${params.task} blocked: ${params.summary}`, "build.paused", "blocked");
        return stop("The build is paused: the human decides how to go on. Stop here.");
      }
      return await checkAndAdvance(ctx, store, p, loaded.spec, signal);
    },
  });

  /* --------------------------------- plan -------------------------------- */

  /** Run the test suite in the background; its result is posted into the session when it's done. */
  const startBaseline = (ctx: ExtensionContext, store: Store, command: string) => {
    if (baselineRunning) return;
    baselineRunning = true;
    const cfg = store.config();
    // In a worktree at HEAD: the planner's own builds in the working copy can't collide with it (Maven's target/).
    void inWorktree(ctx.cwd, (dir) => runVerify(command, dir, cfg.verifyTimeoutSec, cfg.testOutputCap))
      .then((r) => {
        store.saveBaseline({ ...r, head: gitHead(ctx.cwd) });
        try {
          post(`**Baseline** (the test suite on the last commit): ${r.ok ? r.summary : `${r.summary}\n\nThe final check runs the whole suite, so it fails until this is fixed.`}`);
        } catch {
          // the session was replaced meanwhile: baseline.json still has the result
        }
      })
      .finally(() => {
        baselineRunning = false;
      });
  };

  /** Start planning mode for this session (the snapshot shows later what changed while it was on). */
  const startPlanning = (ctx: ExtensionContext, store: Store) => {
    const session = ctx.sessionManager.getSessionFile();
    if (!session) return;
    const existing = store.planning(session)?.snapshot;
    const snap = existing ? undefined : store.config().checkpoints ? snapshot(ctx.cwd, "pb: start of planning") : undefined;
    store.setPlanning(session, true, existing ?? snap?.commit);
    store.detachSession(session);
  };

  /**
   * Files that changed in the project while this session was planning (bash can write where edit and
   * write are blocked). Asks whether to keep or restore them; false = cancel.
   */
  const reviewPlanningChanges = async (ctx: ExtensionContext, store: Store, notes?: string[]): Promise<boolean> => {
    const session = ctx.sessionManager.getSessionFile();
    const snap = session ? store.planning(session)?.snapshot : undefined;
    if (!session || !snap) return true;
    const cur = snapshot(ctx.cwd, "pb: end of planning");
    if (!cur) return true;
    const files = changedPaths(ctx.cwd, snap, cur.commit);
    if (!files.length) return true;
    const list = `${files.slice(0, 10).join(", ")}${files.length > 10 ? ` … (+${files.length - 10})` : ""}`;
    const KEEP = "Keep them";
    const RESTORE = "Restore them to how they were when planning began";
    const choice = await choose(ctx, store, `These project files changed while planning: ${list}`, [KEEP, RESTORE, "Cancel"], KEEP, notes);
    if (choice === RESTORE) {
      restore(ctx.cwd, cur.commit, snap, files);
      ctx.ui.notify(`Restored ${files.length} file(s).`, "info");
    } else if (choice !== KEEP) return false;
    else if (!ctx.hasUI) ctx.ui.notify(`Kept files changed while planning: ${list}`, "warning");
    store.setPlanning(session, store.planningSessions().includes(session), (choice === RESTORE ? undefined : cur.commit) ?? snap);
    return true;
  };

  /**
   * Standards live in AGENTS.md (Pi loads it everywhere); offer pb's section once per project, at the
   * first /pb:plan or /pb:build. A stack's own section (Java, Vue) goes only in the project's AGENTS.md,
   * so the shared one stays free of stack rules. A Vue project that only finds a shared section (a
   * parent's or the agent directory's, e.g. the backend's) is offered its frontend one next to it.
   */
  const offerStandards = async (ctx: ExtensionContext, store: Store) => {
    if (!ctx.hasUI || store.asked("standards")) return;
    const found = findStandards(ctx.cwd);
    const stack = projectStack(ctx.cwd);
    const shared = !!found && path.dirname(found.file) !== path.resolve(ctx.cwd);
    if (found && !(shared && stack === "vue" && !found.text.includes("- Frontend role:"))) return;
    store.markAsked("standards");
    const HERE = stack === "vue" ? "Add pb's frontend standards to this project's AGENTS.md" : "Add pb's engineering standards to this project's AGENTS.md";
    const ALL = `Add them to ${path.join(agentDir(), "AGENTS.md")} (all projects)`;
    const covers = stack === "vue" ? "the page's role, backend refusals, browser security, Vue" : "concurrency";
    const title = found
      ? `This Vue project only gets the standards in ${found.file}, not the frontend ones. Pi loads both files, so that section stays in force next to this project's: keep the shared AGENTS.md free of stack-specific rules`
      : `Engineering standards (quality, dependencies, comments without history, tests, security, ${covers})`;
    const choice = await ctx.ui.select(title, stack ? [HERE, "No thanks"] : [HERE, ALL, "No thanks"]);
    if (choice !== HERE && choice !== ALL) return;
    const file = choice === HERE ? path.join(ctx.cwd, "AGENTS.md") : path.join(agentDir(), "AGENTS.md");
    addStandards(file, { stack });
    const which = stack === "java" ? " (with Java 25 defaults)" : stack === "vue" ? " (the frontend ones, for a Vue project)" : "";
    ctx.ui.notify(`Added to ${file}${which}: edit them there. Pi loads them into every session from now on.`, "info");
  };

  /** Continue planning a spec in a fresh session, seeded from it: clean context, exact checkpoint. */
  const continuePlan = async (ctx: ExtensionCommandContext, store: Store, name: string) => {
    const md = store.readSpec(name)!;
    store.setCarry({ model: sessionModel(ctx), thinking: pi.getThinkingLevel() as string | undefined, spec: name });
    const snap = store.config().checkpoints ? snapshot(ctx.cwd, "pb: start of planning") : undefined;
    const result = await ctx.newSession({
      parentSession: ctx.sessionManager.getSessionFile(),
      setup: async (sm) => {
        sm.appendSessionInfo(`plan: ${name}`);
      },
      withSession: async (c) => {
        // Only `c` from here on: the captured pi and ctx belong to the replaced session.
        const session = c.sessionManager.getSessionFile();
        if (session) store.setPlanning(session, true, snap?.commit);
        const p = store.progress(name);
        if (p) store.saveProgress({ ...p, writtenIn: session, compacted: false });
        await c.sendMessage(
          {
            customType: "pb",
            content: `▶ Planning **${name}** on, from ${store.rel("specs", name, "spec.md")} (the project's files stay untouched).\nThis session: "plan: ${name}" · back to it with /resume, or \`pi --session ${c.sessionManager.getSessionId()}\``,
            display: true,
          },
          { triggerTurn: false },
        );
        void c.sendMessage({ customType: "pb-instruction", content: continuePlanPrompt(name, md, ""), display: false }, { triggerTurn: true });
      },
    });
    if (result.cancelled) ctx.ui.notify("Cancelled.", "info");
  };

  pi.registerCommand(cmd("plan"), {
    description: "Plan something with Pi: /pb:plan <describe what you want to build or change, in your own words>, or /pb:plan <spec> to continue planning a spec in a fresh session. Pi can run anything to investigate but won't touch the project's files. /pb:plan off ends that",
    getArgumentCompletions: (prefix: string) => [{ value: "off", label: "off" }, ...specCompletions(prefix)].filter((c) => c.value.startsWith(prefix)),
    handler: async (args, ctx) => {
      const arg = args.trim();
      const store = new Store(ctx.cwd);
      const session = ctx.sessionManager.getSessionFile();
      if (arg === "off") {
        if (session && !(await reviewPlanningChanges(ctx, store))) return;
        if (session) store.setPlanning(session, false);
        return ctx.ui.notify("Planning mode off: Pi can change the project's files again.", "info");
      }
      if (!arg)
        return ctx.ui.notify(`Describe what you want, in your own words, e.g.\n/${cmd("plan")} let admins cancel an order while it is still pending, and notify the customer`, "warning");
      if (SPEC_NAME.test(arg) && store.readSpec(arg) && (store.progress(arg)?.phase ?? "written") === "written") {
        if (!ctx.isIdle()) return ctx.ui.notify("Pi is busy. Wait for the current turn to finish.", "warning");
        return continuePlan(ctx, store, arg);
      }
      // A name makes the planning session easy to find again in /resume, e.g. after a crash.
      const title = arg.length > 60 ? `${arg.slice(0, 57)}…` : arg;
      pi.setSessionName(`plan: ${title}`);
      const { cfg, testCmd } = commands(ctx.cwd, store);

      await offerStandards(ctx, store);

      // After the standards offer: its AGENTS.md isn't a change made while planning.
      startPlanning(ctx, store);
      // A cheap staleness check of the project map, no model call: paths it names that are gone.
      const gone = missingPaths(ctx.cwd, readMap(ctx.cwd));
      if (gone.length) ctx.ui.notify(`The project map in AGENTS.md names ${gone.length} path(s) that no longer exist (${gone.slice(0, 3).join(", ")}${gone.length > 3 ? ", …" : ""}): /${cmd("map")} refreshes it.`, "warning");

      // The baseline costs no tokens: the harness runs the suite while the discussion starts.
      const baseline = cfg.baseline && !!testCmd;
      if (baseline) startBaseline(ctx, store, testCmd!);
      instruct(
        `▶ /${cmd("plan")} — ${arg} (the project's files stay untouched)${baseline ? ` · running \`${testCmd}\` in the background for a baseline` : ""}\nThis session: "plan: ${title}" · back to it any time with /resume, or \`pi --session ${ctx.sessionManager.getSessionId()}\``,
        planPrompt(arg, testCmd, standardsFor(ctx), baseline ? "running" : "none"),
      );
    },
  });

  pi.registerCommand(cmd("deps"), {
    description: "Check dependencies (versions, deprecations) and propose upgrades as a change of their own. Optional: which ones",
    handler: async (args, ctx) => {
      const store = new Store(ctx.cwd);
      startPlanning(ctx, store);
      pi.setSessionName(`deps: ${args.trim() || "all"}`);
      instruct(`▶ /${cmd("deps")}${args.trim() ? ` — ${args.trim()}` : ""} (the project's files stay untouched)`, depsPrompt(args.trim()));
    },
  });

  // Planning mode: investigating is free (bash, curl, scripts, scratch files elsewhere), changing the project isn't.
  pi.on("tool_call", (e, ctx) => {
    const ev = e as { toolName: string; input: { path?: string } };
    if (ev.toolName !== "edit" && ev.toolName !== "write") return;
    const session = ctx.sessionManager.getSessionFile();
    const store = new Store(ctx.cwd);
    if (session && store.reviewSession(session)) return { block: true, reason: "This is a review session: read-only. Report what should change with pb_report_findings." };
    if (!session || !store.planningSessions().includes(session)) return;
    const rel = path.relative(ctx.cwd, path.resolve(ctx.cwd, ev.input.path ?? ""));
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return;
    return {
      block: true,
      reason: `Planning mode: the project's files stay untouched until /${cmd("build")}. Put scratch files outside the project (e.g. in a mktemp -d directory), or say what you would change.`,
    };
  });

  /* --------------------------------- spec -------------------------------- */

  pi.registerCommand(cmd("spec"), {
    description: "Write the spec for what we planned (one per feature); run it again to revise. Optional: which feature",
    handler: async (args, ctx) => {
      const store = new Store(ctx.cwd);
      const which = args.trim();
      const md = which && SPEC_NAME.test(which) ? store.readSpec(which) : undefined;
      instruct(`▶ /${cmd("spec")}${which ? ` — ${which}` : ""}`, specPrompt(which, store.specNames(), md ? { name: which, markdown: md } : undefined));
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
    const loaded = loadSpec(store, p.spec);
    const task = loaded?.spec.tasks.find((t) => t.id === taskId);
    const tp = p.tasks.find((t) => t.id === taskId);
    if (!loaded || !task || !tp) return;
    const { cfg, testCmd, buildCmd } = commands(ctx.cwd, store);
    if (tp.status === "todo" && cfg.checkpoints) {
      const snap = snapshot(ctx.cwd, `pb: before ${p.spec} ${taskId}`);
      if (snap) {
        const list = store.checkpoints(p.spec);
        const where = o.inTool ? { pendingEntry: true } : { entry: tree(ctx).getLeafId?.() ?? undefined, intro: o.intro || undefined };
        list.push({ id: taskId, at: now(), ...snap, head: gitHead(ctx.cwd), tasks: structuredClone(p.tasks), task: taskId, ...where });
        store.saveCheckpoints(p.spec, list);
      }
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
      prompt: taskPrompt(task, tp.attempts, cfg.maxAttempts, checkCommand(loaded.spec, task, testCmd, buildCmd, false, cfg.taskChecks === "each")),
    };
  };

  /** The build's state as a summary, for a reset at a task boundary or a compaction in the middle of a task. */
  const stateSummary = (ctx: ExtensionContext, store: Store, p: Progress, reason: "reset" | "compaction", extra: { changed?: string[]; read?: string[]; previous?: string } = {}) => {
    const loaded = loadSpec(store, p.spec);
    const { cfg, testCmd, buildCmd } = commands(ctx.cwd, store);
    const each = cfg.taskChecks === "each";
    const tp = p.tasks.find((t) => t.id === p.current);
    const task = loaded?.spec.tasks.find((t) => t.id === p.current);
    const current =
      p.current === "final"
        ? fixText("final", `\`${p.lastVerify?.command ?? "the full suite"}\``, p.lastVerify?.summary ?? "", tp?.attempts ?? 1, cfg.maxAttempts, false)
        : task && loaded
          ? taskPrompt(task, tp?.attempts ?? 1, cfg.maxAttempts, checkCommand(loaded.spec, task, testCmd, buildCmd, false, each))
          : `Carry on with ${p.current ?? "the build"}; finish it with pb_task_done.`;
    return buildStateSummary({ p, markdown: loaded?.md, mechanics: loaded ? buildMechanics(loaded.spec, buildCmd, each) : "", current, reason, ...extra });
  };

  /** When a build session should be reset at a task boundary: past checkpointAt, always before Pi would compact. */
  const pastCheckpoint = (ctx: ExtensionContext, store: Store, specTokens: number) => {
    const cfg = store.config();
    const usage = ctx.getContextUsage();
    if (!cfg.checkpointAt || !usage || usage.tokens == null) return undefined;
    const limit = Math.min((usage.contextWindow * cfg.checkpointAt) / 100, usage.contextWindow - PI_RESERVE_TOKENS - Math.max(12000, 2 * specTokens));
    return usage.tokens >= limit ? Math.round((100 * usage.tokens) / usage.contextWindow) : undefined;
  };

  const pauseBuild = (ctx: ExtensionContext, store: Store, p: Progress, reason: string, tipKey: string, why: string, vars: Record<string, string | number> = {}) => {
    p.phase = "paused";
    p.pause = reason;
    store.saveProgress(p);
    store.event(p.spec, { type: "pause", why, task: p.current });
    showProgress(ctx, p);
    post(`**⏸ Build paused** — ${reason}\n\n${tip(tipKey, { spec: p.spec, ...vars })}`);
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
  const checkAndAdvance = async (
    ctx: ExtensionContext,
    store: Store,
    p: Progress,
    spec: ParsedSpec,
    signal: AbortSignal | undefined,
  ): Promise<ReturnType<typeof reply> | ReturnType<typeof stop>> => {
    const final = p.current === "final";
    const { cfg, testCmd, buildCmd } = commands(ctx.cwd, store);
    const each = cfg.taskChecks === "each";
    const task = spec.tasks.find((t) => t.id === p.current);
    const tp = p.tasks.find((t) => t.id === p.current);
    const found = final ? [] : inspectTask(ctx, store, p);

    let failure: string | undefined;
    let what = "";
    const ran = checkCommand(spec, task, testCmd, buildCmd, final, each);
    if (ran) {
      showProgress(ctx, p, `checking ${final ? "everything" : p.current}: ${ran}`);
      checking = true;
      try {
        p.lastVerify = await runVerify(ran, ctx.cwd, cfg.verifyTimeoutSec, cfg.testOutputCap, signal);
      } finally {
        checking = false;
      }
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
    store.event(p.spec, { type: "check", task: p.current, attempt: tp?.attempts ?? 1, ok: !failure, command: ran, notices: found });

    if (failure) {
      const attempts = tp?.attempts ?? 1;
      if (attempts >= cfg.maxAttempts) {
        if (tp) tp.status = "doing";
        pauseBuild(ctx, store, p, `${p.current} still fails after ${attempts} attempts.`, "build.paused-attempts", "attempts", { task: p.current ?? "" });
        return stop(fixText(p.current!, what, failure, attempts, cfg.maxAttempts, true));
      }
      if (tp) tp.attempts += 1;
      store.saveProgress(p);
      showProgress(ctx, p);
      return reply(fixText(p.current!, what, failure, attempts + 1, cfg.maxAttempts, false));
    }

    // Passed: close the task and move on.
    if (tp) tp.status = "done";
    const cps = store.checkpoints(p.spec);
    const cp = cps.find((c) => c.id === p.current);
    if (cp) {
      cp.summary = `${p.current} ✓ · ${(cp.files ?? []).length} files · ${(tp?.summary ?? "").replace(/\s+/g, " ")}`;
      store.saveCheckpoints(p.spec, cps);
    }
    const notices = found.length ? `\n⚠ ${found.join("\n⚠ ")}` : "";
    const passed = `✓ ${p.current} ${ran ? `passed (\`${ran}\`)` : spec.gate === "none" ? "done (no checks for this feature)" : each ? "done (no check for this task)" : "done (checked after the last task)"}${notices}`;

    const next = nextTodo(p);
    if (next) {
      const t = beginTask(ctx, store, p, next.id, { inTool: true })!;
      boundary = true;
      return reply(`${passed}\n\n${t.prompt}`);
    }
    // Every task done: one full check, unless the last task's check was that already.
    const endCmd = checkCommand(spec, undefined, testCmd, buildCmd, true, each);
    if (!final && endCmd && ran !== endCmd) {
      p.current = "final";
      p.tasks.push({ id: "final", title: `Final check: ${spec.gate === "tests" ? "full suite" : "compile"}`, status: "doing", attempts: 1 });
      store.saveProgress(p);
      const r = await checkAndAdvance(ctx, store, p, spec, signal);
      return { ...r, content: text(`${passed}\nRunning \`${endCmd}\`…\n\n${r.content[0].text}`) };
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
    post(
      [
        `**✅ BUILD COMPLETE — ${p.spec}**${notices}`,
        "",
        "```",
        ...p.tasks.map(taskLine),
        "```",
        `Check: ${p.lastVerify?.summary.split("\n")[0] ?? `none (verification ${spec.gate})`}`,
        p.assumptions?.length ? `\nChoices the build made where the spec was unclear (in the spec's Decisions; the review checks them):\n${p.assumptions.map((a) => `- ${a}`).join("\n")}` : "",
        p.unattended?.length ? `\nDecided without you (no answer in time):\n${p.unattended.map((c) => `- ${c}`).join("\n")}` : "",
        p.testChanges?.length ? `\nExisting tests the build changed (the review checks whether each was justified):\n${p.testChanges.map((c) => `- ${c}`).join("\n")}` : "",
        "",
        tip("build.done", { spec: p.spec }),
        ...rest.map((n, i) => `${i ? "" : "\nStill to build, from the same plan:\n"}- ${n}: \`/${cmd("build")} ${n}\``),
      ].join("\n"),
    );
    return stop(`${passed}\n\nBuild complete: every check passed. Stop here; the harness shows the summary.`);
  };

  // The build session's own instance applies the carried-over model and thinking level before its first turn.
  pi.on("session_start", async (e, ctx) => {
    const store = new Store(ctx.cwd);
    const session = ctx.sessionManager.getSessionFile();
    const carry = (e as { reason?: string }).reason === "new" ? store.takeCarry() : undefined;
    if (carry?.review && session) store.saveReviewSession(session, carry.review);
    // A review session's model reads and reports only; everywhere else pb_report_findings isn't offered.
    const active = pi.getActiveTools();
    if (store.reviewSession(session)) {
      pi.setActiveTools(REVIEW_SESSION_TOOLS);
      if (store.reviewRun()?.interrupted?.session === session) ctx.ui.notify(`This review was interrupted: \`/${cmd("review")} continue\` picks it up where it was.`, "info");
    }
    else if (active.includes("pb_report_findings")) pi.setActiveTools(active.filter((t) => t !== "pb_report_findings"));
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
  const checkpointing = new Map<string, { since: string; percent: number; from?: string; last: { human?: string; answer?: string } }>();
  // Don't ask again until the session has grown another 5% of its window (after a failed or undone checkpoint).
  const checkpointQuiet = new Map<string, number>();

  /** The human's last message and the reply to it, for the reset summary: the thread you were in stays word for word. */
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
  const requestCheckpoint = (ctx: ExtensionContext, store: Store, session: string) => {
    const usage = ctx.getContextUsage();
    const percent = usage?.tokens != null ? Math.round((100 * usage.tokens) / usage.contextWindow) : Math.round(usage?.percent ?? 0);
    checkpointing.set(session, { since: now(), percent, from: tree(ctx).getLeafId?.() ?? undefined, last: lastExchange(ctx) });
    return checkpointPrompt(percent, store.specsOfPlanning(session));
  };

  pi.registerCommand(cmd("compact"), {
    description:
      "pb's compaction. Planning: write the plan to its spec, then reset the session to it (e.g. before quitting); /pb:compact undo brings the whole discussion back. Build: compact to the build's state, no summarizing model call",
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) return ctx.ui.notify("Pi is busy. Wait for the current turn to finish.", "warning");
      const store = new Store(ctx.cwd);
      const session = ctx.sessionManager.getSessionFile();
      const build = specOfSession(ctx).progress;
      if (session && build && unfinishedPhase(build.phase) && args.trim() !== "undo") {
        // A build: Pi compacts, with the summary pb writes from the build's state (session_before_compact).
        return ctx.compact({
          onComplete: () => ctx.ui.notify("Compacted to the build's state: tasks, the current task and what it changed, the spec.", "info"),
          onError: (e) => ctx.ui.notify(`Compaction failed: ${e.message}`, "error"),
        });
      }
      if (!session || !store.planningSessions().includes(session))
        return ctx.ui.notify(`/${cmd("compact")} is for planning and build sessions; elsewhere, Pi's /compact.`, "warning");
      if (args.trim() !== "undo") return instruct(`▶ /${cmd("compact")} — writing the plan to its spec, then resetting to it`, requestCheckpoint(ctx, store, session));

      const from = store.planning(session)?.checkpointFrom;
      const nav = (ctx as Partial<ExtensionCommandContext>).navigateTree;
      if (!from || !nav || !tree(ctx).getEntry?.(from)) return ctx.ui.notify("Nothing to undo: no planning reset in this session.", "info");
      const branch = tree(ctx).getBranch?.() ?? [];
      const reset = branch.map((e) => e.type).lastIndexOf("compaction");
      const since = reset < 0 ? 0 : branch.slice(reset + 1).filter((e) => e.type === "message").length;
      if (since && ctx.hasUI && !(await ctx.ui.confirm("Undo the reset?", `The ${since} message(s) since it stay on the other branch (reachable with /tree).`))) return;
      const r = await nav(from, { summarize: false, label: "pb: compact undone" });
      if (r.cancelled) return;
      store.setCheckpointFrom(session, undefined);
      checkpointQuiet.set(session, ctx.getContextUsage()?.tokens ?? Number.MAX_SAFE_INTEGER);
      post(`**↺ Reset undone**: the whole discussion is back in the context. The spec keeps what was written to it; \`/${cmd("compact")}\` writes and resets again when you want.`);
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
      if (!planned.some((n) => (store.progress(n)?.updatedAt ?? "") >= pending.since)) {
        checkpointQuiet.set(session, usage?.tokens ?? 0);
        return { entries: [{ type: "custom_message" as const, customType: "pb", content: "pb: the plan wasn't written to a spec, so the conversation goes on as it is (Pi compacts it when it's full).", display: true }] };
      }
      const specs = planned.map((n) => ({ name: n, markdown: store.readSpec(n) ?? "" }));
      store.setCheckpointFrom(session, pending.from);
      for (const n of planned) {
        const q = store.progress(n)!;
        store.saveProgress({ ...q, compacted: false });
        store.event(n, { type: "checkpoint", tokensBefore: usage?.tokens, percent: pending.percent });
      }
      return {
        entries: [
          { type: "compaction" as const, summary: checkpointSummary(specs, pending.last), firstKeptEntryId: null, details: { pb: "checkpoint", specs: planned } },
          {
            type: "custom_message" as const,
            customType: "pb",
            content: `**Plan checkpointed** to ${planned.map((n) => store.rel("specs", n, "spec.md")).join(", ")}: the conversation was reset to it (it was ${pending.percent}% full). Carry on; \`/${cmd("build")}\` when ready · \`/${cmd("compact")} undo\` brings the whole discussion back.`,
            display: true,
          },
        ],
      };
    }
    if (!cfg.checkpointAt || !usage || usage.tokens == null) return;
    const specTokens = store.specsOfPlanning(session).reduce((n, name) => n + tokensOf(store.readSpec(name) ?? ""), 0);
    const limit = Math.min((usage.contextWindow * cfg.checkpointAt) / 100, usage.contextWindow - PI_RESERVE_TOKENS - Math.max(12000, 2 * specTokens));
    if (usage.tokens < limit) return;
    const quietUntil = checkpointQuiet.get(session);
    if (quietUntil !== undefined && usage.tokens < quietUntil + usage.contextWindow * 0.05) return; // don't insist every turn
    return { entries: [{ type: "custom_message" as const, customType: "pb-instruction", content: requestCheckpoint(ctx, store, session), display: false }], continue: true };
  });

  pi.on("agent_settled", async (_e, ctx) => {
    if (await offerPendingBuild(ctx)) return;
    const { store, progress: p } = specOfSession(ctx);
    if (p?.phase === "building") pauseBuild(ctx, store, p, "the agent stopped without finishing its task (you stopped it, or it stopped again after a reminder).", "build.paused", "stopped");
  });

  /*
   * At the end of a turn: rewind points for tasks started mid-run, and the build's reset. Right after a task
   * passed and the next was handed out, past checkpointAt, the session is reset to the build's state: the
   * finished task is done and summarized, the next hasn't started, so nothing half-done is lost (unlike a
   * compaction in the middle of a task). No summarizing model call.
   */
  pi.on("turn_end", (_e, ctx) => {
    const { store, name, progress: p } = specOfSession(ctx);
    const wasBoundary = boundary;
    boundary = false;
    if (!name || !p) return;
    const leaf = tree(ctx).getLeafId?.() ?? undefined;
    const cps = store.checkpoints(name);
    let changed = false;
    // A reset in the last turn: the task it handed out starts at that reset (undo goes back to it).
    const branch = tree(ctx).getBranch?.() ?? [];
    const lastReset = [...branch].reverse().find((x) => x.type === "compaction")?.id;
    for (const c of cps.filter((c) => c.pendingReset)) {
      if (lastReset) c.entry = lastReset;
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
    const percent = pastCheckpoint(ctx, store, tokensOf(store.readSpec(name) ?? ""));
    if (percent === undefined) return;
    const cp = cps.find((c) => c.id === p.current);
    if (cp) {
      cp.pendingReset = true;
      store.saveCheckpoints(name, cps);
    }
    store.event(name, { type: "reset", task: p.current, percent });
    return {
      entries: [
        { type: "compaction" as const, summary: stateSummary(ctx, store, p, "reset"), firstKeptEntryId: null, details: { pb: "build-reset", task: p.current } },
        { type: "custom_message" as const, customType: "pb", content: `**Context reset** before ${p.current} (it was ${percent}% full): the build goes on from its state and the spec.`, display: true },
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
      const planned = session ? store.specsOfPlanning(session) : [];
      if (session && planned.length && store.planningSessions().includes(session)) {
        for (const n of planned) store.event(n, { type: "compact", reason: ev.reason, tokensBefore: ev.preparation.tokensBefore, planning: true });
        return {
          compaction: {
            summary: checkpointSummary(planned.map((n) => ({ name: n, markdown: store.readSpec(n) ?? "" }))),
            firstKeptEntryId: ev.preparation.firstKeptEntryId,
            tokensBefore: ev.preparation.tokensBefore,
          },
        };
      }
      for (const n of planned) {
        const q = store.progress(n)!;
        store.saveProgress({ ...q, compacted: true });
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
    return {
      compaction: {
        summary: stateSummary(ctx, store, p, "compaction", { changed, read, previous: ev.preparation.previousSummary }),
        firstKeptEntryId: ev.preparation.firstKeptEntryId,
        tokensBefore: ev.preparation.tokensBefore,
      },
    };
  });

  pi.on("session_before_tree", () => (undoSummary ? { summary: { summary: undoSummary } } : undefined));

  // Keep the cache warm while a check runs: the agent certainly continues afterwards.
  pi.on("cache_warming_decision", () => (checking ? { action: "warm" as const } : undefined));

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
    const notes = o.notes ?? [];
    const loaded = loadSpec(store, name);
    if (!loaded) return ctx.ui.notify(`${store.rel("specs", name, "spec.md")} doesn't parse. Rewrite it with /${cmd("spec")} ${name}.`, "error");
    const { spec, md } = loaded;
    if (spec.status === "planning") return ctx.ui.notify(`${name} is still being planned: /${cmd("build")} ${name} finishes it first.`, "warning");
    const { cfg, testCmd, buildCmd } = commands(ctx.cwd, store);
    if (spec.gate === "tests" && !testCmd) return ctx.ui.notify(`Verification is "tests" but no test command is set: set "verify" in ${store.rel("config.json")}, or use Verification: build/none in the spec.`, "warning");
    if (spec.gate === "build" && !buildCmd) return ctx.ui.notify(`Verification is "build" but no build command is set: set "build" in ${store.rel("config.json")}.`, "warning");
    if (spec.dependsOn) {
      const dep = store.progress(spec.dependsOn)?.phase;
      if (dep !== "built" && dep !== "reviewed") {
        if (!(await agree(ctx, store, `${name} depends on ${spec.dependsOn}, which isn't built yet. Build ${name} anyway?`, notes))) return;
      }
    }
    const baseline = store.baseline();
    if (!o.checked && spec.gate === "tests" && baseline?.ok === false && baseline.command === testCmd) {
      if (!(await agree(ctx, store, baselineQuestion(baseline), notes))) return;
    }
    if (!o.checked && !(await reviewPlanningChanges(ctx, store, notes))) return;

    // Optionally build on another model (e.g. plan on a strong one, build on a local one).
    let buildModel: unknown;
    if (cfg.buildModel) {
      buildModel = findModel(ctx, cfg.buildModel);
      if (!buildModel) ctx.ui.notify(`buildModel "${cfg.buildModel}" isn't a model Pi knows; building on ${sessionModel(ctx) ?? "the current model"}.`, "warning");
    }
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
    const prev = store.progress(name);
    const restart = !!prev && unfinishedPhase(prev.phase);
    const p: Progress = {
      ...prev,
      spec: name,
      phase: "building",
      baseCommit: restart ? (prev!.baseCommit ?? gitHead(ctx.cwd)) : gitHead(ctx.cwd),
      tasks: syncTasks(spec, prev?.tasks).map((t) => (t.status === "done" ? t : { ...t, status: "todo" as const, attempts: 0 })),
      current: undefined,
      pause: undefined,
      nudged: undefined,
      needsIntro: undefined,
      detached: undefined,
      unattended: notes.length ? notes : undefined,
      updatedAt: now(),
    };
    const first = p.tasks.find((t) => t.status !== "done")?.id;
    if (!first) return ctx.ui.notify(`Every task of ${name} is done. Next: /${cmd("review")} ${name}.`, "info");
    /** The start-of-build undo point, in the session that builds. */
    const startCheckpoint = (c: ExtensionContext) => {
      if (!cfg.checkpoints || (restart && store.checkpoints(name).length)) return;
      const snap = snapshot(c.cwd, `pb: start of ${name}`);
      const entry = tree(c).getLeafId?.() ?? undefined;
      store.saveCheckpoints(name, snap ? [{ id: "start", at: now(), ...snap, head: p.baseCommit, tasks: structuredClone(p.tasks), entry, intro: true }] : []);
    };

    if (!fresh) {
      // Same session: lift the planning protection, send the build instructions and the first task.
      if (buildModel && switching) await pi.setModel(buildModel as Parameters<typeof pi.setModel>[0]);
      p.session = session;
      if (session) store.setPlanning(session, false);
      store.saveProgress(p);
      startCheckpoint(ctx);
      store.event(name, { type: "build-start", tasks: spec.tasks.length, gate: spec.gate, fresh: false });
      const knowsSpec = !!session && p.writtenIn === session && !p.edited && !p.compacted;
      const task = beginTask(ctx, store, p, first, { intro: true })!;
      instruct(
        `▶ Building **${name}** here${switching ? ` on ${cfg.buildModel}` : ""}${knowsSpec ? "" : " (the spec comes along: this session didn't write it, or it was edited since)"}.\n${task.marker}`,
        `${buildIntro(name, spec, buildCmd, cfg.taskChecks === "each", standardsFor(ctx), knowsSpec ? undefined : md)}\n\n${task.prompt}`,
      );
      return;
    }

    // Fresh session: seeded with the spec, on the model and thinking level you planned with.
    const cctx = ctx as ExtensionCommandContext;
    const carried = { model: buildModel ? cfg.buildModel : sessionModel(ctx), thinking: pi.getThinkingLevel() as string | undefined };
    store.setCarry({ ...carried, spec: name });
    // A new session loads AGENTS.md itself: the standards needn't come along.
    const intro = buildIntro(name, spec, buildCmd, cfg.taskChecks === "each", "", md);
    const result = await cctx.newSession({
      parentSession: session,
      setup: async (sm) => {
        sm.appendSessionInfo(`build: ${name}`);
      },
      withSession: async (c) => {
        // Only `c` from here on: the captured pi and ctx belong to the replaced session.
        // The new session gets a fresh runtime with the default tools, so editing is on.
        p.session = c.sessionManager.getSessionFile();
        store.saveProgress(p);
        startCheckpoint(c);
        store.event(name, { type: "build-start", tasks: spec.tasks.length, gate: spec.gate, fresh: true });
        const task = beginTask(c, store, p, first, { intro: true })!;
        await c.sendMessage(
          {
            customType: "pb",
            content: `▶ Building **${name}** from ${store.rel("specs", name, "spec.md")}${carried.model ? `, on ${carried.model}` : ""}${carried.thinking ? `, thinking ${carried.thinking}` : ""}.\nThis session: "build: ${name}" · back to it with /resume, or \`pi --session ${c.sessionManager.getSessionId()}\`\n${task.marker}`,
            display: true,
          },
          { triggerTurn: false },
        );
        // Not awaited: the build runs on in this session while the command returns.
        void c.sendMessage({ customType: "pb-instruction", content: `${intro}\n\n${task.prompt}`, display: false }, { triggerTurn: true });
      },
    });
    if (result.cancelled) ctx.ui.notify("Build cancelled.", "info");
  };

  /** The spec that was just written: its tasks in the session, the whole of it as a view (not sent to the model: it wrote it). */
  const showSpec = (store: Store, name: string, names: string[] = [name]) => {
    const loaded = loadSpec(store, name);
    if (!loaded) return;
    post(
      [
        `**Spec written: ${name}** (${store.rel("specs", name, "spec.md")})${names.length > 1 ? ` · also: ${names.filter((n) => n !== name).join(", ")}` : ""}`,
        "",
        ...loaded.spec.tasks.map((t) => `- ${t.id}: ${t.title}${t.test ? ` · \`${t.test}\`` : ""}`),
        "",
        `Verification: ${loaded.spec.gate}${loaded.spec.newTests ? "" : " · no new tests"}`,
        ...assumptionsOf(loaded.md).map((a, i) => `${i ? "" : "\nSettled without asking you (the review checks them):\n"}- ${a}`),
      ].join("\n"),
    );
    pi.appendEntry("pb-spec", { name, markdown: loaded.md });
  };

  /** The spec's recorded assumptions (Decisions lines starting "Assumption"), as written while writing it. */
  const assumptionsOf = (md: string) => {
    const decisions = md.split(/^##\s+Decisions\s*$/im)[1]?.split(/^##\s+(?!#)/m)[0] ?? "";
    return [...decisions.matchAll(/^\s*-\s*(Assumption(?! \(build)[^\n]*)/gm)].map((m) => m[1].trim());
  };

  const baselineQuestion = (b: { summary: string; at: string }) =>
    `The test suite already failed when planning began (${b.summary.split("\n")[0]}, ${b.at}): the final check runs it, so it fails too unless that's fixed. Build anyway?`;

  /** The specs this session has written, ready to build, first those nothing else among them depends on. */
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
  const specWriting = new Set<string>();
  const specThenBuild = async (ctx: ExtensionCommandContext, store: Store, marker: string, prompt: string) => {
    const session = ctx.sessionManager.getSessionFile();
    const { cfg, testCmd } = commands(ctx.cwd, store);
    const notes: string[] = [];
    if (!(await reviewPlanningChanges(ctx, store, notes))) return;
    const baseline = store.baseline();
    if (baseline?.ok === false && baseline.command === testCmd && !(await agree(ctx, store, baselineQuestion(baseline), notes))) return;

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
      store.setPendingBuild(session);
      return instruct(marker, `${prompt}\n\nAfter writing it, stop: the harness shows it to me and asks whether to build.`);
    }

    const since = now();
    if (session) specWriting.add(session);
    instruct(marker, `${prompt}\n\nAfter writing it, stop: the build starts by itself.`);
    // Wait for the spec here, in the command: the run starts right after this handler hands it over.
    try {
      for (let i = 0; i < 40 && ctx.isIdle(); i++) await new Promise((r) => setTimeout(r, 50));
      await ctx.waitForIdle();
    } finally {
      if (session) specWriting.delete(session);
    }
    const ready = readySpecs(store, session, since);
    if (!ready.length) {
      // A question in chat, or the spec isn't ready yet: pb offers the build once it is.
      store.setPendingBuild(session);
      return post(`No spec ready to build yet. Answer Pi's questions; once the spec is written, pb shows it and asks how to build.`);
    }
    showSpec(store, ready[0], ready);
    await startBuild(ctx, store, ready[0], choice === FRESH, { decided: true, checked: true, notes });
  };

  /** After /pb:build asked for the spec: once it's written, show it and ask how to go on. */
  const offerPendingBuild = async (ctx: ExtensionContext): Promise<boolean> => {
    const store = new Store(ctx.cwd);
    const session = ctx.sessionManager.getSessionFile();
    if (!store.pendingBuild(session)) return false;
    const names = readySpecs(store, session);
    if (!names.length) return true; // still talking (e.g. a question before writing): keep waiting
    store.setPendingBuild(undefined);
    const name = names[0];
    const loaded = loadSpec(store, name);
    if (!loaded) return true;
    const { spec } = loaded;
    showSpec(store, name, names);
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

  pi.registerCommand(cmd("build"), {
    description: "Build the planned feature here, task by task, each checked (writes the spec first if there isn't one). --fresh builds in a new session. In a paused build: continue, optionally with guidance",
    getArgumentCompletions: specCompletions,
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) return ctx.ui.notify("Pi is busy. Wait for the current turn to finish.", "warning");
      const store = new Store(ctx.cwd);
      const fresh = /(^|\s)--fresh(\s|$)/.test(args);
      const words = args.replace(/(^|\s)--fresh(?=\s|$)/g, " ").trim().split(/\s+/).filter(Boolean);
      const session = ctx.sessionManager.getSessionFile();
      const { cfg, buildCmd } = commands(ctx.cwd, store);

      // This session has an unfinished build: continue it.
      const here = specOfSession(ctx);
      if (here.name && here.progress && unfinishedPhase(here.progress.phase)) {
        const p = here.progress;
        const guidance = words.join(" ");
        if (guidance) {
          const md = store.readSpec(p.spec);
          if (md) store.writeSpec(p.spec, addDecision(md, guidance));
        }
        const from = guidance ? `\n\nFrom the human: ${guidance}` : "";
        if (p.current === "final") {
          const fin = p.tasks.find((t) => t.id === "final");
          if (fin) fin.attempts = 1;
          p.phase = "building";
          p.pause = undefined;
          store.saveProgress(p);
          showProgress(ctx, p);
          return instruct("▶ final check", fixText("final", `\`${p.lastVerify?.command ?? "the full suite"}\``, p.lastVerify?.summary ?? "", 1, cfg.maxAttempts, false) + from);
        }
        const cur = p.current ?? nextTodo(p)?.id;
        const tp = p.tasks.find((t) => t.id === cur);
        const loaded = loadSpec(store, p.spec);
        if (!loaded) return ctx.ui.notify(`${store.rel("specs", p.spec, "spec.md")} doesn't parse. Fix it (or /${cmd("spec")} ${p.spec}), then /${cmd("build")}.`, "error");
        if (!cur || !tp) return ctx.ui.notify("Nothing left to build here.", "info");
        // Your answer to a task that kept failing buys it a fresh set of attempts; other pauses cost none.
        const exhausted = tp.attempts >= cfg.maxAttempts;
        if (exhausted) tp.attempts = 0;
        const again = exhausted || tp.status === "todo";
        const intro = !!p.needsIntro;
        p.needsIntro = undefined;
        const t = beginTask(ctx, store, p, cur, { countAttempt: again, intro })!;
        const knowsSpec = !!session && p.writtenIn === session && !p.edited && !p.compacted;
        const body = intro
          ? `${buildIntro(p.spec, loaded.spec, buildCmd, cfg.taskChecks === "each", standardsFor(ctx), knowsSpec ? undefined : loaded.md)}\n\n${t.prompt}`
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
      let name = words[0] && store.readSpec(words[0]) ? words[0] : undefined;
      if (!name) {
        const mine = offered.filter((n) => store.progress(n)?.writtenIn === session);
        const planning = !!session && store.planningSessions().includes(session);
        if (!mine.length && (planning || !offered.length)) {
          // No spec from this discussion yet: write it first, then build it.
          return specThenBuild(ctx, store, `▶ /${cmd("build")} — writing the spec first`, specPrompt(words.join(" "), store.specNames()));
        }
        const pool = mine.length ? mine : offered;
        const labelOf = (n: string) => (unfinishedPhase(phaseOf(n)) ? `${n} (restart the build, finished tasks stay done)` : n);
        if (pool.length === 1 || !ctx.hasUI) name = pool[0];
        else {
          const labels = pool.map(labelOf);
          const choice = await ctx.ui.select("Build which spec?", labels);
          name = choice ? pool[labels.indexOf(choice)] : undefined;
        }
        if (!name) return;
      }
      if (loadSpec(store, name)?.spec.status === "planning") {
        // A checkpoint of an unfinished discussion: finish it (tasks, verification), then build it.
        return specThenBuild(ctx, store, `▶ /${cmd("build")} — finishing the spec ${name} first`, finishSpecPrompt(name).replace(/\s*After writing it, stop:[^\n]*/, ""));
      }
      await startBuild(ctx, store, name, fresh);
    },
  });

  /* -------------------------------- review ------------------------------- */

  const P_ORDER = ["P0", "P1", "P2", "P3"] as const;

  /**
   * One review pass in its own, real Pi session ("review: <spec> · spec" or "· adversarial"): you're moved into it
   * and watch it natively; its model is read-only and reports with pb_report_findings. It ends when the model
   * has reported and stopped, or at /pb:review done. Returns what it found, and whether you left meanwhile.
   */
  const drivePass = async (
    c: Pick<ExtensionContext, "isIdle" | "sessionManager">,
    send: ReplacedSessionContext["sendMessage"],
    store: Store,
    o: { role: "review" | "abuse"; label: string; brief: string; resume?: boolean },
  ) => {
    const idleMs = (store.config().reviewer.idleSec ?? 20) * 1000;
    const session = c.sessionManager.getSessionFile() ?? "";
    try {
      await send(
        {
          customType: "pb",
          content: o.resume
            ? `▶ Continuing the ${o.role === "review" ? "review" : "adversarial pass"} of **${o.label}** where it was interrupted.`
            : `▶ ${o.role === "review" ? "Review" : "Adversarial pass"} of **${o.label}**, in a fresh session. The model can't change files; you can watch, interrupt and ask it anything. It ends when it has reported its findings and stops (\`/${cmd("review")} done\` ends it now); then pb takes you back.`,
          display: true,
        },
        { triggerTurn: false },
      );
      const first = o.resume
        ? "[pb] You were interrupted. Carry on where you were, then report all your findings with pb_report_findings (including any you reported before) and stop."
        : reviewSessionPrompt(o.role, o.brief);
      void send({ customType: "pb-instruction", content: first, display: false }, { triggerTurn: true });
      let idle = 0;
      let nudged = false;
      for (;;) {
        await sleep(200);
        const state = store.reviewSession(session);
        if (state?.done) break;
        if (!c.isIdle()) {
          idle = 0;
          continue;
        }
        idle += 200;
        if (state?.findings && idle >= 400) break; // reported, and stopped
        if (!state?.findings && idle >= idleMs) {
          if (nudged) break;
          nudged = true;
          idle = 0;
          void send({ customType: "pb-instruction", content: "[pb] Report your findings with pb_report_findings (an empty list if there are none), then stop.", display: false }, { triggerTurn: true });
        }
      }
      const branch = tree(c as ExtensionContext).getBranch?.() ?? [];
      const prose = [...branch].reverse().find((e) => e.type === "message" && e.message?.role === "assistant" && contentText(e.message.content).trim());
      const text = prose ? contentText(prose.message!.content).trim() : "";
      const state = store.reviewSession(session);
      if (state?.done) store.saveReviewSession(session, { ...state, done: undefined });
      return { findings: state?.findings ?? fromProse(text), prose: text, left: false, session };
    } catch {
      // You switched to another session: this one can't be driven any more.
      return { findings: store.reviewSession(session)?.findings ?? [], prose: "", left: true, session };
    }
  };

  /**
   * The rest of a review from its saved state: the next pass in a new session, or the finish. When you leave
   * mid-pass, the state is kept (with the interrupted pass) so /pb:review can continue it instead of starting over.
   */
  const reviewNext = async (from: ExtensionCommandContext, store: Store, run: ReviewRun, left = false): Promise<void> => {
    if (left) {
      const cut = run.passes.at(-1);
      store.saveReviewRun({ ...run, interrupted: cut ? { role: cut.role, session: cut.session } : undefined });
      writeReview(store, run, true);
      return;
    }
    let todo: "review" | "abuse" | undefined = !run.passes.length ? "review" : run.security && run.passes.length === 1 ? "abuse" : undefined;
    if (todo === "abuse") {
      // The adversarial pass is optional: asked when the review is done; unanswered, it runs.
      const RUN = "Run the adversarial pass";
      const choice = await choose(from, store, "The review is done. Run the adversarial pass now (someone trying to break the change)?", [RUN, "Skip it"], RUN);
      if (choice !== RUN) {
        run.security = undefined;
        run.abuseSkipped = true;
        todo = undefined;
      }
    }
    if (!todo) return reviewFinish(from, store, run);
    store.saveReviewRun(run);
    store.setCarry({ model: run.model, thinking: run.thinking, spec: run.name ?? "", review: { role: todo, spec: run.name } });
    const result = await from.newSession({
      parentSession: run.home,
      setup: async (sm) => {
        // Both passes are part of one review: named together, so they sort together in /resume.
        sm.appendSessionInfo(`review: ${run.label} · ${todo === "abuse" ? "adversarial" : run.name ? "spec" : "intent"}`);
      },
      withSession: async (c) => {
        const r = await drivePass(c, c.sendMessage, store, { role: todo, label: run.label, brief: run.brief });
        run.passes.push({ role: todo, ...r });
        await reviewNext(c, store, run, r.left);
      },
    });
    if (result.cancelled) return reviewNext(from, store, run, true);
  };

  /** Continue an interrupted pass in its own session (`c` is that session), then the rest of the review. */
  const reviewContinue = async (c: ExtensionCommandContext, send: ReplacedSessionContext["sendMessage"], store: Store, run: ReviewRun, cut: NonNullable<ReviewRun["interrupted"]>) => {
    const role = cut.role;
    run.passes = run.passes.filter((x) => x.session !== cut.session);
    run.interrupted = undefined;
    store.saveReviewRun(run);
    const r = await drivePass(c, send, store, { role, label: run.label, brief: run.brief, resume: true });
    run.passes.push({ role, ...r });
    await reviewNext(c, store, run, r.left);
  };

  /** The review's message: verdict, findings, what was dismissed or put back, and the sessions. */
  const reviewMessage = (run: ReviewRun, o: { findings: Finding[]; dismissed: { finding: Finding; evidence: string }[]; restored: string[]; partial: boolean }) => {
    const findings = [...o.findings].sort((a, b) => P_ORDER.indexOf(a.priority) - P_ORDER.indexOf(b.priority));
    const counts = P_ORDER.map((k) => findings.filter((f) => f.priority === k).length);
    const finished = (role: "review" | "abuse") => run.passes.some((x) => x.role === role && !x.left);
    const verdict = run.passes.length ? verdictOf(findings) : "none";
    const tally = findings.length || o.dismissed.length ? ` · ${counts.map((c, n) => `P${n} ${c}`).join(" · ")}` : "";
    const sessions = run.passes.map((x) => `${x.role === "review" ? (run.name ? "spec" : "intent") : "adversarial"} \`pi --session ${path.relative(run.cwd, x.session)}\``);
    const text = [
      `**Review of ${run.label}**${run.followUp ? " (follow-up)" : ""} — ${verdict === "pass" ? "✅ PASS" : verdict === "changes_needed" ? "✗ CHANGES NEEDED" : "no verdict"}${tally}${finished("abuse") ? " · with an adversarial pass" : run.abuseSkipped ? " · adversarial pass skipped" : ""}`,
      ...(o.partial
        ? ["", `⚠ You left the review before it finished: the ${finished("review") ? "adversarial pass" : "review"} didn't finish; this is what had been reported. \`/${cmd("review")}\` continues it.`]
        : []),
      "",
      run.passes.find((x) => x.role === "review")?.prose ?? "",
      ...(findings.length ? ["", "**Findings**", "", ...findings.map((f, i) => findingLine(f, i + 1))] : []),
      ...(o.dismissed.length ? ["", "Dismissed after a second look:", ...o.dismissed.map((d) => `- [${d.finding.priority}] ${d.finding.title} — ${d.evidence}`)] : []),
      ...(o.restored.length ? ["", `⚠ Files changed during the review were put back: ${o.restored.join(", ")}`] : []),
      ...(sessions.length ? ["", `The review sessions: ${sessions.join(" · ")}`] : []),
      "",
      tip(verdict === "pass" ? "review.pass" : verdict === "changes_needed" ? "review.changes" : "review.other", { spec: run.label }),
    ].join("\n");
    return { text, verdict, counts, findings, complete: finished("review") && (!run.security || finished("abuse")), abuse: finished("abuse") };
  };

  const allFindings = (run: ReviewRun) => run.passes.flatMap((x) => (x.role === "abuse" ? x.findings.map((f) => ({ ...f, title: `Adversarial: ${f.title}` })) : x.findings));

  /** Never lost: the result (or what was reported so far) is kept with the spec. */
  const writeReview = (store: Store, run: ReviewRun, partial: boolean) => {
    const m = reviewMessage(run, { findings: allFindings(run), dismissed: [], restored: [], partial });
    fs.mkdirSync(path.dirname(store.reviewFile(run.name)), { recursive: true });
    fs.writeFileSync(store.reviewFile(run.name), `${m.text}\n`);
    return m;
  };

  /** Double-check, put back anything changed, record the result, and take you home with it. */
  const reviewFinish = async (from: ExtensionCommandContext, store: Store, run: ReviewRun): Promise<void> => {
    const cfg = store.config();
    const widget = (t?: string[]) => safely(() => from.ui.setWidget("pb-review", t));
    let textNow = "";
    const all = allFindings(run);
    const checked =
      cfg.reviewer.verify === false
        ? { findings: all, dismissed: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 }
        : await verifyFindings({
            cwd: run.cwd,
            findings: all,
            base: run.base,
            spec: run.name ? store.readSpec(run.name) : undefined,
            model: run.model,
            thinking: run.thinking,
            sessionDir: run.name ? store.specSessionsDir(run.name, "verifier") : store.sessionsDir("verifier"),
            onActivity: (a) => widget([`pb review ${run.label} — verifying P0/P1 findings`, `  ↳ ${a}`, ...tail(textNow).map((l) => `  │ ${l}`)]),
            onText: (t) => {
              textNow = t;
            },
          });
    widget(undefined);
    const after = run.before ? snapshot(run.cwd, `pb: after review ${run.label}`) : undefined;
    const restored = run.before && after && run.before.tree !== after.tree ? restore(run.cwd, after.commit, run.before.commit) : [];
    const m = reviewMessage(run, { findings: checked.findings, dismissed: checked.dismissed, restored, partial: false });
    const p = run.name ? store.progress(run.name) : undefined;
    if (run.name && p) {
      store.event(run.name, { type: "review", security: m.abuse, verdict: m.verdict, p: m.counts, dismissed: checked.dismissed.length, followUp: run.followUp, ...checked.tokens, cost: checked.cost });
      if (m.complete) {
        p.review = { at: now(), snapshot: run.before?.commit, verdict: m.verdict, findings: m.findings.filter((f) => f.priority !== "P3") };
        if (m.verdict === "pass") p.phase = "reviewed";
      }
      p.reviewUnshown = true;
      store.saveProgress(p);
    }
    fs.mkdirSync(path.dirname(store.reviewFile(run.name)), { recursive: true });
    fs.writeFileSync(store.reviewFile(run.name), `${m.text}\n`);
    store.saveReviewRun(undefined);
    if (!run.home) return;
    try {
      await from.switchSession(run.home, {
        withSession: async (c) => {
          await c.sendMessage({ customType: "pb", content: m.text, display: true }, { triggerTurn: false });
          const q = run.name ? store.progress(run.name) : undefined;
          if (q) {
            q.reviewUnshown = undefined;
            store.saveProgress(q);
          }
        },
      });
    } catch {
      // you went elsewhere meanwhile: review.md has it, and the next /pb:review shows it
    }
  };

  pi.registerCommand(cmd("review"), {
    description:
      "Independent review in fresh sessions you watch: a spec pass by a reviewer who never saw the build, then an adversarial pass, against the spec or any uncommitted change's intent; pb brings you back with the result. Follow-ups look only at what changed (--full: everything). /pb:review done ends a review session now",
    getArgumentCompletions: specCompletions,
    handler: async (args, ctx) => {
      const store = new Store(ctx.cwd);
      // Inside a review session: /pb:review done ends it.
      const session = ctx.sessionManager.getSessionFile();
      const here = store.reviewSession(session);
      const saved = store.reviewRun();
      if (here) {
        // Inside a review session: done ends the pass; continue picks up an interrupted one.
        const cut = saved?.interrupted;
        if (args.trim() === "continue" && saved && cut && cut.session === session) {
          if (!ctx.isIdle()) return ctx.ui.notify("Pi is busy. Wait for the current turn to finish.", "warning");
          return reviewContinue(ctx, async (m, o) => pi.sendMessage(m, o), store, saved, cut);
        }
        if (args.trim() !== "done") return ctx.ui.notify(`This is a review session: \`/${cmd("review")} done\` ends it${saved?.interrupted?.session === session ? `; \`/${cmd("review")} continue\` picks it up where it was interrupted` : ""}.`, "info");
        store.saveReviewSession(session!, { ...here, done: true });
        return ctx.ui.notify("Ending this review pass…", "info");
      }
      if (!ctx.isIdle()) return ctx.ui.notify("Pi is busy. Wait for the current turn to finish.", "warning");
      // An interrupted review: continue it rather than start over.
      if (saved?.interrupted) {
        const CONTINUE = `Continue the interrupted review of ${saved.label} (the ${saved.interrupted.role === "review" ? "spec pass" : "adversarial pass"} didn't finish)`;
        const SHOW = "Show what it had reported";
        const NEW = "Start a new review";
        const choice = ctx.hasUI ? await ctx.ui.select("A review was interrupted", [CONTINUE, SHOW, NEW]) : CONTINUE;
        if (!choice) return;
        if (choice === SHOW) return post(fs.readFileSync(store.reviewFile(saved.name), "utf8"));
        if (choice === CONTINUE) {
          // Not "interrupted" any more as you arrive: pb is continuing it, no need to say how.
          const cut = saved.interrupted;
          const run = { ...saved, interrupted: undefined };
          store.saveReviewRun(run);
          await ctx.switchSession(cut.session, { withSession: (c) => reviewContinue(c, c.sendMessage, store, run, cut) });
          return;
        }
        store.saveReviewRun(undefined);
      }
      const full = /(^|\s)--full(\s|$)/.test(args);
      const rest = args.replace(/(^|\s)--full(?=\s|$)/g, " ").trim();
      const { cfg, testCmd, buildCmd } = commands(ctx.cwd, store);

      // What to review: this session's spec; else a built one or the uncommitted change without a spec.
      let name = specOfSession(ctx).name;
      if (!name) {
        const built = store.specNames().filter((n) => ["built", "reviewed", "building", "paused"].includes(store.progress(n)?.phase ?? ""));
        const ADHOC = "The uncommitted change (no spec)";
        if (built.length) {
          const choice = ctx.hasUI ? await ctx.ui.select("Review what?", [...built, ADHOC]) : built[0];
          if (!choice) return;
          name = choice === ADHOC ? undefined : choice;
        }
      }
      const loaded = name ? loadSpec(store, name) : undefined;
      const p = name ? store.progress(name) : undefined;
      if (name && (!loaded || !p)) return ctx.ui.notify(`${store.rel("specs", name, "spec.md")} doesn't parse.`, "error");
      // A review that finished while you were elsewhere: show it first.
      if (name && p?.reviewUnshown) {
        p.reviewUnshown = undefined;
        store.saveProgress(p);
        return post(fs.readFileSync(store.reviewFile(name), "utf8"));
      }
      const base = p?.baseCommit;
      const changed = changedSince(ctx.cwd, base);
      if (!name && !changed.length) return ctx.ui.notify("Nothing to review: there are no uncommitted changes.", "info");
      const intent = name ? "" : rest || (ctx.hasUI ? ((await ctx.ui.input("What is the change meant to do? (optional)")) ?? "") : "");

      // Once per project: the model that built the change shares its blind spots; offer a different one.
      if (!cfg.reviewer.model && ctx.hasUI && !store.asked("reviewer-model")) {
        store.markAsked("reviewer-model");
        const current = sessionModel(ctx);
        const registry = (ctx as { modelRegistry?: { getAvailable?(): { provider: string; id: string }[] } }).modelRegistry;
        const others = (registry?.getAvailable?.() ?? []).map((m) => `${m.provider}/${m.id}`).filter((m) => m !== current);
        if (others.length) {
          const KEEP = `Keep ${current ?? "the session's model"}`;
          const choice = await ctx.ui.select(`The reviewer runs on ${current ?? "the session's model"}, which likely built this too. A different model family catches different mistakes:`, [KEEP, ...others]);
          if (choice && choice !== KEEP) {
            store.updateConfig((raw) => ({ ...raw, reviewer: { ...(raw.reviewer ?? {}), model: choice } }));
            cfg.reviewer.model = choice;
            ctx.ui.notify(`The reviewer now runs on ${choice} (reviewer.model in ${store.rel("config.json")}).`, "info");
          }
        }
      }

      const label = name ?? "the uncommitted change";
      // Fresh ground truth first: the reviewer should judge what's on disk now.
      const command = loaded ? (loaded.spec.gate === "tests" ? testCmd : loaded.spec.gate === "build" ? buildCmd : null) : (testCmd ?? buildCmd);
      let check = "(not run)";
      if (command) {
        safely(() => ctx.ui.setWidget("pb-review", [`pb review ${label} — checking: ${command}`]));
        const v = await runVerify(command, ctx.cwd, cfg.verifyTimeoutSec, cfg.testOutputCap);
        safely(() => ctx.ui.setWidget("pb-review", undefined));
        check = v.summary;
        if (p) {
          p.lastVerify = v;
          store.saveProgress(p);
        }
      }

      // The tree as the reviewer sees it: the next review's delta starts here, and anything changed during it is put back.
      const before = cfg.checkpoints ? snapshot(ctx.cwd, `pb: review ${label}`) : undefined;
      const prevReview = p?.review;
      let previous: { snapshot: string; findings: Finding[]; changed: string[] } | undefined;
      if (!full && prevReview?.snapshot && before) {
        const since = changedPaths(ctx.cwd, prevReview.snapshot, before.commit);
        if (!since.length) return ctx.ui.notify(`Nothing changed since the last review (${prevReview.verdict}). /${cmd("review")} --full reviews everything again.`, "info");
        previous = { snapshot: prevReview.snapshot, findings: prevReview.findings, changed: since };
      }

      // The abuse pass: on every review by default (reviewer.security "always"), or on sensitive ground ("auto").
      const mode = cfg.reviewer.security ?? "always";
      const diffText = mode === "auto" ? gitDiff(ctx.cwd, base) : "";
      const security =
        mode === "always" ? "always" : mode === "off" ? undefined : sensitiveGround({ spec: loaded?.md, files: changed, diff: diffText + untrackedText(ctx.cwd, changed) });
      const brief = reviewerBrief({
        spec: loaded && name ? { name, markdown: loaded.md, parsed: loaded.spec } : undefined,
        intent,
        base,
        changed,
        stat: diffStat(ctx.cwd, base),
        check,
        focus: name ? rest : "",
        previous,
        testChanges: p?.testChanges,
      });
      // Only plain values from here on: `ctx` belongs to this session, which the first pass replaces.
      const run: ReviewRun = {
        cwd: ctx.cwd,
        name,
        label,
        brief,
        base,
        security,
        followUp: !!previous,
        home: ctx.sessionManager.getSessionFile(),
        before: before ? { commit: before.commit, tree: before.tree } : undefined,
        model: cfg.reviewer.model ?? sessionModel(ctx),
        thinking: cfg.reviewer.thinking ?? (pi.getThinkingLevel() as string | undefined),
        passes: [],
      };
      await reviewNext(ctx, store, run);
    },
  });

  /* -------------------------------- stats -------------------------------- */

  pi.registerCommand(cmd("stats"), {
    description: "How a build went: tasks, first-try rate, checks, pauses, tokens and cache. A spec name, or all",
    getArgumentCompletions: specCompletions,
    handler: async (args, ctx) => {
      const store = new Store(ctx.cwd);
      const arg = args.trim();
      const all = loadStats(store);
      if (arg === "all") return post(renderAll(all));
      const name = arg || specOfSession(ctx).name || (all.length === 1 ? all[0].name : undefined);
      const one = all.find((s) => s.name === name);
      if (!one) return all.length ? post(renderAll(all)) : ctx.ui.notify("No stats yet: they are collected while building.", "info");
      post(renderCard(one));
    },
  });

  /* ------------------------------ project map ----------------------------- */

  /**
   * Update the project map in a fresh, read-only call (the session doesn't grow). Paths that don't resolve
   * go back to it once to be corrected; then the map is written, with the change shown and /pb:map undo to
   * go back. It asks first only when something looks off: paths that still don't resolve, or a large part of
   * the existing map removed (unanswered: the current map stays).
   */
  const updateMap = async (ctx: ExtensionContext, store: Store, o: { spec?: { name: string; findings: string }; changed?: string[]; focus?: string } = {}) => {
    const cfg = store.config();
    const current = readMap(ctx.cwd);
    const abort = new AbortController();
    const unsubEsc = ctx.mode === "tui" ? ctx.ui.onTerminalInput((d) => (d === "\x1b" ? (abort.abort(), { consume: true }) : undefined)) : undefined;
    let textNow = "";
    const render = (phase: string, activity?: string) =>
      safely(() => ctx.ui.setWidget("pb-map", [`pb map — ${phase}   (Esc to stop)`, ...(activity ? [`  ↳ ${activity}`] : []), ...tail(textNow).map((l) => `  │ ${l}`)]));
    let mapSession: string | undefined;
    const cartographer = (brief: string, phase: string) =>
      runFresh({
        cwd: ctx.cwd,
        role: "cartographer",
        systemPrompt: CARTOGRAPHER_SYSTEM,
        brief,
        prompt: "Do what the attached file asks; report the whole map with report_map.",
        tools: ["read", "grep", "find", "ls", "bash", "report_map"],
        extensions: [REVIEW_TOOLS],
        model: cfg.explorer.model ?? sessionModel(ctx),
        thinking: cfg.explorer.thinking ?? "max",
        signal: abort.signal,
        onActivity: (a) => render(phase, a),
        onText: (t) => {
          textNow = t;
          render(phase);
        },
        sessionDir: store.sessionsDir("cartographer"),
      }).then((r) => {
        mapSession = r.sessionFile ?? mapSession;
        return r;
      });
    const mapOf = (r: Awaited<ReturnType<typeof runFresh>>) => {
      const call = r.toolCalls.filter((c) => c.name === "report_map").at(-1);
      return {
        map: typeof call?.arguments.map === "string" ? normalizeMap(call.arguments.map) : "",
        changes: Array.isArray(call?.arguments.changes) ? (call.arguments.changes as string[]) : [],
      };
    };
    let body = "";
    let changes: string[] = [];
    let unresolved: { path: string; line: string }[] = [];
    try {
      render("reading the project");
      const first = await cartographer(cartographerBrief({ current, ...o }), "reading the project");
      store.exploreEvent({ session: ctx.sessionManager.getSessionFile(), ...first.tokens, cost: first.cost, ms: first.ms });
      if (first.aborted) return ctx.ui.notify("Map update stopped.", "info");
      ({ map: body, changes } = mapOf(first));
      if (!body) return ctx.ui.notify(`No map came back${first.error ? `: ${first.error}` : ""}.`, "warning");
      unresolved = unresolvedPaths(ctx.cwd, body);
      if (unresolved.length) {
        // Once: the cartographer corrects or removes what doesn't resolve; nothing is deleted behind its back.
        const second = await cartographer(cartographerBrief({ current, proposed: body, unresolved }), "checking its paths");
        store.exploreEvent({ session: ctx.sessionManager.getSessionFile(), ...second.tokens, cost: second.cost, ms: second.ms });
        if (second.aborted) return ctx.ui.notify("Map update stopped.", "info");
        const fixed = mapOf(second).map;
        if (fixed) {
          body = fixed;
          unresolved = unresolvedPaths(ctx.cwd, body);
        }
      }
    } finally {
      unsubEsc?.();
      ctx.ui.setWidget("pb-map", undefined);
    }

    const diff = mapDiff(current, body);
    if (!diff.length) return ctx.ui.notify("The project map is up to date: nothing to change.", "info");
    const tokens = mapTokens(body);
    const currentLines = current.split("\n").filter((l) => l.trim()).length;
    const removed = diff.filter((l) => l.startsWith("-")).length;
    const warnings = [
      ...unresolved.map((u) => `\`${u.path}\` doesn't resolve`),
      ...(currentLines >= 6 && removed / currentLines > 0.3 ? [`it removes ${removed} of the map's ${currentLines} lines`] : []),
    ];
    pi.appendEntry("pb-map", { diff, warnings, tokens, map: body, changes });
    if (warnings.length) {
      const APPLY = "Apply it anyway";
      const EDIT = "Edit it first";
      const KEEP = "Keep the current map";
      const choice = await choose(ctx, store, `The proposed project map needs a look: ${warnings.join("; ")}`, [KEEP, APPLY, EDIT], KEEP);
      if (choice === EDIT) {
        const edited = await ctx.ui.editor("Edit the project map", body);
        if (edited === undefined) return ctx.ui.notify("Map not changed.", "info");
        body = normalizeMap(edited);
      } else if (choice !== APPLY) return ctx.ui.notify("Map not changed.", "info");
    }
    store.saveMapPrevious(current);
    writeMap(ctx.cwd, body);
    ctx.ui.notify(
      `Project map ${current ? "updated" : "written"} in AGENTS.md (~${tokens} tokens${changes.length ? `: ${changes.slice(0, 3).join("; ")}${changes.length > 3 ? "; …" : ""}` : ""}). \`/${cmd("map")} undo\` puts the previous one back.${mapSession ? ` The whole run: \`pi --session ${path.relative(ctx.cwd, mapSession)}\`` : ""}`,
      "info",
    );
  };

  pi.registerCommand(cmd("map"), {
    description: "Refresh the project map in AGENTS.md (layout, patterns, constraints) from the code as it is now. Optional: what to focus on; /pb:map undo puts the previous map back",
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) return ctx.ui.notify("Pi is busy. Wait for the current turn to finish.", "warning");
      const store = new Store(ctx.cwd);
      if (args.trim() === "undo") {
        const previous = store.mapPrevious();
        if (previous === undefined) return ctx.ui.notify("No previous map to go back to.", "info");
        const now_ = readMap(ctx.cwd);
        writeMap(ctx.cwd, previous);
        store.saveMapPrevious(now_);
        return ctx.ui.notify(`The previous project map is back in AGENTS.md (\`/${cmd("map")} undo\` again swaps them back).`, "info");
      }
      await updateMap(ctx, store, { focus: args.trim() || undefined });
    },
  });

  /* ------------------------------- archive ------------------------------- */

  pi.registerCommand(cmd("archive"), {
    description: "Put a finished spec (and its history) away in .pi/pb-archive/",
    getArgumentCompletions: specCompletions,
    handler: async (args, ctx) => {
      const store = new Store(ctx.cwd);
      const candidates = store.specNames().filter((n) => ["built", "reviewed"].includes(store.progress(n)?.phase ?? ""));
      let name = args.trim() || undefined;
      if (!name) {
        if (!candidates.length) return ctx.ui.notify("No finished spec to archive.", "info");
        name = candidates.length === 1 || !ctx.hasUI ? candidates[0] : await ctx.ui.select("Archive which spec?", candidates);
        if (!name) return;
      }
      if (!store.readSpec(name)) return ctx.ui.notify(`No spec "${name}".`, "warning");
      if (!candidates.includes(name) && ctx.hasUI && !(await ctx.ui.confirm(`${name} isn't finished`, "Archive it anyway?"))) return;
      const markdown = store.readSpec(name) ?? "";
      const changed = changedSince(ctx.cwd, store.progress(name)?.baseCommit);
      // The feature is finished: its review runs and the explorer and map runs so far aren't needed any more.
      store.dropSessions(name);
      const dest = store.archive(name);
      if (!store.specNames().length) dropCheckpoints(ctx.cwd); // no live spec left to undo: let git reclaim the snapshots
      ctx.ui.notify(`Archived ${name} to ${path.relative(ctx.cwd, dest)}.`, "info");
      // The feature is done: what it established about the project goes into the map every session reads.
      if (store.config().mapOnArchive) {
        ctx.ui.notify(`Updating the project map from ${name} (mapOnArchive in ${store.rel("config.json")} turns this off)…`, "info");
        await updateMap(ctx, store, { spec: { name, findings: findingsOf(markdown) }, changed });
      }
    },
  });

  /* --------------------------------- undo -------------------------------- */

  pi.registerCommand(cmd("undo"), {
    description: "Go back to before a task of this build: files, task list and conversation, picked from a list",
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) return ctx.ui.notify("Pi is busy. Wait for the current turn to finish.", "warning");
      const { store, name, progress: p } = specOfSession(ctx);
      if (!name || !p) return ctx.ui.notify(`Run /${cmd("undo")} in the build session of a spec.`, "warning");
      const cps = store.checkpoints(name);
      if (!cps.length) return ctx.ui.notify("No checkpoints for this build.", "info");
      const label = (c: Checkpoint) => (c.id === "start" ? `⌂ start of the build (${c.at})` : c.id.startsWith("u") ? `↺ before undo (${c.at})` : `${c.id}  ${c.summary ?? "(not finished)"}`);
      const newest = [...cps].reverse();
      const [idArg] = args.trim().split(/\s+/);
      let target = idArg ? cps.find((c) => c.id.toLowerCase() === idArg.toLowerCase()) : undefined;
      if (!target && ctx.hasUI && !idArg) {
        const labels = newest.map(label);
        const choice = await ctx.ui.select("Restore the working tree to the state BEFORE…", labels);
        target = choice ? newest[labels.indexOf(choice)] : undefined;
      }
      if (!target) return idArg ? ctx.ui.notify(`No checkpoint "${idArg}".`, "warning") : post(["```", ...newest.map((c) => `${c.id.padEnd(6)} ${label(c)}`), "```", `\`/${cmd("undo")} <id>\``].join("\n"));

      const cur = snapshot(ctx.cwd, "pb: before undo");
      if (!cur) return ctx.ui.notify("Could not snapshot the working tree (is this a git repository?). Nothing was changed.", "error");
      const files = changedPaths(ctx.cwd, cur.commit, target.commit);
      const idx = cps.indexOf(target);
      const undoneCps = cps.slice(idx).filter((c) => c.task);
      const undone = undoneCps.map((c) => c.id);
      const head = gitHead(ctx.cwd);
      const summary = [
        `Files: ${files.length ? files.slice(0, 20).join(", ") + (files.length > 20 ? ` … (+${files.length - 20})` : "") : "none"}`,
        undone.length ? `Tasks back to todo: ${undone.join(", ")}` : "",
        target.head && head && target.head !== head ? "⚠ You committed since then: undo restores files but never moves your branch." : "",
      ]
        .filter(Boolean)
        .join("\n");
      if (ctx.hasUI && !(await ctx.ui.confirm(`Undo to before ${target.id === "start" ? "the build" : target.id}?`, summary))) return;
      restore(ctx.cwd, cur.commit, target.commit);

      // The conversation goes back too, so the discarded attempt doesn't anchor the next one;
      // everything before that point is still in the prompt cache.
      const oldLeaf = tree(ctx).getLeafId?.() ?? undefined;
      const reverting = target.id.startsWith("u");
      let point = rewindPoint(ctx, target.entry, reverting);
      // A point before the latest compaction or reset would bring back the whole old context: files only then.
      const branch = tree(ctx).getBranch?.() ?? [];
      const at = point ? branch.findIndex((x) => x.id === point) : -1;
      const beforeCompaction = !!point && !reverting && (at < 0 || at < branch.map((x) => x.type).lastIndexOf("compaction"));
      if (beforeCompaction) point = undefined;
      const nav = (ctx as Partial<ExtensionCommandContext>).navigateTree;
      let rewound = false;
      if (point && nav && point !== oldLeaf) {
        // What the human said in the part that's rewound would go with it: the note keeps it.
        const said: string[] = [];
        for (let id = oldLeaf; id && id !== point; ) {
          const e = tree(ctx).getEntry?.(id);
          if (!e) break;
          if (e.type === "message" && e.message?.role === "user") {
            const c = e.message.content;
            const t = typeof c === "string" ? c : Array.isArray(c) ? c.map((x: { text?: string }) => x.text ?? "").join("") : "";
            if (t.trim()) said.unshift(t.trim().replace(/\s+/g, " "));
          }
          id = e.parentId ?? undefined;
        }
        undoSummary = reverting
          ? undefined
          : `[pb] The human undid the work from ${target.id === "start" ? "the start of the build" : target.id} on (/pb:undo restored the files). What had been done: ${undoneCps.map((c) => c.summary ?? `${c.id} (unfinished)`).join("; ") || "nothing finished"}. Don't simply repeat it.${said.length ? ` What the human said meanwhile, still valid unless they say otherwise: ${said.map((x) => `"${x}"`).join("; ")}` : ""}`;
        try {
          const r = await nav(point, { summarize: !reverting, label: `pb: before ${target.id}` });
          rewound = !r.cancelled;
        } catch (e) {
          ctx.ui.notify(`Files restored, but the conversation couldn't be rewound: ${(e as Error).message}`, "warning");
        } finally {
          undoSummary = undefined;
        }
      }
      const undoEntry: Checkpoint = { id: `u${cps.filter((c) => c.id.startsWith("u")).length + 1}`, at: now(), ...cur, head, tasks: structuredClone(p.tasks), entry: rewound ? oldLeaf : undefined };
      store.saveCheckpoints(name, [...cps.slice(0, idx).concat(target.id === "start" ? [target] : []), undoEntry]);
      p.tasks = structuredClone(target.tasks).filter((t) => t.id !== "final");
      p.current = undefined;
      p.phase = "paused";
      p.pause = `undone to before ${target.id}`;
      p.needsIntro = rewound && !!target.intro ? true : undefined;
      store.saveProgress(p);
      showProgress(ctx, p);
      store.event(name, { type: "undo", to: target.id, tasks: undone, rewound });
      const note = beforeCompaction
        ? `\nThe conversation wasn't rewound (that point is before a context reset or compaction). What was undone: ${undoneCps.map((c) => c.summary ?? `${c.id} (unfinished)`).join("; ") || "nothing finished"}.`
        : "";
      post(
        `**↺ Undone to before ${target.id === "start" ? "the build" : target.id}** — ${files.length} file(s) restored${rewound ? ", the conversation rewound" : ""}.\n${summary}${note}\n\n${tip("undo.done", { id: undoEntry.id })}`,
      );
    },
  });

  /* -------------------------------- status ------------------------------- */

  pi.registerCommand(cmd("status"), {
    description: "Every spec and where it stands",
    handler: async (_args, ctx) => {
      const store = new Store(ctx.cwd);
      const names = store.specNames();
      if (!names.length) return ctx.ui.notify(`No specs yet. Start with /${cmd("plan")} <feature>.`, "info");
      const here = store.specForSession(ctx.sessionManager.getSessionFile());
      const lines = names.flatMap((n) => {
        const p = store.progress(n);
        const s = loadSpec(store, n)?.spec;
        const where = p?.session && n !== here ? ` · session: pi --session ${p.session}` : "";
        const head = `${n === here ? "▸ " : ""}${n} — ${p?.phase ?? "written"}${where}${s ? ` · verification ${s.gate}${s.newTests ? "" : " · no new tests"}${s.dependsOn ? ` · depends on ${s.dependsOn}` : ""}` : " · ⚠ doesn't parse"}${p?.pause ? ` · paused: ${p.pause}` : ""}`;
        return [head, ...(p && p.phase !== "written" ? p.tasks.map((t) => `    ${taskLine(t)}`) : [])];
      });
      ctx.ui.notify([...lines, `help: /${cmd("help")}`].join("\n"), "info");
    },
  });

  /* --------------------------------- help -------------------------------- */

  pi.registerCommand(cmd("help"), {
    description: "What to do next and how to handle edge cases. /pb:help <topic> shows one section",
    handler: async (args, ctx) => {
      const name = args.trim().toLowerCase();
      const body = name ? topic(name) : undefined;
      if (body) return post(`${body}\n\n(Full guide: ${HELP_PATH})`);
      const list = topics().map((t) => `- \`/${cmd("help")} ${t.name}\` — ${t.title}`);
      if (!list.length) return ctx.ui.notify(`Help file not found: ${HELP_PATH}`, "warning");
      post([name ? `No help topic "${name}".` : "**pb help** — pick a topic:", "", ...list, "", `Full guide: ${HELP_PATH}`].join("\n"));
    },
  });
}
