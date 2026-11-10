/**
 * /pb:commit: commit the work when you choose — after the build, after fixes, after the review or the archive.
 * pb never commits on its own: you see the files and the message, and the commit happens only once you confirm.
 * It offers the uncommitted change (explicit paths, never `git add -A`, pb's own state and the spec excluded) in an
 * editor where you edit the message and leave out any file that isn't the feature's, and its message is
 * built from the spec, not by a model: the first commit carries the feature, a later one what changed since.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { KEBAB_NAME } from "./names.ts";
import { commitMessage, parseSpec } from "./spec.ts";
import { type Progress, Store, changedSince, now, readEvents } from "./store.ts";
import { cmd, nextLine, post, specCompletions, specOfSession } from "./kit.ts";
import { whereNext } from "./next.ts";

/** The spec whose work is committed: live, or archived (a commit right after /pb:archive). */
interface Target {
  name: string;
  dir: string;
  md: string;
  p?: Progress;
  archived: boolean;
}

const LIST_CAP = 30;

/** The marker between the message and the file list in the commit editor, as git's own template has one. */
const FILES_MARKER = "# Files to commit — delete a line to leave that file out. Clear the message to cancel.";

/** What the editor shows: the message, then every file, one per line. */
export const commitEditorText = (message: string, files: string[]) => `${message}\n\n${FILES_MARKER}\n${files.map((f) => `- ${f}`).join("\n")}\n`;

/**
 * What the human left in the editor: the message (lines starting with # are comments, as in git) and the files
 * still listed — only ones pb offered, so an edited line can never add a path.
 */
export function readCommitEditor(text: string, offered: string[]): { message: string; files: string[] } {
  const at = text.indexOf(FILES_MARKER);
  const head = at < 0 ? text : text.slice(0, at);
  const tail = at < 0 ? "" : text.slice(at + FILES_MARKER.length);
  const message = head.split("\n").filter((l) => !l.startsWith("#")).join("\n").trim();
  const kept = new Set(tail.split("\n").map((l) => l.match(/^\s*-\s+(.+?)\s*$/)?.[1]).filter((f): f is string => !!f));
  return { message, files: at < 0 ? offered : offered.filter((f) => kept.has(f)) };
}

/**
 * The message for this commit, from the spec and what pb recorded since its last commit of it: the feature the
 * first time; the review fixes, or the map update, or "follow-up changes" after that. Pure.
 */
export function commitMessageFor(o: { md: string; name: string; events: Record<string, unknown>[]; files: string[] }): string {
  const title = parseSpec(o.md).spec?.title ?? o.name;
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const lastCommit = o.events.map((e) => e.type).lastIndexOf("commit");
  const since = o.events.slice(lastCommit + 1);
  const mapChanges = since.filter((e) => e.type === "map").flatMap((e) => strings(e.changes));
  const mapOnly = o.files.length > 0 && o.files.every((f) => f === "AGENTS.md");
  if (mapOnly) return [`Update the project map after ${title}`, ...(mapChanges.length ? ["", ...mapChanges.map((c) => `- ${c}`)] : [])].join("\n");
  const withMap = o.files.includes("AGENTS.md") ? ["", "Also updates the project map in AGENTS.md."] : [];
  if (lastCommit < 0) return [commitMessage(o.md) ?? title, ...withMap].join("\n");
  const fixed = [...new Set(since.filter((e) => e.type === "fix").flatMap((e) => strings(e.fixed)))];
  if (fixed.length) return [`${title}: review fixes`, "", ...fixed.map((t) => `- ${t}`), ...withMap].join("\n");
  return [`${title}: follow-up changes`, ...withMap].join("\n");
}

