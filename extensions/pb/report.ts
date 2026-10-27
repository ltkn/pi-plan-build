/**
 * The machine-readable report: pb.report/1. `/pb:status --json`, `/pb:stats --json` and the
 * `pb-report` command all return this document, so a dashboard or a script reads one shape and
 * never has to parse the human views. The schema string is the contract: a breaking change
 * needs a new one.
 */
import { acceptanceCriteria, parseSpec } from "./spec.ts";
import { loadStats, summarize, type SpecStats } from "./stats.ts";
import type { AcceptanceStatus, Finding, Gate, Phase, Priority, Store } from "./store.ts";
import { parseRequirementDeltas, requirementInventory } from "./requirements.ts";

export const REPORT_SCHEMA = "pb.report/1";

export interface ReportTask {
  id: string;
  title: string;
  status: string;
  attempts: number;
}

export interface ReportFinding {
  id: string | null;
  priority: Priority;
  file: string | null;
  line: number | null;
  title: string;
  fix: string | null;
  outside: boolean;
}

export interface ReportAcceptance {
  id: string;
  text: string;
  task: string | null;
  capability: string | null;
  requirement: string | null;
  status: AcceptanceStatus | "not reported";
  evidence: string | null;
}

export interface ReportStats {
  tasks: number;
  done: number;
  firstTry: { met: number; checked: number };
  attempts: number;
  mostAttempts: { task: string; checks: number } | null;
  checks: { run: number; failed: number };
  pauses: Record<string, number>;
  undo: number;
  reviews: string[];
  proof: { proven: number; sentBack: number; preGreen: number };
  confirmed: { p0: number; p1: number };
  tokens: {
    buildIn: number;
    buildCached: number;
    buildOut: number;
    buildPeak: number;
    contextWindow: number | null;
    buildTurns: number;
    reviewIn: number;
    reviewOut: number;
    exploreCalls: number;
    exploreIn: number;
    exploreOut: number;
  };
  cost: { build: number; review: number; explore: number };
  context: { compactions: number; resets: number; nudges: number; asks: number };
  ms: number;
}

export interface ReportRequirementDelta {
  capability: string;
  added: string[];
  modified: string[];
  removed: string[];
}

export interface ReportReview {
  at: string | null;
  verdict: string | null;
  /** P0–P2 findings from the latest review (P3 nits never open) */
  open: number;
  total: number;
  /** full findings, only with review details */
  findings?: ReportFinding[];
}

export interface ReportSpec {
  name: string;
  title: string | null;
  phase: Phase;
  parse: { ok: boolean; errors: string[] };
  status: "planning" | "ready" | null;
  verification: {
    gate: Gate | null;
    reason: string | null;
    newTests: boolean | null;
    newTestsReason: string | null;
    dependsOn: string | null;
  };
  progress: {
    current: string | null;
    pause: string | null;
    baseCommit: string | null;
    updatedAt: string | null;
    tasks: ReportTask[];
  };
  review: ReportReview;
  /** every acceptance criterion, with the latest review's status where one was reported */
  acceptance: ReportAcceptance[];
  requirements: ReportRequirementDelta[];
  requirementErrors: string[];
  stats?: ReportStats;
}

export interface Report {
  schema: typeof REPORT_SCHEMA;
  generatedAt: string;
  cwd: string;
  specs: ReportSpec[];
  requirements: Array<{ capability: string; path: string; requirements: number; scenarios: number; errors: string[] }>;
  summary: {
    specs: number;
    byPhase: Record<string, number>;
    openFindings: number;
    requirements: number;
    scenarios: number;
  };
}

export interface ReportOptions {
  /** include build stats (events) per spec */
  stats?: boolean;
  /** include the latest review's full findings */
  review?: boolean;
}

/** Timestamps are stored as UTC "YYYY-MM-DD HH:mm:ss"; expose them as ISO 8601. */
const iso = (at: string | undefined): string | null => {
  if (!at) return null;
  const parsed = Date.parse(`${at.replace(" ", "T")}Z`);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : at;
};

const reportFinding = (finding: Finding): ReportFinding => ({
  id: finding.id ?? null,
  priority: finding.priority,
  file: finding.file ?? null,
  line: finding.line ?? null,
  title: finding.title,
  fix: finding.fix ?? null,
  outside: finding.outside === true,
});

