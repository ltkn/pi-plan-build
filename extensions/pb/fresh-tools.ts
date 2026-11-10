/** pb_explore and pb_try: the two fresh-context research tools. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import { Type } from "./schema.ts";
import { snapshot } from "./checkpoint.ts";
import { EXPLORER_SYSTEM, PRODUCTION_RULE, TRY_SYSTEM, explorerBrief, explorerLimits, probeLimits, tryBrief } from "./prompts.ts";
import { type ExploreDetails, LIVE_FLUSH_MS, LIVE_STEPS, LIVE_WRITING_LINES, renderExploreCall, renderExploreResult, renderTryCall, renderTryResult } from "./render.ts";
import { duration } from "./format.ts";
import { runFresh, usageOf } from "./runner.ts";
import { Store } from "./store.ts";
import { guardSettings, longCommandSec, revertFreshRun, sessionModel, tail, text, tree, warnLater } from "./kit.ts";
import { fileURLToPath } from "node:url";
import { GUARD_ENV } from "./fresh-guard.ts";

/** The guard loaded into both processes: limits, the explorer's read-only list, a probe's no-remote-writes rule, a credential-free shell. */
const FRESH_GUARD = fileURLToPath(new URL("./fresh-guard.ts", import.meta.url));
const guarded = (role: "explorer" | "trier", cwd: string, store: Store) => ({ extensions: [FRESH_GUARD], env: { [GUARD_ENV]: JSON.stringify(guardSettings(role, cwd, store)) } });

