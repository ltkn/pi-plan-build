/**
 * The review: a reviewer and an abuse pass, each in a real Pi session you can watch (see /pb:review), report
 * findings through pb_report_findings; a fresh background call double-checks the blocking ones (P0/P1)
 * against the code before they reach you, since a false P1 costs a whole fix cycle.
 */
import { fileURLToPath } from "node:url";
import { VERIFIER_SYSTEM, verifierBrief } from "./prompts.ts";
import { runFresh } from "./runner.ts";
import type { Finding, Priority } from "./store.ts";

export const REVIEW_TOOLS = fileURLToPath(new URL("./review-tools.ts", import.meta.url));
const INSPECT = ["read", "grep", "find", "ls", "bash"];

export type Verdict = "pass" | "changes_needed" | "none";

export const blocking = (f: Finding) => f.priority === "P0" || f.priority === "P1";

/** Any P0 or P1 means changes needed. */
export const verdictOf = (findings: Finding[]): Verdict => (findings.some(blocking) ? "changes_needed" : "pass");

/** A pass that answered in prose only: findings are the lines that start with a priority tag. */
export function fromProse(text: string): Finding[] {
  return [...text.matchAll(/^\s*(?:\d+[.)]\s*|[-*]\s*)?\[(P[0-3])\]\s*(.+)$/gm)].map((m) => ({ priority: m[1] as Priority, title: m[2].trim() }));
}

/**
 * The double-check: a fresh background call looks at each P0/P1 finding in the code and confirms or rejects
 * it. Only an explicit rejection drops a finding.
 */
export async function verifyFindings(o: {
  cwd: string;
  findings: Finding[];
  base?: string;
  spec?: string;
  model?: string;
  thinking?: string;
  signal?: AbortSignal;
  sessionDir?: string;
  onActivity?: (line: string) => void;
  onText?: (text: string) => void;
}): Promise<{ findings: Finding[]; dismissed: { finding: Finding; evidence: string }[]; aborted: boolean; sessionFile?: string; tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }; cost: number }> {
  const toCheck = o.findings.filter(blocking);
  const none = { findings: o.findings, dismissed: [], aborted: false, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 };
  if (!toCheck.length) return none;
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
    sessionDir: o.sessionDir,
    onActivity: o.onActivity,
    onText: o.onText,
  });
  const t = v.tokens;
  const usage = { tokens: { input: t.input, output: t.output, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite }, cost: v.cost, sessionFile: v.sessionFile };
  if (v.aborted) return { ...none, ...usage, aborted: true };
  const verdicts = v.toolCalls.filter((c) => c.name === "report_verdicts").flatMap((c) => (Array.isArray(c.arguments.verdicts) ? (c.arguments.verdicts as { finding: number; verdict: string; evidence: string }[]) : []));
  const rejected = new Map<Finding, string>();
  for (const x of verdicts) if (x.verdict === "rejected" && toCheck[x.finding - 1]) rejected.set(toCheck[x.finding - 1], x.evidence ?? "");
  return { ...usage, aborted: false, findings: o.findings.filter((f) => !rejected.has(f)), dismissed: [...rejected].map(([finding, evidence]) => ({ finding, evidence })) };
}

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

