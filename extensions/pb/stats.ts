/**
 * /pb:stats: numbers per spec from its events.jsonl (live specs and archived ones):
 * tasks, attempts, checks, pauses, undo, review, the build session's tokens and cache use,
 * and the pb_explore calls of the sessions that wrote or built it. The planning
 * conversation itself isn't counted.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { type ParsedSpec, earlierProof, needsRed, parseSpec } from "./spec.ts";
import { type Progress, type Store, readEvents as readJsonl, COHERE_TASK_ID } from "./store.ts";
import { duration, human, outRate } from "./format.ts";

type Ev = { type: string; at: string; [k: string]: unknown };

export interface SpecStats {
  name: string;
  phase: string;
  events: Ev[];
  /** pb_explore calls made in the sessions that wrote or built the spec */
  explore: Ev[];
  progress?: Progress;
  /** the spec, parsed: the proof signal tells a task that needs no run from one that could not be proven */
  spec?: ParsedSpec;
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
      const markdown = (() => {
        try {
          return fs.readFileSync(path.join(dir, "spec.md"), "utf8");
        } catch {
          return undefined;
        }
      })();
      return {
        name: progress?.spec ?? path.basename(dir).replace(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-/, ""),
        phase: progress?.phase ?? "written",
        events: readEvents(dir),
        explore: explore.filter((x) => typeof x.session === "string" && sessions.some((s) => sameSession(s, x.session as string))),
        progress,
        spec: markdown ? parseSpec(markdown).spec : undefined,
      };
    })
    .filter((s) => s.events.length || s.progress);
}

const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "–");
const num = (v: unknown) => (typeof v === "number" ? v : 0);
/** Store.now() emits UTC without Z ("2026-… 12:00:00"): parse as UTC, not local, so durations survive TZ/DST. */
const ts = (at: string) => Date.parse(`${at.replace(" ", "T")}Z`);

export interface BuildTiming {
  /** The parts where the build was running: build-start → pause/built, summed. */
  activeMs: number;
  /** The first build-start → built (or the last event): pauses included. */
  wallMs: number;
}

/** Build time from its own events; a pause closes a running segment, a resume opens a new one. */
export function buildTiming(events: Record<string, unknown>[]): BuildTiming {
  const start = events.find((x) => x.type === "build-start");
  const end = [...events].reverse().find((x) => x.type === "built") ?? events.at(-1);
  const at = (e: Record<string, unknown>) => (typeof e.at === "string" ? ts(e.at) : Number.NaN);
  // Events carry whole seconds: a segment that starts and ends inside one second is under a
  // second, not zero — a zero would read as "no time recorded" and hide it.
  const span = (from: number, to: number) => Math.max(1, to - from);
  const wallMs = start && end ? span(at(start), at(end)) : 0;
  let activeMs = 0;
  let running: number | undefined;
  for (const e of events) {
    const time = at(e);
    if (!Number.isFinite(time)) continue;
    if (e.type === "build-start") {
      if (running !== undefined) activeMs += span(running, time);
      running = time;
    } else if (e.type === "pause" || e.type === "built") {
      if (running !== undefined) {
        activeMs += span(running, time);
        running = undefined;
      }
    }
  }
  if (running !== undefined && end) activeMs += span(running, at(end));
  return { activeMs, wallMs };
}

