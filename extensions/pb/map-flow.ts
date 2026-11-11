/** The project map: /pb:map, and the update the archive triggers. */
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext
} from "@earendil-works/pi-coding-agent";
import { snapshot } from "./checkpoint.ts";
import { extraBlock } from "./prompts.ts";
import { CARTOGRAPHER_SYSTEM, MAP_BULLET_CHARS, MAP_CHECK_LINES, MAP_CHECK_SYSTEM, MAP_MARKERS, MAP_TOKENS, areaNotes, bulletsCiting, bulletsOf, cartographerBrief, droppedBullets, changedBullets, longBullets, mapCheckBrief, readCore, mapDefect, mapDiff, mapFile, mapRepairPhase, mapTokens, normalizeMap, readMap, unresolvedPaths, writeMap } from "./map.ts";
import { REVIEW_TOOLS } from "./review.ts";
import { runFresh } from "./runner.ts";
import { duration } from "./format.ts";
import { freshProgress } from "./progress.ts";
import { type ReviewLedgerEntry, Store } from "./store.ts";
import { appendEntry, choose, cmd, post, revertFreshRun, sessionModel, warnLater } from "./kit.ts";

export const mapRefusal = (cwd: string): string => {
  const defect = mapDefect(cwd);
  const file = defect?.file ?? mapFile(cwd);
  return `${file}'s project map markers can't be resolved${defect ? ` (${defect.marker} on line ${defect.line})` : ""}: pb can't tell its map section from your own text there, so pb wrote nothing. The section needs exactly one "${MAP_MARKERS.start}" and one "${MAP_MARKERS.end}" line, with the map between them. Fix that, then run /${cmd("map")} again.`;
};

/**
 * Update the project map in a fresh, read-only call (the session doesn't grow). Paths that don't resolve,
 * and a map over the budget, go back to it once to be corrected; then the map is written, with the change shown and /pb:map undo to
 * go back. It asks first only when something looks off: paths that still don't resolve, or a large part of
 * the existing map removed (unanswered: it is written and what it was flagged for is posted; dismissed: the proposal is kept for `/pb:map apply`). Returns the changes when it wrote the map.
 */

