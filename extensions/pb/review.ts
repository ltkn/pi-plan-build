/**
 * The review: a reviewer reports findings through pb_report_findings in the session you watch; the
 * adversarial pass is a background runFresh on the same frozen brief (see /pb:review). A fresh
 * background call double-checks the blocking ones (P0/P1) against the code before they reach you,
 * since a false P1 costs a whole fix cycle.
 */
import { fileURLToPath } from "node:url";
import { VERIFIER_SYSTEM, verifierBrief } from "./prompts.ts";
import { type RunOptions, runFresh } from "./runner.ts";
import { verdictAnswers } from "./verdict-answers.ts";
import type { AcceptanceCheck, AcceptanceCriterion, AcceptanceStatus, Finding, Priority } from "./store.ts";

export const REVIEW_TOOLS = fileURLToPath(new URL("./review-tools.ts", import.meta.url));
/** What a review pass may do: read the frozen tree and the brief's diff. No shell, so it cannot act on it. */
const INSPECT = ["read", "grep", "find", "ls"];

export type Verdict = "pass" | "changes_needed" | "unverified" | "none";

export const blocking = (f: Finding) => f.priority === "P0" || f.priority === "P1";

/**
 * What the double check of the blocking findings came to: `checked` of `of` — the findings it holds a usable
 * verdict for, out of the ones it was handed (the parse cannot answer more than it was given, so `checked`
 * never passes `of`). `skipped` is the config's no; `error` is why a run fell short.
 */
export type Verification = { checked: number; of: number; skipped?: boolean; error?: string };

/**
 * The double check's lines: the mark on the evidence line, the note saying what is reported unconfirmed when
 * the check fell short of the findings it was handed, and `fellShort` for anything else that has to say so —
 * the next step, which sends an unanswered finding back through a full review.
 *
 * A run that failed is never a clean check, even when it answered every finding before dying: the failure is
 * the one thing the mark must not hide. A review that never reached the double check (`undefined`) prints no
 * mark and no note and did not fall short.
 */
export function verificationLines(v: Verification | undefined): { mark: string; note?: string; fellShort: boolean } {
  if (v === undefined) return { mark: "", fellShort: false };
  if (v.skipped) return { mark: "verifier skipped", fellShort: false };
  if (v.of === 0) return { mark: "verifier —", fellShort: false };
  const { checked, of } = v;
  const failed = v.error?.split("\n")[0];
  if (!failed && checked >= of) return { mark: "verifier ✓", fellShort: false };
  const mark = failed ? `verifier ✗ ${checked}/${of}` : `verifier ⚠ ${checked}/${of}`;
  // A run that answered nothing says the check did not happen; one that answered some says which it left
  // out; one that answered everything and still failed says the failure and that the check is incomplete.
  const note = failed
    ? checked === 0
      ? `⚠ The second look at the blocking findings couldn't run (${failed}): they are reported unconfirmed.`
      : checked >= of
        ? `⚠ The second look at the blocking findings answered ${checked} of ${of}, but its run failed (${failed}): treat the double-check as incomplete.`
        : `⚠ The second look at the blocking findings reported ${checked} of ${of} blocking findings (${failed}): the other ${of - checked} are reported unconfirmed.`
    : checked === 0
      ? "⚠ The second look at the blocking findings reported nothing: they are reported unconfirmed."
      : `⚠ The second look at the blocking findings reported ${checked} of ${of} blocking findings: the other ${of - checked} are reported unconfirmed.`;
  return { mark, note, fellShort: true };
}

/** A criterion the reviewer did not report: missing is not a pass. */
export interface AcceptanceLine {
  criterion: AcceptanceCriterion;
  status: AcceptanceStatus | "not reported";
  evidence?: string;
}

