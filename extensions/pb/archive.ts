/** /pb:archive: move a finished spec out of the way. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { dropCheckpoints } from "./checkpoint.ts";
import { findingsOf, readMap } from "./map.ts";
import { sectionOf } from "./spec.ts";
import { type Progress, Store, changedSince, now, readEvents, reviewLedger } from "./store.ts";
import { KEBAB_NAME } from "./names.ts";
import { cmd, nextLine, post, specCompletions } from "./kit.ts";
import { updateMap } from "./map-flow.ts";

/**
 * What a spec still owes before it is put away: a build that never finished, a review never run or whose last
 * verdict was not a pass, and the P0-P2 findings still open. Empty when it is done.
 */
export const owedOnArchive = (p: Progress | undefined): string[] => {
  if (!p || !["built", "reviewed"].includes(p.phase)) return [`its build is ${p?.phase ?? "not started"}`];
  const review = p.review;
  if (!review) return ["it was never reviewed"];
  const open = review.findings.filter((f) => f.priority !== "P3").length;
  return [
    ...(review.verdict !== "pass" ? [`its last review was ${review.verdict === "changes_needed" ? "CHANGES NEEDED" : review.verdict === "unverified" ? "UNVERIFIED" : "without a verdict"}`] : []),
    ...(open ? [`${open} review finding${open === 1 ? "" : "s"} still open`] : []),
  ];
};

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
      // The name is the only user string that reaches a path: anything that isn't one is refused here.
      if (!KEBAB_NAME.test(name)) return ctx.ui.notify(`\`${name}\` isn't a valid spec name (spec names are lowercase with hyphens). /${cmd("status")} lists the specs.`, "warning");
      if (!store.readSpec(name)) return ctx.ui.notify(`No spec "${name}".`, "warning");
      // Archived findings are out of /pb:fix's reach: what the spec still owes is said before it goes, not after.
      const owed = owedOnArchive(store.progress(name));
      if (owed.length) {
        if (ctx.hasUI && !(await ctx.ui.confirm(`${name} isn't finished: ${owed.join("; ")}`, "Archive it anyway? Its open findings leave /pb:fix's reach."))) return;
        if (!ctx.hasUI) ctx.ui.notify(`Archiving ${name} with work left: ${owed.join("; ")}.`, "warning");
      }
      const markdown = store.readSpec(name) ?? "";
      const reviewFindings = reviewLedger(readEvents(path.join(store.specDir(name), "events.jsonl")));
      const baseCommit = store.progress(name)?.baseCommit;
      const changed = changedSince(ctx.cwd, baseCommit);
      const base = baseCommit && /^[0-9a-f]{7,40}$/.test(baseCommit) ? baseCommit : undefined; // it reaches the cartographer's brief as a command
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
        // The feature's change only: /pb:map is the whole-map audit, run when you choose.
        mapChanges = await updateMap(ctx, store, { spec: { name, findings }, changed, reviewFindings, scope: "change", base });
      }
      // What the map gained is kept with the archived spec: a later /pb:commit of the map names it.
      if (mapChanges) fs.appendFileSync(path.join(dest, "events.jsonl"), `${JSON.stringify({ at: now(), type: "map", changes: mapChanges })}\n`);
      // Archiving ends a feature: what's left is the commit (the feature if it wasn't yet, and the map), and the next feature.
      const uncommitted = changedSince(ctx.cwd).length > 0;
      post(nextLine(`${uncommitted ? `\`/${cmd("commit")} ${name}\` commits what's left (the feature and the map update), then ` : ""}\`/${cmd("plan")} <feature>\` for the next one.`));
    },
  });

  /* --------------------------------- undo -------------------------------- */
}
