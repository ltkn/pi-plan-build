/**
 * /pb:stats: numbers per spec from its events.jsonl (live specs and archived ones):
 * tasks, attempts, checks, pauses, undo, review, the build session's tokens and cache use,
 * and the pb_explore calls of the sessions that wrote or built it. The planning
 * conversation itself isn't counted.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { type Progress, type Store, readEvents as readJsonl } from "./store.ts";

type Ev = { type: string; at: string; [k: string]: unknown };

export interface SpecStats {
  name: string;
  phase: string;
  events: Ev[];
  /** pb_explore calls made in the sessions that wrote or built the spec */
  explore: Ev[];
  progress?: Progress;
}

const readEvents = (dir: string) => readJsonl(path.join(dir, "events.jsonl")) as Ev[];

function readProgress(dir: string): Progress | undefined {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(dir, "progress.json"), "utf8")) as Progress;
    if ((p.phase as string) === "checking") p.phase = "paused";
    if ((p.tasks ?? []).some((t) => t.id === "skeleton")) {
      p.tasks = p.tasks.filter((t) => t.id !== "skeleton");
      if ((p as { current?: string }).current === "skeleton") p.current = p.tasks.find((t) => t.status === "doing" || t.status === "todo")?.id;
    }
    return p;
  } catch {
    return undefined;
  }
}

/** Session files can be reached via different cwd spellings (/tmp vs /private/tmp): compare realpaths. */
const sameSession = (a: string, b: string): boolean => {
  if (a === b) return true;
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return false;
  }
};

/** Archived specs (oldest first), then live ones; specs with progress show even before their first event. */
export function loadStats(store: Store): SpecStats[] {
  const archived = fs.existsSync(store.archiveRoot)
    ? fs
        .readdirSync(store.archiveRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
        .map((d) => path.join(store.archiveRoot, d))
    : [];
  const dirs = [...archived, ...store.specNames().map((n) => store.specDir(n))];
  const explore = store.exploreEvents() as Ev[];
  return dirs
    .map((dir) => {
      const progress = readProgress(dir);
      const sessions = [progress?.writtenIn, progress?.session].filter((x): x is string => !!x);
      return {
        name: progress?.spec ?? path.basename(dir).replace(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-/, ""),
        phase: progress?.phase ?? "written",
        events: readEvents(dir),
        explore: explore.filter((x) => typeof x.session === "string" && sessions.some((s) => sameSession(s, x.session as string))),
        progress,
      };
    })
    .filter((s) => s.events.length || s.progress);
}

const human = (n: number) => (n < 1000 ? `${n}` : n < 1e6 ? `${(n / 1e3).toFixed(1)}k` : `${(n / 1e6).toFixed(2)}M`);
const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "–");
const dur = (ms: number) => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
};
const num = (v: unknown) => (typeof v === "number" ? v : 0);
/** Store.now() emits UTC without Z ("2026-… 12:00:00"): parse as UTC, not local, so durations survive TZ/DST. */
const ts = (at: string) => Date.parse(`${at.replace(" ", "T")}Z`);

export interface Summary {
  tasks: number;
  done: number;
  firstTry: [number, number];
  attempts: number;
  most?: [string, number];
  checks: number;
  failed: number;
  pauses: Record<string, number>;
  undo: number;
  reviews: string[];
  build: { prompt: number; cached: number; output: number; cost: number; peak: number; window?: number; turns: number };
  review: { prompt: number; output: number; cost: number };
  explorer: { calls: number; prompt: number; output: number; cost: number };
  context: { compactions: number; resets: number; nudges: number; asks: number };
  ms: number;
}

