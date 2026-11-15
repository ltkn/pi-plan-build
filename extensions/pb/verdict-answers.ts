/**
 * The answers a fresh run gave through `report_verdicts`. The verifier numbers the blocking findings and
 * the map check numbers the new map lines, and both read the same payload, so what counts as an answer for
 * item n is decided once: an unknown verdict word, a number outside `1..of`, and evidence that is missing or
 * blank once flattened to one safe line are no answer. `verdictAnswers` keeps the last entry per number (what "how
 * many were answered" counts); `rejectedAnswers` keeps every rejection, so a later confirmation cannot
 * erase one (what the map check hands to the repair pass).
 */
import { safeLine } from "./markdown.ts";
import type { ToolCall } from "./runner.ts";

/** One entry of a `report_verdicts` payload as it arrived: model-authored, so no field is trusted. */
export interface ReportedVerdict {
  finding?: unknown;
  verdict?: unknown;
  evidence?: unknown;
}

/** What an answer says about one numbered item. Distinct from a review's `Verdict` (pass / changes needed). */
export interface VerdictAnswer {
  verdict: "confirmed" | "rejected";
  evidence: string;
}

/** The verdict entries of every `report_verdicts` call, in order and as they arrived — the entries that count and the ones that don't. */
export function reportedVerdicts(toolCalls: ToolCall[]): ReportedVerdict[] {
  return toolCalls
    .filter((c) => c.name === "report_verdicts")
    .flatMap((c) => (Array.isArray(c.arguments.verdicts) ? (c.arguments.verdicts as ReportedVerdict[]) : []));
}

/** One arrival that is a whole answer for its number, or nothing: known word, item in range, readable evidence. */
function countedVerdict(x: unknown, of: number): { number: number; answer: VerdictAnswer } | undefined {
  if (!x || typeof x !== "object") return undefined;
  const entry = x as ReportedVerdict;
  const finding = entry.finding;
  if (typeof finding !== "number" || !Number.isInteger(finding) || finding < 1 || finding > of) return undefined;
  const verdict = entry.verdict;
  if (verdict !== "confirmed" && verdict !== "rejected") return undefined;
  // Flattened, not refused: a rejection whose evidence spans two lines is still a rejection, and dropping it
  // would let a contradicted map line through as merely unanswered.
  const evidence = typeof entry.evidence === "string" ? safeLine(entry.evidence) : "";
  if (!evidence) return undefined;
  return { number: finding, answer: { verdict, evidence } };
}

/**
 * The answers keyed by item number, so `size` is how many items were answered. `of` is how many items the
 * brief handed over, never a number read off the payload: the payload cannot raise the count above what it
 * was given, repeated entries for one number count once, and the last countable entry for a number wins.
 */
export function verdictAnswers(toolCalls: ToolCall[], of: number): Map<number, VerdictAnswer> {
  const byNumber = new Map<number, VerdictAnswer>();
  for (const x of reportedVerdicts(toolCalls)) {
    const counted = countedVerdict(x, of);
    if (counted) byNumber.set(counted.number, counted.answer);
  }
  return byNumber;
}

/**
 * The numbers any entry rejected, with that rejection's evidence. A rejection is sticky: a later
 * confirmation for the same number does not undo it, so a contradicted map line cannot disappear from
 * the repair pass because the checker changed its mind on a second call.
 */
export function rejectedAnswers(toolCalls: ToolCall[], of: number): Map<number, string> {
  const rejected = new Map<number, string>();
  for (const x of reportedVerdicts(toolCalls)) {
    const counted = countedVerdict(x, of);
    if (counted?.answer.verdict === "rejected") rejected.set(counted.number, counted.answer.evidence);
  }
  return rejected;
}
