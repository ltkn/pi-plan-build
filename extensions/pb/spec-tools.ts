/** The spec's own tools: pb_write_spec, pb_update_spec, pb_record_decision, /pb:spec, and the dry run of its Test: commands. */
import { StringEnum, Type } from "./schema.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { snapshot } from "./checkpoint.ts";
import { specFormatHandout, specPrompt } from "./prompts.ts";
import { specAssumptions, acceptanceCriteria, blockFingerprints, blockLabel, isDraftSpec, needsRed, parseSpec, removedLines, removeSection, sectionKey, sectionOf, setSection, setStatus, specLosses, specTextBlocks, tokensOf, unseenBlocks } from "./spec.ts";
import { duration } from "./format.ts";
import { KEBAB_NAME } from "./names.ts";
import { Store, now } from "./store.ts";
import { runVerify } from "./verify.ts";
import { appendDecision, appendEntry, cmd, evidenceLine, instruct, liveBuildOfSession, loadSpec, nextLine, phaseHeader, post, recordedMs, reply, revertFreshRun, rewriteWarning, safely, sizeNote, specCompletions, specOfSession, specPathErrors, specRepoErrors, specStarted, specWarnings, suspiciousCommand, syncTasks, timeSuffix, warnLater, watchable, withChecking } from "./kit.ts";

const DRY_RUN_TIMEOUT_SEC = 120;

/** A dry-run command's limit: the checks' own when shorter, never none — the human waits at the approval. */
export const dryRunLimitSec = (verifyTimeoutSec: number) => (verifyTimeoutSec > 0 ? Math.min(verifyTimeoutSec, DRY_RUN_TIMEOUT_SEC) : DRY_RUN_TIMEOUT_SEC);

/**
 * Each red-eligible task command, run once before the human approves the build: failing is expected
 * (nothing built yet), passing smells pre-existing behaviour, erroring smells a broken command. Advisory
 * only — small changes (other gates, no new tests, refactors) have no red-eligible commands and skip this.
 */

export const dryRunTests = async (ctx: ExtensionContext, store: Store, name: string): Promise<string[]> => {
  const loaded = loadSpec(store, name);
  if (!loaded) return [];
  const cwd = ctx.cwd;
  const cfg = store.config();
  const commands = [...new Set(loaded.spec.tasks.filter((t) => needsRed(loaded.spec, t) && t.test).map((t) => t.test!))];
  if (!commands.length) return [];
  const started = Date.now();
  // The dry-run executes real Test: commands in the working copy: their artifacts (coverage,
  // caches) must not show up afterwards as planning changes, so put back whatever they wrote.
  const dryBefore = snapshot(cwd, "pb: before dry-run");
  // The human waits at the approval for up to DRY_RUN_TIMEOUT_SEC per command, so the widget
  // says which one is running and its elapsed seconds instead of leaving the session silent.
  let current: { command: string; n: string; since: number } | undefined;
  const paint = () => {
    const run = current; // one frame's view of what is running; the next frame repaints
    if (!run) return;
    safely(() =>
      ctx.ui.setWidget("pb-dry-run", [`pb dry-run ${name} (${run.n}/${commands.length}) — \`${run.command}\` · ${Math.round((Date.now() - run.since) / 1000)}s`]),
    );
  };
  const beat = watchable(ctx) ? setInterval(paint, 1000) : undefined;
  try {
    const results: Array<{ command: string; result: string; line: string }> = [];
    for (const [i, command] of commands.entries()) {
      if (suspiciousCommand(command)) {
        results.push({ command, result: "unknown", line: "not run here: chains shells or reaches the network — review before building" });
        continue;
      }
      current = { command, n: `${i + 1}`, since: Date.now() };
      paint();
      const r = await withChecking(() => runVerify(command, cwd, dryRunLimitSec(cfg.verifyTimeoutSec), cfg.testOutputCap));
      const line = r.summary.split("\n")[0];
      const result = r.ok ? "pass" : /TIMEOUT|ENOENT|not found|No such file/i.test(r.summary) ? "unknown" : "fail";
      results.push({ command, result, line });
      current = undefined;
    }
    store.event(name, { type: "dryrun", results: results.map(({ command, result }) => ({ command, result })) });
    const describe: Record<string, (c: string, l: string) => string> = {
      fail: (c) => `✗ \`${c}\` fails (expected: nothing built yet — if it fails for the wrong reason, like no runner, fix the command)`,
      pass: (c) => `⚠ \`${c}\` passes before the build: the behaviour may already exist (re-slice?) or the tests don't cover it yet (carry on — the build still requires red)`,
      unknown: (c, l) => `? \`${c}\` couldn't run here (${l}) — unknown, not a verdict`,
    };
    return ["", `Test commands, run once before you approve (took ${duration(Date.now() - started)}):`, ...results.map((r) => `- ${describe[r.result](r.command, r.line)}`)];
  } finally {
    if (beat !== undefined) clearInterval(beat);
    safely(() => ctx.ui.setWidget("pb-dry-run", undefined));
    revertFreshRun(cwd, (m) => warnLater(ctx, m), "the dry-run", dryBefore, snapshot(cwd, "pb: after dry-run"));
  }
};

