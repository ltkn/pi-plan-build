/** /pb:undo: restore files and rewind the conversation to before a task. */
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext
 } from "@earendil-works/pi-coding-agent";
import { type Snapshot, changedPaths, cleanupIndexes, commitTime, dropCheckpoints, inWorktree, inspectChanges, restore, skippedLargeFiles, snapshot, staleProseRefs } from "./checkpoint.ts";
import { HELP_PATH, tip, topic, topics } from "./help.ts";
import { type AcceptanceCheck, type Checkpoint, type Finding, type Progress, type ReviewLedgerEntry, type ReviewRun, type ReviewSessionState, type TaskProgress, type VerifyResult, COHERE_TASK_ID, PREFIX, Store, appendCheckpoint, cap, changedSince, diffStat, gitDiff, gitHead, gitRepo, ledgerFindings, now, readEvents, resolvesRevision, reviewLedger, untrackedText } from "./store.ts";
import { cmd, post, rewindPoint, runtime, showProgress, specOfSession, text, tree } from "./kit.ts";

export function registerUndo(pi: ExtensionAPI) {
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
      const reverted = restore(ctx.cwd, cur.commit, target.commit);
      if (reverted.guardFailed) return ctx.ui.notify("Nothing was undone: the guard snapshot for the drift check failed (is git healthy?). Your files are as they were; try again.", "error");
      // The drift guard deliberately leaves a file alone when it changed again since the diff was
      // taken (you may have been typing in it while the dialog was open): name it, never count it.
      const skipped = files.filter((f) => !reverted.restored.includes(f));

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
        runtime.undoSummary = reverting
          ? undefined
          : `[pb] The human undid the work from ${target.id === "start" ? "the start of the build" : target.id} on (/pb:undo restored the files). What had been done: ${undoneCps.map((c) => c.summary ?? `${c.id} (unfinished)`).join("; ") || "nothing finished"}. Don't simply repeat it.${said.length ? ` What the human said meanwhile, still valid unless they say otherwise: ${said.map((x) => `"${x}"`).join("; ")}` : ""}`;
        try {
          const r = await nav(point, { summarize: !reverting, label: `pb: before ${target.id}` });
          rewound = !r.cancelled;
        } catch (e) {
          ctx.ui.notify(`Files restored, but the conversation couldn't be rewound: ${(e as Error).message}`, "warning");
        } finally {
          runtime.undoSummary = undefined;
        }
      }
      const keptCps = cps.slice(0, idx).concat(target.id === "start" ? [target] : []);
      // Number from the list being saved, never from the pre-undo list: rows from the target on
      // are dropped here, so a count over them can re-issue an id that survives — and ids are
      // looked up by first match, so a duplicate would send `/pb:undo uN` to an older state.
      const undoNumber = keptCps.reduce((n, c) => (/^u\d+$/.test(c.id) ? Math.max(n, Number(c.id.slice(1))) : n), 0) + 1;
      const undoEntry: Checkpoint = { id: `u${undoNumber}`, at: now(), ...cur, head, tasks: structuredClone(p.tasks), entry: rewound ? oldLeaf : undefined };
      appendCheckpoint(keptCps, undoEntry); // freshly numbered, so it always adds information
      store.saveCheckpoints(name, keptCps);
      p.tasks = structuredClone(target.tasks).filter((t) => t.id !== "final" && t.id !== COHERE_TASK_ID);
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
      const leftAlone = skipped.length
        ? `\nLeft alone because they changed again since the diff was taken: ${skipped.join(", ")} — restore them by hand if that wasn't you.`
        : "";
      post(
        `**↺ Undone to before ${target.id === "start" ? "the build" : target.id}** — ${reverted.restored.length} file(s) restored${rewound ? ", the conversation rewound" : ""}.\n${summary}${note}${leftAlone}\n\n${tip("undo.done", { id: undoEntry.id })}`,
      );
    },
  });

  /* -------------------------------- status ------------------------------- */
}
