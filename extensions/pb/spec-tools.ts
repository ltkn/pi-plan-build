/** The spec's own tools: pb_write_spec, pb_update_spec, pb_record_decision, /pb:spec, and the dry run of its Test: commands. */
import { StringEnum, Type } from "./schema.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { snapshot } from "./checkpoint.ts";
import { specPrompt } from "./prompts.ts";
import { specAssumptions, acceptanceCriteria, needsRed, parseSpec, setSection, setStatus, specLosses, tokensOf } from "./spec.ts";
import { duration } from "./format.ts";
import { KEBAB_NAME } from "./names.ts";
import { Store, now } from "./store.ts";
import { runVerify } from "./verify.ts";
import { appendDecision, appendEntry, cmd, evidenceLine, instruct, liveBuildOfSession, loadSpec, nextLine, phaseHeader, post, recordedMs, reply, revertFreshRun, rewriteWarning, safely, sizeNote, specCompletions, specOfSession, specPathErrors, specRepoErrors, specStarted, specWarnings, suspiciousCommand, syncTasks, timeSuffix, warnLater, watchable, withChecking } from "./kit.ts";

const DRY_RUN_TIMEOUT_SEC = 120;

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
      const r = await withChecking(() => runVerify(command, cwd, Math.min(cfg.verifyTimeoutSec, DRY_RUN_TIMEOUT_SEC), cfg.testOutputCap));
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
      "Write or rewrite a pb feature spec (.pi/pb/specs/<name>/spec.md). Use it when the user runs /pb:spec or /pb:build asks for the spec. The content must follow the spec format the user's instructions give; the tool rejects a spec that doesn't parse and says why.",
    parameters: Type.Object({
      name: Type.String({ description: "short kebab-case spec name (the folder under .pi/pb/specs/, not a path), e.g. order-cancellation" }),
      content: Type.String({ description: "the complete spec in markdown" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!KEBAB_NAME.test(params.name)) throw new Error(`"${params.name}" is not a valid name: use short kebab-case, e.g. order-cancellation`);
      if (params.name === "off") throw new Error(`"off" is reserved (/${cmd("plan")} off ends planning): pick another spec name.`);
      const store = new Store(ctx.cwd);
      const session = ctx.sessionManager.getSessionFile();
      const repair = store.fixOfSession(session);
      if (repair && params.name !== repair.name)
        throw new Error(`A repair lap for ${repair.name} is open in this session: it may write that spec only, not ${params.name}. Finish the lap, or /${cmd("undo")} to drop it.`);
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
      const { spec, errors } = parseSpec(params.content);
      if (!spec) throw new Error(`The spec doesn't parse:\n- ${errors.join("\n- ")}\nFix it and call pb_write_spec again.`);
      const pathErrs = spec.status === "ready" ? [...specPathErrors(params.content, ctx.cwd), ...specRepoErrors(spec, ctx.cwd)] : [];
      if (pathErrs.length) throw new Error(`The spec points at code that isn't there:\n- ${pathErrs.join("\n- ")}\nFix the path, line or citation; new files need no line number.`);
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
      if (specMs !== undefined && session) specStarted.delete(session);
      store.saveProgress({
        ...(prev ?? { spec: params.name, phase: "written" }),
        spec: params.name,
        tasks: syncTasks(spec, prev?.tasks),
        // A repair lap runs in a session of its own: the spec stays owned by the session that wrote it.
        writtenIn: repair && prev ? prev.writtenIn : session,
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
      "Change part of an existing pb spec instead of rewriting it: replace or append to one section (e.g. Findings, Decisions, Design, Tasks), and/or set its Status (planning | ready). The result must still parse, or nothing is written. A replace whose body is blank is refused — a section with nothing to say is one line, \"none — <why>\".",
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "the spec's name; the one this session is building or writing, if omitted" })),
      section: Type.Optional(Type.String({ description: 'the "## " section to change, e.g. Decisions; created if missing' })),
      content: Type.Optional(Type.String({ description: "the section's new body (without its heading), or the lines to append" })),
      mode: Type.Optional(StringEnum(["replace", "append"])),
      status: Type.Optional(StringEnum(["planning", "ready"])),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const store = new Store(ctx.cwd);
      const session = ctx.sessionManager.getSessionFile();
      const repair = store.fixOfSession(session);
      const mine = store.specForSession(session);
      const live = mine ? store.progress(mine) : undefined;
      const building = live?.phase === "building" ? live : undefined;
      const fixLap = store.fixSession(session);
      const name = params.name ?? repair?.name ?? fixLap?.spec ?? mine;
      if (!name) throw new Error("Which spec? Give its name.");
      if (repair && name !== repair.name)
        throw new Error(`A repair lap for ${repair.name} is open in this session: it may write that spec only, not ${name}. Finish the lap, or /${cmd("undo")} to drop it.`);
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
      let md = store.readSpec(name);
      if (!md) throw new Error(`No spec "${name}": write it with pb_write_spec.`);
      const before = md;
      if (params.section) {
        if (params.content === undefined) throw new Error("content is required with section.");
        // An empty body under replace would leave the heading standing over nothing, and an empty
        // section answers every evidence gate by deleting what the gate inspects.
        if ((params.mode ?? "replace") !== "append" && !params.content.trim())
          throw new Error(`Not written: replacing ${params.section.replace(/^#+\s*/, "").trim()} with nothing leaves it empty — a section with nothing to say is one line, "none — <why>".`);
        md = setSection(md, params.section, params.content, (params.mode as "replace" | "append" | undefined) ?? "replace");
      }
      if (params.status) md = setStatus(md, params.status as "planning" | "ready");
      const { spec, errors } = parseSpec(md);
      if (!spec) throw new Error(`Not written: the spec wouldn't parse:\n- ${errors.join("\n- ")}`);
      const sectionName = params.section?.replace(/^#+\s*/, "").trim().toLowerCase() ?? "";
      // A path:line is a claim about the code the spec was written against. Check it on every
      // ready write except Design, which the build writes and may legitimately describe new code.
      if (spec.status === "ready" && sectionName !== "design") {
        const pathErrs = [...specPathErrors(md, ctx.cwd), ...specRepoErrors(spec, ctx.cwd)];
        if (pathErrs.length) throw new Error(`Not written: the spec points at code that isn't there:\n- ${pathErrs.join("\n- ")}\nFix the path, line or citation; new files need no line number.`);
      }
      const prev = store.progress(name);
      const isTasks = sectionName === "tasks";
      const rw = isTasks ? rewriteWarning(name, prev, spec) : undefined;
      const lost = lossNote(before, md);
      const notes = [...(isTasks ? [...specWarnings(md, spec), ...(rw ? [rw] : [])] : []), ...(lost ? [lost] : [])].map((w) => `\nNote: ${w}.`);
      const started = session ? specStarted.get(session) : undefined;
      const specMs = !building && spec.status === "ready" && started !== undefined ? Math.max(0, Date.now() - started) : undefined;
      // Answer built from pre-write values above; what follows is the file and its two ledger records.
      store.writeSpec(name, md);
      if (specMs !== undefined && session) specStarted.delete(session);
      // A live build's task list is its approved one: a Design or Decisions edit never resyncs it
      // from the live file, and the build that owns the spec keeps its writtenIn.
      // A fix lap's or a repair lap's edit is the same kind: the spec stays owned by the session that wrote it.
      const buildingNow = !!building || !!fixLap;
      const ownerStays = buildingNow || !!repair;
      store.saveProgress({
        ...(prev ?? { spec: name, phase: "written" }),
        spec: name,
        tasks: buildingNow ? (prev?.tasks ?? []) : syncTasks(spec, prev?.tasks),
        writtenIn: ownerStays && prev ? prev.writtenIn : session,
        updatedAt: now(),
      });
      store.event(name, { type: "spec", update: params.section ?? "status", status: spec.status, tokens: tokensOf(md), ...(specMs !== undefined ? { ms: specMs } : {}) });
      return reply(`✅ Updated ${store.rel("specs", name, "spec.md")}${params.section ? ` (${params.section})` : ""}: status ${spec.status}; ${sizeNote(tokensOf(md))}${timeSuffix(specMs)}.${notes.join("")}`);
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
      if (session) specStarted.set(session, Date.now());
      instruct(`▶ /${cmd("spec")}${which ? ` — ${which}` : ""}`, specPrompt(which, store.specNames(), md ? { name: which, markdown: md } : undefined, store.extra("spec"), session ? store.planning(session)?.answers : undefined));
    },
  });

  /** Let the human edit a spec in the editor; it's saved only when it still parses. */
}
