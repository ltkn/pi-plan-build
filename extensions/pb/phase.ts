/**
 * The build's lifecycle as data: which phase may follow which, and what comes after a passed step.
 * Pure (no I/O): every phase change goes through here, so the lifecycle is read in one place and an
 * impossible move fails loudly instead of leaving a record no command knows how to continue.
 */
import { type Phase, type Progress, type TaskProgress, COHERE_TASK_ID } from "./store.ts";

/**
 * Which phase may follow which. Staying in a phase is always allowed: a repeated transition is a no-op.
 * Any phase may (re)start a build; only a build finishes, only a finished build is reviewed.
 * `/pb:undo` is the one move outside the table (`restorePhase`): it returns to a recorded state.
 */
export const PHASE_TRANSITIONS: Readonly<Record<Phase, readonly Phase[]>> = {
  written: ["building"],
  building: ["paused", "built"],
  paused: ["building"],
  built: ["building", "reviewed"],
  reviewed: ["building"],
};

/** The phase `to`, or a throw when the lifecycle has no such move from `from`. */
export function nextPhase(from: Phase, to: Phase): Phase {
  if (from !== to && !PHASE_TRANSITIONS[from].includes(to)) throw new Error(`pb: a build cannot go from "${from}" to "${to}"`);
  return to;
}

/** A build is under way: running or paused, with a step to come back to. */
export const unfinishedPhase = (phase?: string) => phase === "building" || phase === "paused";

/** Start (or resume) a step: the build is running it. */
export function enterStep(p: Progress, step: string): void {
  p.phase = nextPhase(p.phase, "building");
  p.current = step;
  p.pause = undefined;
}

/** Stop the build where it stands, with the reason the human reads. */
export function pauseAt(p: Progress, reason: string): void {
  p.phase = nextPhase(p.phase, "paused");
  p.pause = reason;
}

/** Every step passed: the build is done and no step is current. */
export function finishBuild(p: Progress): void {
  p.phase = nextPhase(p.phase, "built");
  p.tasks = p.tasks.filter((t) => t.id !== "final");
  p.current = undefined;
  p.nudged = undefined;
}

/** A complete review passed a finished build. */
export function markReviewed(p: Progress): void {
  p.phase = nextPhase(p.phase, "reviewed");
}

/** `/pb:undo` back to a recorded state: outside the table on purpose, the row is the authority. */
export function restorePhase(p: Progress, phase: Phase | undefined, reason: string): void {
  p.phase = phase ?? "paused";
  p.pause = p.phase === "paused" ? reason : undefined;
}

/** The first spec task still to do, in list order. */
export const nextTodo = (p: Progress): TaskProgress | undefined => p.tasks.find((t) => t.status === "doing" || t.status === "todo");

/** What follows a passed step. */
export type NextStep = { kind: "task"; id: string } | { kind: "cohere" } | { kind: "final"; suiteDone: boolean } | { kind: "done" };

/**
 * After a step passed: the next task; else, on a build big enough to drift, one coherence pass; else
 * the final check, unless the step that just passed was that check already and no project check is
 * left to run; else done.
 */
export function nextStep(p: Progress, o: { cohere: boolean; endCommand: string | null; ran: string | null; extraChecks: boolean }): NextStep {
  const final = p.current === "final";
  const todo = nextTodo(p);
  if (todo) return { kind: "task", id: todo.id };
  if (!final && p.current !== COHERE_TASK_ID && !p.tasks.some((t) => t.id === COHERE_TASK_ID) && o.cohere) return { kind: "cohere" };
  if (!final && ((o.endCommand && o.ran !== o.endCommand) || o.extraChecks)) return { kind: "final", suiteDone: !!o.endCommand && o.ran === o.endCommand };
  return { kind: "done" };
}
