/**
 * The review: a fresh reviewer reports findings through a tool; a second fresh call double-checks
 * the blocking ones (P0/P1) against the code before they reach you, since a false P1 costs a whole
 * fix cycle. The verdict follows from the confirmed findings.
 */
import { fileURLToPath } from "node:url";
import { ATTACKER_SYSTEM, REVIEWER_SYSTEM, VERIFIER_SYSTEM, verifierBrief } from "./prompts.ts";
import { type RunResult, runFresh } from "./runner.ts";
import type { Finding, Priority } from "./store.ts";

export const REVIEW_TOOLS = fileURLToPath(new URL("./review-tools.ts", import.meta.url));
const INSPECT = ["read", "grep", "find", "ls", "bash"];

export type Verdict = "pass" | "changes_needed" | "none";

export interface ReviewOutcome {
  aborted: boolean;
  error?: string;
  /** the reviewer's reply besides the findings (e.g. the acceptance checklist) */
  prose: string;
  findings: Finding[];
  dismissed: { finding: Finding; evidence: string }[];
  verdict: Verdict;
  /** the abuse pass ran */
  security?: boolean;
  /** each pass's saved session, to open with `pi --session <file>` */
  transcripts: { pass: string; file: string }[];
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  cost: number;
  ms: number;
}

const blocking = (f: Finding) => f.priority === "P0" || f.priority === "P1";

/**
 * Whether a change stands on ground worth an abuse pass (security, entry points, money, quantities, state),
 * from its spec and its diff: a reason, or undefined. Used with reviewer.security "auto"; deliberately broad.
 */
export function sensitiveGround(o: { spec?: string; files: string[]; diff: string }): string | undefined {
  if (o.spec && /^##\s+Threats(\s+and\s+abuse)?\s*$/im.test(o.spec)) return "the spec has Threats and abuse";
  const words =
    /\b(auth\w*|login|logout|sign-?in|session|token|jwt|oauth|saml|sso|password|passwd|credential|secret|api[_-]?key|permission|role|acl|polic(y|ies)|grant|privilege|admin|csrf|cors|cookie|crypt\w*|hash\w*|signature|upload|download|payment|billing|invoice|refund|webhook|redirect|sanitiz\w*|escape|exec|eval|deserializ\w*|security|route|router|controller|handler|endpoint|resolver|consumer|listener|job|cron|schedul\w*|amount|price|balance|quantity|stock|discount|coupon|credit|limit|quota|status|retry|transfer|withdraw\w*)\b/i;
  const file = o.files.find((f) => words.test(f.replace(/[/._-]/g, " ")));
  if (file) return `touches ${file}`;
  const line = o.diff.split("\n").find((l) => /^\+(?!\+\+)/.test(l) && words.test(l));
  return line ? `the diff mentions "${line.slice(1).trim().match(words)![0]}"` : undefined;
}

/** Findings from the report_findings calls; undefined when the reviewer never called it. */
function reported(res: RunResult): Finding[] | undefined {
  const calls = res.toolCalls.filter((c) => c.name === "report_findings");
  if (!calls.length) return undefined;
  return calls.flatMap((c) => (Array.isArray(c.arguments.findings) ? (c.arguments.findings as Finding[]) : [])).filter((f) => /^P[0-3]$/.test(f.priority) && f.title);
}

/** A reviewer that answered in prose only: findings are the lines that start with a priority tag. */
function fromProse(text: string): Finding[] {
  return [...text.matchAll(/^\s*(?:\d+[.)]\s*|[-*]\s*)?\[(P[0-3])\]\s*(.+)$/gm)].map((m) => ({ priority: m[1] as Priority, title: m[2].trim() }));
}