/** One form for build time everywhere: active, with elapsed in parentheses only when a pause made them differ. */
export const buildTimeLabel = (t: BuildTiming): string =>
  t.activeMs > 0 && t.activeMs !== t.wallMs ? `${duration(t.activeMs)} (${duration(t.wallMs)} elapsed)` : duration(t.activeMs || t.wallMs);

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
  /** Red-proof signal: tasks proven, tasks sent back at least once (excluding pre-green), pre-green tasks. */
  proof: { proven: number; sentBack: number; unproven: number };
  /** Confirmed P0/P1 of the latest review (post double-check). */
  confirmed: { p0: number; p1: number };
  /** Review honesty: findings reported (post-verification tally + verifier-dismissed), dismissed, and distinct titles fixed in fix laps. Present once a review ran. */
  precision?: { reported: number; dismissed: number; fixed: number };
  build: { prompt: number; cached: number; output: number; cost: number; peak: number; window?: number; turns: number };
  review: { prompt: number; output: number; cost: number };
  explorer: { calls: number; prompt: number; output: number; cost: number; ms: number };
  context: { compactions: number; resets: number; nudges: number };
  /** wall-clock from the first build-start to built, pauses included */
  ms: number;
  /** the same span with pauses removed */
  activeMs: number;
  /** the latest ready spec write's elapsed step */
  specMs?: number;
  /** the latest spec review's duration */
  specReviewMs?: number;
  /** the latest code review's duration */
  reviewMs?: number;
  /** What getting the spec ready cost: its reviews, claim checks and repair laps. Present once any ran. */
  spec?: SpecPhase;
}

/** The spec phase in numbers: the data a change to the spec's evidence rules is judged by. */
export interface SpecPhase {
  reviews: number;
  /** reviews that blocked the build on a P0 */
  blocked: number;
  /** findings the reviews reported, P0 to P3 */
  findings: [number, number, number, number];
  /** the same findings by the spec check they fail (untagged ones are not counted), most first */
  byCheck: Record<string, number>;
  claimChecks: number;
  /** un-evidenced claims the claim checks reported */
  claims: number;
  laps: number;
  applied: number;
  rebutted: number;
  parked: number;
  assumed: number;
  /** tokens and cost of the fresh review and claim-check runs (a lap runs in the planning session: not counted) */
  prompt: number;
  output: number;
  cost: number;
  ms: number;
}

const PRIORITIES = ["P0", "P1", "P2", "P3"];