/** The checklist joined with what the pass reported, including what it left out. */
export interface AcceptanceCoverage {
  expected: AcceptanceCriterion[];
  lines: AcceptanceLine[];
  met: number;
  notMet: AcceptanceLine[];
  notVerified: AcceptanceLine[];
  missing: AcceptanceLine[];
  enforced: boolean;
}

/**
 * Join a spec's checklist with the pass's report. Unknown ids are ignored (a model miscounting can't
 * invent criteria), the last report per id wins, and `met` without evidence degrades to `not verified`.
 */
export function acceptanceCoverage(expected: AcceptanceCriterion[] | undefined, checks: AcceptanceCheck[] | undefined): AcceptanceCoverage {
  const list = expected ?? [];
  const known = new Set(list.map((c) => c.id));
  const byId = new Map<string, AcceptanceCheck>();
  for (const check of checks ?? []) {
    if (!known.has(check.criterion)) continue;
    byId.set(check.criterion, check);
  }
  const lines: AcceptanceLine[] = list.map((criterion) => {
    const check = byId.get(criterion.id);
    if (!check) return { criterion, status: "not reported" };
    const evidence = check.evidence.trim();
    if (check.status === "met" && !evidence) return { criterion, status: "not verified", evidence: "no evidence supplied" };
    return { criterion, status: check.status, ...(evidence ? { evidence } : {}) };
  });
  const withStatus = (status: AcceptanceLine["status"]) => lines.filter((l) => l.status === status);
  return {
    expected: list,
    lines,
    met: withStatus("met").length,
    notMet: withStatus("not met"),
    notVerified: withStatus("not verified"),
    missing: withStatus("not reported"),
    enforced: list.length > 0,
  };
}

/**
 * The verdict ladder. Any confirmed P0/P1, or any reported `not met`, means changes needed. A review
 * that leaves any checklist item unverified (reported as such or omitted) gets its own verdict, so
 * silence never reads as a pass. Without a checklist, the old findings-only rule applies.
 */
export const verdictOf = (findings: Finding[], coverage?: AcceptanceCoverage): Verdict => {
  if (findings.some(blocking)) return "changes_needed";
  if (coverage?.enforced) {
    if (coverage.notMet.length) return "changes_needed";
    if (coverage.notVerified.length || coverage.missing.length) return "unverified";
  }
  return "pass";
};

/**
 * Normalize what pb_report_findings received: known statuses and criteria only, last entry per id,
 * and no `met` without evidence. With an expected checklist, ids outside it are dropped.
 */
export function normalizeAcceptance(raw: unknown, expected: AcceptanceCriterion[] = []): AcceptanceCheck[] {
  const known = expected.length ? new Set(expected.map((c) => c.id)) : undefined;
  const byId = new Map<string, AcceptanceCheck>();
  for (const item of Array.isArray(raw) ? raw : []) {
    const x = item as { criterion?: unknown; status?: unknown; evidence?: unknown };
    const criterion = typeof x.criterion === "string" ? x.criterion.trim() : "";
    const status = x.status;
    if (!criterion || (status !== "met" && status !== "not met" && status !== "not verified")) continue;
    if (known && !known.has(criterion)) continue;
    let evidence = typeof x.evidence === "string" ? x.evidence.trim() : "";
    let normalized: AcceptanceStatus = status;
    if (normalized === "met" && !evidence) {
      normalized = "not verified";
      evidence = "no evidence supplied";
    }
    byId.set(criterion, { criterion, status: normalized, evidence });
  }
  return [...byId.values()];
}

