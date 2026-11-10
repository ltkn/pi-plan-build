/** The build's lifecycle: the transition table, the guarded moves, and what follows a passed step. */
import assert from "node:assert/strict";
import { test } from "node:test";

const { PHASE_TRANSITIONS, enterStep, finishBuild, markReviewed, nextPhase, nextStep, pauseAt, restorePhase } = await import("../extensions/pb/phase.ts");
type Progress = import("../extensions/pb/store.ts").Progress;
type Phase = import("../extensions/pb/store.ts").Phase;

const PHASES: Phase[] = ["written", "building", "paused", "built", "reviewed"];

const progress = (phase: Phase, tasks: Progress["tasks"] = [], current?: string): Progress => ({ spec: "s", phase, tasks, current, updatedAt: "" });
const task = (id: string, status: "todo" | "doing" | "done") => ({ id, title: id, status, attempts: 1 });

test("phase: only the lifecycle's moves are allowed; staying put is always a no-op", () => {
  const allowed = new Set(PHASES.flatMap((from) => PHASE_TRANSITIONS[from].map((to) => `${from}>${to}`)));
  for (const from of PHASES) {
    for (const to of PHASES) {
      if (from === to || allowed.has(`${from}>${to}`)) assert.equal(nextPhase(from, to), to);
      else assert.throws(() => nextPhase(from, to), new RegExp(`cannot go from "${from}" to "${to}"`));
    }
  }
  // The moves that would strand a record: nothing but a build reaches "built", nothing but a finished build is reviewed.
  for (const [from, to] of [["written", "built"], ["paused", "built"], ["building", "reviewed"], ["paused", "reviewed"], ["written", "reviewed"], ["built", "paused"], ["reviewed", "paused"], ["reviewed", "written"]] as const) {
    assert.throws(() => nextPhase(from, to));
  }
});

test("phase: a step is entered from any phase that can (re)start a build, and clears the pause", () => {
  for (const from of ["written", "paused", "built", "reviewed", "building"] as const) {
    const p = progress(from);
    p.pause = "stopped";
    enterStep(p, "T2");
    assert.deepEqual([p.phase, p.current, p.pause], ["building", "T2", undefined]);
  }
});

test("phase: a pause needs a running build and keeps the reason; a finished build cannot be paused", () => {
  const p = progress("building", [], "T1");
  pauseAt(p, "T1 still fails after 3 attempts.");
  assert.deepEqual([p.phase, p.pause, p.current], ["paused", "T1 still fails after 3 attempts.", "T1"]);
  pauseAt(p, "again"); // a repeat is a no-op move
  assert.equal(p.phase, "paused");
  assert.throws(() => pauseAt(progress("built"), "late"));
});

test("phase: finishing drops the final step and the current one; only a finished build is reviewed", () => {
  const p = progress("building", [task("T1", "done"), task("final", "doing")], "final");
  p.nudged = "final";
  finishBuild(p);
  assert.deepEqual([p.phase, p.current, p.nudged, p.tasks.map((t) => t.id)], ["built", undefined, undefined, ["T1"]]);
  markReviewed(p);
  assert.equal(p.phase, "reviewed");
  assert.throws(() => markReviewed(progress("paused")));
  assert.throws(() => finishBuild(progress("paused")));
});

test("phase: undo restores the recorded phase outside the table, paused with the reason when none was recorded", () => {
  const p = progress("reviewed");
  restorePhase(p, "built", "undone to before T2");
  assert.deepEqual([p.phase, p.pause], ["built", undefined]);
  restorePhase(p, undefined, "undone to before T2");
  assert.deepEqual([p.phase, p.pause], ["paused", "undone to before T2"]);
});

test("next step: tasks first, then one coherence pass when the build needs it, then the final check, then done", () => {
  const checks = { cohere: true, endCommand: "npm test", ran: "npx tsc --noEmit", extraChecks: false };
  assert.deepEqual(nextStep(progress("building", [task("T1", "done"), task("T2", "todo")], "T1"), checks), { kind: "task", id: "T2" });
  const done = [task("T1", "done"), task("T2", "done"), task("T3", "done")];
  assert.deepEqual(nextStep(progress("building", done, "T3"), checks), { kind: "cohere" });
  assert.deepEqual(nextStep(progress("building", [...done, task("cohere", "done")], "cohere"), checks), { kind: "final", suiteDone: false });
  assert.deepEqual(nextStep(progress("building", [...done, task("cohere", "done")], "T3"), checks), { kind: "final", suiteDone: false }); // never a second pass
  assert.deepEqual(nextStep(progress("building", done, "T3"), { ...checks, cohere: false }), { kind: "final", suiteDone: false });
  assert.deepEqual(nextStep(progress("building", [...done, task("final", "done")], "final"), checks), { kind: "done" });
});

test("next step: the suite the last task already ran is not run again, unless a project check still has to", () => {
  const done = [task("T1", "done")];
  const ranSuite = { cohere: false, endCommand: "npm test", ran: "npm test", extraChecks: false };
  assert.deepEqual(nextStep(progress("building", done, "T1"), ranSuite), { kind: "done" });
  assert.deepEqual(nextStep(progress("building", done, "T1"), { ...ranSuite, extraChecks: true }), { kind: "final", suiteDone: true });
  assert.deepEqual(nextStep(progress("building", done, "T1"), { ...ranSuite, endCommand: null, ran: null }), { kind: "done" }); // verification "none"
});
