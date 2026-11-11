/** The small commands: /pb:stats, /pb:standards, /pb:status, /pb:help. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import { HELP_PATH, topic, topics } from "./help.ts";
import { buildReport } from "./report.ts";
import { findStandards, isUserTemplate, projectStack, stackNames, templatesDir, usesDatabase, writeStandards } from "./standards.ts";
import { loadStats, renderAll, renderCard, renderCompare } from "./stats.ts";
import { Store } from "./store.ts";
import { whereHere, whereNext } from "./next.ts";
import { cmd, loadSpec, post, sessionIdOf, specCompletions, specOfSession, stackLabel, taskLine } from "./kit.ts";

export function registerMisc(pi: ExtensionAPI) {
  pi.registerCommand(cmd("stats"), {
    description: "How a build went: tasks, first-try rate, checks, pauses, tokens and cache. A spec name, all, compare [n] (the last n specs phase by phase), or --json for pb.report/2",
    getArgumentCompletions: specCompletions,
    handler: async (args, ctx) => {
      const store = new Store(ctx.cwd);
      const arg = args.trim();
      if (arg.split(/\s+/).includes("--json")) return post(JSON.stringify(buildReport(store, { stats: true, review: true }), null, 2));
      const all = loadStats(store);
      if (arg === "all") return post(renderAll(all));
      const compare = arg.match(/^compare(?:\s+(\d+))?$/);
      if (compare) return post(renderCompare(all, Math.max(1, Number(compare[1] ?? 10))));
      const name = arg || specOfSession(ctx).name || (all.length === 1 ? all[0].name : undefined);
      const one = all.find((s) => s.name === name);
      if (!one) return all.length ? post(renderAll(all)) : ctx.ui.notify("No stats yet: they are collected while building.", "info");
      post(renderCard(one));
    },
  });

  /* ------------------------------ project map ----------------------------- */

  /**
   * What to tell the human when AGENTS.md's map section can't be located: the file, the marker, the
   * line — and that pb wrote nothing, since the alternative to refusing is deleting what pb can't read.
   */

  pi.registerCommand(cmd("standards"), {
    description: `Write the current engineering standards into this project's AGENTS.md: created if missing, pb's section replaced, the rest untouched. Optional: which stack (java, vue, rust, plain, or a template of yours in ${templatesDir()}); default: detected`,
    getArgumentCompletions: (prefix: string) => stackNames().filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s })),
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      const names = stackNames();
      if (arg && !names.includes(arg)) return ctx.ui.notify(`/${cmd("standards")} takes ${names.join(", ")} (default: detected from the project). Your own go in ${templatesDir()}.`, "warning");
      const stack = arg ? (arg === "plain" ? undefined : arg) : projectStack(ctx.cwd);
      const file = path.join(ctx.cwd, "AGENTS.md");
      const database = usesDatabase(ctx.cwd);
      const result = writeStandards(file, stack, database);
      new Store(ctx.cwd).markAsked("standards");
      if (result === "broken") return ctx.ui.notify(`${file} has "<!-- pb:standards -->" without its "<!-- /pb:standards -->": add the end marker where pb's section ends, then run /${cmd("standards")} again.`, "error");
      const what = { created: "Created", added: "Added pb's standards to", replaced: "Replaced pb's standards in", unchanged: "pb's standards are already current in" }[result];
      const shared = findStandards(path.dirname(ctx.cwd));
      ctx.ui.notify(
        `${what} ${file} (${stackLabel(stack)}${database && stack !== "vue" && !(stack && isUserTemplate(stack)) ? ", with the database rules" : ""})${result === "created" ? ", with pb's standards" : ""}.${result === "replaced" || result === "added" ? " The rest of the file is untouched." : ""}${result === "unchanged" ? "" : " Sessions already running keep the ones they loaded until restarted."}${shared ? ` ${shared.file} also has a pb section: Pi loads both.` : ""}`,
        "info",
      );
    },
  });

  pi.registerCommand(cmd("status"), {
    description: "Every spec and where it stands; --json for pb.report/2",
    handler: async (args, ctx) => {
      const store = new Store(ctx.cwd);
      if (args.trim().split(/\s+/).includes("--json")) return post(JSON.stringify(buildReport(store, { review: true }), null, 2));
      const names = store.specNames();
      const problems = store.configProblems();
      const config = problems.length ? ["", "config — ignored or replaced:", ...problems.map((x) => `    ${x}`)] : [];
      if (!names.length) return ctx.ui.notify([`No specs yet. Start with /${cmd("plan")} <feature>.`, ...config].join("\n"), problems.length ? "warning" : "info");
      const here = store.specForSession(ctx.sessionManager.getSessionFile());
      const lines = names.flatMap((n) => {
        const p = store.progress(n);
        const s = loadSpec(store, n)?.spec;
        const where = p?.session && n !== here ? ` · session: pi --session ${sessionIdOf(p.session)}` : "";
        const next = whereNext(store, n);
        const head = `${n === here ? "▸ " : ""}${n} — ${next.state}${where}${s ? ` · verification ${s.gate}${s.newTests ? "" : " · no new tests"}${s.dependsOn ? ` · depends on ${s.dependsOn}` : ""}` : " · ⚠ doesn't parse"}${p?.pause ? ` · paused: ${p.pause}` : ""}${p?.fix ? ` · repair lap ${p.fix.laps} open (${p.fix.driver ? "hardening" : "one lap"})` : ""}`;
        return [head, `    next: ${next.next}`, ...(p && p.phase !== "written" ? p.tasks.map((t) => `    ${taskLine(t)}`) : [])];
      });
      ctx.ui.notify([...lines, ...config, `help: /${cmd("help")}`].join("\n"), problems.length ? "warning" : "info");
    },
  });

  /* --------------------------------- help -------------------------------- */

  pi.registerCommand(cmd("help"), {
    description: "What to do next and how to handle edge cases. /pb:help <topic> shows one section",
    handler: async (args, ctx) => {
      const name = args.trim().toLowerCase();
      const body = name ? topic(name) : undefined;
      if (body) return post(`${body}\n\n(Full guide: ${HELP_PATH})`);
      const list = topics().map((t) => `- \`/${cmd("help")} ${t.name}\` — ${t.title}`);
      if (!list.length) return ctx.ui.notify(`Help file not found: ${HELP_PATH}`, "warning");
      // Help without a topic starts where you are: the one thing most people open it for.
      const where = name ? undefined : whereHere(new Store(ctx.cwd), ctx.sessionManager.getSessionFile() ?? undefined);
      const here = where
        ? [`**You are here:** ${where.spec ? `${where.spec} — ` : ""}${where.state}`, `**Next:** ${where.next}${where.command ? ` (alt+n puts \`${where.command}\` in the editor)` : ""}`, ""]
        : name
          ? []
          : [`**You are here:** no pb work yet`, `**Next:** \`/${cmd("plan")} <feature>\` plans one with you`, ""];
      post([...here, name ? `No help topic "${name}".` : "**pb help** — pick a topic:", "", ...list, "", `Full guide: ${HELP_PATH}`].join("\n"));
    },
  });
}
