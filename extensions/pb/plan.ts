/** The planning flow: /pb:plan, /pb:approach, /pb:deps, the baseline, and the planning protections. */
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext
 } from "@earendil-works/pi-coding-agent";
import { inWorktree, snapshot } from "./checkpoint.ts";
import { approachPrompt, continuePlanPrompt, depsPrompt, planPrompt } from "./prompts.ts";
import { missingPaths, readMap } from "./map.ts";
import { parseSpec, setStatus } from "./spec.ts";
import { KEBAB_NAME } from "./names.ts";
import { agentDir, findStandards, isUserTemplate, presetNote, projectStack, sectionFor, usesDatabase, writeStandards } from "./standards.ts";
import { type VerifyResult, Store, cap, gitHead, now } from "./store.ts";
import { dependencyCommands, runVerify } from "./verify.ts";
import { MODEL_ARG_CAP, baselineSessions, cmd, commands, instruct, liftPlanning, noSnapshotWarning, normSpecArg, planTitle, post, reviewPlanningChanges, runtime, sessionGone, sessionModel, specCompletions, stackLabel, standardsFor, syncTasks, applyPlanner, plannerSettings } from "./kit.ts";
import { unfinishedPhase } from "./phase.ts";

export const offerStandards = async (ctx: ExtensionContext, store: Store) => {
  if (!ctx.hasUI || store.asked("standards")) return;
  const found = findStandards(ctx.cwd);
  const stack = projectStack(ctx.cwd);
  const database = usesDatabase(ctx.cwd);
  const shared = !!found && path.dirname(found.file) !== path.resolve(ctx.cwd);
  // A shared section is enough unless this project's own adds to it (a stack's or the database's
  // rules, which a shared section must never carry): then the project is offered its own.
  if (found && !(shared && (stack || database) && !sectionFor(stack, database).includes(found.text))) return;
  store.markAsked("standards");
  const HERE =
    stack === "vue"
      ? "Add pb's frontend standards to this project's AGENTS.md"
      : stack && isUserTemplate(stack)
        ? `Add your ${stack} standards to this project's AGENTS.md`
        : "Add pb's engineering standards to this project's AGENTS.md";
  const ALL = `Add them to ${path.join(agentDir(), "AGENTS.md")} (all projects)`;
  const covers =
    stack && isUserTemplate(stack)
      ? `your ${stack} template`
      : `quality, simplicity, dependencies, comments without history, tests, security${stack === "vue" ? ", the page's role, backend refusals, browser security, Vue" : `${database ? ", database consistency" : ""}${stack === "java" ? ", Java 25" : stack === "rust" ? ", Rust" : ""}`}`;
  const title = found
    ? `This project only gets the standards in ${found.file}, not its own (${stackLabel(stack)}). Pi loads both files, so that section stays in force next to this project's: keep the shared AGENTS.md free of stack-specific rules`
    : `Engineering standards (${covers})${presetNote(stack) ? `. ${presetNote(stack)}` : ""}`;
  const choice = await ctx.ui.select(title, stack || database ? [HERE, "No thanks"] : [HERE, ALL, "No thanks"]);
  if (choice !== HERE && choice !== ALL) return;
  const file = choice === HERE ? path.join(ctx.cwd, "AGENTS.md") : path.join(agentDir(), "AGENTS.md");
  writeStandards(file, stack, choice === HERE && database);
  ctx.ui.notify(`Added to ${file}${stack ? ` (${stackLabel(stack)})` : ""}. Pi loads them into every session from now on. /${cmd("standards")} rewrites pb's section, so a change of yours inside it lasts until then${presetNote(stack) ? `; ${presetNote(stack)}` : "."}`, "info");
};

/** Continue planning a spec in a fresh session, seeded from it: clean context, exact checkpoint. */