const reportStats = (spec: SpecStats): ReportStats => {
  const x = summarize(spec);
  return {
    tasks: x.tasks,
    done: x.done,
    firstTry: { met: x.firstTry[0], checked: x.firstTry[1] },
    attempts: x.attempts,
    mostAttempts: x.most ? { task: x.most[0], checks: x.most[1] } : null,
    checks: { run: x.checks, failed: x.failed },
    pauses: x.pauses,
    undo: x.undo,
    reviews: x.reviews,
    proof: x.proof,
    confirmed: x.confirmed,
    tokens: {
      buildIn: x.build.prompt,
      buildCached: x.build.cached,
      buildOut: x.build.output,
      buildPeak: x.build.peak,
      contextWindow: x.build.window ?? null,
      buildTurns: x.build.turns,
      reviewIn: x.review.prompt,
      reviewOut: x.review.output,
      exploreCalls: x.explorer.calls,
      exploreIn: x.explorer.prompt,
      exploreOut: x.explorer.output,
    },
    cost: { build: x.build.cost, review: x.review.cost, explore: x.explorer.cost },
    context: x.context,
    ms: x.ms,
  };
};

function reportSpec(store: Store, name: string, options: ReportOptions, stats: Map<string, SpecStats> | undefined): ReportSpec {
  const markdown = store.readSpec(name) ?? "";
  const parsed = parseSpec(markdown);
  const progress = store.progress(name);
  const review = progress?.review;
  const findings = review?.findings ?? [];
  const reported = new Map((review?.acceptance ?? []).map((a) => [a.criterion, a]));
  const criteria = parsed.spec ? acceptanceCriteria(markdown, parsed.spec) : [];
  const acceptance: ReportAcceptance[] = criteria.map((criterion) => {
    const result = reported.get(criterion.id);
    return {
      id: criterion.id,
      text: criterion.text,
      task: criterion.task ?? null,
      capability: criterion.capability ?? null,
      requirement: criterion.requirement ?? null,
      status: result?.status ?? "not reported",
      evidence: result?.evidence ?? null,
    };
  });
  const deltas = parseRequirementDeltas(markdown);
  const requirements = deltas.deltas.map((delta) => {
    const names = (kind: "ADDED" | "MODIFIED" | "REMOVED") => delta.groups.find((g) => g.kind === kind)?.requirements.map((r) => r.name) ?? [];
    return { capability: delta.capability, added: names("ADDED"), modified: names("MODIFIED"), removed: names("REMOVED") };
  });
  const specStats = stats?.get(name);
  return {
    name,
    title: parsed.spec?.title ?? null,
    phase: progress?.phase ?? "written",
    parse: { ok: !!parsed.spec, errors: parsed.errors },
    status: parsed.spec?.status ?? null,
    verification: {
      gate: parsed.spec?.gate ?? null,
      reason: parsed.spec?.gateReason ?? null,
      newTests: parsed.spec?.newTests ?? null,
      newTestsReason: parsed.spec?.newTestsReason ?? null,
      dependsOn: parsed.spec?.dependsOn ?? null,
    },
    progress: {
      current: progress?.current ?? null,
      pause: progress?.pause ?? null,
      baseCommit: progress?.baseCommit ?? null,
      updatedAt: iso(progress?.updatedAt),
      tasks: (progress?.tasks ?? [])
        .filter((task) => task.id !== "final" && task.id !== "cohere")
        .map((task) => ({ id: task.id, title: task.title, status: task.status, attempts: task.attempts })),
    },
    review: {
      at: iso(review?.at),
      verdict: review?.verdict ?? null,
      open: findings.filter((finding) => finding.priority !== "P3").length,
      total: findings.length,
      ...(options.review ? { findings: findings.map(reportFinding) } : {}),
    },
    acceptance,
    requirements,
    requirementErrors: deltas.errors,
    ...(specStats ? { stats: reportStats(specStats) } : {}),
  };
}

/** Build the pb.report/1 document for the store's live specs and living requirement base. */
export function buildReport(store: Store, options: ReportOptions = {}): Report {
  const stats = options.stats ? new Map(loadStats(store).map((s) => [s.name, s])) : undefined;
  const specs = store.specNames().map((name) => reportSpec(store, name, options, stats));
  const requirements = requirementInventory(store);
  const byPhase: Record<string, number> = {};
  for (const spec of specs) byPhase[spec.phase] = (byPhase[spec.phase] ?? 0) + 1;
  return {
    schema: REPORT_SCHEMA,
    generatedAt: new Date().toISOString(),
    cwd: store.cwd,
    specs,
    requirements,
    summary: {
      specs: specs.length,
      byPhase,
      openFindings: specs.reduce((n, spec) => n + spec.review.open, 0),
      requirements: requirements.reduce((n, entry) => n + entry.requirements, 0),
      scenarios: requirements.reduce((n, entry) => n + entry.scenarios, 0),
    },
  };
}