function specPhase(e: Ev[]): SpecPhase | undefined {
  const reviews = e.filter((x) => x.type === "spec-review" && x.verdict !== "error");
  const checks = e.filter((x) => x.type === "spec-check" && x.verdict !== "error");
  const laps = e.filter((x) => x.type === "spec-fix");
  const runs = e.filter((x) => x.type === "spec-review" || x.type === "spec-check");
  if (!runs.length && !laps.length) return undefined;
  const findings: [number, number, number, number] = [0, 0, 0, 0];
  const byCheck = new Map<string, number>();
  for (const r of reviews) {
    for (const f of Array.isArray(r.reported) ? r.reported : []) {
      const i = PRIORITIES.indexOf(String((f as { priority?: unknown }).priority));
      if (i >= 0) findings[i] += 1;
      const check = (f as { check?: unknown }).check;
      if (typeof check === "string" && check) byCheck.set(check, (byCheck.get(check) ?? 0) + 1);
    }
  }
  const items = (key: string) => laps.reduce((n, l) => n + (Array.isArray(l[key]) ? (l[key] as unknown[]).length : 0), 0);
  return {
    reviews: reviews.length,
    blocked: reviews.filter((r) => r.verdict === "block").length,
    findings,
    byCheck: Object.fromEntries([...byCheck].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
    claimChecks: checks.length,
    claims: checks.reduce((n, c) => n + num(c.findings), 0),
    laps: laps.length,
    applied: items("applied"),
    rebutted: items("rebutted"),
    parked: items("parked"),
    assumed: items("assumed"),
    prompt: runs.reduce((n, r) => n + num(r.input) + num(r.cacheRead) + num(r.cacheWrite), 0),
    output: runs.reduce((n, r) => n + num(r.output), 0),
    cost: runs.reduce((n, r) => n + num(r.cost), 0),
    ms: runs.reduce((n, r) => n + num(r.ms), 0),
  };
}

export function summarize(s: SpecStats): Summary {
  const e = s.events;
  // The spec's tasks: not the final check, the coherence pass, the skeleton step earlier versions recorded, nor a /pb:fix lap's checks.
  const checks = e.filter((x) => x.type === "check" && x.task !== "final" && x.task !== "skeleton" && x.task !== "fix" && x.task !== COHERE_TASK_ID);
  const perTask = new Map<string, Ev[]>();
  for (const c of checks) perTask.set(String(c.task), [...(perTask.get(String(c.task)) ?? []), c]);
  const tasks = (s.progress?.tasks ?? []).filter((t) => t.id !== "final" && t.id !== "skeleton" && t.id !== COHERE_TASK_ID);
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
  const explorer = { calls: s.explore.length, prompt: 0, output: 0, cost: 0, ms: 0 };
  for (const x of s.explore) {
    explorer.prompt += num(x.input) + num(x.cacheRead) + num(x.cacheWrite);
    explorer.output += num(x.output);
    explorer.cost += num(x.cost);
    explorer.ms += num(x.ms);
  }
  const count = (type: string) => e.filter((x) => x.type === type).length;
  const timing = buildTiming(e);
  const lastMs = (type: string): number | undefined => {
    const ms = [...e].reverse().find((x) => x.type === type && typeof x.ms === "number")?.ms;
    return typeof ms === "number" ? ms : undefined;
  };
  // Red sent-backs: a `red` event with ok:false means the tests passed without the change. A task
  // whose command an earlier one already proved cannot fail again: unproven, not sent back.
  const sentBackIds = new Set(e.filter((x) => x.type === "red" && x.ok === false).map((x) => String(x.task)));
  const unprovenIds = new Set(
    tasks
      .filter((t) => {
        const task = s.spec?.tasks.find((x) => x.id === t.id);
        return !t.redCommand && !!s.spec && needsRed(s.spec, task) && !!earlierProof(s.spec, tasks, task);
      })
      .map((t) => t.id),
  );
  const lastReview = [...e].reverse().find((x) => x.type === "review");
  const pp = Array.isArray(lastReview?.p) ? (lastReview.p as unknown[]) : [];
  // Review honesty: `p` is the post-verification tally, so the reviewer's own report counted
  // the verifier-dismissed ones too. Fix laps record raw titles; a title repeated across laps
  // was still fixed once.
  const reviewEvents = e.filter((x) => x.type === "review");
  const reported = reviewEvents.reduce((n, x) => n + (Array.isArray(x.p) ? (x.p as unknown[]).reduce<number>((a, v) => a + num(v), 0) : 0) + num(x.dismissed), 0);
  const dismissed = reviewEvents.reduce((n, x) => n + num(x.dismissed), 0);
  const fixedTitles = new Set(e.filter((x) => x.type === "fix" && Array.isArray(x.fixed)).flatMap((x) => (x.fixed as unknown[]).filter((t): t is string => typeof t === "string")));
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
    proof: {
      proven: tasks.filter((t) => !!t.redCommand).length,
      sentBack: [...sentBackIds].filter((id) => !unprovenIds.has(id)).length,
      unproven: unprovenIds.size,
    },
    confirmed: { p0: num(pp[0]), p1: num(pp[1]) },
    precision: reviewEvents.length ? { reported, dismissed, fixed: fixedTitles.size } : undefined,
    build,
    review,
    explorer,
    context: { compactions: count("compact"), resets: count("reset"), nudges: count("nudge") },
    ms: timing.wallMs,
    activeMs: timing.activeMs,
    specMs: lastMs("spec"),
    specReviewMs: lastMs("spec-review"),
    reviewMs: typeof lastReview?.ms === "number" ? lastReview.ms : undefined,
    spec: specPhase(e),
  };
}