export const readySpecs = (store: Store, session: string | undefined, since = "") => {
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

export const showSpec = (store: Store, name: string, o: { names?: string[]; next: string; extra?: string[] }) => {
  const loaded = loadSpec(store, name);
  if (!loaded) return;
  const names = o.names ?? [name];
  const specMs = recordedMs(store, name, "spec");
  const criteria = acceptanceCriteria(loaded.md, loaded.spec).length;
  const assumptions = specAssumptions(loaded.md);
  const others = names.filter((n) => n !== name);
  post(
    [
      phaseHeader("✅", "Spec written", name, `${loaded.spec.tasks.length} task${loaded.spec.tasks.length === 1 ? "" : "s"}`, criteria ? `${criteria} criteri${criteria === 1 ? "on" : "a"}` : "", specMs !== undefined ? duration(specMs) : ""),
      "",
      nextLine(o.next),
      evidenceLine(store.rel("specs", name, "spec.md"), `verification ${loaded.spec.gate}${loaded.spec.newTests ? "" : " · no new tests"}`, assumptions.length ? `${assumptions.length} assumption${assumptions.length === 1 ? "" : "s"} recorded` : "", others.length ? `also: ${others.join(", ")}` : ""),
      "",
      ...loaded.spec.tasks.map((t) => `- ${t.id}: ${t.title}${t.test ? ` · \`${t.test}\`` : ""}`),
      ...assumptions.map((a, i) => `${i ? "" : "\nSettled without asking you (the review checks them):\n"}- ${a}`),
      ...(o.extra?.length ? o.extra : []),
    ].join("\n"),
  );
  appendEntry("pb-spec", { name, markdown: loaded.md });
};

/** What a refused write tells the model when its text was kept: fix what's listed, by section. */
const DRAFT_KEPT =
  "The draft is kept: fix only what's listed with pb_update_spec (a section's new content, or mode remove for a section that shouldn't be there), which edits this draft while it's pending — not the whole spec again.";

/**
 * A write the checks refused: kept as the session's draft when there is a session to own it, so the fix is a
 * section edit; the thrown error lists what to fix either way.
 */
const refuse = (store: Store, name: string, session: string | undefined, content: string, head: string, errors: string[], tail: string): never => {
  if (session) store.writeDraft(name, { session, content, errors, at: now() });
  throw new Error(`${head}\n- ${errors.join("\n- ")}\n${tail}${session ? `\n${DRAFT_KEPT}` : ""}`);
};

/**
 * The answer to a write built from a copy of the spec older than the file: the blocks as they stand now, so the
 * model edits those instead of retrying what it remembers. Being shown a block is not reading it: a blind retry of
 * the same text is refused again, until the session edits by quoting (mode edit) or reads the file.
 */
const staleRefusal = (head: string, blocks: { text: string }[]) =>
  new Error(
    `${head}\n\n${blocks.map((b) => `--- as it stands ---\n${b.text}`).join("\n\n")}\n--- end ---\n\nChange it with pb_update_spec mode edit (old: the exact text to change, new: its replacement), or read the spec file and then write: a write from an older copy would erase what changed.`,
  );

/**
 * Decisions approved for a build hold while that build is running or paused in its own session, and in its fix
 * laps: those writers are autonomous, and approval does not fingerprint Decisions (the build adds to them). Adding is
 * theirs; changing or dropping an approved line is a spec revision, re-approved by the human.
 */
const droppedApprovedDecisions = (store: Store, name: string, md: string): string[] => {
  const approved = store.readApprovedSpec(name);
  return approved ? removedLines(sectionOf(approved, "Decisions"), sectionOf(md, "Decisions")) : [];
};

/** A write's note on what it removed from the previous text, when it removed anything. */
const lossNote = (before: string | undefined, after: string): string | undefined => {
  const lost = before ? specLosses(before, after) : [];
  return lost.length ? `this write removed ${lost.join("; ")} — if that wasn't meant, put it back` : undefined;
};

export const editSpec = async (ctx: ExtensionContext, store: Store, name: string) => {
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
    // Human edits save on parse alone: the human is the guardrail here, not the model.
    store.event(name, { type: "spec", tasks: spec.tasks.length, gate: spec.gate, newTests: spec.newTests, by: "human" });
    return ctx.ui.notify(`Saved ${store.rel("specs", name, "spec.md")}.`, "info");
  }
};

/* --------------------------------- build ------------------------------- */

/**
 * Snapshot and mark a task as started (a new task gets an undo entry); returns what to tell the agent.
 * inTool: started from pb_task_done, mid-run: the rewind point is set at the end of the turn.
 */

export function registerSpecTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: "pb_write_spec",
    label: "Write spec",
    description:
      "Write or rewrite a pb feature spec (.pi/pb/specs/<name>/spec.md). Use it when the user runs /pb:spec or /pb:build asks for the spec. The content must follow the spec format the user's instructions give; the tool rejects a spec that doesn't parse or cites code that isn't there, says why, and keeps the rejected text as a draft: fix it with pb_update_spec, section by section, rather than sending it whole again.",
    parameters: Type.Object({
      name: Type.String({ description: "short kebab-case spec name (the folder under .pi/pb/specs/, not a path), e.g. order-cancellation" }),
      content: Type.String({ description: "the complete spec in markdown" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!KEBAB_NAME.test(params.name)) throw new Error(`"${params.name}" is not a valid name: use short kebab-case, e.g. order-cancellation`);
      if (params.name === "off") throw new Error(`"off" is reserved (/${cmd("plan")} off ends planning): pick another spec name.`);
      const store = new Store(ctx.cwd);
      const session = ctx.sessionManager.getSessionFile();
      const fixLap = store.fixSession(session);
      if (fixLap)
        throw new Error(
          `This fix lap for ${fixLap.spec} can't rewrite a spec. Only its Design and Decisions may change (pb_update_spec), to say what the fix changed; a finding that needs its Goal, Contracts or Acceptance changed is reported as skipped, for a spec revision.`,
        );
      const building = liveBuildOfSession(ctx, store);
      if (building)
        throw new Error(
          `The build of ${building.spec} is running: its approved spec can't be rewritten. Only its Design and Decisions may change (pb_update_spec). If the contract itself must change, stop the task with pb_task_done status blocked and say why; the human then revises it and /${cmd("build")} re-approves the revision.`,
        );
      // Planning has no spec format of its own: a spec meant for building is written against the one pb hands
      // over, never against another spec's copy. A draft (a checkpoint's Status: planning) needs no format yet.
      if (session && !isDraftSpec(params.content)) {
        const planning = store.planning(session);
        if (planning && !planning.specFormatGiven) {
          store.markSpecFormatGiven(session);
          throw new Error(specFormatHandout());
        }
      }
      // A whole rewrite from an older copy erases whatever changed on disk since: the blocks this session has not
      // seen as they stand come back to it, and nothing is written (or kept as a draft: the text is stale).
      const existing = store.readSpec(params.name);
      if (existing && session) {
        const seen = store.seenBlocks(params.name, session);
        const unseen = unseenBlocks(existing, seen ?? {});
        if (unseen.length)
          throw staleRefusal(
            seen
              ? `Not written: spec.md changed since this session last read it: ${unseen.map(blockLabel).join(", ")}.`
              : `Not written: this session has not read the spec it would replace (${store.rel("specs", params.name, "spec.md")}).`,
            unseen,
          );
      }
      const { spec, errors } = parseSpec(params.content);
      if (!spec) return refuse(store, params.name, session, params.content, "The spec doesn't parse:", errors, "Fix it.");
      const pathErrs = spec.status === "ready" ? [...specPathErrors(params.content, ctx.cwd), ...specRepoErrors(spec, ctx.cwd)] : [];
      if (pathErrs.length) return refuse(store, params.name, session, params.content, "The spec points at code that isn't there:", pathErrs, "Fix the path, line or citation; new files need no line number.");
      const prev = store.progress(params.name);
      // Everything the answer needs is settled first: from the write down, the only work left is the
      // spec file and its two ledger records, so a failing note can't report an error over a spec
      // that was actually written, and the file never lands without its record.
      const what = spec.status === "planning" ? "status planning" : `${spec.tasks.length} tasks, verification ${spec.gate}${spec.newTests ? "" : ", no new tests"}`;
      const warnings = specWarnings(params.content, spec);
      const rw = rewriteWarning(params.name, prev, spec);
      if (rw) warnings.push(rw);
      const lost = lossNote(store.readSpec(params.name), params.content);
      if (lost) warnings.push(lost);
      const notes = warnings.map((w) => `\nNote: ${w}.`);
      const started = session ? specStarted.get(session) : undefined;
      const specMs = spec.status === "ready" && started !== undefined ? Math.max(0, Date.now() - started) : undefined;
      store.writeSpec(params.name, params.content);
      store.clearDraft(params.name);
      if (session) store.markSeen(params.name, session, blockFingerprints(params.content));
      if (specMs !== undefined && session) specStarted.delete(session);
      store.saveProgress({
        ...(prev ?? { spec: params.name, phase: "written" }),
        spec: params.name,
        tasks: syncTasks(spec, prev?.tasks),
        writtenIn: session,
        edited: false,
        updatedAt: now(),
      });
      store.event(params.name, { type: "spec", tasks: spec.tasks.length, gate: spec.gate, newTests: spec.newTests, status: spec.status, tokens: tokensOf(params.content), ...(specMs !== undefined ? { ms: specMs } : {}) });
      return reply(`✅ Wrote ${store.rel("specs", params.name, "spec.md")}: "${spec.title}", ${what}${spec.dependsOn ? `, depends on ${spec.dependsOn}` : ""}; ${sizeNote(tokensOf(params.content))}${timeSuffix(specMs)}.${notes.join("")}`);
    },
  });

  pi.registerTool({
    name: "pb_update_spec",
    label: "Update spec",
    description:
      "Change part of an existing pb spec instead of rewriting it: edit text inside one section (mode edit: old, the exact text as it stands, and new — the way to change a line or two), replace, append to or remove one section (e.g. Findings, Decisions, Design, Tasks), and/or set its Status (planning | ready). A replace or remove is refused when the section changed since this session last read the spec, with the section as it stands; edit then, or read the file first. The result must still parse, or nothing is written. A replace whose body is blank is refused — a section with nothing to say is one line, \"none — <why>\". When this session's pb_write_spec was refused, this edits that kept draft, and the spec is written once the draft passes.",
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "the spec's name; the one this session is building or writing, if omitted" })),
      section: Type.Optional(Type.String({ description: 'the "## " section to change, e.g. Decisions; created if missing' })),
      content: Type.Optional(Type.String({ description: "the section's new body (without its heading), or the lines to append; none for remove or edit" })),
      mode: Type.Optional(StringEnum(["replace", "append", "remove", "edit"])),
      old: Type.Optional(Type.String({ description: "mode edit: the exact text to change, as it stands in the section, enough of it to name one place" })),
      new: Type.Optional(Type.String({ description: "mode edit: what replaces it (empty deletes it)" })),
      status: Type.Optional(StringEnum(["planning", "ready"])),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const store = new Store(ctx.cwd);
      const session = ctx.sessionManager.getSessionFile();
      const mine = store.specForSession(session);
      const live = mine ? store.progress(mine) : undefined;
      const building = live?.phase === "building" ? live : undefined;
      const fixLap = store.fixSession(session);
      const name = params.name ?? fixLap?.spec ?? mine;
      if (!name) throw new Error("Which spec? Give its name.");
      if (building) {
        if (name !== building.spec)
          throw new Error(`The build of ${building.spec} is running in this session: only its Design and Decisions may change, not ${name}.`);
        if (params.status)
          throw new Error(`The build of ${building.spec} is running: its status can't change. Only its Design and Decisions may change; a contract change pauses the build and /${cmd("build")} re-approves the revision.`);
        const sectionName = params.section?.replace(/^#+\s*/, "").trim().toLowerCase();
        if (sectionName !== "design" && sectionName !== "decisions")
          throw new Error(
            `The build of ${building.spec} is running: only its Design and Decisions may change, not ${sectionName ? `"${params.section!.replace(/^#+\s*/, "").trim()}"` : "the spec"}. A contract change pauses the build and /${cmd("build")} re-approves the revision.`,
          );
      }
      if (fixLap) {
        // A fix lap keeps the spec true to the code it fixed, as a build does; its contract is not the lap's to change.
        const sectionName = params.section?.replace(/^#+\s*/, "").trim().toLowerCase();
        if (name !== fixLap.spec || params.status || (sectionName !== "design" && sectionName !== "decisions"))
          throw new Error(
            `This fix lap may change only ${fixLap.spec}'s Design and Decisions, to say what the fix changed. A finding that needs its Goal, Contracts, Acceptance or Status changed is reported as skipped, for a spec revision.`,
          );
      }
      // This session's refused write, if there is one: the edit fixes it. A build or a fix lap edits the spec
      // it was approved against, and another session's draft is never this session's to finish.
      const kept = building || fixLap || !session ? undefined : store.readDraft(name);
      const draft = kept?.session === session ? kept : undefined;
      let md = draft?.content ?? store.readSpec(name);
      if (!md) throw new Error(`No spec "${name}": write it with pb_write_spec.`);
      const before = store.readSpec(name);
      const sectionLabel = params.section?.replace(/^#+\s*/, "").trim();
      const key = sectionLabel ? sectionKey(sectionLabel) : undefined;
      const mode = params.mode ?? (params.section ? "replace" : undefined);
      const asItStands = () => specTextBlocks(md!).filter((b) => b.key === key);
      // A replace or remove overwrites the whole section: only from what this session saw of it. The spec on disk is
      // what's guarded; a kept draft is this session's own text.
      if (!draft && session && before && key && (mode === "replace" || mode === "remove") && asItStands().length) {
        const seen = store.seenBlocks(name, session);
        if (!seen) throw staleRefusal(`Not written: this session has not read the spec, so it can't replace ## ${sectionLabel} from what it holds.`, asItStands());
        if (seen[key] !== blockFingerprints(md)[key]) throw staleRefusal(`Not written: ## ${sectionLabel} changed since this session last read it.`, asItStands());
      }
      if (mode === "edit") {
        if (!sectionLabel) throw new Error("mode edit needs the section whose text it changes.");
        if (params.old === undefined || params.old === "") throw new Error("mode edit needs old: the exact text to change, as it stands in the section.");
        const body = sectionOf(md, sectionLabel);
        if (!asItStands().length) throw new Error(`Not written: there is no "## ${sectionLabel}" section to edit.`);
        const count = body.split(params.old).length - 1;
        if (count === 0) throw staleRefusal(`Not written: the text to change is not in ## ${sectionLabel} as it stands.`, asItStands());
        if (count > 1) throw new Error(`Not written: the text to change occurs ${count} times in ## ${sectionLabel}: quote enough to name one place.`);
        const edited = body.replace(params.old, () => params.new ?? "");
        if (!edited.trim()) throw new Error(`Not written: this edit leaves ${sectionLabel} empty — a section with nothing to say is one line, "none — <why>".`);
        md = setSection(md, sectionLabel, edited, "replace");
      } else if (params.mode === "remove") {
        if (!sectionLabel) throw new Error("mode remove needs the section to remove.");
        const removed = removeSection(md, sectionLabel);
        if (removed === undefined) throw new Error(`Not written: there is no "## ${sectionLabel}" section to remove.`);
        md = removed;
      } else if (params.section) {
        if (params.content === undefined) throw new Error("content is required with section.");
        // An empty body under replace would leave the heading standing over nothing, and an empty
        // section answers every evidence gate by deleting what the gate inspects.
        if ((params.mode ?? "replace") !== "append" && !params.content.trim())
          throw new Error(`Not written: replacing ${params.section.replace(/^#+\s*/, "").trim()} with nothing leaves it empty — a section with nothing to say is one line, "none — <why>".`);
        md = setSection(md, params.section, params.content, (params.mode as "replace" | "append" | undefined) ?? "replace");
      }
      if (params.status) md = setStatus(md, params.status as "planning" | "ready");
      // Approved decisions hold for the autonomous writers of a live build: the build, running or paused in its own
      // session, and its fix laps. (A paused build's own session is where they were rewritten from memory before.)
      const spoken = store.progress(name);
      const buildsIt = !!building || !!fixLap || (spoken?.phase === "paused" && !!session && spoken.session === session);
      if (buildsIt && key === "section:decisions" && mode !== "append") {
        const dropped = droppedApprovedDecisions(store, name, md);
        if (dropped.length)
          throw new Error(
            `Not written: approved decisions hold during the build of ${name}; this write would change or drop:\n${dropped.map((l) => (l.startsWith("- ") ? l : `- ${l}`)).join("\n")}\nAdd a decision with pb_record_decision or mode append. If an approved decision is wrong, stop the task with pb_task_done status blocked and say why: the human revises the spec and /${cmd("build")} re-approves it.`,
          );
      }
      const { spec, errors } = parseSpec(md);
      if (!spec) {
        if (draft) return refuse(store, name, session, md, "Not written: the draft still doesn't parse:", errors, "Fix it.");
        throw new Error(`Not written: the spec wouldn't parse:\n- ${errors.join("\n- ")}`);
      }
      const sectionName = sectionLabel?.toLowerCase() ?? "";
      // A path:line is a claim about the code the spec was written against. Check it on every
      // ready write except Design, which the build writes and may legitimately describe new code.
      if (spec.status === "ready" && (sectionName !== "design" || draft)) {
        const pathErrs = [...specPathErrors(md, ctx.cwd), ...specRepoErrors(spec, ctx.cwd)];
        const fix = "Fix the path, line or citation; new files need no line number.";
        if (pathErrs.length && draft) return refuse(store, name, session, md, "Not written: the draft points at code that isn't there:", pathErrs, fix);
        if (pathErrs.length) throw new Error(`Not written: the spec points at code that isn't there:\n- ${pathErrs.join("\n- ")}\n${fix}`);
      }
      const prev = store.progress(name);
      // A draft becomes the spec whole, so it gets a whole write's notes.
      const isTasks = sectionName === "tasks" || !!draft;
      const rw = isTasks ? rewriteWarning(name, prev, spec) : undefined;
      const lost = lossNote(before, md);
      const notes = [...(isTasks ? [...specWarnings(md, spec), ...(rw ? [rw] : [])] : []), ...(lost ? [lost] : [])].map((w) => `\nNote: ${w}.`);
      const started = session ? specStarted.get(session) : undefined;
      const specMs = !building && spec.status === "ready" && started !== undefined ? Math.max(0, Date.now() - started) : undefined;
      // Answer built from pre-write values above; what follows is the file and its two ledger records.
      store.writeSpec(name, md);
      if (draft) store.clearDraft(name);
      if (session) {
        // What this write showed the session: all of a draft (its own text), the blocks it replaced, edited or removed;
        // an append or a status change leaves a block seen only if it was seen as it stood before.
        const after = blockFingerprints(md);
        const touched = [...(key ? [key] : []), ...(params.status ? ["header"] : [])];
        if (draft) store.markSeen(name, session, after);
        else {
          const seen = store.seenBlocks(name, session) ?? {};
          const was = before ? blockFingerprints(before) : {};
          const follows = (k: string) => mode === "replace" || mode === "remove" || mode === "edit" || seen[k] === was[k];
          const keys = touched.filter((k) => (k === "header" ? seen.header === was.header : follows(k)));
          if (keys.length) store.markSeen(name, session, after, keys);
        }
      }
      if (specMs !== undefined && session) specStarted.delete(session);
      // A live build's task list is its approved one: a Design or Decisions edit never resyncs it
      // from the live file, and the build that owns the spec keeps its writtenIn.
      // A fix lap's edit is the same kind: the spec stays owned by the session that wrote it.
      const buildingNow = !!building || !!fixLap;
      const ownerStays = buildingNow;
      store.saveProgress({
        ...(prev ?? { spec: name, phase: "written" }),
        spec: name,
        tasks: buildingNow ? (prev?.tasks ?? []) : syncTasks(spec, prev?.tasks),
        writtenIn: ownerStays && prev ? prev.writtenIn : session,
        updatedAt: now(),
      });
      store.event(name, { type: "spec", update: params.section ?? "status", ...(draft ? { fromDraft: true } : {}), status: spec.status, tokens: tokensOf(md), ...(specMs !== undefined ? { ms: specMs } : {}) });
      const change = sectionLabel ? ` (${sectionLabel}${mode === "remove" ? " removed" : mode === "edit" ? " edited" : ""})` : "";
      const what = draft ? `✅ Wrote ${store.rel("specs", name, "spec.md")} from the draft${change}` : `✅ Updated ${store.rel("specs", name, "spec.md")}${change}`;
      return reply(`${what}: status ${spec.status}; ${sizeNote(tokensOf(md))}${timeSuffix(specMs)}.${notes.join("")}`);
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
      if (!name || !md || !progress) throw new Error("This is not a pb build session. In planning, decisions stay in the discussion and enter the spec via /pb:spec or /pb:build — carry on.");
      const entry = params.assumption ? `Assumption (build${progress.current ? `, ${progress.current}` : ""}): ${params.decision}` : params.decision;
      const refused = appendDecision(store, name, entry);
      if (refused) throw new Error(`Not recorded: ${refused}. Fix the spec (pb_update_spec) and record the decision again.`);
      const session = ctx.sessionManager.getSessionFile();
      const after = store.readSpec(name);
      // The session's own append: Decisions stays seen if it was seen as it stood before.
      if (session && after && store.seenBlocks(name, session)?.["section:decisions"] === blockFingerprints(md)["section:decisions"])
        store.markSeen(name, session, blockFingerprints(after), ["section:decisions"]);
      if (params.assumption) {
        progress.assumptions = [...(progress.assumptions ?? []), entry];
        store.saveProgress(progress);
      }
      return reply("Recorded in the spec's Decisions.");
    },
  });

  pi.registerCommand(cmd("spec"), {
    description: "Write the spec for what we planned (one per feature); run it again to revise. Optional: which feature",
    getArgumentCompletions: specCompletions,
    handler: async (args, ctx) => {
      const store = new Store(ctx.cwd);
      const which = args.trim();
      const md = which && KEBAB_NAME.test(which) ? store.readSpec(which) : undefined;
      const session = ctx.sessionManager.getSessionFile();
      if (session) {
        specStarted.set(session, Date.now());
        store.markSpecFormatGiven(session);
      }
      instruct(`▶ /${cmd("spec")}${which ? ` — ${which}` : ""}`, specPrompt(which, store.specNames(), md ? { name: which, markdown: md } : undefined, store.extra("spec"), session ? store.planning(session)?.answers : undefined));
    },
  });

  /** Let the human edit a spec in the editor; it's saved only when it still parses. */
}
