/** /pb:archive: move a finished spec out of the way. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { dropCheckpoints } from "./checkpoint.ts";
import { findingsOf, readMap } from "./map.ts";
import { parseSpec, sectionOf } from "./spec.ts";
import { type Progress, Store, changedSince, now, readEvents, reviewLedger, samePath } from "./store.ts";
import { inRepo, resolveRepos } from "./repos.ts";
import { KEBAB_NAME } from "./names.ts";
import { buildLivenessMs, cmd, nextLine, post, sessionLive, specCompletions } from "./kit.ts";
import { updateMap } from "./map-flow.ts";

/**
 * What a spec still owes before it is put away: a build that never finished, a review still running or
 * interrupted, a review never run or whose last verdict was not a pass, and the P0-P2 findings still open.
 * Empty when it is done.
 */
export const owedOnArchive = (p: Progress | undefined, reviewOpen = false): string[] => {
  if (!p || !["built", "reviewed"].includes(p.phase)) return [`its build is ${p?.phase ?? "not started"}`];
  const running = reviewOpen ? ["a review of it is running or was interrupted: archiving ends it"] : [];
  const review = p.review;
  if (!review) return [...running, "it was never reviewed"];
  const open = review.findings.filter((f) => f.priority !== "P3").length;
  return [
    ...running,
    ...(review.verdict !== "pass" ? [`its last review was ${review.verdict === "changes_needed" ? "CHANGES NEEDED" : review.verdict === "unverified" ? "UNVERIFIED" : "without a verdict"}`] : []),
    ...(open ? [`${open} review finding${open === 1 ? "" : "s"} still open`] : []),
  ];
};

/** How many leftover files the closing line names before it says how many more there are. */
const LIST_CAP = 5;

/**
 * What the working tree still holds against HEAD, in every repository the spec reaches: the project's own
 * files, then each declared sibling's, named as `/pb:commit` names them (`../<repo>/<path>`). A committed
 * change is not in it — this is the set a hand revert and `/pb:commit` face once the spec is gone.
 */
const leftoverFiles = (cwd: string, repos: string[]): string[] => [
  ...changedSince(cwd),
  ...resolveRepos(cwd, repos).flatMap((r) => (r.root ? changedSince(r.root).map((f) => inRepo(r.name, f)) : [])),
];

/** What a human can still do with the files an archived spec left behind: commit them, or put them back. */
const leftoverAdvice = (name: string, left: string[], phase: Progress["phase"] | undefined): string => {
  const nextPlan = `\`/${cmd("plan")} <feature>\` for the next one.`;
  if (!left.length) return `Nothing is left uncommitted — in the project or in a sibling the spec declares — against HEAD. ${nextPlan}`;
  const shown = left.slice(0, LIST_CAP).join(", ") + (left.length > LIST_CAP ? `, … ${left.length - LIST_CAP} more` : "");
  const files = `${left.length} file${left.length === 1 ? " is" : "s are"} still uncommitted against HEAD (${shown})`;
  // A build that didn't finish has nothing for /pb:commit to build a message from: only git reaches those files.
  const way = phase === "building" ? `\`/${cmd("commit")}\` refuses a build that didn't finish, so put them back by hand` : `\`/${cmd("commit")} ${name}\` offers them, or put them back by hand`;
  return `${files}: ${way}. Then ${nextPlan}`;
};

