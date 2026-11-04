/** /pb:archive: move a finished spec out of the way. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { type Snapshot, changedPaths, cleanupIndexes, commitTime, dropCheckpoints, inWorktree, inspectChanges, restore, skippedLargeFiles, snapshot, staleProseRefs } from "./checkpoint.ts";
import { CARTOGRAPHER_SYSTEM, MAP_MARKERS, MAP_TOKENS, cartographerBrief, findingsOf, ignoredPathsFor, mapDefect, mapDiff, mapFile, mapRepairPhase, mapTokens, missingPaths, normalizeMap, projectFiles, readMap, resolveProjectPath, unresolvedPaths, writeMap } from "./map.ts";
import { type ParsedSpec, type SpecTask, acceptanceCriteria, addDecision, buildTask, commitMessage, contractHash, earlierProof, isAcceptanceLine, needsRed, parseSpec, redExemption, sectionHeading, sectionOf, setSection, setStatus, sharedTestCommands, specHash, specPathRefs, tokensOf } from "./spec.ts";
import { type AcceptanceCheck, type Checkpoint, type Finding, type Progress, type ReviewLedgerEntry, type ReviewRun, type ReviewSessionState, type TaskProgress, type VerifyResult, COHERE_TASK_ID, PREFIX, Store, cap, changedSince, diffStat, gitDiff, gitHead, gitRepo, ledgerFindings, now, readEvents, resolvesRevision, reviewLedger, untrackedText } from "./store.ts";
import { cmd, commitBlock, post, specCompletions } from "./kit.ts";
import { updateMap } from "./map-flow.ts";

export function registerArchive(pi: ExtensionAPI) {
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
      const reviewFindings = reviewLedger(readEvents(path.join(store.specDir(name), "events.jsonl")));
      const changed = changedSince(ctx.cwd, store.progress(name)?.baseCommit);
      // The feature is finished: its review runs and the explorer and map runs so far aren't needed any more.
      let dest: string;
      try {
        dest = store.archive(name);
      } catch (e) {
        return ctx.ui.notify(`Could not archive ${name}: ${(e as Error).message}`, "error");
      }
      // Only after the move succeeded: a failed archive must leave the live spec with its review
      // runs and the fail-closed review-session records that keep its reviewers read-only.
      store.dropSessions(name);
      fs.rmSync(path.join(dest, "sessions"), { recursive: true, force: true }); // dropSessions no longer sees it: it moved with the spec
      if (!store.specNames().length) dropCheckpoints(ctx.cwd); // no live spec left to undo: let git reclaim the snapshots
      // The feature is done: what it established about the project goes into the map every session reads.
      let mapChanges: string[] | undefined;
      // What it established about the project: its Findings, and the design the build settled on.
      const design = sectionOf(markdown, "Design");
      const findings = [findingsOf(markdown), design ? `The design as built (its "## Design"):\n${design}` : ""].filter(Boolean).join("\n\n");
      // Writing the first map is always worth one read; an update needs stated findings —
      // changed files alone rarely justify a full re-read, and the next feature's run covers
      // placement. Review findings count as news: they are leads the map may not have yet.
      const mapNews = !!findings.trim() || reviewFindings.length > 0 || !readMap(ctx.cwd);
      const willMap = store.config().mapOnArchive && mapNews;
      ctx.ui.notify(`Archived ${name} to ${path.relative(ctx.cwd, dest)}.${willMap ? ` Updating the project map from ${name}…` : ""}`, "info");
      if (store.config().mapOnArchive && !mapNews) {
        ctx.ui.notify(`No new findings in ${name} for the project map; skipping.`, "info");
      } else if (willMap) {
        mapChanges = await updateMap(ctx, store, { spec: { name, findings }, changed, reviewFindings });
      }
      // What's left to commit: the feature itself if it wasn't committed yet, and the map.
      const feature = changedSince(ctx.cwd).some((f) => f !== "AGENTS.md" && !f.startsWith(".pi/"));
      const title = parseSpec(markdown).spec?.title ?? name;
      const mapNote = mapChanges ? ["Update the project map in AGENTS.md", ...(mapChanges.length ? ["", ...mapChanges.map((c) => `- ${c}`)] : [])] : [];
      const message = feature
        ? [commitMessage(markdown) ?? title, ...(mapChanges ? ["", "Also updates the project map in AGENTS.md."] : [])].join("\n")
        : mapChanges
          ? [`${mapNote[0]} after ${title}`, ...mapNote.slice(1)].join("\n")
          : undefined;
      if (message) post(commitBlock(message));
    },
  });

  /* --------------------------------- undo -------------------------------- */
}
