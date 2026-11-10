/** The project map: /pb:map, and the update the archive triggers. */
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext
} from "@earendil-works/pi-coding-agent";
import { snapshot } from "./checkpoint.ts";
import { extraBlock } from "./prompts.ts";
import { CARTOGRAPHER_SYSTEM, MAP_MARKERS, MAP_TOKENS, cartographerBrief, mapDefect, mapDiff, mapFile, mapRepairPhase, mapTokens, normalizeMap, readMap, unresolvedPaths, writeMap } from "./map.ts";
import { REVIEW_TOOLS } from "./review.ts";
import { runFresh } from "./runner.ts";
import { type ReviewLedgerEntry, Store } from "./store.ts";
import { appendEntry, choose, cmd, revertFreshRun, safely, sessionModel, warnLater } from "./kit.ts";

export const mapRefusal = (cwd: string): string => {
  const defect = mapDefect(cwd);
  return `${mapFile(cwd)}'s project map markers can't be resolved${defect ? ` (${defect.marker} on line ${defect.line})` : ""}: pb can't tell its map section from your own text there, so pb wrote nothing. The section needs exactly one "${MAP_MARKERS.start}" and one "${MAP_MARKERS.end}" line, with the map between them. Fix that, then run /${cmd("map")} again.`;
};

/**
 * Update the project map in a fresh, read-only call (the session doesn't grow). Paths that don't resolve,
 * and a map over the budget, go back to it once to be corrected; then the map is written, with the change shown and /pb:map undo to
 * go back. It asks first only when something looks off: paths that still don't resolve, or a large part of
 * the existing map removed (unanswered: the current map stays). Returns the changes when it wrote the map.
 */