/** A pass that answered in prose only: findings are the lines that start with a priority tag (outside fences). */
export function fromProse(text: string): Finding[] {
  const lines = text.split("\n");
  let inFence = false;
  const out: Finding[] = [];
  for (const line of lines) {
    if (/^(\s*)```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = line.match(/^\s*(?:\d+[.)]\s*|[-*]\s*)?\[(P[0-3])\]\s*(.+)$/);
    if (m) out.push({ priority: m[1] as Priority, title: m[2].trim() });
  }
  return out;
}

/**
 * A pass whose report can't be trusted structurally: no tool report, nothing parseable
 * in the prose, yet the prose is substantial (a real report in the wrong shape, not a
 * one-line "done"). An explicit empty report is a report: only `undefined` means the pass
 * never called the tool, since the prompt requires an empty list when there are no findings.
 */
export function unparsedReport(toolFindings: Finding[] | undefined, text: string): boolean {
  return toolFindings === undefined && !fromProse(text).length && text.trim().length > 500;
}

/**
 * The double-check: a fresh background call looks at each P0/P1 finding in the code and confirms or rejects
 * it. Only an explicit rejection drops a finding.
 */
export async function verifyFindings(o: {
  cwd: string;
  findings: Finding[];
  base?: string;
  /** the frozen diff the findings are judged against */
  diff?: string;
  /** the spec's path: the verifier reads it at the source, like the reviewer */
  specPath?: string;
  model?: string;
  thinking?: string;
  /** Cap on concurrent fresh runs (pb config's maxConcurrent; PI_PB_MAX_CONCURRENT outranks it). */
  maxConcurrent?: number;
  signal?: AbortSignal;
  sessionDir?: string;
  onActivity?: RunOptions["onActivity"];
  onUsage?: RunOptions["onUsage"];
  onSession?: RunOptions["onSession"];
  onText?: (text: string) => void;
}): Promise<{ findings: Finding[]; dismissed: { finding: Finding; evidence: string }[]; checked: number; of: number; aborted: boolean; error?: string; sessionFile?: string; tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }; cost: number; ms: number }> {
  const toCheck = o.findings.filter(blocking);
  const none = { findings: o.findings, dismissed: [], checked: 0, of: toCheck.length, aborted: false, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0, ms: 0 };
  if (!toCheck.length) return none;
  const v = await runFresh({
    cwd: o.cwd,
    role: "verifier",
    systemPrompt: VERIFIER_SYSTEM,
    brief: verifierBrief(toCheck, o.base, o.specPath, o.diff),
    prompt: "Verify each finding in the attached file; report with report_verdicts.",
    tools: [...INSPECT, "report_verdicts"],
    extensions: [REVIEW_TOOLS],
    model: o.model,
    thinking: o.thinking,
    maxConcurrent: o.maxConcurrent,
    signal: o.signal,
    sessionDir: o.sessionDir,
    onActivity: o.onActivity,
    onUsage: o.onUsage,
    onSession: o.onSession,
    onText: o.onText,
  });
  const t = v.tokens;
  const usage = { tokens: { input: t.input, output: t.output, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite }, cost: v.cost, sessionFile: v.sessionFile };
  if (v.aborted) return { ...none, ...usage, aborted: true, ms: v.ms };
  // Numbers outside 1..toCheck.length are dropped by the parse (the model miscounted; the harness keeps all findings).
  const answers = verdictAnswers(v.toolCalls, toCheck.length);
  const rejected = new Map<Finding, string>();
  for (const [n, answer] of answers) if (answer.verdict === "rejected") rejected.set(toCheck[n - 1], answer.evidence);
  // A run that failed never reads as agreement, whether or not it got through some of the findings: the
  // report says it fell short, and everything it did not reject stays.
  return { ...usage, checked: answers.size, of: toCheck.length, aborted: false, error: v.error, findings: o.findings.filter((f) => !rejected.has(f)), dismissed: [...rejected].map(([finding, evidence]) => ({ finding, evidence })), ms: v.ms };
}

/**
 * Whether a change stands on ground worth an abuse pass (security, entry points, money, quantities, state),
 * from its spec and its diff: a reason, or undefined. Used with reviewer.security "auto"; deliberately broad.
 */
export function sensitiveGround(o: { spec?: string; files: string[]; diff: string }): string | undefined {
  const specBody = (o.spec ?? "").split("\n");
  let inFence = false;
  const hasThreats = specBody.some((l) => {
    if (/^(\s*)```/.test(l)) {
      inFence = !inFence;
      return false;
    }
    return !inFence && /^##\s+Threats(\s+and\s+abuse)?\s*:?\s*$/i.test(l);
  });
  if (hasThreats) return "the spec has Threats and abuse";
  const words =
    /\b(auth\w*|login|logout|sign-?in|session|token|jwt|oauth|saml|sso|password|passwd|credential|secret|api[_-]?key|permission|role|acl|polic(y|ies)|grant|privilege|admin|csrf|cors|cookie|crypt\w*|hash\w*|signature|upload|download|payment|billing|invoice|refund|webhook|redirect|sanitiz\w*|escape|exec|eval|deserializ\w*|security|route|router|controller|handler|endpoint|resolver|consumer|listener|job|cron|schedul\w*|amount|price|balance|quantity|stock|discount|coupon|credit|limit|quota|status|retry|transfer|withdraw\w*|email|phone|address|ssn|credit.?card)\b/i;
  const file = o.files.find((f) => words.test(f.replace(/[/._-]/g, " ")));
  if (file) return `touches ${file}`;
  const line = o.diff.split("\n").find((l) => /^[+-](?![+-])/.test(l) && words.test(l.slice(1)));
  return line ? `the diff mentions "${line.slice(1).trim().match(words)![0]}"` : undefined;
}