export function registerArchive(pi: ExtensionAPI) {
  pi.registerCommand(cmd("archive"), {
    description: "Put a finished spec (and its history) away in .pi/pb-archive/ and say which files the tree still holds against HEAD. --force <name> archives one that still owes work with no question and no project-map run; a build live in another session is refused either way (its own session gets through once Pi is idle)",
    getArgumentCompletions: (prefix: string) =>
      [{ value: "--force", label: "--force", description: "archive a spec that still owes work: no question, no project-map run" }, ...specCompletions(prefix)].filter((c) => c.value.startsWith(prefix)),
    handler: async (args, ctx) => {
      // --force is the human's own confirmation; it reads in either order, as /pb:build's --fresh does.
      const force = /(^|\s)--force(\s|$)/.test(args);
      const named = args.replace(/(^|\s)--force(?=\s|$)/g, " ").trim();
      const store = new Store(ctx.cwd);
      // Archiving drops the records that keep a review or fix session to its own tools: never from inside one.
      const here = ctx.sessionManager.getSessionFile();
      if (store.reviewSession(here) || store.fixSession(here)) return ctx.ui.notify(`This is a review or fix session: run /${cmd("archive")} from the session you build in.`, "warning");
      // --force chooses nothing on its own: without a name it would take whichever candidate comes first.
      if (force && !named) return ctx.ui.notify(`\`--force\` names nothing: \`/${cmd("archive")} --force <spec>\`. /${cmd("status")} lists the specs.`, "warning");
      const candidates = store.specNames().filter((n) => ["built", "reviewed"].includes(store.progress(n)?.phase ?? ""));
      let name = named || undefined;
      if (!name) {
        if (!candidates.length) return ctx.ui.notify("No finished spec to archive.", "info");
        name = candidates.length === 1 || !ctx.hasUI ? candidates[0] : await ctx.ui.select("Archive which spec?", candidates);
        if (!name) return;
      }
      // The name is the only user string that reaches a path: anything that isn't one is refused here.
      if (!KEBAB_NAME.test(name)) return ctx.ui.notify(`\`${name}\` isn't a valid spec name (spec names are lowercase with hyphens). /${cmd("status")} lists the specs.`, "warning");
      if (!store.readSpec(name)) return ctx.ui.notify(`No spec "${name}".`, "warning");
      // Archived findings are out of /pb:fix's reach: what the spec still owes is said before it goes, not after.
      const progress = store.progress(name);
      // A live build would keep writing the tree with no spec to resolve its tools to: refused, --force included.
      // Its own session passes once Pi is idle — that is the build that crashed here, which nothing else can reach.
      const cfg = store.config();
      const ownIdle = !!here && !!progress?.session && samePath(progress.session, here) && ctx.isIdle();
      if (progress?.phase === "building" && progress.session && sessionLive(cfg, progress.session) && !ownIdle) {
        return ctx.ui.notify(
          `${name} is building right now: its session was written within the last ${Math.round(buildLivenessMs(cfg) / 1000)} s, the window pb judges a build live by. Archiving would orphan a build still writing the tree, so nothing was moved${force ? ", `--force` included" : ""}. Let it finish or pause, then /${cmd("archive")} ${name} again.`,
          "warning",
        );
      }
      const owed = owedOnArchive(progress, store.reviewOpen(name));
      if (owed.length) {
        if (force) ctx.ui.notify(`Archiving ${name} with work left: ${owed.join("; ")}. \`--force\` accepted what it still owes.`, "warning");
        else if (!ctx.hasUI) ctx.ui.notify(`Archiving ${name} with work left: ${owed.join("; ")}.`, "warning");
        else if (!(await ctx.ui.confirm(`${name} isn't finished: ${owed.join("; ")}`, "Archive it anyway? Its open findings leave /pb:fix's reach."))) return;
      }
      const markdown = store.readSpec(name) ?? "";
      const reviewFindings = reviewLedger(readEvents(path.join(store.specDir(name), "events.jsonl")));
      const baseCommit = progress?.baseCommit;
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
      const willMap = !force && store.config().mapOnArchive && mapNews;
      ctx.ui.notify(`Archived ${name} to ${path.relative(ctx.cwd, dest)}.${willMap ? ` Updating the project map from ${name}…` : ""}`, "info");
      if (store.config().mapOnArchive && !mapNews && !force) {
        ctx.ui.notify(`No new findings in ${name} for the project map; skipping.`, "info");
      } else if (force && store.config().mapOnArchive) {
        // An abandoned design may never have reached the tree, and a wrong map line is read by every later
        // session: the human decides that with /pb:map, not a forced archive.
        ctx.ui.notify(`\`--force\` skipped the project map update for ${name}: /${cmd("map")} makes that one deliberately.`, "info");
      } else if (willMap) {
        // The feature's change only: /pb:map is the whole-map audit, run when you choose.
        mapChanges = await updateMap(ctx, store, { spec: { name, findings }, changed, reviewFindings, scope: "change", base });
      }
      // What the map gained is kept with the archived spec: a later /pb:commit of the map names it.
      if (mapChanges) fs.appendFileSync(path.join(dest, "events.jsonl"), `${JSON.stringify({ at: now(), type: "map", changes: mapChanges })}\n`);
      // Why the spec left, and what the tree still holds: its undo points go with the spec, so this line and
      // git are what a later change of mind has to work from. Measured after the map step, whose own file counts.
      const uncommitted = leftoverFiles(ctx.cwd, parseSpec(markdown).spec?.repos ?? []);
      fs.appendFileSync(path.join(dest, "events.jsonl"), `${JSON.stringify({ at: now(), type: "archive", force, owed, base: base ?? "HEAD", uncommitted })}\n`);
      // Archiving ends a feature: what's left is the decision about those files, and the next feature.
      post(nextLine(leftoverAdvice(name, uncommitted, progress?.phase)));
    },
  });

  /* --------------------------------- undo -------------------------------- */
}