export const updateMap = async (ctx: ExtensionContext, store: Store, o: { spec?: { name: string; findings: string }; changed?: string[]; focus?: string; reviewFindings?: ReviewLedgerEntry[] } = {}): Promise<string[] | undefined> => {
  const cwd = ctx.cwd;
  // Before any cartographer runs: minutes of work are not spent on a file pb cannot write, and the
  // human reads which marker to fix while the reason is still the live problem.
  if (mapDefect(cwd)) return void ctx.ui.notify(mapRefusal(cwd), "error");
  const sessionFile = ctx.sessionManager.getSessionFile();
  const cfg = store.config();
  const current = readMap(cwd);
  const started = Date.now();
  const abort = new AbortController();
  const canEsc = ctx.hasUI && ctx.mode === "tui" && typeof ctx.ui.onTerminalInput === "function";
  const unsubEsc = canEsc ? ctx.ui.onTerminalInput((d) => (d === "\x1b" ? (abort.abort(), { consume: true }) : undefined)) : undefined;
  const render = (phase: string, activity?: string) =>
    safely(() => ctx.ui.setWidget("pb-map", [`pb map — ${phase}${canEsc ? "   (Esc to stop)" : ""}`, ...(activity ? [`  ↳ ${activity}`] : [])]));
  let mapSession: string | undefined;
  // The cartographer gets bash for inspection but must leave the project untouched, like the
  // explorer: anything it writes is put back, so the map update never carries stray files with it.
  const mapGuardBefore = snapshot(cwd, "pb: before map");
  const cartographer = (brief: string, phase: string) =>
    runFresh({
      cwd,
      role: "cartographer",
      systemPrompt: CARTOGRAPHER_SYSTEM + extraBlock(store.extra("map")),
      brief,
      prompt: "Do what the attached file asks; report the whole map with report_map.",
      tools: ["read", "grep", "find", "ls", "bash", "report_map"],
      extensions: [REVIEW_TOOLS],
      model: cfg.explorer.model ?? sessionModel(ctx),
      thinking: cfg.explorer.thinking ?? "max",
      maxConcurrent: cfg.maxConcurrent,
      signal: abort.signal,
      // Activity only, never the cartographer's streaming prose: the proposed map arrives
      // via the approve step, and the saved run holds the whole transcript for audit.
      onActivity: (a) => render(phase, a),
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
    store.exploreEvent({ session: sessionFile, ...first.tokens, cost: first.cost, ms: first.ms });
    if (first.aborted) return void ctx.ui.notify("Map update stopped.", "info");
    ({ map: body, changes } = mapOf(first));
    if (!body) return void ctx.ui.notify(`No map came back${first.error ? `: ${first.error}` : ""}.`, "warning");
    unresolved = unresolvedPaths(cwd, body);
    const overBy = mapTokens(body) - MAP_TOKENS;
    if (unresolved.length || overBy > 0) {
      // Once: the cartographer corrects or removes what doesn't resolve and trims to the budget, still able to
      // read the code; nothing is deleted behind its back.
      const phase = mapRepairPhase(unresolved.length, overBy > 0 ? overBy : 0);
      const second = await cartographer(cartographerBrief({ current, proposed: body, unresolved, overBy: overBy > 0 ? overBy : undefined }), phase);
      store.exploreEvent({ session: sessionFile, ...second.tokens, cost: second.cost, ms: second.ms });
      if (second.aborted) return void ctx.ui.notify("Map update stopped.", "info");
      const fixed = mapOf(second).map;
      if (fixed) {
        body = fixed;
        unresolved = unresolvedPaths(cwd, body);
      }
    }
  } finally {
    unsubEsc?.();
    safely(() => ctx.ui.setWidget("pb-map", undefined));
    revertFreshRun(cwd, (m) => warnLater(ctx, m), "the cartographer", mapGuardBefore, snapshot(cwd, "pb: after map"));
  }

  const diff = mapDiff(current, body);
  if (!diff.length) return void ctx.ui.notify("The project map is up to date: nothing to change.", "info");
  const tokens = mapTokens(body);
  const currentLines = current.split("\n").filter((l) => l.trim()).length;
  const removed = diff.filter((l) => l.startsWith("-")).length;
  const warnings = [
    ...unresolved.map((u) => `\`${u.path}\` doesn't resolve`),
    ...(currentLines >= 6 && removed / currentLines > 0.3 ? [`it removes ${removed} of the map's ${currentLines} lines`] : []),
  ];
  appendEntry("pb-map", { diff, warnings, tokens, map: body, changes });
  if (warnings.length) {
    const APPLY = "Apply it anyway";
    const EDIT = "Edit it first";
    const KEEP = "Keep the current map";
    const choice = await choose(ctx, store, `The proposed project map needs a look: ${warnings.join("; ")}`, [KEEP, APPLY, EDIT], KEEP);
    if (choice === EDIT) {
      const edited = await ctx.ui.editor("Edit the project map", body);
      if (edited === undefined) return void ctx.ui.notify("Map not changed.", "info");
      body = normalizeMap(edited);
    } else if (choice !== APPLY) return void ctx.ui.notify("Map not changed.", "info");
  }
  // The write has the last word on whether the file can be written at all (it may have been edited
  // while the cartographer ran), and the copy undo goes back to is stored only once it did write.
  if (!writeMap(ctx.cwd, body)) return void ctx.ui.notify(mapRefusal(ctx.cwd), "error");
  store.saveMapPrevious(current);
  ctx.ui.notify(
    `Project map ${current ? "updated" : "written"} in AGENTS.md (~${tokens} tokens in ${Math.max(1, Math.round((Date.now() - started) / 1000))}s${changes.length ? `: ${changes.slice(0, 3).join("; ")}${changes.length > 3 ? "; …" : ""}` : ""}). \`/${cmd("map")} undo\` puts the previous one back.${mapSession ? ` The whole run: \`pi --session ${path.relative(ctx.cwd, mapSession)}\`` : ""}`,
    "info",
  );
  return changes;
};

export function registerMapFlow(pi: ExtensionAPI) {
  pi.registerCommand(cmd("map"), {
    description: "Refresh the project map in AGENTS.md (layout, patterns, constraints) from the code as it is now. Optional: what to focus on; /pb:map undo puts the previous map back",
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) return ctx.ui.notify("Pi is busy. Wait for the current turn to finish.", "warning");
      const store = new Store(ctx.cwd);
      if (args.trim() === "undo") {
        const previous = store.mapPrevious();
        if (previous === undefined) return ctx.ui.notify("No previous map to go back to.", "info");
        // A broken section is read as a truncated one, and undo writes what it reads with no check
        // after it: refusing here is what keeps the one good copy of the map from being replaced by that.
        if (mapDefect(ctx.cwd)) return ctx.ui.notify(mapRefusal(ctx.cwd), "error");
        const now_ = readMap(ctx.cwd);
        if (!writeMap(ctx.cwd, previous)) return ctx.ui.notify(mapRefusal(ctx.cwd), "error");
        store.saveMapPrevious(now_);
        return ctx.ui.notify(`The previous project map is back in AGENTS.md (\`/${cmd("map")} undo\` again swaps them back).`, "info");
      }
      await updateMap(ctx, store, { focus: args.trim() || undefined });
    },
  });

  /* ------------------------------- archive ------------------------------- */
}