export function registerFreshTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: "pb_explore",
    label: "Explore",
    description:
      "Answer a question about the code from a separate, read-only context and get back only the answer: where things live, how a similar feature is built, the conventions, what calls what. It runs read-only inspection commands only — pb refuses anything else, so it never reaches a database, the network or production — and stops when it makes no progress for explorer.idleSec (10 minutes by default) or after explorer.timeoutSec (30) in all. Use it for broad or multi-file questions when you need the conclusion; when you know the 1-3 files, read them yourself. Several calls can run in parallel.",
    parameters: Type.Object({
      question: Type.String({ description: "what to find out, specific enough to answer in a short report" }),
    }),
    executionMode: "parallel",
    // What it's doing, from the explorer's own steps: shown to you, never sent to the model.
    renderCall: (args, theme) => renderExploreCall(args, theme),
    renderResult: (result, opts, theme, context) => renderExploreResult(result as { content: { type: string; text?: string }[]; details?: ExploreDetails }, opts, theme, context?.isError),
    async execute(_id, params, signal, onUpdate, ctx) {
      const cwd = ctx.cwd;
      const sessionFile = ctx.sessionManager.getSessionFile();
      const store = new Store(cwd);
      const cfg = store.config();
      const name = tree(ctx).getSessionName?.();
      const before = snapshot(cwd, "pb: before explore");
      const started = Date.now();
      const steps: string[] = [];
      const files = new Set<string>();
      let writing = "";
      const details = (): ExploreDetails => ({ steps: steps.slice(-LIVE_STEPS), count: steps.length, files: [...files], started, writing: tail(writing, LIVE_WRITING_LINES) });
      // Bursts of sub-second tool calls repaint faster than anyone can read: coalesce them,
      // trailing-edge so the latest state always lands. Terminal states flush on their own path.
      let lastPaint = 0;
      let paintTimer: ReturnType<typeof setTimeout> | undefined;
      let pendingContent: { type: "text"; text: string }[] | undefined;
      const paint = (content: { type: "text"; text: string }[]) => {
        if (!onUpdate) return;
        pendingContent = content;
        if (paintTimer !== undefined) return; // a flush is queued; it picks up the latest content
        const wait = LIVE_FLUSH_MS - (Date.now() - lastPaint);
        if (wait <= 0) {
          lastPaint = Date.now();
          onUpdate({ content: pendingContent, details: details() });
          pendingContent = undefined;
        } else {
          paintTimer = setTimeout(() => {
            paintTimer = undefined;
            lastPaint = Date.now();
            if (pendingContent) onUpdate?.({ content: pendingContent, details: details() });
            pendingContent = undefined;
          }, wait);
        }
      };
      // Heartbeat so the elapsed counter ticks even between tool calls on quiet stretches.
      const beat = setInterval(() => paint(text("")), 1000);
      const res = await runFresh({
        cwd,
        role: "explorer",
        systemPrompt: EXPLORER_SYSTEM,
        brief: explorerBrief(params.question, name?.startsWith("plan: ") ? name.slice(6) : undefined, explorerLimits({ commandSec: cfg.explorer.commandTimeoutSec, idleSec: cfg.explorer.idleSec, totalSec: cfg.explorer.timeoutSec })),
        prompt: "Answer the question in the attached file.",
        tools: ["read", "grep", "find", "ls", "bash"],
        ...guarded("explorer", cwd, store),
        model: cfg.explorer.model ?? sessionModel(ctx),
        thinking: cfg.explorer.thinking ?? "max",
        maxConcurrent: cfg.maxConcurrent,
        // A lookup that keeps reading is working; one that stops making progress is stuck: both limits, one ceiling.
        timeoutMs: cfg.explorer.timeoutSec > 0 ? cfg.explorer.timeoutSec * 1000 : undefined,
        idleMs: cfg.explorer.idleSec > 0 ? cfg.explorer.idleSec * 1000 : undefined,
        signal,
        onActivity: (line, call) => {
          steps.push(line);
          const p = call.arguments.path ?? call.arguments.file_path;
          if (call.name === "read" && typeof p === "string") files.add(p);
          paint(text(`↳ ${line}`));
        },
        onText: (t) => {
          writing = t;
          paint(text(""));
        },
        sessionDir: store.sessionsDir("explorer"),
      }).finally(() => {
        clearInterval(beat);
        if (paintTimer !== undefined) {
          // A trailing repaint is obsolete now: the returned details carry the final state.
          clearTimeout(paintTimer);
          paintTimer = undefined;
        }
      });
      const after = snapshot(cwd, "pb: after explore");
      revertFreshRun(cwd, (m) => warnLater(ctx, m), "the explorer", before, after);
      store.exploreEvent({ session: sessionFile, ...res.tokens, cost: res.cost, ms: res.ms });
      if (res.timedOut) {
        const limit = res.timedOutBy === "idle" ? `${duration(cfg.explorer.idleSec * 1000)} without progress (explorer.idleSec)` : `${duration(cfg.explorer.timeoutSec * 1000)} in all (explorer.timeoutSec)`;
        throw new Error(`Exploration stopped after ${limit}. Split the question into narrower ones, in parallel in one block; what was already read is listed above. If the question genuinely needs longer, the human raises the limit in ${store.rel("config.json")} (0 = none).${res.text.trim() ? `\n\nWhat it had so far:\n${res.text.trim()}` : ""}`);
      }
      if (res.aborted) throw new Error("Exploration stopped. Narrow the question to one area or split it across two calls in one block; what was already read is listed above.");
      if (!res.text.trim()) throw new Error(`The explorer produced no answer${res.error ? `: ${res.error}` : ""}`);
      const t = res.tokens;
      const session = res.sessionFile ? path.relative(cwd, res.sessionFile) : undefined;
      return { content: text(res.text.trim()), details: { ...details(), writing: [], ms: res.ms, tokens: t.input + t.output + t.cacheRead + t.cacheWrite, tokensIn: t.input + t.cacheRead + t.cacheWrite, tokensOut: t.output, session }, usage: usageOf(res) };
    },
  });

  pi.registerTool({
    name: "pb_try",
    label: "Try",
    description:
      "When a decision needs something only running code shows (library behaviour or limits, performance, a read-only query), call pb_try with the question to settle: back come Commands, Result and Conclusion. If settling it needs a scratch script file — or its output won't fit in a few lines — it belongs in pb_try; single read-only commands stay in this session. It reads the project but writes scratch files only outside it, and anything it changes in the project is put back. " + PRODUCTION_RULE + " pb refuses its commands that write to a system outside this machine, and its shell runs without database, cloud and cluster credentials. Bound the goal: a probe is stopped at `probeTimeoutSec` (15 minutes by default), and its commands never outlast it, so one that cannot settle in that time is the wrong probe. Several calls can run in parallel.",
    parameters: Type.Object({
      goal: Type.String({ description: "the question to settle by running, specific enough to probe in one go" }),
    }),
    executionMode: "parallel",
    renderCall: (args, theme) => renderTryCall(args, theme),
    renderResult: (result, opts, theme, context) => renderTryResult(result as { content: { type: string; text?: string }[]; details?: ExploreDetails }, opts, theme, context?.isError),
    async execute(_id, params, signal, onUpdate, ctx) {
      const cwd = ctx.cwd;
      const sessionFile = ctx.sessionManager.getSessionFile();
      const store = new Store(cwd);
      const cfg = store.config();
      const name = tree(ctx).getSessionName?.();
      const before = snapshot(cwd, "pb: before try");
      const started = Date.now();
      const steps: string[] = [];
      const files = new Set<string>();
      let writing = "";
      const details = (): ExploreDetails => ({ steps: steps.slice(-LIVE_STEPS), count: steps.length, files: [...files], started, writing: tail(writing, LIVE_WRITING_LINES) });
      let lastPaint = 0;
      let paintTimer: ReturnType<typeof setTimeout> | undefined;
      let pendingContent: { type: "text"; text: string }[] | undefined;
      const paint = (content: { type: "text"; text: string }[]) => {
        if (!onUpdate) return;
        pendingContent = content;
        if (paintTimer !== undefined) return;
        const wait = LIVE_FLUSH_MS - (Date.now() - lastPaint);
        if (wait <= 0) {
          lastPaint = Date.now();
          onUpdate({ content: pendingContent, details: details() });
          pendingContent = undefined;
        } else {
          paintTimer = setTimeout(() => {
            paintTimer = undefined;
            lastPaint = Date.now();
            if (pendingContent) onUpdate?.({ content: pendingContent, details: details() });
            pendingContent = undefined;
          }, wait);
        }
      };
      // Heartbeat so the elapsed counter ticks even between tool calls on quiet stretches.
      const beat = setInterval(() => paint(text("")), 1000);
      const res = await runFresh({
        cwd,
        role: "try",
        systemPrompt: TRY_SYSTEM,
        brief: tryBrief(params.goal, name?.startsWith("plan: ") ? name.slice(6) : undefined, probeLimits({ commandSec: cfg.commandTimeoutSec, longSec: longCommandSec(cfg), totalSec: cfg.probeTimeoutSec })),
        prompt: "Establish the goal in the attached file. Scratch files go to a temporary directory outside the project; read-only queries only.",
        tools: ["read", "grep", "find", "ls", "bash"],
        ...guarded("trier", cwd, store),
        model: cfg.explorer.model ?? sessionModel(ctx),
        thinking: cfg.explorer.thinking ?? "max",
        maxConcurrent: cfg.maxConcurrent,
        timeoutMs: cfg.probeTimeoutSec > 0 ? cfg.probeTimeoutSec * 1000 : undefined,
        signal,
        onActivity: (line, call) => {
          steps.push(line);
          const p = call.arguments.path ?? call.arguments.file_path;
          if (call.name === "read" && typeof p === "string") files.add(p);
          paint(text(`↳ ${line}`));
        },
        onText: (t) => {
          writing = t;
          paint(text(""));
        },
        sessionDir: store.sessionsDir("try"),
      }).finally(() => {
        clearInterval(beat);
        if (paintTimer !== undefined) {
          clearTimeout(paintTimer);
          paintTimer = undefined;
        }
      });
      const after = snapshot(cwd, "pb: after try");
      revertFreshRun(cwd, (m) => warnLater(ctx, m), "the trier", before, after);
      store.exploreEvent({ session: sessionFile, ...res.tokens, cost: res.cost, ms: res.ms });
      if (res.timedOut) throw new Error(`Probe stopped after ${duration(cfg.probeTimeoutSec * 1000)} (probeTimeoutSec). Bound the work before rerunning: size the input and the loop first, cap the rows, and wrap anything that could hang in \`timeout <seconds>\`. If it genuinely needs longer, the human raises probeTimeoutSec in ${store.rel("config.json")} (0 = none).`);
      if (res.aborted) throw new Error("Probe stopped. Split the goal into smaller steps or bound it (fewer rows, less work); rerun the smaller probe.");
      if (!res.text.trim()) throw new Error(`The trier produced no answer${res.error ? `: ${res.error}` : ""}`);
      const t = res.tokens;
      const session = res.sessionFile ? path.relative(cwd, res.sessionFile) : undefined;
      return { content: text(res.text.trim()), details: { ...details(), writing: [], ms: res.ms, tokens: t.input + t.output + t.cacheRead + t.cacheWrite, tokensIn: t.input + t.cacheRead + t.cacheWrite, tokensOut: t.output, session }, usage: usageOf(res) };
    },
  });
}