export function registerPlan(pi: ExtensionAPI) {
  const startBaseline = (ctx: ExtensionContext, store: Store, command: string, say?: (content: string) => void): boolean => {
    const session = ctx.sessionManager.getSessionFile();
    // One baseline per session: re-planning here reuses the one in flight, a second planning session gets its own.
    if (session) {
      if (baselineSessions.has(session)) return false;
      baselineSessions.add(session);
    }
    const origin = session;
    const cfg = store.config();
    const head = gitHead(ctx.cwd);
    // Outside git there is no worktree to isolate the run: it shares the working copy, so its
    // artifacts (coverage, caches) may show up as planning changes — reviewPlanningChanges will list them.
    if (!head) ctx.ui.notify("Not a git repo, so the baseline runs in the working copy; its test artifacts may show as planning changes.", "warning");
    // In a worktree at the captured HEAD: the planner's own builds in the working copy can't collide with it.
    // Lint and the project's own checks ride along, so a red final gate never surprises: red there
    // warns (it never blocks alone), red suite blocks via the usual question.
    const { lintCmd, extraCmds } = commands(ctx.cwd, store);
    runtime.checking += 1;
    void inWorktree(
      ctx.cwd,
      async (dir) => {
        const r = await runVerify(command, dir, cfg.verifyTimeoutSec, cfg.testOutputCap);
        const lint = lintCmd ? await runVerify(lintCmd, dir, cfg.verifyTimeoutSec, cfg.testOutputCap) : null;
        const extra: VerifyResult[] = [];
        for (const cmd of extraCmds) extra.push(await runVerify(cmd, dir, cfg.verifyTimeoutSec, cfg.testOutputCap));
        return { r, lint, extra };
      },
      head ?? "HEAD",
    )
      .then(({ r, lint, extra }) => {
        store.saveBaseline({ ...r, head, lint, extra }, origin ?? undefined);
        const poster =
          say ??
          ((content: string) => {
            try {
              if (ctx.sessionManager.getSessionFile() !== origin) return;
            } catch {
              return;
            }
            post(content);
          });
        try {
          const extras = [...(lint ? [`lint \`${lintCmd}\` → ${lint.summary.split("\n")[0]}`] : []), ...extra.map((e) => `\`${e.command}\` → ${e.summary.split("\n")[0]}`)];
          poster(
            `**Baseline** (the test suite on the last commit): ${r.ok ? r.summary : `${r.summary}\n\nThe final check runs the whole suite, so it fails until this is fixed.`}${extras.length ? `\n\nAlso ran for the final gate:\n- ${extras.join("\n- ")}` : ""}`,
          );
        } catch {
          // the session was replaced meanwhile: baseline.json still has the result
        }
      })
      .finally(() => {
        runtime.checking -= 1;
        if (session) baselineSessions.delete(session);
      });
    return true;
  };

  /** Why pb can't list what changed while planning when no snapshot was taken. */

  const warnStaleMap = (ctx: ExtensionContext) => {
    const gone = missingPaths(ctx.cwd, readMap(ctx.cwd));
    if (gone.length)
      ctx.ui.notify(
        `The project map in AGENTS.md names ${gone.length} path(s) that no longer exist (${gone.slice(0, 3).join(", ")}${gone.length > 3 ? ", …" : ""}): /${cmd("map")} refreshes it.`,
        "warning",
      );
  };

  /** Start planning mode for this session (the snapshot shows later what changed while it was on). */

  const startPlanning = (ctx: ExtensionContext, store: Store, request?: string): boolean => {
    const session = ctx.sessionManager.getSessionFile();
    if (!session) {
      // Every planning guard keys off the session file (edit/write block, undo snapshots, checkpointing): without it,
      // "the project's files stay untouched" would be a promise pb can't keep, so planning doesn't start.
      ctx.ui.notify("No session file for this session, so the planning protections can't run. Start Pi with a saved session and try again.", "error");
      return false;
    }
    const existing = store.planning(session)?.snapshot;
    const checkpoints = store.config().checkpoints;
    const snap = existing ? undefined : checkpoints ? snapshot(ctx.cwd, "pb: start of planning") : undefined;
    // The verbatim request is recorded (an explicit arg wins, otherwise whatever is already there survives),
    // so the checkpoint summary keeps what was asked even after a long discussion.
    store.setPlanning(session, true, existing ?? snap?.commit, request ?? store.planning(session)?.request);
    store.detachSession(session);
    ctx.ui.setWidget("pb-plan", ["planning · /pb:plan off"]);
    if (!existing && !snap?.commit) ctx.ui.notify(noSnapshotWarning(checkpoints), "warning");
    return true;
  };

  /**
   * Files that changed in the project while this session was planning (bash can write where edit and
   * write are blocked). Asks whether to keep or restore them; false = cancel.
   */

  const continuePlan = async (ctx: ExtensionCommandContext, store: Store, name: string) => {
    let md = store.readSpec(name)!;
    const oldSession = ctx.sessionManager.getSessionFile();
    // Files the old planning session's bash wrote are reviewed before we move on.
    if (!(await reviewPlanningChanges(ctx, store))) return;
    // A finished plan reopened: the spec says so while it is replanned, or the next /pb:build would build it mid-replan.
    if (parseSpec(md).spec?.status === "ready") {
      const reopened = setStatus(md, "planning");
      if (parseSpec(reopened).spec) {
        md = reopened;
        store.writeSpec(name, md);
        store.event(name, { type: "spec", update: "status", status: "planning" });
        ctx.ui.notify(`\`${name}\` was Status: ready; set back to planning while we replan it.`, "info");
      }
    }
    // The new session plans on the planner's settings: the old session's planning run already chose them;
    // otherwise they are chosen now. The handover carries them over, and the new record what to put back.
    const planner =
      store.planning(oldSession ?? "")?.planner ??
      plannerSettings({ thinking: pi.getThinkingLevel() as string | undefined, model: sessionModel(ctx) }, store.config().planner);
    store.setCarry({ model: planner.appliedModel ?? sessionModel(ctx), thinking: planner.appliedThinking ?? (pi.getThinkingLevel() as string | undefined), spec: name, parent: oldSession ?? undefined });
    let newSessionFile: string | undefined;
    const result = await ctx.newSession({
      parentSession: oldSession,
      setup: async (sm) => {
        sm.appendSessionInfo(`plan: ${name}`);
      },
      withSession: async (c) => {
        // Only `c` from here on: the captured pi and ctx belong to the replaced session.
        // Snapshot here, in the new session's working copy: the old session's tree may differ.
        const ns = new Store(c.cwd);
        const checkpoints = ns.config().checkpoints;
        const snap = checkpoints ? snapshot(c.cwd, "pb: start of planning") : undefined;
        const session = c.sessionManager.getSessionFile();
        newSessionFile = session ?? undefined;
        if (session) {
          ns.setPlanning(session, true, snap?.commit, store.planning(oldSession ?? "")?.request);
          ns.setPlannerSettings(session, planner);
        }
        if (session) c.ui.setWidget("pb-plan", ["planning · /pb:plan off"]);
        if (!snap?.commit) c.ui.notify(noSnapshotWarning(checkpoints), "warning");
        // Same staleness check as /pb:plan: the map may have rotted since the old session.
        warnStaleMap(c);
        const p = ns.progress(name);
        if (p) ns.saveProgress({ ...p, writtenIn: session });
        else {
          const parsed = parseSpec(md).spec;
          if (parsed && session) ns.saveProgress({ spec: name, phase: "written", writtenIn: session, tasks: syncTasks(parsed, []), edited: false, updatedAt: now() });
        }
        // A fresh session gets a fresh baseline, not the previous session's result.
        const { cfg, testCmd } = commands(c.cwd, ns);
        const baseline = cfg.baseline && !!testCmd;
        if (baseline) startBaseline(c, ns, testCmd!, (content) => c.sendMessage({ customType: "pb", content, display: true }, { triggerTurn: false }));
        await c.sendMessage(
          {
            customType: "pb",
            content: `▶ Planning **${name}** on, from ${ns.rel("specs", name, "spec.md")} (the project's files stay untouched).${baseline ? ` Running \`${testCmd}\` in the background for a baseline.` : ""}\nThis session: "plan: ${name}" · back to it with /resume, or \`pi --session ${c.sessionManager.getSessionId()}\` · \`/${cmd("plan")}\` off ends planning`,
            display: true,
          },
          { triggerTurn: false },
        );
        void c.sendMessage({ customType: "pb-instruction", content: continuePlanPrompt(name, md, ""), display: false }, { triggerTurn: true });
      },
    }).catch((e) => {
      store.clearCarry(); // a throw must not leave the handover behind either
      throw e;
    });
    if (result.cancelled) {
      store.clearCarry(); // its handover must not leak into a later, unrelated new session
      if (!sessionGone(ctx)) ctx.ui.notify("Cancelled.", "info");
      return;
    }
    if (oldSession && newSessionFile && oldSession !== newSessionFile && store.planning(oldSession) && store.specsOfPlanning(oldSession).length === 0) {
      store.setPlanning(oldSession, false);
    }
  };

  pi.registerCommand(cmd("plan"), {
    description: "Plan something with Pi: /pb:plan <describe what you want to build or change, in your own words>, or /pb:plan <spec> to continue planning a spec in a fresh session. Pi can run anything to investigate but won't touch the project's files. /pb:plan off ends that",
    getArgumentCompletions: (prefix: string) => [{ value: "off", label: "off" }, ...specCompletions(prefix)].filter((c) => c.value.startsWith(prefix)),
    handler: async (args, ctx) => {
      const arg = args.trim();
      const store = new Store(ctx.cwd);
      const session = ctx.sessionManager.getSessionFile();
      if (arg === "off") {
        if (!session || !store.planningSessions().includes(session)) return ctx.ui.notify("Not in planning mode.", "info");
        if (!(await liftPlanning(ctx, store))) return;
        return ctx.ui.notify("Planning mode off: Pi can change the project's files again.", "info");
      }
      if (!arg)
        return ctx.ui.notify(`Describe what you want, in your own words, e.g.\n/${cmd("plan")} let admins cancel an order while it is still pending, and notify the customer`, "warning");
      if (KEBAB_NAME.test(arg) && store.readSpec(arg)) {
        const phase = store.progress(arg)?.phase ?? "written";
        if (phase === "written") {
          if (!ctx.isIdle()) return ctx.ui.notify("Pi is busy. Wait for the current turn to finish.", "warning");
          return continuePlan(ctx, store, arg);
        }
        const next = unfinishedPhase(phase)
          ? `\`/${cmd("build")} ${arg}\` continues the unfinished build, \`/${cmd("spec")} ${arg}\` revises its spec`
          : `\`/${cmd("review")} ${arg}\` reviews it, \`/${cmd("spec")} ${arg}\` revises its spec`;
        return ctx.ui.notify(
          `\`${arg}\` is not being planned (its phase is ${phase}): ${next}. To plan something new, describe it in your own words.`,
          "warning",
        );
      }
      // A near-miss spec name silently starting a new plan costs a duplicate spec downstream:
      // redirect in the same style as the phase-mismatch message above.
      const near = normSpecArg(arg);
      if (near !== arg && near !== "off" && KEBAB_NAME.test(near)) {
        const hit = store.specNames().filter((n) => n === near);
        if (hit.length === 1 && store.readSpec(hit[0])) {
          return ctx.ui.notify(
            `\`${arg}\` isn't a spec name (spec names are lowercase with hyphens). Did you mean \`${hit[0]}\`? \`/${cmd("plan")} ${hit[0]}\` continues it; to plan something new, describe it in your own words.`,
            "warning",
          );
        }
      }
      // A name makes the planning session easy to find again in /resume, e.g. after a crash.
      if (!ctx.isIdle()) return ctx.ui.notify("Pi is busy. Wait for the current turn to finish.", "warning");
      const title = planTitle(arg);
      const { cfg, testCmd } = commands(ctx.cwd, store);

      await offerStandards(ctx, store);

      // After the standards offer: its AGENTS.md isn't a change made while planning.
      if (!startPlanning(ctx, store, arg)) return;
      await applyPlanner(ctx, store);
      pi.setSessionName(`plan: ${title}`);
      // A cheap staleness check of the project map, no model call: paths it names that are gone.
      warnStaleMap(ctx);

      // The baseline costs no tokens: the harness runs the suite while the discussion starts.
      const baseline = cfg.baseline && !!testCmd;
      const started = baseline ? startBaseline(ctx, store, testCmd!) : false;
      instruct(
        `▶ /${cmd("plan")} — ${title} (the project's files stay untouched)${baseline ? (started ? ` · running \`${testCmd}\` in the background for a baseline` : ` · baseline already running — its result lands here`) : ""}\nThis session: "plan: ${title}" · back to it any time with /resume, or \`pi --session ${ctx.sessionManager.getSessionId()}\` · \`/${cmd("plan")}\` off ends planning\n\n${arg.split("\n").map((l) => `> ${l}`).join("\n")}`,
        planPrompt(cap(arg, MODEL_ARG_CAP), testCmd, standardsFor(ctx), baseline ? "running" : "none"),
      );
    },
  });

  pi.registerCommand(cmd("approach"), {
    description: "In a planning session: hear how Pi would approach the implementation — architecture, seams, non-goals, test strategy, alternatives, risks, open questions (listed, not asked). Optional: which idea to expand",
    handler: async (args, ctx) => {
      const store = new Store(ctx.cwd);
      const session = ctx.sessionManager.getSessionFile();
      if (!session || !store.planningSessions().includes(session))
        return ctx.ui.notify(`/${cmd("approach")} is for planning sessions: run /${cmd("plan")} first, then ask for the approach mid-discussion.`, "warning");
      if (!ctx.isIdle()) return ctx.ui.notify("Pi is busy. Wait for the current turn to finish.", "warning");
      const focus = args.trim();
      const shown = planTitle(focus);
      instruct(
        `▶ /${cmd("approach")}${shown ? ` — ${shown}` : ""} (chat only: nothing is written)`,
        approachPrompt(focus, standardsFor(ctx)),
      );
    },
  });

  pi.registerCommand(cmd("deps"), {
    description: "Check dependencies (versions, deprecations) and propose upgrades as a change of their own. Optional: which ones",
    handler: async (args, ctx) => {
      const store = new Store(ctx.cwd);
      if (!ctx.isIdle()) return ctx.ui.notify("Pi is busy. Wait for the current turn to finish.", "warning");
      await offerStandards(ctx, store);
      if (!startPlanning(ctx, store, args.trim() ? `/pb:deps ${args.trim()}` : "/pb:deps")) return;
      await applyPlanner(ctx, store);
      pi.setSessionName(`deps: ${planTitle(args.trim()) || "all"}`);
      // Same staleness check as /pb:plan: the investigation starts from the map.
      warnStaleMap(ctx);
      // Same baseline as /pb:plan: an upgrade is judged against the suite as it is today, run at no token cost.
      const { cfg, testCmd } = commands(ctx.cwd, store);
      const baseline = cfg.baseline && !!testCmd;
      const started = baseline ? startBaseline(ctx, store, testCmd!) : false;
      instruct(
        `▶ /${cmd("deps")}${args.trim() ? ` — ${planTitle(args.trim())}` : ""} (the project's files stay untouched)${baseline ? (started ? ` · running \`${testCmd}\` in the background for a baseline` : " · baseline already running — its result lands here") : ""}`,
        depsPrompt(cap(args.trim(), MODEL_ARG_CAP), { testCmd, standards: standardsFor(ctx), baseline: baseline ? "running" : "none", tools: dependencyCommands(ctx.cwd) }),
      );
    },
  });

  // Planning mode, first layer: edit/write inside the project are blocked synchronously.
  // Anything else that can write (bash, other tools) is caught by reviewPlanningChanges at the end of planning.
}