/** The spec phase on one card line: reviews and their findings, claim checks, laps, then what the fresh runs cost. */
const specLine = (s: SpecPhase): string =>
  [
    `Spec      ${s.reviews} review${s.reviews === 1 ? "" : "s"}${s.blocked ? ` (${s.blocked} blocked)` : ""}`,
    s.reviews ? `findings ${s.findings.map((n, i) => `P${i} ${n}`).join(" ")}` : "",
    Object.keys(s.byCheck).length ? `by check ${Object.entries(s.byCheck).map(([k, n]) => `${k} ${n}`).join(" ")}` : "",
    s.claimChecks ? `${s.claimChecks} claim check${s.claimChecks === 1 ? "" : "s"}: ${s.claims} claim${s.claims === 1 ? "" : "s"}` : "",
    s.laps ? `${s.laps} lap${s.laps === 1 ? "" : "s"}: ${s.applied} applied, ${s.rebutted} rebutted, ${s.parked} parked, ${s.assumed} assumed` : "",
    `in ${human(s.prompt)} · out ${human(s.output)} · $${s.cost.toFixed(2)}${s.ms ? ` · ${duration(s.ms)}` : ""}`,
  ]
    .filter(Boolean)
    .join(" · ");

export function renderCard(s: SpecStats): string {
  const x = summarize(s);
  const pauses = Object.entries(x.pauses).map(([k, v]) => `${k} ${v}`).join(" · ");
  const b = x.build;
  const hasRed = s.events.some((e) => e.type === "red");
  const phases = [
    x.specMs !== undefined ? `spec ${duration(x.specMs)}` : "",
    x.specReviewMs !== undefined ? `spec review ${duration(x.specReviewMs)}` : "",
    x.activeMs || x.ms ? `build ${buildTimeLabel({ activeMs: x.activeMs, wallMs: x.ms })}` : "",
    x.reviewMs !== undefined ? `review ${duration(x.reviewMs)}` : "",
  ].filter(Boolean);
  return [
    "```",
    `pb stats — ${s.name} (${s.phase})`,
    "",
    `Tasks     ${x.done} of ${x.tasks} done · first try ${x.firstTry[0]}/${x.firstTry[1]} (${pct(...x.firstTry)}) · ${x.attempts} task checks${x.most ? ` · most: ${x.most[0]} (${x.most[1]})` : ""}`,
    `Checks    ${x.checks} run, ${x.failed} failed`,
    ...(x.spec ? [specLine(x.spec)] : []),
    `Pauses    ${pauses || "none"}${x.undo ? ` · undo ${x.undo}` : ""}`,
    `Review    ${x.reviews.length ? `${x.reviews.join(" → ")} · P0/P1 confirmed (latest): ${x.confirmed.p0 + x.confirmed.p1}` : "not run"}`,
    ...(x.precision ? [`Precision ${x.precision.reported} reported · ${x.precision.dismissed} dismissed (${pct(x.precision.dismissed, x.precision.reported)}) · ${x.precision.fixed} fixed`] : []),
    ...(hasRed ? [`Proof     ${x.proof.proven} proven · ${x.proof.sentBack} sent back · ${x.proof.unproven} no run could prove`] : []),
    `Build     ${b.turns} turns · in ${human(b.prompt)} (${pct(b.cached, b.prompt)} cached) · out ${human(b.output)} · $${b.cost.toFixed(2)}`,
    ...(phases.length ? [`Time      ${phases.join(" · ")}`] : []),
    `Context   peak ${human(b.peak)}${b.window ? ` (${pct(b.peak, b.window)} of ${human(b.window)})` : ""}`,
    `Reviewer  in ${human(x.review.prompt)} · out ${human(x.review.output)} · $${x.review.cost.toFixed(2)}`,
    `Explorer  ${x.explorer.calls ? `${x.explorer.calls} calls · in ${human(x.explorer.prompt)} · out ${human(x.explorer.output)}${x.explorer.ms > 0 ? ` @ ${outRate(x.explorer.prompt + x.explorer.output, x.explorer.ms)} tok/s` : ""} · $${x.explorer.cost.toFixed(2)}` : "not used"}`,
    `Session   ${x.context.compactions} compactions · ${x.context.resets} resets · ${x.context.nudges} reminders`,
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
    return `${pad(s.name, 26)}${lp(`${x.done}/${x.tasks}`, 7)}${lp(pct(...x.firstTry), 9)}${lp(String(x.failed), 8)}${lp(String(Object.values(x.pauses).reduce((a, b) => a + b, 0)), 8)}  ${pad(x.reviews.at(-1)?.replace("changes_needed", "changes") ?? "–", 10)}${lp(human(x.build.prompt + x.build.output), 9)}${lp(pct(x.build.cached, x.build.prompt), 7)}${lp(`$${(x.build.cost + x.review.cost + x.explorer.cost + (x.spec?.cost ?? 0)).toFixed(2)}`, 9)}${lp(x.activeMs || x.ms ? duration(x.activeMs || x.ms) : "–", 9)}`;
  });
  return ["```", `${pad("spec", 26)}${lp("tasks", 7)}${lp("1st try", 9)}${lp("failed", 8)}${lp("pauses", 8)}  ${pad("review", 10)}${lp("tokens", 9)}${lp("cache", 7)}${lp("cost", 9)}${lp("time", 9)}`, ...rows, "```"].join("\n");
}

