/** /pb:build: the build-start screen, its checks and baseline questions, launching here or fresh, the pending-build offer, and resuming a paused build. */
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext
 } from "@earendil-works/pi-coding-agent";
import { changedPaths, snapshot } from "./checkpoint.ts";
import { tip } from "./help.ts";
import { buildIntro, coherePrompt, continuePrompt, findingLine, finishSpecPrompt, fixText, specPrompt } from "./prompts.ts";
import { type ParsedSpec, contractHash, specHash, specTextBlocks } from "./spec.ts";
import { KEBAB_NAME } from "./names.ts";
import { type Progress, COHERE_TASK_ID, Store, cap, gitHead, now, readEvents } from "./store.ts";
import { agree, appendDecision, approveSpec, changedFilesSection, choose, cmd, commands, findModel, instruct, liftPlanning, loadSpec, normSpecArg, pauseBuild, planningWriteNotes, post, reviewPlanningChanges, sessionGone, sessionModel, showProgress, sleep, specCompletions, specOfSession, specRef, repoHeads, repoSnapshots, specStarted, specWriting, standardsFor, syncTasks, tree } from "./kit.ts";
import { offerStandards } from "./plan.ts";
import { dryRunTests, editSpec, readySpecs, showSpec } from "./spec-tools.ts";
import { COHERE_MARKER, beginCohereEntry, beginTask, confirmLiveBuild, needsCohere } from "./build-loop.ts";
import { ensureSpecReviewed, recordedFindings, reviewDoor } from "./spec-review.ts";
import { advanceSpecFix, fixLive } from "./repair.ts";
import { enterStep, nextPhase, nextTodo, unfinishedPhase } from "./phase.ts";

/**
 * A resume buys an exhausted step a fresh set of attempts; any other pause keeps its count.
 * Resets and returns true only when the step had exhausted its budget; the next handout
 * counts the new attempt.
 */
const resetExhausted = (tp: { attempts: number } | undefined, max: number): boolean => {
    const exhausted = (tp?.attempts ?? 0) >= max;
    if (exhausted && tp) tp.attempts = 0;
    return exhausted;
  };

  /**
   * What a task did to existing tests (deleted, fewer cases, new skips) and to earlier tasks' files.
   * Nothing here fails a task: a refactor legitimately moves and merges tests. Test changes are listed
   * at the end of the build and handed to the reviewer, who judges whether each was justified.
   */