export async function runReview(o: {
  cwd: string;
  brief: string;
  base?: string;
  spec?: string;
  model?: string;
  thinking?: string;
  verify: boolean;
  /** where each pass saves its session (by role) */
  sessionDir?: (role: string) => string;
  /** a pass's current text (and thinking) as it's written */
  onText?: (pass: string, text: string) => void;
  /** why the change gets an abuse pass, if it does */
  security?: string;
  signal?: AbortSignal;
  onPhase?: (phase: string, activity?: string) => void;
}): Promise<ReviewOutcome> {
  const out: ReviewOutcome = { aborted: false, prose: "", findings: [], dismissed: [], verdict: "none", tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0, ms: 0, transcripts: [] };
  // Each pass: its session saved (to open afterwards), its text streamed (to watch now).
  const watched = (pass: string, role: string) => ({
    sessionDir: o.sessionDir?.(role),
    onText: (t: string) => o.onText?.(pass, t),
  });
  const add = (r: RunResult, pass?: string) => {
    if (pass && r.sessionFile) out.transcripts.push({ pass, file: r.sessionFile });
    for (const k of ["input", "output", "cacheRead", "cacheWrite"] as const) out.tokens[k] += r.tokens[k];
    out.cost += r.cost;
    out.ms += r.ms;
  };

  o.onPhase?.("fresh reviewer");
  const res = await runFresh({
    cwd: o.cwd,
    role: "reviewer",
    systemPrompt: REVIEWER_SYSTEM,
    brief: o.brief,
    prompt: "Review the change described in the attached file; report the findings with report_findings.",
    tools: [...INSPECT, "report_findings"],
    extensions: [REVIEW_TOOLS],
    model: o.model,
    thinking: o.thinking,
    signal: o.signal,
    onActivity: (a) => o.onPhase?.("fresh reviewer", a),
    ...watched("reviewer", "reviewer"),
  });
  add(res, "reviewer");
  if (res.aborted) return { ...out, aborted: true };
  const findings = reported(res);
  out.prose = res.text.replace(/^\s*VERDICT:.*$/gim, "").trim();
  if (!findings) {
    if (!res.text.trim()) return { ...out, error: res.error ?? "the reviewer produced no output" };
    out.findings = fromProse(res.text);
    // Neither tool call nor tags: an old-style VERDICT line is all there is.
    const line = [...res.text.matchAll(/^\s*VERDICT:\s*(pass|changes_needed)\b/gim)].at(-1)?.[1].toLowerCase() as Verdict | undefined;
    out.verdict = out.findings.length ? (out.findings.some(blocking) ? "changes_needed" : "pass") : (line ?? "none");
    return out;
  }
  out.findings = findings;

  // The abuse pass: a second fresh call whose only job is to break the change.
  if (o.security) {
    o.onPhase?.(`abuse pass (${o.security})`);
    const a = await runFresh({
      cwd: o.cwd,
      role: "attacker",
      systemPrompt: ATTACKER_SYSTEM,
      brief: o.brief,
      prompt: "Find how the change described in the attached file can be abused; report with report_findings.",
      tools: [...INSPECT, "report_findings"],
      extensions: [REVIEW_TOOLS],
      model: o.model,
      thinking: o.thinking,
      signal: o.signal,
      onActivity: (x) => o.onPhase?.("abuse pass", x),
      ...watched("abuse pass", "abuse"),
    });
    add(a, "abuse pass");
    if (a.aborted) return { ...out, aborted: true };
    out.findings = [...out.findings, ...(reported(a) ?? []).map((f) => ({ ...f, title: `Abuse: ${f.title}` }))];
    out.security = true;
  }

  const toCheck = out.findings.filter(blocking);
  if (o.verify && toCheck.length) {
    o.onPhase?.("verifying P0/P1 findings");
    const v = await runFresh({
      cwd: o.cwd,
      role: "verifier",
      systemPrompt: VERIFIER_SYSTEM,
      brief: verifierBrief(toCheck, o.base, o.spec),
      prompt: "Verify each finding in the attached file; report with report_verdicts.",
      tools: [...INSPECT, "report_verdicts"],
      extensions: [REVIEW_TOOLS],
      model: o.model,
      thinking: o.thinking,
      signal: o.signal,
      onActivity: (a) => o.onPhase?.("verifying P0/P1 findings", a),
      ...watched("verifier", "verifier"),
    });
    add(v, "verifier");
    if (v.aborted) return { ...out, aborted: true };
    const verdicts = v.toolCalls.filter((c) => c.name === "report_verdicts").flatMap((c) => (Array.isArray(c.arguments.verdicts) ? (c.arguments.verdicts as { finding: number; verdict: string; evidence: string }[]) : []));
    const rejected = new Map(verdicts.filter((x) => x.verdict === "rejected").map((x) => [toCheck[x.finding - 1], x.evidence ?? ""]));
    rejected.delete(undefined as unknown as Finding);
    // A finding the verifier didn't rule on stays: only an explicit rejection drops it.
    out.findings = out.findings.filter((f) => !rejected.has(f));
    out.dismissed = [...rejected].map(([finding, evidence]) => ({ finding, evidence }));
  }
  out.verdict = out.findings.some(blocking) ? "changes_needed" : "pass";
  return out;
}