export function summarize(s: SpecStats): Summary {
  const e = s.events;
  // The spec's tasks: not the final check, nor the skeleton step earlier versions recorded.
  const checks = e.filter((x) => x.type === "check" && x.task !== "final" && x.task !== "skeleton");
  const perTask = new Map<string, Ev[]>();
  for (const c of checks) perTask.set(String(c.task), [...(perTask.get(String(c.task)) ?? []), c]);
  const tasks = (s.progress?.tasks ?? []).filter((t) => t.id !== "final" && t.id !== "skeleton");
  const done = tasks.filter((t) => t.status === "done");
  // First-try only over tasks with a check: gate "none" and unchecked middle tasks carry no signal.
  const tried = done.filter((t) => perTask.has(t.id));
  const firstTry = tried.filter((t) => perTask.get(t.id)?.[0]?.ok === true).length;
  const most = [...perTask].map(([id, cs]) => [id, cs.length] as [string, number]).sort((a, b) => b[1] - a[1])[0];

  const pauses: Record<string, number> = {};
  for (const p of e.filter((x) => x.type === "pause")) pauses[String(p.why)] = (pauses[String(p.why)] ?? 0) + 1;

  const usage = e.filter((x) => x.type === "usage");
  const build = { prompt: 0, cached: 0, output: 0, cost: 0, peak: 0, window: undefined as number | undefined, turns: usage.length };
  for (const u of usage) {
    const prompt = num(u.input) + num(u.cacheRead) + num(u.cacheWrite);
    build.prompt += prompt;
    build.cached += num(u.cacheRead);
    build.output += num(u.output);
    build.cost += num(u.cost);
    // The window shown with the peak is the window when the peak happened, not the last one seen.
    if (prompt > build.peak) {
      build.peak = prompt;
      if (typeof u.window === "number") build.window = u.window;
    } else if (build.window === undefined && typeof u.window === "number") build.window = u.window;
  }
  const reviews = e.filter((x) => x.type === "review");
  const review = { prompt: 0, output: 0, cost: 0 };
  for (const r of [...reviews, ...e.filter((x) => x.type === "review-usage")]) {
    review.prompt += num(r.input) + num(r.cacheRead) + num(r.cacheWrite);
    review.output += num(r.output);
    review.cost += num(r.cost);
  }
  const explorer = { calls: s.explore.length, prompt: 0, output: 0, cost: 0 };
  for (const x of s.explore) {
    explorer.prompt += num(x.input) + num(x.cacheRead) + num(x.cacheWrite);
    explorer.output += num(x.output);
    explorer.cost += num(x.cost);
  }
  const count = (type: string) => e.filter((x) => x.type === type).length;
  const start = e.find((x) => x.type === "build-start");
  const end = [...e].reverse().find((x) => x.type === "built") ?? e.at(-1);
  return {
    tasks: tasks.length,
    done: done.length,
    firstTry: [firstTry, tried.length],
    attempts: checks.length,
    most: most && most[1] > 1 ? most : undefined,
    checks: e.filter((x) => x.type === "check").length,
    failed: e.filter((x) => x.type === "check" && !x.ok).length,
    pauses,
    undo: e.filter((x) => x.type === "undo").length,
    reviews: reviews.map((r) => String(r.verdict)),
    build,
    review,
    explorer,
    context: { compactions: count("compact"), resets: count("reset"), nudges: count("nudge"), asks: count("ask") },
    ms: start && end ? Math.max(0, ts(end.at) - ts(start.at)) : 0,
  };
}

export function renderCard(s: SpecStats): string {
  const x = summarize(s);
  const pauses = Object.entries(x.pauses).map(([k, v]) => `${k} ${v}`).join(" · ");
  const b = x.build;
  return [
    "```",
    `pb stats — ${s.name} (${s.phase})`,
    "",
    `Tasks     ${x.done} of ${x.tasks} done · first try ${x.firstTry[0]}/${x.firstTry[1]} (${pct(...x.firstTry)}) · ${x.attempts} task checks${x.most ? ` · most: ${x.most[0]} (${x.most[1]})` : ""}`,
    `Checks    ${x.checks} run, ${x.failed} failed`,
    `Pauses    ${pauses || "none"}${x.undo ? ` · undo ${x.undo}` : ""}`,
    `Review    ${x.reviews.length ? x.reviews.join(" → ") : "not run"}`,
    `Build     ${b.turns} turns · prompt ${human(b.prompt)} (${pct(b.cached, b.prompt)} from cache) · output ${human(b.output)} · $${b.cost.toFixed(2)}${x.ms ? ` · ${dur(x.ms)}` : ""}`,
    `Context   peak ${human(b.peak)}${b.window ? ` (${pct(b.peak, b.window)} of ${human(b.window)})` : ""}`,
    `Reviewer  prompt ${human(x.review.prompt)} · output ${human(x.review.output)} · $${x.review.cost.toFixed(2)}`,
    `Explorer  ${x.explorer.calls ? `${x.explorer.calls} calls · prompt ${human(x.explorer.prompt)} · output ${human(x.explorer.output)} · $${x.explorer.cost.toFixed(2)}` : "not used"}`,
    `Session   ${x.context.compactions} compactions · ${x.context.resets} resets · ${x.context.nudges} reminders · ${x.context.asks} questions`,
    "",
    "Build = the build session's model turns; the planning conversation isn't counted.",
    "```",
  ].join("\n");
}

export function renderAll(list: SpecStats[]): string {
  if (!list.length) return "No stats yet: they are collected while building.";
  const pad = (v: string, n: number) => (v.length > n ? `${v.slice(0, n - 1)}…` : v.padEnd(n));
  const lp = (v: string, n: number) => v.padStart(n);
  const rows = list.map((s) => {
    const x = summarize(s);
    return `${pad(s.name, 26)}${lp(`${x.done}/${x.tasks}`, 7)}${lp(pct(...x.firstTry), 9)}${lp(String(x.failed), 8)}${lp(String(Object.values(x.pauses).reduce((a, b) => a + b, 0)), 8)}  ${pad(x.reviews.at(-1)?.replace("changes_needed", "changes") ?? "–", 9)}${lp(human(x.build.prompt + x.build.output), 9)}${lp(pct(x.build.cached, x.build.prompt), 7)}${lp(`$${(x.build.cost + x.review.cost + x.explorer.cost).toFixed(2)}`, 9)}${lp(x.ms ? dur(x.ms) : "–", 9)}`;
  });
  return ["```", `${pad("spec", 26)}${lp("tasks", 7)}${lp("1st try", 9)}${lp("failed", 8)}${lp("pauses", 8)}  ${pad("review", 9)}${lp("tokens", 9)}${lp("cache", 7)}${lp("cost", 9)}${lp("time", 9)}`, ...rows, "```"].join("\n");
}