export function registerCommit(pi: ExtensionAPI) {
  const git = (cwd: string, args: string[], input?: string) =>
    execFileSync("git", args, { cwd, encoding: "utf8", input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });

  /** The spec a /pb:commit means: named; else this session's; else the one live spec; else asked; else the newest archived. */
  const target = async (ctx: ExtensionCommandContext, store: Store, word: string): Promise<Target | undefined | "none"> => {
    const load = (name: string): Target | undefined => {
      const md = store.readSpec(name);
      if (md !== undefined) return { name, dir: store.specDir(name), md, p: store.progress(name), archived: false };
      const archived = store.newestArchived(name);
      if (!archived) return undefined;
      return { name, dir: archived.dir, md: fs.readFileSync(path.join(archived.dir, "spec.md"), "utf8"), p: JSON.parse(fs.readFileSync(path.join(archived.dir, "progress.json"), "utf8")) as Progress, archived: true };
    };
    if (word) return load(word);
    const session = ctx.sessionManager.getSessionFile() ?? undefined;
    const own = specOfSession(ctx).name ?? store.writtenSpec(session)?.name;
    if (own) return load(own);
    const live = store.specNames();
    if (live.length === 1) return load(live[0]);
    if (live.length > 1) {
      if (!ctx.hasUI) return undefined;
      const choice = await ctx.ui.select("Commit the work of which spec?", live);
      return choice ? load(choice) : undefined;
    }
    const archived = store.newestArchived();
    return archived ? load(archived.name) : "none";
  };

  pi.registerCommand(cmd("commit"), {
    description: "Commit the work now — after the build, the fixes, the review or the archive: the change's files and a message built from the spec, in an editor where you adjust the message and leave out any file. Optional: which spec",
    getArgumentCompletions: specCompletions,
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) return ctx.ui.notify("Pi is busy. Wait for the current turn to finish.", "warning");
      const store = new Store(ctx.cwd);
      const word = args.trim();
      if (word && !KEBAB_NAME.test(word)) return ctx.ui.notify(`\`${word}\` isn't a valid spec name (spec names are lowercase with hyphens). /${cmd("status")} lists the specs.`, "warning");
      const t = await target(ctx, store, word);
      if (t === undefined) return ctx.ui.notify(word ? `No spec "${word}", live or archived.` : `Which spec? Name it: /${cmd("commit")} <spec>.`, "warning");
      const spec = t === "none" ? undefined : t;
      // Files mid-change are not a commit: a running build or an open repair lap is still writing them.
      if (spec?.p?.phase === "building") return ctx.ui.notify(`${spec.name} is being built: commit when the build is done (or paused).`, "warning");
      if (spec?.p?.fix) return ctx.ui.notify(`A repair lap for ${spec.name} is open: let it report first.`, "warning");
      // The change: what is uncommitted now (pb's state excluded), and — for a spec — what differs since its build began.
      const uncommitted = changedSince(ctx.cwd);
      const touched = spec?.p?.baseCommit ? new Set(changedSince(ctx.cwd, spec.p.baseCommit)) : undefined;
      const files = touched ? uncommitted.filter((f) => touched.has(f)) : uncommitted;
      if (!files.length) return ctx.ui.notify(`Nothing to commit${spec ? ` for ${spec.name}` : ""}: no change since the last commit.`, "info");
      const events = spec ? readEvents(path.join(spec.dir, "events.jsonl")) : [];
      const message = spec ? commitMessageFor({ md: spec.md, name: spec.name, events, files }) : "";
      const shown = files.slice(0, LIST_CAP).map((f) => `- ${f}`).concat(files.length > LIST_CAP ? [`- … and ${files.length - LIST_CAP} more`] : []);
      if (!ctx.hasUI) {
        return post([`**Not committed** — nobody here to confirm. \`/${cmd("commit")}${spec ? ` ${spec.name}` : ""}\` would commit ${files.length} file${files.length === 1 ? "" : "s"}:`, "", ...shown, "", "with the message:", "", "```text", message || "(none: you write it)", "```"].join("\n"));
      }
      // Every uncommitted change is offered, your own edits included: the editor is where you leave any out.
      const edited = await ctx.ui.editor(`Commit${spec ? ` ${spec.name}` : ""}: edit the message, delete a file's line to leave it out`, commitEditorText(message, files));
      const chosen = edited === undefined ? undefined : readCommitEditor(edited, files);
      if (!chosen?.message) return ctx.ui.notify("Not committed.", "info");
      if (!chosen.files.length) return ctx.ui.notify("Not committed: no file left to commit.", "info");
      const commitFiles = chosen.files;
      let sha: string;
      try {
        git(ctx.cwd, ["add", "--", ...commitFiles]);
        // Only these paths: whatever else you had staged stays staged, and out of this commit.
        git(ctx.cwd, ["commit", "--file", "-", "--only", "--", ...commitFiles], chosen.message);
        sha = git(ctx.cwd, ["rev-parse", "HEAD"]).trim();
      } catch (e) {
        const said = String((e as { stderr?: unknown }).stderr ?? (e as Error).message ?? e).trim();
        return post(`**❌ Not committed** — git refused (a hook, or the repository state):\n\n\`\`\`text\n${said.slice(0, 4000)}\n\`\`\``);
      }
      const subject = chosen.message.split("\n")[0];
      const left = files.filter((f) => !commitFiles.includes(f));
      if (spec) fs.appendFileSync(path.join(spec.dir, "events.jsonl"), `${JSON.stringify({ at: now(), type: "commit", sha, files: commitFiles.length, subject })}\n`);
      const next = spec && !spec.archived ? whereNext(store, spec.name).next : `\`/${cmd("plan")} <feature>\` for the next one`;
      post([`**✅ Committed** \`${sha.slice(0, 7)}\` — ${subject} · ${commitFiles.length} file${commitFiles.length === 1 ? "" : "s"}${left.length ? ` · left out, still uncommitted: ${left.join(", ")}` : ""}`, "", nextLine(`${next}.`)].join("\n"));
    },
  });
}
