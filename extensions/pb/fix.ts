/** The fixes: /pb:fix, pb_fix_done, and the fix-lap loop. */
import * as path from "node:path";
import { Type } from "./schema.ts";
import type {
  ExtensionAPI,
  ExtensionCommandContext
} from "@earendil-works/pi-coding-agent";
import { fixSeedPrompt, reportRegister, specReference } from "./prompts.ts";
import { duration } from "./format.ts";
import { KEBAB_NAME } from "./names.ts";
import { type Finding, Store, readEvents } from "./store.ts";
import { cmd, evidenceLine, loadSpec, nextLine, phaseHeader, reply, specOfSession, approvalDrift } from "./kit.ts";

/** One lap's report shape, normalized from its `fix` event. */
export interface LapReport {
  fixed: string[];
  skipped: string[];
  tests: string;
}

/**
 * The report a fix lap owns: the last `fix` event appended after `from`, the event-log position
 * right after the lap's own fix-start marker. Event order, not clock time — `at` strings truncate
 * to seconds, so a prior lap's report in the same second must not read as this lap's.
 */
export function lapReport(events: readonly Record<string, unknown>[], from: number): LapReport | undefined {
  const last = events
    .slice(from)
    .filter((e) => (e as { type?: unknown }).type === "fix")
    .at(-1) as { fixed?: unknown; skipped?: unknown; tests?: unknown } | undefined;
  if (!last || !Array.isArray(last.fixed)) return undefined;
  return {
    fixed: last.fixed.filter((x): x is string => typeof x === "string"),
    skipped: Array.isArray(last.skipped) ? last.skipped.filter((x): x is string => typeof x === "string") : [],
    tests: typeof last.tests === "string" ? last.tests : "",
  };
}

