/**
 * Where a spec stands and what the human does next: the one derivation every place that tells you the next step
 * reads (the footer, the terminal title, /pb:status, /pb:help, the session greeting, the next-step shortcut). It is
 * computed from the spec's own records (progress, events, the text on disk), never stored, so it cannot go stale.
 */
import * as path from "node:path";
import { type Progress, PREFIX, Store, readEvents } from "./store.ts";
import { parseSpec, specHash } from "./spec.ts";

const cmd = (verb: string) => `${PREFIX}:${verb}`;

export interface Where {
  spec?: string;
  /** where things stand, a few words: "built", "review: CHANGES NEEDED (2 open)" */
  state: string;
  /** what to do next, in words, with the command when there is one */
  next: string;
  /** the command that takes that step, ready for the editor; absent when the next step isn't a command */
  command?: string;
}

/** The last spec-review verdict recorded on exactly this text: a review of older bytes says nothing about it. */
export const specReviewOn = (store: Store, name: string, md: string): Record<string, unknown> | undefined => {
  const hash = specHash(md);
  return readEvents(path.join(store.specDir(name), "events.jsonl"))
    .filter((e) => e.type === "spec-review" && (e.verdict === "pass" || e.verdict === "block") && e.hash === hash)
    .at(-1);
};

/** Where one spec stands and its next step. */
export function whereNext(store: Store, name: string): Where {
  const md = store.readSpec(name);
  if (md === undefined) return { spec: name, state: "no spec", next: `/${cmd("status")} lists the specs`, command: `/${cmd("status")}` };
  const spec = parseSpec(md).spec;
  if (!spec) return { spec: name, state: "spec doesn't parse", next: `rewrite it: /${cmd("spec")} ${name}`, command: `/${cmd("spec")} ${name}` };
  const p: Progress | undefined = store.progress(name);
  if (p?.fix) return { spec: name, state: `${p.fix.driver ? "hardening" : "repairing"} the spec (lap ${p.fix.laps})`, next: "let the repair lap finish and report" };
  const phase = p?.phase ?? "written";
  if (phase === "written") {
    if (spec.status === "planning") return { spec: name, state: "planning", next: `answer the open questions, then /${cmd("spec")} ${name} finishes the spec`, command: `/${cmd("spec")} ${name}` };
    const review = specReviewOn(store, name, md);
    const reported = Array.isArray(review?.reported) ? (review.reported as { priority?: string }[]) : [];
    const p1 = reported.filter((f) => f.priority === "P1").length;
    if (review?.verdict === "block") return { spec: name, state: "spec review found a P0", next: `/${cmd("spec-fix")} ${name} repairs it, or /${cmd("spec")} ${name}`, command: `/${cmd("spec-fix")} ${name}` };
    if (review?.verdict === "pass" && p1)
      return { spec: name, state: `spec reviewed: ${p1} P1`, next: `/${cmd("spec-harden")} ${name} repairs the P1${p1 === 1 ? "" : "s"}, or /${cmd("build")} ${name} builds on ${p1 === 1 ? "it" : "them"}`, command: `/${cmd("build")} ${name}` };
    if (review?.verdict === "pass") return { spec: name, state: "spec reviewed", next: `/${cmd("build")} ${name}`, command: `/${cmd("build")} ${name}` };
    return { spec: name, state: "spec ready", next: `/${cmd("build")} ${name} (it reviews the spec first), or /${cmd("spec-review")} ${name} on its own`, command: `/${cmd("build")} ${name}` };
  }
  if (phase === "building") return { spec: name, state: `building ${p?.current ?? ""}`.trim(), next: "the build is running: it says when it needs you" };
  if (phase === "paused") return { spec: name, state: `paused${p?.pause ? `: ${p.pause.replace(/\s+/g, " ").slice(0, 80)}` : ""}`, next: `/${cmd("build")} ${name} resumes`, command: `/${cmd("build")} ${name}` };
  if (phase === "reviewed") return { spec: name, state: "reviewed: PASS", next: `commit, then /${cmd("archive")} ${name}`, command: `/${cmd("archive")} ${name}` };
  // built: the review is next, or what the last review asked for.
  const review = p?.review;
  if (!review) return { spec: name, state: "built", next: `/${cmd("review")} ${name}`, command: `/${cmd("review")} ${name}` };
  const events = readEvents(path.join(store.specDir(name), "events.jsonl"));
  const lastReview = events.map((e) => e.type).lastIndexOf("review");
  const fixedSince = events.slice(lastReview + 1).some((e) => e.type === "fix");
  if (fixedSince) return { spec: name, state: "fixed, not re-reviewed", next: `/${cmd("review")} ${name} checks the fixes`, command: `/${cmd("review")} ${name}` };
  const open = review.findings.filter((f) => f.priority !== "P3").length;
  if (review.verdict === "changes_needed" && open)
    return { spec: name, state: `review: CHANGES NEEDED (${open} open)`, next: `/${cmd("fix")} ${name} fixes them (or fix by hand), then /${cmd("review")} ${name}`, command: `/${cmd("fix")} ${name}` };
  if (review.verdict === "unverified") return { spec: name, state: "review: UNVERIFIED", next: `make the failing check pass or verify the open criteria, then /${cmd("review")} ${name}`, command: `/${cmd("review")} ${name}` };
  return { spec: name, state: `review: ${review.verdict === "pass" ? "PASS" : review.verdict}`, next: `/${cmd("review")} ${name}`, command: `/${cmd("review")} ${name}` };
}

/**
 * Where this session stands: the session's own pb role first (a fix lap, a review, a repair lap, a build, a
 * spec it wrote, planning), else the project's one live spec. Undefined when there is no pb work to point at.
 */
export function whereHere(store: Store, session: string | undefined): Where | undefined {
  const fixing = store.fixSession(session);
  if (fixing) return { spec: fixing.spec, state: "fix lap", next: "fix the findings, then report with pb_fix_done" };
  const reviewing = store.reviewSession(session);
  if (reviewing) return { spec: reviewing.spec, state: "review session (read-only)", next: `the review reports here; /${cmd("review")} done ends it` };
  const repair = store.fixOfSession(session);
  if (repair) return whereNext(store, repair.name);
  const own = store.specForSession(session) ?? store.writtenSpec(session)?.name;
  if (own) return whereNext(store, own);
  if (session && store.planningSessions().includes(session))
    return { state: "planning", next: `discuss; /${cmd("spec")} writes the spec, /${cmd("build")} writes and builds it`, command: `/${cmd("build")}` };
  const live = store.specNames();
  if (live.length === 1) return whereNext(store, live[0]);
  if (live.length > 1) return { state: `${live.length} specs in progress`, next: `/${cmd("status")} shows each one's next step`, command: `/${cmd("status")}` };
  return undefined;
}

/** The footer line: short, the command first. */
export const statusLine = (w: Where): string => `pb${w.spec ? ` · ${w.spec}` : ""} · ${w.state} · next: ${w.command ?? w.next}`;