export function registerBuildStart(pi: ExtensionAPI) {
  const preBuildChecks = async (
    ctx: ExtensionContext,
    store: Store,
    name: string,
    o: { checked?: boolean; notes?: string[] },
  ) => {
    const notes = o.notes ?? [];
    const loaded = loadSpec(store, name);
    if (!loaded) {
      ctx.ui.notify(`${store.rel("specs", name, "spec.md")} doesn't parse. Rewrite it with /${cmd("spec")} ${name}.`, "error");
      return undefined;
    }
    const { spec, md } = loaded;
    if (spec.status === "planning") {
      ctx.ui.notify(`${name} is still being planned: /${cmd("build")} ${name} finishes it first.`, "warning");
      return undefined;
    }
    const prog = store.progress(name);
    if (prog?.fix && fixLive(prog.fix)) {
      // A lap is the model holding the plan in its hands: a build approved now would be built from
      // whichever half-written text the lap had reached when its turn happened to end.
      ctx.ui.notify(`A repair lap for ${name} is still open (the model is rewriting its plan). Let it report, or /${cmd("undo")} to drop the lap — then /${cmd("build")} ${name}.`, "warning");
      return undefined;
    }
    const { cfg, testCmd, buildCmd } = commands(ctx.cwd, store);
    if (spec.gate === "tests" && !testCmd) {
      ctx.ui.notify(`Verification is "tests" but no test command is set: set "verify" in ${store.rel("config.json")}, or use Verification: build/none in the spec.`, "warning");
      return undefined;
    }
    if (spec.gate === "build" && !buildCmd) {
      ctx.ui.notify(`Verification is "build" but no build command is set: set "build" in ${store.rel("config.json")}.`, "warning");
      return undefined;
    }
    // What could make you hold the build is collected, not asked one dialog at a time: the build-start screen
    // shows it all once, after the spec review, with the one choice it leads to.
    const concerns: string[] = [];
    if (spec.dependsOn && !store.finishedPhase(spec.dependsOn)) concerns.push(`${name} depends on ${spec.dependsOn}, which isn't built yet`);
    if (!o.checked && spec.gate === "tests" && baselineApplies(ctx, store, testCmd)) {
      const b = store.baseline(ctx.sessionManager.getSessionFile() ?? undefined)!;
      concerns.push(`the test suite already failed when planning began (${b.summary.split("\n")[0]}, ${b.at}): the final check runs it, so it fails too unless that's fixed`);
    }
    if (!o.checked) baselineExtraWarning(ctx, store, testCmd);
    if (!o.checked && !(await reviewPlanningChanges(ctx, store, notes))) return undefined;
    if (!cfg.checkpoints) ctx.ui.notify("Checkpoints are off: this build runs without undo points, and without the test-tampering checks.", "warning");
    return { spec, md, cfg, buildCmd, concerns };
  };

  /**
   * Fresh progress for (re)starting a build: finished tasks stay done with their proofs,
   * everything else goes back to todo — attempts included, so a crash grants no fresh budget.
   * Returns the progress and the first unfinished step, or undefined when nothing is left.
   */

  const initBuildProgress = (ctx: ExtensionContext, store: Store, name: string, spec: ParsedSpec, notes: string[]) => {
    const prev = store.progress(name);
    const restart = !!prev && unfinishedPhase(prev.phase);
    const p: Progress = {
      ...prev,
      spec: name,
      phase: nextPhase(prev?.phase ?? "written", "building"),
      baseCommit: restart ? (prev!.baseCommit ?? gitHead(ctx.cwd)) : gitHead(ctx.cwd),
      repoBases: restart && prev?.repoBases ? prev.repoBases : repoHeads(ctx.cwd, spec),
      // A task's tests seen failing stay proven: only /pb:undo takes that back, with the files.
      // Attempts are preserved on restart: a crash must not grant a fresh budget. A fresh set comes
      // only from answering an exhausted task via /pb:build guidance (see the build command below).
      tasks: syncTasks(spec, prev?.tasks).map((t) => (t.status === "done" ? t : { ...t, status: "todo" as const })),
      current: undefined,
      pause: undefined,
      nudged: undefined,
      needsIntro: prev?.needsIntro,
      detached: undefined,
      unattended: notes.length ? notes : undefined,
      updatedAt: now(),
    };
    const first = p.tasks.find((t) => t.status !== "done")?.id ?? (needsCohere(spec) && !prev?.tasks.some((t) => t.id === COHERE_TASK_ID && t.status === "done") ? COHERE_TASK_ID : undefined);
    if (!first) {
      ctx.ui.notify(`Every task of ${name} is done. Next: /${cmd("review")} ${name}.`, "info");
      return undefined;
    }
    // A restart keeps the gate its build started with; one from before the choice existed stays per-task.
    p.lintGate = restart ? prev!.lintGate : lintGateFor(ctx, store);
    return { p, first, restart };
  };

  /** The start-of-build undo point, in the session that builds. */

  const saveStartCheckpoint = (c: ExtensionContext, store: Store, name: string, p: Progress, checkpoints: boolean, restart: boolean) => {
    if (!checkpoints || (restart && store.checkpoints(name).length)) return;
    const snap = snapshot(c.cwd, `pb: start of ${name}`);
    const entry = tree(c).getLeafId?.() ?? undefined;
    const repos = snap ? repoSnapshots(c.cwd, store, name, `pb: start ${name}`) : [];
    store.saveCheckpoints(name, snap ? [{ id: "start", at: now(), ...snap, ...(repos.length ? { repos } : {}), head: p.baseCommit, tasks: structuredClone(p.tasks), entry, intro: true }] : []);
  };

  interface LaunchBuild {
    ctx: ExtensionContext;
    store: Store;
    name: string;
    spec: ParsedSpec;
    md: string;
    p: Progress;
    first: string;
    restart: boolean;
    buildModel: unknown;
    switching: boolean;
    session: string | undefined;
  }

  /** Same session: lift the planning protection, send the build instructions and the first task. */

  const launchBuildHere = async (o: LaunchBuild): Promise<void> => {
    const { ctx, store, name, spec, md, p, first, restart, buildModel, switching, session } = o;
    const { cfg, buildCmd } = commands(ctx.cwd, store);
    if (buildModel && switching) await pi.setModel(buildModel as Parameters<typeof pi.setModel>[0]);
    p.session = session;
    if (!(await liftPlanning(ctx, store))) return;
    // The approval is recorded only once the launch is certain: a failed lift leaves the spec as it was.
    const reapproved = approveSpec(store, p, md, spec);
    store.saveProgress(p);
    saveStartCheckpoint(ctx, store, name, p, cfg.checkpoints, restart);
    store.event(name, { type: "build-start", tasks: spec.tasks.length, gate: spec.gate, fresh: false, taskTexts: spec.tasks.map((t) => t.text) });
    // The session is the build's now: its name says so in /resume, as a fresh build session's does.
    pi.setSessionName(`build: ${name}`);
    if (reapproved) post(`**Spec re-approved** — ${name}'s contract changed since its build was approved; the build now runs against the revised spec. Tasks already done stay done.`);
    const cohereFirst = first === COHERE_TASK_ID;
    if (cohereFirst) beginCohereEntry(ctx, store, p);
    const task = cohereFirst ? null : beginTask(ctx, store, p, first, { intro: true });
    if (!task && !cohereFirst) return ctx.ui.notify(`${store.rel("specs", name, "spec.md")} no longer parses. Fix it (or /${cmd("spec")} ${name}), then /${cmd("build")}.`, "error");
    const marker = cohereFirst ? COHERE_MARKER : task!.marker;
    const prompt = cohereFirst ? coherePrompt(p.baseCommit, 1, cfg.maxAttempts, specRef(store, name)) : task!.prompt;
    instruct(
      `▶ Building **${name}** here${switching ? ` on ${cfg.buildModel}` : ""}.\n${marker}`,
      `${buildIntro(name, spec, buildCmd, cfg.taskChecks === "each", standardsFor(ctx), store.extra("build"))}\n\n${prompt}`,
    );
  };

  /** Fresh session: seeded with the spec, on the model and thinking level you planned with. */

  const launchBuildFresh = async (o: LaunchBuild): Promise<void> => {
    const { ctx, store, name, spec, md, p, first, restart, buildModel, session } = o;
    const { cfg, buildCmd } = commands(ctx.cwd, store);
    const cctx = ctx as ExtensionCommandContext;
    const carried = { model: buildModel ? cfg.buildModel : sessionModel(ctx), thinking: pi.getThinkingLevel() as string | undefined };
    store.setCarry({ ...carried, spec: name, parent: session ?? undefined });
    // A new session loads AGENTS.md itself: the standards needn't come along.
    const intro = buildIntro(name, spec, buildCmd, cfg.taskChecks === "each", "", store.extra("build"));
    const result = await cctx.newSession({
      parentSession: session,
      setup: async (sm) => {
        sm.appendSessionInfo(`build: ${name}`);
      },
      withSession: async (c) => {
        // Only `c` from here on: the captured pi and ctx belong to the replaced session.
        // The new session gets a fresh runtime with the default tools, so editing is on.
        p.session = c.sessionManager.getSessionFile();
        const reapproved = approveSpec(store, p, md, spec);
        store.saveProgress(p);
        saveStartCheckpoint(c, store, name, p, cfg.checkpoints, restart);
        if (!cfg.checkpoints) c.ui.notify("Checkpoints are off: this build runs without undo points, and without the test-tampering checks.", "warning");
        store.event(name, { type: "build-start", tasks: spec.tasks.length, gate: spec.gate, fresh: true, taskTexts: spec.tasks.map((t) => t.text) });
        if (reapproved)
          await c.sendMessage(
            { customType: "pb", content: `**Spec re-approved** — ${name}'s contract changed since its build was approved; the build now runs against the revised spec. Tasks already done stay done.`, display: true },
            { triggerTurn: false },
          );
        const cohereFirst = first === COHERE_TASK_ID;
        if (cohereFirst) beginCohereEntry(c, store, p);
        const task = cohereFirst ? null : beginTask(c, store, p, first, { intro: true });
        if (!task && !cohereFirst) {
          pauseBuild(c, store, p, `${store.rel("specs", name, "spec.md")} no longer parses; fix it, then /${cmd("build")}.`, "build.paused", "spec", {}, (content) =>
            c.sendMessage({ customType: "pb", content, display: true }, { triggerTurn: false }),
          );
          return;
        }
        const prompt = cohereFirst ? coherePrompt(p.baseCommit, 1, cfg.maxAttempts, specRef(store, name)) : task!.prompt;
        await c.sendMessage(
          {
            customType: "pb",
            content: `▶ Building **${name}** from ${store.rel("specs", name, "spec.md")}${carried.model ? `, on ${carried.model}` : ""}${carried.thinking ? `, thinking ${carried.thinking}` : ""}.\nThis session: "build: ${name}" · back to it with /resume, or \`pi --session ${c.sessionManager.getSessionId()}\`\n${cohereFirst ? COHERE_MARKER : task!.marker}`,
            display: true,
          },
          { triggerTurn: false },
        );
        // Not awaited: the build runs on in this session while the command returns.
        void c.sendMessage({ customType: "pb-instruction", content: `${intro}\n\n${prompt}`, display: false }, { triggerTurn: true });
      },
    }).catch((e) => {
      store.clearCarry(); // a throw must not leave the handover behind either
      throw e;
    });
    if (result.cancelled) {
      store.clearCarry(); // its handover must not leak into a later, unrelated new session
      if (!sessionGone(ctx)) ctx.ui.notify("Build cancelled.", "info");
    }
  };


  const specReviewCount = (store: Store, name: string) => readEvents(path.join(store.specDir(name), "events.jsonl")).filter((e) => e.type === "spec-review").length;

  /**
   * The P1s the spec review raised on the text about to be approved: known risks the build-start screen names,
   * never a gate. A recorded pass is reused silently at this door, so its P1s are posted again here; a text
   * already approved (a restart or resume) was decided before and counts none.
   */
  const openP1s = (store: Store, name: string, md: string, reused: boolean): number => {
    if (store.progress(name)?.approval?.hash === specHash(md)) return 0;
    const p1 = recordedFindings(store, name, md).filter(({ f }) => f.priority === "P1");
    if (p1.length && reused) post([`**The spec review of this text raised ${p1.length} P1 finding${p1.length === 1 ? "" : "s"}** — not blocking, but the build would carry ${p1.length === 1 ? "it" : "them"}:`, "", ...p1.map(({ id, f }) => `- ${findingLine(f, id)}`)].join("\n"));
    return p1.length;
  };

  const startBuild = async (
    ctx: ExtensionContext,
    store: Store,
    name: string,
    fresh: boolean,
    o: { decided?: boolean; checked?: boolean; notes?: string[] } = {},
  ): Promise<void> => {
    // An explicit build consumes the pending offer either way: a record that survived it would
    // keep agent_settled's stop-pause from firing for this session until the record expired.
    const here = ctx.sessionManager.getSessionFile();
    if (here) store.clearPendingBuild(here);
    const notes = o.notes ?? [];
    const checked = await preBuildChecks(ctx, store, name, o);
    if (!checked) return;
    const { spec, md, cfg } = checked;

    const reviewsBefore = specReviewCount(store, name);
    if ((await ensureSpecReviewed(ctx, store, name, md, reviewDoor(name, "build"))) !== "pass") return;
    const p1s = openP1s(store, name, md, specReviewCount(store, name) === reviewsBefore);
    const buildModel = cfg.buildModel ? findModel(ctx, cfg.buildModel) : undefined;
    const switching = !!buildModel && cfg.buildModel !== sessionModel(ctx);
    const canOpenSession = typeof (ctx as Partial<ExtensionCommandContext>).newSession === "function";
    // The build-start screen: everything that could make you hold the build (an unbuilt dependency, a red
    // baseline, the spec review's P1s, a full session or a model switch), shown once, with one choice.
    const usage = ctx.getContextUsage()?.percent;
    const placing = !fresh && !o.decided && ((usage != null && usage > cfg.freshAbove) || switching);
    const why = !placing ? "" : switching ? `building on ${cfg.buildModel} here sends this whole conversation to it again, uncached` : `this session is ${Math.round(usage!)}% full`;
    const concerns = [...checked.concerns, ...(p1s ? [`the spec review raised ${p1s} P1 finding${p1s === 1 ? "" : "s"} (shown above): the build would carry ${p1s === 1 ? "it" : "them"}`] : [])];
    if ((placing || concerns.length) && ctx.hasUI) {
      const FRESH = "Build in a fresh session, from the spec (recommended)";
      const HERE = "Build here anyway";
      const GO = "Build anyway";
      const REPAIR = `Repair first: /${cmd("spec-harden")} ${name} works through them`;
      const STOP = "Stop here";
      const build = placing ? (canOpenSession ? [FRESH, HERE] : [HERE, FRESH]) : [GO];
      const title = [`Build ${name}${why ? `: ${why}` : "?"}`, ...concerns.map((c) => `- ⚠ ${c}`)].join("\n");
      const choice = await choose(ctx, store, title, [...build, ...(p1s ? [REPAIR] : []), STOP], build[0], notes);
      if (!choice || choice === STOP) return;
      if (choice === REPAIR) {
        ctx.ui.setEditorText(`/${cmd("spec-harden")} ${name}`);
        return ctx.ui.notify(`Press Enter to repair ${name}; /${cmd("build")} ${name} afterwards reviews the repaired text.`, "info");
      }
      if (placing) fresh = choice === FRESH;
    } else if (!fresh && !o.decided && switching) fresh = true;
    if (!ctx.hasUI && p1s) notes.push(`built with ${p1s} P1 finding${p1s === 1 ? "" : "s"} from the spec review unaddressed (no one to ask)`);
    if (fresh && !canOpenSession) {
      ctx.ui.setEditorText(`/${cmd("build")} ${name} --fresh`);
      return ctx.ui.notify(`Press Enter to build ${name} in a fresh session.`, "info");
    }

    const session = ctx.sessionManager.getSessionFile();
    // The review covered the text it read, and the placement dialog can take a while: approve
    // only the text that was reviewed, so an edit in between starts a new review instead of
    // riding in on the old one. (The seconds between here and a fresh session's approval stay
    // uncovered; the dialog is the window a human edit actually needs.)
    const reviewed = store.readSpec(name);
    if (reviewed === undefined || specHash(reviewed) !== specHash(md)) {
      return ctx.ui.notify(`The spec changed while it was under review: run /${cmd("build")} again and the new text will be reviewed.`, "warning");
    }
    const init = initBuildProgress(ctx, store, name, spec, notes);
    if (!init) {
      // Nothing left to build: /pb:build still re-approves a revised contract, so the review
      // that follows judges the code against the spec as it stands.
      const prev = store.progress(name);
      if (prev) {
        const reapproved = approveSpec(store, prev, md, spec);
        store.saveProgress({ ...prev, updatedAt: now() });
        if (reapproved)
          post(`**Spec re-approved** — ${name}'s contract changed since its build was approved; nothing is left to build, and the review now judges the code against the spec as it stands.`);
      }
      return;
    }
    const launch = { ctx, store, name, spec, md, p: init.p, first: init.first, restart: init.restart, buildModel, switching, session };
    if (!fresh) return launchBuildHere(launch);
    return launchBuildFresh(launch);
  };

  /** The spec that was just written: its tasks in the session, the whole of it as a view (not sent to the model: it wrote it). */

  const baselineApplies = (ctx: ExtensionContext, store: Store, testCmd: string | null | undefined) => {
    const b = store.baseline(ctx.sessionManager.getSessionFile() ?? undefined);
    // A red baseline blocks the build only when it describes this commit; a newer HEAD may already have fixed it.
    // No head (outside git): nothing to compare against, so block conservatively.
    return b?.ok === false && b.command === testCmd && (!b.head || b.head === gitHead(ctx.cwd));
  };

  const baselineQuestion = (b: { summary: string; at: string }) =>
    `The test suite already failed when planning began (${b.summary.split("\n")[0]}, ${b.at}): the final check runs it, so it fails too unless that's fixed. Build anyway?`;

  /**
   * Lint/project checks red at baseline warn only, never block: the baseline alone must not stop
   * a build — only an actual final-gate failure sends the agent back. Same-commit only, like the suite.
   */

  /**
   * Where lint gates a build that starts now. A lint you configured gates every step. An auto-detected
   * one does only when the planning baseline ran it clean on this commit: otherwise warnings already in
   * the code would fail the first task for debt it did not create, so it gates the final check alone.
   */
  const lintGateFor = (ctx: ExtensionContext, store: Store): "task" | "final" | undefined => {
    const { cfg, testCmd, lintCmd } = commands(ctx.cwd, store);
    if (!lintCmd) return undefined;
    if (cfg.lint !== "auto") return "task";
    const b = store.baseline(ctx.sessionManager.getSessionFile() ?? undefined);
    const current = !!b && b.command === testCmd && (!b.head || b.head === gitHead(ctx.cwd));
    if (current && b.lint?.command === lintCmd && b.lint.ok === true) return "task";
    ctx.ui.notify(
      `Lint \`${lintCmd}\` gates only the final check of this build: ${current && b.lint?.command === lintCmd ? "it already failed when planning began" : "no planning baseline ran it on this commit"}, so it can't tell this build's findings from the code's. Set "lint" in .pi/pb/config.json to gate every task.`,
      "info",
    );
    return "final";
  };

  const baselineExtraWarning = (ctx: ExtensionContext, store: Store, testCmd: string | null | undefined) => {
    const b = store.baseline(ctx.sessionManager.getSessionFile() ?? undefined);
    if (!b || b.command !== testCmd || (b.head && b.head !== gitHead(ctx.cwd))) return;
    const red = [...(b.lint && b.lint.ok === false ? [`lint \`${b.lint.command}\` (${b.lint.summary.split("\n")[0]})`] : []), ...(b.extra ?? []).filter((e) => e.ok === false).map((e) => `\`${e.command}\` (${e.summary.split("\n")[0]})`)];
    if (red.length) ctx.ui.notify(`Lint/project checks already failed when planning began (${red.join("; ")}): the final gate runs them too, so it fails until that's fixed.`, "warning");
  };

  /** The specs this session has written, ready to build, first those nothing else among them depends on. */

  /**
   * The reply's last block is a contract ("End your reply with this block, verbatim"), so the
   * stop-instruction goes before it, never after — a prompt must not end by contradicting itself.
   */

  const withStopBeforeTip = (prompt: string, stop: string): string => {
    const key = tip("spec.next");
    const at = key ? prompt.lastIndexOf(key) : -1;
    return at > 0 ? `${prompt.slice(0, at)}${stop}\n\n${prompt.slice(at)}` : `${prompt}\n\n${stop}`;
  };

  const specThenBuild = async (ctx: ExtensionCommandContext, store: Store, marker: string, prompt: string) => {
    const session = ctx.sessionManager.getSessionFile();
    const { cfg, testCmd } = commands(ctx.cwd, store);
    const notes: string[] = [];
    if (!(await reviewPlanningChanges(ctx, store, notes))) return;
    const baseline = store.baseline(session ?? undefined);
    if (baselineApplies(ctx, store, testCmd) && !(await agree(ctx, store, baselineQuestion(baseline!), notes))) return;

    const usage = ctx.getContextUsage()?.percent;
    const switching = !!cfg.buildModel && cfg.buildModel !== sessionModel(ctx) && !!findModel(ctx, cfg.buildModel);
    const preferFresh = switching || (usage != null && usage > cfg.freshAbove);
    const HERE = "Build here as soon as the spec is written (keeps our discussion; the cache stays warm)";
    const FRESH = `Build in a fresh session as soon as the spec is written (${switching ? `on ${cfg.buildModel}, ` : ""}lean context)`;
    const SHOW = "Show me the spec first";
    const options = preferFresh ? [FRESH, HERE, SHOW] : [HERE, FRESH, SHOW];
    const choice = await choose(ctx, store, "Pi writes the spec first. Then?", options, options[0], notes);
    if (!choice) return;
    if (choice === SHOW) {
      if (session) specStarted.set(session, Date.now());
      store.setPendingBuild(session);
      return instruct(marker, withStopBeforeTip(prompt, "After writing it, stop: the harness shows it to me and asks whether to build."));
    }

    const since = now();
    if (session) specWriting.add(session);
    if (session) specStarted.set(session, Date.now());
    instruct(marker, withStopBeforeTip(prompt, "After writing it, stop: the build starts by itself."));
    // Wait for the spec here, in the command: the run starts right after this handler hands it over.
    // Capped: on timeout the pending offer below picks the spec up once it is written.
    // The human may move on while waiting: a dead session ends the wait quietly (nothing is
    // consumed, so a later /pb:build still offers the spec).
    try {
      for (let i = 0; i < 40 && ctx.isIdle(); i++) await new Promise((r) => setTimeout(r, 50));
      if (cfg.specWaitSec > 0) await Promise.race([ctx.waitForIdle(), sleep(cfg.specWaitSec * 1000)]);
      else await ctx.waitForIdle();
    } catch (e) {
      if (!sessionGone(ctx)) throw e;
    } finally {
      if (session) specWriting.delete(session);
    }
    if (sessionGone(ctx)) return;
    const ready = readySpecs(store, session, since);
    if (!ready.length) {
      // A question in chat, or the spec isn't ready yet: pb offers the build once it is.
      store.setPendingBuild(session);
      const finished = store.specNames().filter((n) => {
        const p = store.progress(n);
        return !!p && p.writtenIn === session && ["built", "reviewed"].includes(p.phase ?? "");
      });
      const hint = finished.length
        ? ` Note: ${finished.map((n) => `\`${n}\` is already ${store.progress(n)?.phase}`).join("; ")} — to change it again, write a new spec: rewriting a finished spec keeps its done state.`
        : "";
      return post(`No spec ready to build yet. Answer Pi's questions; once the spec is written, pb shows it and asks how to build.${hint}`);
    }
    const dry = await dryRunTests(ctx, store, ready[0]);
    if (sessionGone(ctx)) return; // replaced during the dry run: a later /pb:build still offers the spec
    showSpec(store, ready[0], {
      names: ready,
      next: choice === FRESH ? "the build starts in a fresh session; one fresh reviewer checks the spec before T1." : "the build starts here; one fresh reviewer checks the spec before T1.",
      extra: dry,
    });
    await startBuild(ctx, store, ready[0], choice === FRESH, { decided: true, checked: true, notes });
  };

  /** After /pb:build asked for the spec: once it's written, show it and ask how to go on. */

  const recordGuidance = (store: Store, name: string, text: string): boolean => {
    if (!text.trim()) return true;
    return !appendDecision(store, name, text.trim(), "guidance");
  };

  /** "3h ago" style staleness for a progress updatedAt ("2026-10-01 10:00:00", UTC like Store.now()). */

  const offerPendingBuild = async (ctx: ExtensionContext): Promise<boolean> => {
    const store = new Store(ctx.cwd);
    const session = ctx.sessionManager.getSessionFile();
    if (!store.pendingBuild(session)) return false;
        const names = readySpecs(store, session);
    if (!names.length) return true; // still talking (e.g. a question before writing): keep waiting
    if (session) store.clearPendingBuild(session);
    const name = names[0];
    const loaded = loadSpec(store, name);
    if (!loaded) return true;
    const { spec } = loaded;
    const dry = await dryRunTests(ctx, store, name);
    if (sessionGone(ctx)) {
      // Replaced during the dry run: offer again on a later turn instead of dying mid-offer.
      if (session) store.setPendingBuild(session);
      return true;
    }
    showSpec(store, name, {
      names,
      next: ctx.hasUI ? "choose how to build: here or in a fresh session — or edit the spec first." : `\`/${cmd("build")} ${name}\` builds it here.`,
      extra: dry,
    });
    if (!ctx.hasUI) {
      post(tip("spec.next"));
      return true;
    }
    const cfg = store.config();
    const usage = ctx.getContextUsage()?.percent;
    const switching = !!cfg.buildModel && cfg.buildModel !== sessionModel(ctx) && !!findModel(ctx, cfg.buildModel);
    const preferFresh = switching || (usage != null && usage > cfg.freshAbove);
    const HERE = "Build here (keeps our discussion; the cache stays warm)";
    const FRESH = `Build in a fresh session, from the spec (${switching ? `on ${cfg.buildModel}, ` : ""}lean context)`;
    const EDIT = "Edit the spec first";
    const LATER = "Not now";
    const notes: string[] = [];
    for (;;) {
      // Unanswered, it builds here: a fresh session can't be opened from here, only from a command.
      const choice = await choose(ctx, store, `Build ${name} now? ${spec.tasks.length} tasks`, preferFresh ? [FRESH, HERE, EDIT, LATER] : [HERE, FRESH, EDIT, LATER], HERE, notes);
      if (sessionGone(ctx)) {
        // Replaced while deciding: offer again on a later turn instead of dying mid-offer.
        if (session) store.setPendingBuild(session);
        return true;
      }
      if (choice === EDIT) {
        await editSpec(ctx, store, name);
        continue;
      }
      if (choice === HERE) await startBuild(ctx, store, name, false, { decided: true, notes });
      else if (choice === FRESH) await startBuild(ctx, store, name, true, { decided: true, notes });
      else post(tip("spec.next"));
      return true;
    }
  };

  /**
   * Leave planning mode for a build (or for good): show files bash wrote while planning,
   * then clear the planning state and its widget. False = the human cancelled.
   */

  pi.on("agent_settled", async (_e, ctx) => {
    if (await offerPendingBuild(ctx)) return;
    // A repair lap's next step is driveRepair's, in the command that started the run — except when a build
    // took the plan meanwhile: then the lap is dropped here and the build settles as a build does.
    const fixStore = new Store(ctx.cwd);
    const owned = fixStore.fixOfSession(ctx.sessionManager.getSessionFile());
    if (owned?.p.fix) {
      if (!unfinishedPhase(owned.p.phase)) return;
      await advanceSpecFix(ctx, fixStore, owned.name, owned.p);
    }
    const { store, progress: p } = specOfSession(ctx);
    if (p?.phase === "building") pauseBuild(ctx, store, p, "the agent stopped without finishing its task (you stopped it, or it stopped again after a reminder).", "build.paused", "stopped");
    // bash can write where edit and write are blocked: say what changed as soon as the turn ends,
    // not only when planning stops, so a stray write is caught while its cause is still fresh.
    const session = ctx.sessionManager.getSessionFile();
    const snapshotAtStart = session && store.planningSessions().includes(session) ? store.planning(session)?.snapshot : undefined;
    if (!session || !snapshotAtStart) return;
    const current = snapshot(ctx.cwd, "pb: planning turn");
    const files = current ? changedPaths(ctx.cwd, snapshotAtStart, current.commit) : [];
    const key = [...files].sort().join("\n");
    if (files.length && planningWriteNotes.get(session) !== key) {
      planningWriteNotes.set(session, key);
      const list = `${files.slice(0, 10).join(", ")}${files.length > 10 ? ` … (+${files.length - 10})` : ""}`;
      post(`**Changed while planning** — these project files differ from when planning began: ${list}\n\nCommands may write where edits are blocked. Nothing is lost: \`/${cmd("plan")} off\` or the build start offers to keep or restore them.`);
    } else if (!files.length) planningWriteNotes.delete(session);
  });

  /**
   * What the resume confirm shows the human: every block the contract binds — everything but
   * Design and Decisions, which the build itself may change — as it was approved and as it
   * stands now, each side capped so the dialog stays readable.
   */

  const contractDiff = (store: Store, name: string, md: string): string => {
    const approved = store.readApprovedSpec(name);
    if (approved === undefined) return `No approved copy on file: the build would run against ${store.rel("specs", name, "spec.md")} as it stands now.`;
    const label = (key: string) => (key === "header" ? "the header (Status, Depends on)" : `## ${key.replace(/^section:/, "")}`);
    const was = new Map(specTextBlocks(approved).map((b) => [b.key, b.text]));
    const changed = specTextBlocks(md).filter((b) => b.key !== "section:design" && b.key !== "section:decisions" && was.get(b.key) !== b.text);
    const body = changed
      .map((b) => [label(b.key), "--- approved ---", cap(was.get(b.key) ?? "(absent)", 700), "--- now ---", cap(b.text, 700)].join("\n"))
      .join("\n\n");
    return `${changed.map((b) => label(b.key)).join(", ")}\n\n${body}`;
  };

  pi.registerCommand(cmd("build"), {
    description: "Build the planned feature here, task by task (the full check runs after the last task; writes the spec first if there isn't one). --fresh builds in a new session. In a paused build: continue, optionally with guidance",
    getArgumentCompletions: (prefix: string) => [{ value: "--fresh", label: "--fresh" }, ...specCompletions(prefix)].filter((c) => c.value.startsWith(prefix)),
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) return ctx.ui.notify("Pi is busy. Wait for the current turn to finish.", "warning");
      const store = new Store(ctx.cwd);
      const fresh = /(^|\s)--fresh(\s|$)/.test(args);
      const words = args.replace(/(^|\s)--fresh(?=\s|$)/g, " ").trim().split(/\s+/).filter(Boolean);
      const session = ctx.sessionManager.getSessionFile();
      const { cfg, buildCmd } = commands(ctx.cwd, store);

      // The name is the only user string that reaches path.join, and store.specDir refuses anything
      // that isn't a valid spec name (or a folder already under specs/). Here the arg counts as a
      // name only when valid; a path-like or legacy-named arg is refused, not read or reinterpreted.
      if (words[0] && !KEBAB_NAME.test(words[0])) {
        const near = normSpecArg(words[0]);
        const hit = near !== "off" && KEBAB_NAME.test(near) ? store.specNames().filter((n) => n === near) : [];
        if (hit.length === 1 && store.readSpec(hit[0])) {
          return ctx.ui.notify(
            `\`${words[0]}\` isn't a spec name (spec names are lowercase with hyphens). Did you mean \`${hit[0]}\`? \`/${cmd("build")} ${hit[0]}\` continues it; to start something else, describe it without a leading name.`,
            "warning",
          );
        }
        if (/[/\\]/.test(words[0]) || store.readSpec(words[0])) {
          return ctx.ui.notify(`\`${words[0]}\` isn't a valid spec name (spec names are lowercase with hyphens). To build, name a spec exactly as written.`, "warning");
        }
      }

      // This session has an unfinished build: continue it — unless a different spec was named.
      const here = specOfSession(ctx);
      const named = words[0] && KEBAB_NAME.test(words[0]) && store.readSpec(words[0]) ? words[0] : undefined;
      if (here.name && here.progress && unfinishedPhase(here.progress.phase) && (!named || named === here.name)) {
        const p = here.progress;
        if (fresh) ctx.ui.notify("`--fresh` only applies when starting a build: continuing here instead.", "warning");
        // Resuming lifts planning protection: a /pb:plan or /pb:deps after the pause turned it back on.
        if (!(await liftPlanning(ctx, store))) return;
        // The spec name itself isn't guidance: only what follows it is.
        const guidance = (named ? words.slice(1) : words).join(" ");
        if (guidance && !recordGuidance(store, p.spec, guidance)) {
          ctx.ui.notify("Guidance not recorded: it would leave the spec unparseable.", "warning");
        }
        const from = guidance ? `\n\nFrom the human: ${guidance}` : "";
        // A resume approves the spec as it stands — but only a revision the human has seen. The
        // model gets turns while paused too, so "a contract edited while paused is the human's
        // revision" was an assumption: show what changed and ask, instead of inheriting it.
        const live = loadSpec(store, p.spec);
        if (!live) return ctx.ui.notify(`${store.rel("specs", p.spec, "spec.md")} doesn't parse. Fix it (or /${cmd("spec")} ${p.spec}), then /${cmd("build")}.`, "error");
        if (p.approval && contractHash(live.md) !== p.approval.contractHash && ctx.hasUI) {
          if (!(await ctx.ui.confirm(`${p.spec}'s contract changed while the build was paused`, contractDiff(store, p.spec, live.md)))) {
            return ctx.ui.notify("Not re-approved: the build stays paused. Edit the spec (or /" + cmd("spec") + ` ${p.spec}), then /${cmd("build")} again.`, "warning");
          }
        }
        const reapproved = approveSpec(store, p, live.md, live.spec);
        store.saveProgress(p);
        if (reapproved) post(`**Spec re-approved** — ${p.spec}'s contract changed while the build was paused; it now runs against the revised spec. Tasks already done stay done.`);
        if (p.current === "final") {
          const fin = p.tasks.find((t) => t.id === "final");
          resetExhausted(fin, cfg.maxAttempts);
          const attempt = (fin?.attempts ?? 0) + 1;
          if (fin) fin.attempts = attempt;
          enterStep(p, "final");
          store.saveProgress(p);
          showProgress(ctx, p);
          const finalFiles = changedFilesSection(store, p);
          return instruct("▶ final check", fixText("final", `\`${p.lastVerify?.command ?? "the full suite"}\``, p.lastVerify?.summary ?? "", attempt, cfg.maxAttempts, false, specRef(store, p.spec)) + (finalFiles ? `\n${finalFiles}` : "") + from);
        }
        if (p.current === COHERE_TASK_ID) {
          const cc = p.tasks.find((t) => t.id === COHERE_TASK_ID);
          if (!cc) {
            beginCohereEntry(ctx, store, p);
            return instruct(COHERE_MARKER, `${coherePrompt(p.baseCommit, 1, cfg.maxAttempts, specRef(store, p.spec))}${from}`);
          }
          resetExhausted(cc, cfg.maxAttempts);
          const attempt = cc.attempts + 1;
          cc.attempts = attempt;
          enterStep(p, COHERE_TASK_ID);
          store.saveProgress(p);
          showProgress(ctx, p);
          return instruct("▶ coherence pass", `${coherePrompt(p.baseCommit, attempt, cfg.maxAttempts, specRef(store, p.spec))}${from}`);
        }
        // p.current can name a task the list no longer has: a spec rewrite or human edit renamed
        // it. Only a live, undone task keeps its claim; anything else resumes at the next todo,
        // so a stale id reads as "continue", not as "nothing left to build".
        const claimed = p.current !== undefined && p.tasks.some((t) => t.id === p.current && t.status !== "done");
        const cur = claimed ? p.current : nextTodo(p)?.id;
        const tp = p.tasks.find((t) => t.id === cur);
        const loaded = live;
        // Undone past the coherence pass (or a restart that dropped it): all spec tasks done, pass pending.
        if ((!cur || !tp) && needsCohere(loaded.spec) && !p.tasks.some((t) => t.id === COHERE_TASK_ID)) {
          beginCohereEntry(ctx, store, p);
          return instruct(COHERE_MARKER, `${coherePrompt(p.baseCommit, 1, cfg.maxAttempts, specRef(store, p.spec))}${from}`);
        }
        if (!cur || !tp) return ctx.ui.notify("Nothing left to build here.", "info");
        // Your answer to a task that kept failing buys it a fresh set of attempts; other pauses cost none.
        const exhausted = resetExhausted(tp, cfg.maxAttempts);
        const again = exhausted || tp.status === "todo";
        const intro = !!p.needsIntro;
        p.needsIntro = undefined;
        const t = beginTask(ctx, store, p, cur, { countAttempt: again, intro });
        if (!t) return ctx.ui.notify(`${store.rel("specs", p.spec, "spec.md")} doesn't parse. Fix it (or /${cmd("spec")} ${p.spec}), then /${cmd("build")}.`, "error");
        const body = intro
          ? `${buildIntro(p.spec, loaded.spec, buildCmd, cfg.taskChecks === "each", standardsFor(ctx), store.extra("build"))}\n\n${t.prompt}`
          : again
            ? t.prompt
            : continuePrompt(t.task);
        return instruct(t.marker, body + from);
      }

      // Building without a /pb:plan first: the standards are offered here instead.
      await offerStandards(ctx, store);

      // Which spec: a named one; else the ones this session wrote; else any ready one.
      const phaseOf = (n: string) => store.progress(n)?.phase ?? "written";
      const offered = store.specNames().filter((n) => phaseOf(n) === "written" || unfinishedPhase(phaseOf(n)));
      let name = words[0] && KEBAB_NAME.test(words[0]) && store.readSpec(words[0]) ? words[0] : undefined;
      if (!name) {
        const mine = offered.filter((n) => store.progress(n)?.writtenIn === session);
        const planning = !!session && store.planningSessions().includes(session);
        if (!mine.length && (planning || !offered.length)) {
          // No spec from this discussion yet: write it first, then build it.
          return specThenBuild(ctx, store, `▶ /${cmd("build")} — writing the spec first`, specPrompt(words.join(" "), store.specNames(), undefined, store.extra("spec"), session ? store.planning(session)?.answers : undefined));
        }
        const pool = mine.length ? mine : offered;
        const labelOf = (n: string) => {
          const bits: string[] = [];
          const owner = store.progress(n)?.session ?? store.progress(n)?.writtenIn;
          if (owner && owner !== session) bits.push("from another session");
          if (unfinishedPhase(phaseOf(n))) bits.push("restart the build, finished tasks stay done");
          return bits.length ? `${n} (${bits.join("; ")})` : n;
        };
        if (pool.length === 1 || !ctx.hasUI) name = pool[0];
        else {
          const labels = pool.map(labelOf);
          const choice = await ctx.ui.select("Build which spec?", labels);
          name = choice ? pool[labels.indexOf(choice)] : undefined;
        }
        if (!name) return;
      }
      if (!(await confirmLiveBuild(ctx, store, name, ["building"], "Restart it here — finished tasks stay done?"))) return;
      if (loadSpec(store, name)?.spec.status === "planning") {
        // A checkpoint of an unfinished discussion: finish it (tasks, verification), then build it.
        return specThenBuild(ctx, store, `▶ /${cmd("build")} — finishing the spec ${name} first`, finishSpecPrompt(name, store.extra("spec"), session ? store.planning(session)?.answers : undefined).replace(/\s*After writing it, stop:[^\n]*/, ""));
      }
      if (words[0] === name && words.length > 1) {
        // Trailing words with a named spec are guidance (as on resume); without a name
        // they are the new spec's topic, not guidance.
        if (!recordGuidance(store, name, words.slice(1).join(" "))) {
          ctx.ui.notify("Guidance not recorded: it would leave the spec unparseable.", "warning");
        }
      }
      await startBuild(ctx, store, name, fresh);
    },
  });

  /* -------------------------------- review ------------------------------- */
}