export function registerFix(pi: ExtensionAPI) {
  pi.registerTool({
    name: "pb_fix_done",
    label: "Fixes done",
    description:
      "In a pb fixes session (opened by /pb:fix): report which review findings this lap fixed and which need a design decision (spec revision) instead of an edit, with the test results. Name each by the number it was shown as in the brief. Then stop: the home session runs the approved path after the fix — /pb:build to re-approve a revised contract, otherwise /pb:review to check the delta. " + reportRegister,
    parameters: Type.Object({
      fixed: Type.Array(Type.Number(), { description: "the numbers of the findings this lap fixed, as shown in the brief (e.g. 1, 3)" }),
      skipped: Type.Array(Type.Number(), { description: "the numbers of findings that need a design decision (spec revision), not an edit, as shown in the brief" }),
      tests: Type.String({ description: "test commands run and what each showed" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const store = new Store(ctx.cwd);
      const session = ctx.sessionManager.getSessionFile();
      const rec = store.fixSession(session);
      if (!session || !rec) throw new Error("This is not a pb fixes session. Fix review findings only inside the session /pb:fix opened — carry on there, or run /pb:fix for a new one.");
      const picked = (numbers: number[]): Finding[] => {
        const out: Finding[] = [];
        for (const n of numbers) {
          const f = Number.isInteger(n) && n >= 1 && n <= rec.findings.length ? rec.findings[n - 1] : undefined;
          if (!f) throw new Error(`${n} is not one of the findings shown for this lap: the brief numbers them 1–${rec.findings.length}. Report the number it was shown as.`);
          if (!out.includes(f)) out.push(f);
        }
        return out;
      };
      const fixed = picked(params.fixed);
      const skipped = picked(params.skipped);
      const both = fixed.filter((f) => skipped.includes(f));
      if (both.length) throw new Error(`A finding cannot be both fixed and skipped: ${both.map((f) => f.title).join("; ")}. Pick one.`);
      if (!fixed.length && !skipped.length) throw new Error("Report at least one finding by its number in fixed or skipped, with the test results.");
      store.event(rec.spec, { type: "fix", fixed: fixed.map((f) => f.title), skipped: skipped.map((f) => f.title), tests: params.tests });
      store.clearFixSession(session);
      const cur = store.progress(rec.spec);
      const drift = cur ? approvalDrift(store, cur) : undefined;
      const nextStep = drift
        ? `the fix changed the approved contract, so run \`/${cmd("build")} ${rec.spec}\` to re-approve it, then \`/${cmd("review")}\`.`
        : `run \`/${cmd("review")}\` back home to check the delta.`;
      return reply(`Recorded fix report for \`${rec.spec}\`: fixed ${fixed.length}, skipped ${skipped.length}. Reply briefly, then stop: ${nextStep}`);
    },
  });

  /* --------------------------------- plan -------------------------------- */
  /** Run the test suite in the background; its result is posted into the session when it's done. Returns whether it started (a second plan in the same session shares the one in flight). */

  const FIX_LAPS = 3;
  /** Finish-nudges before a silent lap stops the loop (never retried: a second silent session doubles nothing). */

  const FIX_NUDGES = 2;

  /**
   * One fixes lap: open a fenced session seeded with the remaining findings and wait for its
   * pb_fix_done report. Returns the live lap session for chaining (like reviewNext: a session
   * that opened a new one is stale afterwards) plus the report — or no report when the lap
   * went silent (nudges unanswered) or its session never opened.
   */

  const runFixLap = async (
    ctx: ExtensionCommandContext,
    store: Store,
    spec: string,
    remaining: Finding[],
  ): Promise<{ live: ExtensionCommandContext; report?: { fixed: string[]; skipped: string[]; tests: string }; ms: number } | undefined> => {
    const started = Date.now();
    const seed = fixSeedPrompt(spec, remaining, loadSpec(store, spec) ? specReference(spec) : "");
    let live: ExtensionCommandContext | undefined;
    // The lap owns only events appended after its own fix-start marker; `from` is the log
    // position captured right after that marker is written.
    let from = 0;
    const result = await ctx.newSession({
      parentSession: ctx.sessionManager.getSessionFile() ?? undefined,
      setup: async (sm) => {
        sm.appendSessionInfo(`fix: ${spec}`);
      },
      withSession: async (c) => {
        const cc = c as ExtensionCommandContext;
        live = cc;
        const lapFile = cc.sessionManager.getSessionFile() ?? undefined;
        if (lapFile) store.saveFixSession(lapFile, { spec, findings: remaining });
        store.event(spec, { type: "fix-start", findings: remaining.map((f) => f.title) });
        from = readEvents(path.join(store.specDir(spec), "events.jsonl")).length;
        await c.sendMessage({ customType: "pb-fix", content: seed, display: true }, { triggerTurn: true });
        for (let nudge = 0; nudge < FIX_NUDGES; nudge++) {
          await cc.waitForIdle();
          if (!lapFile || !store.fixSession(lapFile)) return; // reported
          await c.sendMessage({ customType: "pb-fix", content: "Finish with pb_fix_done now: report fixed ids, skipped ids and test results, then stop.", display: false }, { triggerTurn: true });
        }
        await cc.waitForIdle();
      },
    }).catch(() => ({ cancelled: true as const }));
    if (result.cancelled || !live) return undefined;
    const report = lapReport(readEvents(path.join(store.specDir(spec), "events.jsonl")), from);
    if (!report) return { live, ms: Date.now() - started };
    return { live, ms: Date.now() - started, report };
  };

  /**
   * Unattended fix loop: lap until every finding is fixed or skipped-as-spec-revision, up to FIX_LAPS, then
   * come home with the outcome. The human runs /pb:review next: a lap's report says what it claims to have
   * done, so the summary hands the checking over instead of doing it. The report names findings by the
   * numbers the brief shows, so no prose has to be matched back to one.
   */

  const driveFix = async (ctx: ExtensionCommandContext, store: Store, spec: string, first: Finding[], allOpen: Finding[]): Promise<void> => {
    const home = ctx.sessionManager.getSessionFile() ?? undefined;
    const numberOf = new Map(allOpen.map((f, i) => [f, i + 1] as const));
    const label = (f: Finding) => `#${numberOf.get(f) ?? "?"} ${f.title}`;
    let live: ExtensionCommandContext = ctx;
    let remaining = first;
    const fixed: string[] = [];
    const skipped: string[] = [];
    let laps = 0;
    let ms = 0;
    let silent = false;
    while (remaining.length && laps < FIX_LAPS) {
      laps++;
      const out = await runFixLap(live, store, spec, remaining);
      if (!out) return; // its session never opened (cancelled): user is present, nothing to say
      live = out.live;
      ms += out.ms;
      const report = out.report;
      if (!report) {
        silent = true;
        break;
      }
      const skip = remaining.filter((f) => report.skipped.includes(f.title));
      const done = remaining.filter((f) => !skip.includes(f) && report.fixed.includes(f.title));
      fixed.push(...done.map(label));
      skipped.push(...skip.map(label));
      const resolved = new Set([...done, ...skip].map((f) => f.title));
      remaining = remaining.filter((f) => !resolved.has(f.title));
    }
    const open = remaining.map(label);
    const ids = remaining.flatMap((f) => (numberOf.has(f) ? [numberOf.get(f)!] : [])).join(" ");
    // Cap the lists: a long title per finding makes the evidence line a wall, and /pb:status has the detail.
    const list = (items: string[]) => (items.length <= 6 ? items.join(", ") : `${items.slice(0, 6).join(", ")}, +${items.length - 6} more`);
    // The fix may have revised the approved contract. Review judges the code against that
    // contract, so it cannot run until `/pb:build` has re-approved whatever stands now.
    const drift = (() => {
      const p = store.progress(spec);
      return p ? approvalDrift(store, p) : undefined;
    })();
    const reviewStep = drift
      ? `\`/${cmd("build")} ${spec}\` re-approves the ${drift === "missing" ? "spec as it stands (its approved copy is missing or changed)" : "revised contract (the fix changed it)"}, then \`/${cmd("review")}\` can check the delta.`
      : `\`/${cmd("review")}\` checks the delta.`;
    const next = open.length
      ? `\`/${cmd("fix")}${ids ? ` ${ids}` : ""}\` (or fix them by hand), then ${reviewStep}`
      : skipped.length
        ? `revise the spec with \`/${cmd("spec")}\` for the skipped findings (or fix them by hand), then ${reviewStep}`
        : reviewStep;
    const time = ms ? duration(ms) : "";
    const header = silent
      ? phaseHeader("❌", "Fixes stopped", spec, "no report", time)
      : phaseHeader(open.length ? "❌" : "✅", open.length ? "Fixes stopped" : "Fixes complete", spec, `${laps} lap${laps === 1 ? "" : "s"}`, time);
    const summary = [
      header,
      "",
      nextLine(next),
      evidenceLine(`fixed ${list(fixed) || "none"}`, skipped.length ? `skipped as needing a spec revision: ${list(skipped)}` : "", open.length ? `still open: ${list(open)}` : "", silent ? `no report after ${FIX_NUDGES} nudges` : ""),
      ...(drift ? ["", `**The fix changed the approved contract.** \`/${cmd("build")} ${spec}\` must re-approve it before \`/${cmd("review")}\` can run.`] : []),
      "",
      drift
        ? `A fix lap's report is its own claim; the revised contract must be re-approved before \`/${cmd("review")}\` checks the files it changed.`
        : `A fix lap's report is its own claim; \`/${cmd("review")}\` checks the files it changed.`,
    ].join("\n");
    try {
      if (!home) throw new Error("no home session");
      await live.switchSession(home, {
        withSession: async (c) => {
          await c.sendMessage({ customType: "pb", content: summary, display: true }, { triggerTurn: false });
        },
      });
    } catch {
      // Home is gone: the summary still lands in the spec's events for the next session to find.
      store.event(spec, { type: "fix-summary", summary, ms });
    }
  };

  pi.registerCommand(cmd("fix"), {
    description: "Fix P0-P2 review findings in a fresh fenced session: /pb:fix [finding ids]. No ids = all open findings (P3 nits are never open: fix those by hand). Run /pb:review afterwards: it checks only those findings and what changed",
    handler: async (args, ctx) => {
      const store = new Store(ctx.cwd);
      const session = ctx.sessionManager.getSessionFile();
      const words = args.trim().split(/\s+/).filter(Boolean);
      // Spec: named, else this session's. Findings: all open, else the named ones.
      let name = words[0] && KEBAB_NAME.test(words[0]) && store.readSpec(words[0]) ? words[0] : undefined;
      const ids = name ? words.slice(1) : words;
      if (!name) name = specOfSession(ctx).name;
      if (!name && session) {
        // A planning session that wrote the spec but never built it: its writtenIn names it.
        const mine = store.specNames().filter((n) => store.progress(n)?.writtenIn === session);
        if (mine.length === 1) name = mine[0];
        else if (mine.length > 1) return ctx.ui.notify(`Several specs here (${mine.join(", ")}): name one: \`/${cmd("fix")} <spec> [ids].`, "warning");
      }
      if (!name) return ctx.ui.notify(`No spec here: run /${cmd("fix")} from a build or review session, or name a spec.`, "warning");
      const open = store.progress(name)?.review?.findings ?? [];
      if (!open.length) return ctx.ui.notify(`\`${name}\` has no open review findings to fix.`, "info");
      let picked = open;
      if (ids.length) {
        const misses: string[] = [];
        picked = [];
        for (const id of ids) {
          const hit = /^\d+$/.test(id)
            ? open[Number(id) - 1]
            : open.filter((f) => f.title.toLowerCase().includes(id.toLowerCase())).length === 1
              ? open.filter((f) => f.title.toLowerCase().includes(id.toLowerCase()))[0]
              : undefined;
          if (!hit || picked.includes(hit)) {
            if (!hit) misses.push(id);
            continue;
          }
          picked.push(hit);
        }
        if (misses.length || !picked.length) {
          return ctx.ui.notify(
            `No such finding${misses.length === 1 ? "" : "s"}: ${(misses.length ? misses : ids).join(", ")}. \`/pb:fix\` takes P0–P2 ids (P3 nits are never open: fix those by hand). Open findings for \`${name}\`:${open.map((f, i) => `\n${i + 1}. ${f.title}`).join("")}`,
            "warning",
          );
        }
      }
      if (!ctx.isIdle()) return ctx.ui.notify("Pi is busy. Wait for the current turn to finish.", "warning");
      const cctx = ctx as ExtensionCommandContext;
      if (typeof cctx.newSession !== "function") return ctx.ui.notify("This Pi can't open sessions: fix the findings here instead.", "warning");
      await driveFix(cctx, store, name!, picked, open);
    },
  });

  /* -------------------------------- stats -------------------------------- */
}