/**
 * The last `n` specs side by side, oldest first, on what each phase caught and cost: the spec's first review
 * (findings P0/P1/P2/P3) and its repair laps, the build's first-try rate, the code review's first report and
 * the fix laps after it. What a change to pb's prompts or rules is judged by.
 */
export function renderCompare(list: SpecStats[], n: number): string {
  const shown = list.filter((s) => s.events.length).slice(-n);
  if (!shown.length) return "No stats yet: they are collected while building.";
  const pad = (v: string, w: number) => (v.length > w ? `${v.slice(0, w - 1)}…` : v.padEnd(w));
  const lp = (v: string, w: number) => v.padStart(w);
  const money = (v: number) => (v ? `$${v.toFixed(2)}` : "–");
  const rows = shown.map((s) => {
    const x = summarize(s);
    const firstSpecReview = s.events.find((e) => e.type === "spec-review" && e.verdict !== "error");
    const reported = Array.isArray(firstSpecReview?.reported) ? (firstSpecReview.reported as { priority?: unknown }[]) : [];
    const specFound = PRIORITIES.map((p) => reported.filter((f) => f.priority === p).length).join("/");
    const firstReview = s.events.find((e) => e.type === "review");
    const reviewFound = firstReview ? (Array.isArray(firstReview.p) ? (firstReview.p as unknown[]).reduce<number>((a, v) => a + num(v), 0) : 0) + num(firstReview.dismissed) : undefined;
    const fixLaps = s.events.filter((e) => e.type === "fix").length;
    return `${pad(s.name, 24)}${lp(firstSpecReview ? specFound : "–", 10)}${lp(String(x.spec?.laps ?? 0), 6)}${lp(pct(...x.firstTry), 8)}${lp(reviewFound === undefined ? "–" : String(reviewFound), 8)}${lp(String(fixLaps), 6)}${lp(money(x.spec?.cost ?? 0), 8)}${lp(money(x.build.cost), 8)}${lp(money(x.review.cost), 9)}${lp(x.activeMs || x.ms ? duration(x.activeMs || x.ms) : "–", 9)}`;
  });
  return [
    "```",
    `${pad("spec", 24)}${lp("spec P0-3", 10)}${lp("laps", 6)}${lp("1st try", 8)}${lp("review", 8)}${lp("fixes", 6)}${lp("$spec", 8)}${lp("$build", 8)}${lp("$review", 9)}${lp("build", 9)}`,
    ...rows,
    "",
    "spec P0-3: the first spec review's findings · laps: spec repair laps · review: findings the first code review reported",
    "fixes: /pb:fix laps · $: each phase's fresh runs and build turns (the planning conversation isn't counted) · oldest first",
    "```",
  ].join("\n");
}