export const updateMap = async (
  ctx: ExtensionContext,
  store: Store,
  o: { spec?: { name: string; findings: string }; changed?: string[]; focus?: string; reviewFindings?: ReviewLedgerEntry[]; scope?: "change"; base?: string } = {},
): Promise<string[] | undefined> => {
  const cwd = ctx.cwd;
  // Before any cartographer runs: minutes of work are not spent on a file pb cannot write, and the
  // human reads which marker to fix while the reason is still the live problem.
  if (mapDefect(cwd)) return void ctx.ui.notify(mapRefusal(cwd), "error");
  const sessionFile = ctx.sessionManager.getSessionFile();
  const cfg = store.config();
  const current = readMap(cwd);
  // Only the feature's change is read on an archive, once there is a map to keep: the first one is always a full read.
  const scope = o.scope === "change" && current ? "change" : undefined;
  const recheck = scope ? bulletsCiting(cwd, current, o.changed ?? []) : undefined;
  const started = Date.now();
  const abort = new AbortController();
  const canEsc = ctx.hasUI && ctx.mode === "tui" && typeof ctx.ui.onTerminalInput === "function";
  const unsubEsc = canEsc ? ctx.ui.onTerminalInput((d) => (d === "\x1b" ? (abort.abort(), { consume: true }) : undefined)) : undefined;
  const progress = freshProgress(ctx, "pb-map", "pb map", { esc: canEsc, sessionsRoot: cwd });
  let mapSession: string | undefined;
  // The cartographer gets bash for inspection but must leave the project untouched, like the
  // explorer: anything it writes is put back, so the map update never carries stray files with it.
  const mapGuardBefore = snapshot(cwd, "pb: before map");
  const cartographer = (brief: string, phase: string) => {
    progress.step(phase);
    return runFresh({
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
      ...progress.hooks,
      sessionDir: store.sessionsDir("cartographer"),
    }).then((r) => {
      mapSession = r.sessionFile ?? mapSession;
      return r;
    });
  };
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
    progress.step(`checking ${shown.length} new line${shown.length === 1 ? "" : "s"} against the code`);
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
      ...progress.hooks,
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
    const first = await cartographer(cartographerBrief({ current, ...o, scope, recheck }), scope ? "reading the change" : "reading the project");
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
    progress.stop();
    revertFreshRun(cwd, (m) => warnLater(ctx, m), "the cartographer", mapGuardBefore, snapshot(cwd, "pb: after map"));
  }

  const diff = mapDiff(current, body);
  if (!diff.length) return void ctx.ui.notify("The project map is up to date: nothing to change.", "info");
  const tokens = mapTokens(body);
  // Rules, not lines: a reworded, split or moved rule is still in the map; only one nothing carries counts.
  const rules = bulletsOf(current).length;
  const dropped = droppedBullets(current, body);
  const quote = (t: string) => `"${t.replace(/^[-*]\s+/, "").slice(0, 80)}${t.length > 82 ? "…" : ""}"`;
  // A contradicted line the repair kept word for word is still contradicted: the human decides.
  const kept = new Set(bulletsOf(body).map((b) => b.text));
  const stillWrong = disproved.filter((d) => kept.has(d.text));
  const warnings = [
    ...stillWrong.map((d) => `the code contradicts "${d.text.slice(0, 120)}${d.text.length > 120 ? "…" : ""}" (${d.evidence})`),
    ...unresolved.map((u) => `\`${u.path}\` doesn't resolve`),
    ...(rules >= 6 && dropped.length / rules > 0.3 ? [`it drops ${dropped.length} of the map's ${rules} rules, e.g. ${dropped.slice(0, 2).map((b) => quote(b.text)).join(", ")}`] : []),
  ];
  appendEntry("pb-map", { diff, warnings, tokens, map: body, changes });
  let unanswered = false;
  if (warnings.length) {
    // Saved before asking: a dismissed dialog or a closed editor must not throw away the run that made it.
    store.saveMapProposal({ map: body, base: current, at: Date.now(), warnings });
    const kept = `Map not changed. The proposal is kept: \`/${cmd("map")} apply\` writes it as it is.`;
    const APPLY = "Apply it";
    const EDIT = "Edit it first";
    const KEEP = "Keep the current map";
    // Unanswered, it is applied: a wrong map costs one /pb:map undo, a discarded one the whole run again.
    const timedOut: string[] = [];
    const choice = await choose(ctx, store, `The proposed project map needs a look: ${warnings.join("; ")}`, [APPLY, KEEP, EDIT], APPLY, timedOut);
    unanswered = timedOut.length > 0;
    if (choice === EDIT) {
      const edited = await ctx.ui.editor("Edit the project map", body);
      if (edited === undefined) return void ctx.ui.notify(kept, "info");
      body = normalizeMap(edited);
    } else if (choice === KEEP) {
      store.clearMapProposal();
      return void ctx.ui.notify("Map not changed.", "info");
    } else if (choice !== APPLY) return void ctx.ui.notify(kept, "info");
  }
  // The write has the last word on whether the file can be written at all (it may have been edited
  // while the cartographer ran), and the copy undo goes back to is stored only once it did write.
  if (!writeMap(ctx.cwd, body)) return void ctx.ui.notify(mapRefusal(ctx.cwd), "error");
  store.saveMapPrevious(current);
  store.clearMapProposal();
  // Said where you will look when you come back: these lines are read by every session until someone fixes them.
  if (unanswered) post(`**The project map was written without your answer**, with what it was flagged for:\n${warnings.map((w) => `- ${w}`).join("\n")}\n\n\`/${cmd("map")} undo\` puts the previous map back.`);
  const notes = areaNotes(ctx.cwd);
  const where = notes.length ? `AGENTS.md (~${mapTokens(readCore(ctx.cwd))} tokens read in every session) and ${notes.length} area note${notes.length === 1 ? "" : "s"}` : "AGENTS.md";
  ctx.ui.notify(
    `Project map ${current ? "updated" : "written"} in ${where} (~${tokens} tokens in ${Math.max(1, Math.round((Date.now() - started) / 1000))}s${changes.length ? `: ${changes.slice(0, 3).join("; ")}${changes.length > 3 ? "; …" : ""}` : ""}).${dropped.length ? ` It dropped ${dropped.length} rule${dropped.length === 1 ? "" : "s"}: ${dropped.slice(0, 3).map((b) => quote(b.text)).join(", ")}${dropped.length > 3 ? ", …" : ""}.` : ""}${scope ? ` Only ${o.spec?.name ?? "the feature"}'s change was read against the map; \`/${cmd("map")}\` audits the whole map.` : ""}${long.length ? ` ${long.length} bullet${long.length === 1 ? " is" : "s are"} still over ${MAP_BULLET_CHARS} characters.` : ""}${checkNote} \`/${cmd("map")} undo\` puts the previous one back.${mapSession ? ` The whole run: \`pi --session ${path.relative(ctx.cwd, mapSession)}\`` : ""}`,
    "info",
  );
  return changes;
};

/**
 * `/pb:map apply`: write the proposal a "needs a look" dialog left unanswered. Only onto the map it was made
 * against: a map changed since (by hand, an undo, another run) would be silently overwritten, so that is refused.
 */
const applyMapProposal = (ctx: ExtensionContext, store: Store): void => {
  const proposal = store.mapProposal();
  if (!proposal) return ctx.ui.notify(`No proposed map is waiting. \`/${cmd("map")}\` makes one.`, "info");
  if (mapDefect(ctx.cwd)) return ctx.ui.notify(mapRefusal(ctx.cwd), "error");
  const current = readMap(ctx.cwd);
  if (current !== proposal.base) return ctx.ui.notify(`The project map changed since this proposal was made, so pb didn't write it over your changes. \`/${cmd("map")}\` makes a new one.`, "warning");
  if (!writeMap(ctx.cwd, normalizeMap(proposal.map))) return ctx.ui.notify(mapRefusal(ctx.cwd), "error");
  store.saveMapPrevious(current);
  store.clearMapProposal();
  ctx.ui.notify(
    `The proposed project map (made ${duration(Date.now() - proposal.at)} ago) is now in AGENTS.md${proposal.warnings.length ? `, with what it was flagged for: ${proposal.warnings.join("; ")}` : ""}. \`/${cmd("map")} undo\` puts the previous one back.`,
    "info",
  );
};

export function registerMapFlow(pi: ExtensionAPI) {
  pi.registerCommand(cmd("map"), {
    description: "Refresh the project map in AGENTS.md (layout, patterns, constraints) from the code as it is now. Optional: what to focus on; /pb:map apply writes a proposal you dismissed; /pb:map undo puts the previous map back",
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) return ctx.ui.notify("Pi is busy. Wait for the current turn to finish.", "warning");
      const store = new Store(ctx.cwd);
      if (args.trim() === "apply") return applyMapProposal(ctx, store);
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