/** Noise words for comparing two fixes: shared filler must not count as overlap. */
const FIX_STOPWORDS = new Set(
  "a,an,the,to,of,in,on,and,or,for,with,that,this,it,as,at,by,be,is,are,was,were,so,either,neither,not,no,nor,than,then,from,into,over,under,its,their,they,them,you,your,our,will,would,should,could,can,just,only,also,when,what,which,who,how,all,any,each,per,such,via,using,use,add,made,keep,left,still,more,most,between,without,within".split(","),
);

/** Significant tokens of a fix: lowercased, split on non-alphanumerics and snake_case, filler dropped. */
const fixTokens = (fix?: string): Set<string> =>
  new Set((fix ?? "").toLowerCase().split(/[\W_]+/).filter((w) => w.length > 1 && !FIX_STOPWORDS.has(w)));

/**
 * Merge findings with the same concrete fix: same file and line, plus fix prescriptions
 * that substantially overlap (near-duplicate fixes for one defect, e.g. filed twice at
 * different priorities). Keeps the highest priority (with its prescription) and joins titles,
 * so nothing reported is lost — only the duplication. Findings without a file, without a
 * fix, or with genuinely different prescriptions stay split: the model is separately
 * instructed to merge same-defect findings itself (which also covers same defect with a
 * different fix); this backstop catches identical prescriptions the instruction missed.
 */
export function mergeFindings(findings: Finding[]): Finding[] {
  const rank = { P0: 0, P1: 1, P2: 2, P3: 3 } as const;
  const out: Finding[] = [];
  for (const f of findings) {
    const ft = fixTokens(f.fix);
    const same =
      f.file === undefined
        ? undefined
        : out.find((o) => {
            if (o.file !== f.file || (o.line ?? -1) !== (f.line ?? -1)) return false;
            const ot = fixTokens(o.fix);
            if (!ft.size || !ot.size) return false;
            const inter = [...ft].filter((w) => ot.has(w)).length;
            return inter / Math.min(ft.size, ot.size) >= 0.5;
          });
    if (!same) {
      out.push({ ...f });
      continue;
    }
    if (rank[f.priority] < rank[same.priority]) {
      same.priority = f.priority;
      same.fix = f.fix;
    }
    // A defect the change is responsible for is not outside it, whichever copy was seen first.
    if (!f.outside) delete same.outside;
    same.map ??= f.map;
    if (!same.title.includes(f.title)) same.title = `${same.title} / ${f.title}`;
  }
  return out;
}

