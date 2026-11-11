/** The project map: /pb:map, and the update the archive triggers. */
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext
} from "@earendil-works/pi-coding-agent";
import { snapshot } from "./checkpoint.ts";
import { extraBlock } from "./prompts.ts";
import { CARTOGRAPHER_SYSTEM, MAP_BULLET_CHARS, MAP_CHECK_LINES, MAP_CHECK_SYSTEM, MAP_MARKERS, MAP_TOKENS, areaNotes, bulletsOf, cartographerBrief, changedBullets, longBullets, mapCheckBrief, readCore, mapDefect, mapDiff, mapFile, mapRepairPhase, mapTokens, normalizeMap, readMap, unresolvedPaths, writeMap } from "./map.ts";
import { REVIEW_TOOLS } from "./review.ts";
import { runFresh } from "./runner.ts";
import { type ReviewLedgerEntry, Store } from "./store.ts";
import { appendEntry, choose, cmd, revertFreshRun, safely, sessionModel, warnLater } from "./kit.ts";

export const mapRefusal = (cwd: string): string => {
  const defect = mapDefect(cwd);
  const file = defect?.file ?? mapFile(cwd);
  return `${file}'s project map markers can't be resolved${defect ? ` (${defect.marker} on line ${defect.line})` : ""}: pb can't tell its map section from your own text there, so pb wrote nothing. The section needs exactly one "${MAP_MARKERS.start}" and one "${MAP_MARKERS.end}" line, with the map between them. Fix that, then run /${cmd("map")} again.`;
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
  let long: { text: string; chars: number }[] = [];
  let disproved: { text: string; evidence: string }[] = [];
  let checkNote = "";
  // The map check: a fresh, read-only pass over the new or changed lines, before they are written. No shell,
  // so nothing to revert. A check that reports nothing is said, never read as a pass.
  const checkLines = async (proposed: string) => {
    const lines = changedBullets(current, proposed);
    if (!lines.length) return;
    const shown = lines.slice(0, MAP_CHECK_LINES);
    render(`checking ${shown.length} new line${shown.length === 1 ? "" : "s"} against the code`);
    const r = await runFresh({
      cwd,
      role: "map-check",
      systemPrompt: MAP_CHECK_SYSTEM,
      brief: mapCheckBrief(shown, lines.length - shown.length),
      prompt: "Check each line in the attached file against the code; report with report_verdicts.",
      tools: ["read", "grep", "find", "ls", "report_verdicts"],
      extensions: [REVIEW_TOOLS],
      model: cfg.explorer.model ?? sessionModel(ctx),
      thinking: cfg.explorer.thinking ?? "high",
      maxConcurrent: cfg.maxConcurrent,
      signal: abort.signal,
      onActivity: (a) => render(`checking ${shown.length} new line${shown.length === 1 ? "" : "s"} against the code`, a),
      sessionDir: store.sessionsDir("map-check"),
    });
    store.exploreEvent({ session: sessionFile, ...r.tokens, cost: r.cost, ms: r.ms });
    if (r.aborted) return "aborted" as const;
    const verdicts = r.toolCalls.filter((c) => c.name === "report_verdicts").flatMap((c) => (Array.isArray(c.arguments.verdicts) ? (c.arguments.verdicts as { finding?: unknown; verdict?: unknown; evidence?: unknown }[]) : []));
    if (!verdicts.length) {
      checkNote = ` The new lines weren't checked against the code: the check reported nothing${r.error ? ` (${r.error.split("\n")[0]})` : ""}.`;
      return;
    }
    disproved = verdicts
      .filter((v) => v.verdict === "rejected" && typeof v.finding === "number" && shown[v.finding - 1])
      .map((v) => ({ text: shown[(v.finding as number) - 1].text, evidence: typeof v.evidence === "string" ? v.evidence : "" }));
    checkNote = ` ${shown.length} new line${shown.length === 1 ? " was" : "s were"} checked against the code${lines.length > shown.length ? ` (${lines.length - shown.length} more were not)` : ""}.`;
  };
  try {
    render("reading the project");
    const first = await cartographer(cartographerBrief({ current, ...o }), "reading the project");
    store.exploreEvent({ session: sessionFile, ...first.tokens, cost: first.cost, ms: first.ms });
    if (first.aborted) return void ctx.ui.notify("Map update stopped.", "info");
    ({ map: body, changes } = mapOf(first));
    if (!body) return void ctx.ui.notify(`No map came back${first.error ? `: ${first.error}` : ""}.`, "warning");
    if ((await checkLines(body)) === "aborted") return void ctx.ui.notify("Map update stopped.", "info");
    unresolved = unresolvedPaths(cwd, body);
    long = longBullets(body);
    const overBy = mapTokens(body) - MAP_TOKENS;
    if (disproved.length || unresolved.length || long.length || overBy > 0) {
      // Once: the cartographer corrects what the code contradicts or doesn't resolve, shortens the long bullets
      // and trims to the budget, still able to read the code; nothing is deleted behind its back.
      const phase = mapRepairPhase(unresolved.length, overBy > 0 ? overBy : 0, long.length, disproved.length);
      const second = await cartographer(cartographerBrief({ current, proposed: body, unresolved, long, disproved, overBy: overBy > 0 ? overBy : undefined }), phase);
      store.exploreEvent({ session: sessionFile, ...second.tokens, cost: second.cost, ms: second.ms });
      if (second.aborted) return void ctx.ui.notify("Map update stopped.", "info");
      const fixed = mapOf(second).map;
      if (fixed) {
        body = fixed;
        unresolved = unresolvedPaths(cwd, body);
        long = longBullets(body);
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
  // A contradicted line the repair kept word for word is still contradicted: the human decides.
  const kept = new Set(bulletsOf(body).map((b) => b.text));
  const stillWrong = disproved.filter((d) => kept.has(d.text));
  const warnings = [
    ...stillWrong.map((d) => `the code contradicts "${d.text.slice(0, 120)}${d.text.length > 120 ? "…" : ""}" (${d.evidence})`),
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
  const notes = areaNotes(ctx.cwd);
  const where = notes.length ? `AGENTS.md (~${mapTokens(readCore(ctx.cwd))} tokens read in every session) and ${notes.length} area note${notes.length === 1 ? "" : "s"}` : "AGENTS.md";
  ctx.ui.notify(
    `Project map ${current ? "updated" : "written"} in ${where} (~${tokens} tokens in ${Math.max(1, Math.round((Date.now() - started) / 1000))}s${changes.length ? `: ${changes.slice(0, 3).join("; ")}${changes.length > 3 ? "; …" : ""}` : ""}).${long.length ? ` ${long.length} bullet${long.length === 1 ? " is" : "s are"} still over ${MAP_BULLET_CHARS} characters.` : ""}${checkNote} \`/${cmd("map")} undo\` puts the previous one back.${mapSession ? ` The whole run: \`pi --session ${path.relative(ctx.cwd, mapSession)}\`` : ""}`,
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
