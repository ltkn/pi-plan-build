/**
 * Every prompt pb sends, rendered with fixed inputs and compared with its snapshot in test/golden/.
 * A prompt change, made directly or through a shared rule, shows up as a plain-text diff of what the
 * model reads, with its word count on the first line: growth is reviewed, not capped.
 * Rewrite the snapshots after an intended change: UPDATE_GOLDEN=1 npm test
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

process.env.PI_CODING_AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pb-agent-dir-")); // never the real ~/.pi
const prompts = await import("../extensions/pb/prompts.ts");
const { CARTOGRAPHER_SYSTEM, cartographerBrief } = await import("../extensions/pb/map.ts");
const { parseSpec } = await import("../extensions/pb/spec.ts");
const { default: pb } = await import("../extensions/pb/index.ts");
type Finding = import("../extensions/pb/store.ts").Finding;

const GOLDEN_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "golden");
const UPDATE = process.env.UPDATE_GOLDEN === "1";

const SPEC = `# Order cancellation
Status: ready
Depends on: none
Verification: tests
New tests: yes

## Goal
A customer can cancel a pending order.
## Findings
- src/order.ts holds the order model.
## Decisions
- Only PENDING orders can be cancelled, because the state machine allows no other transition.
## Contracts
- \`POST /orders/{id}/cancel\` returns 204, or 409 when the order is not pending.
## Tasks
### T1: a pending order can be cancelled
- Acceptance: cancelling a pending order sets it to CANCELLED
- Acceptance: cancelling a shipped order returns 409
- Test: \`npm test -- order-cancel\`
`;

const parsed = parseSpec(SPEC).spec!;
const task = parsed.tasks[0];
const reference = prompts.specReference("order-cancellation");
const findings: Finding[] = [
  { priority: "P1", file: "src/order.ts", line: 42, title: "A shipped order can be cancelled: the state check reads the stale status", fix: "Guard the update with WHERE status = 'PENDING'" },
  { priority: "P2", file: "src/util.ts", line: 7, title: "formatId duplicates ids.format", fix: "Call ids.format", outside: true },
];

/** Every prompt pb sends, by snapshot name. Inputs are fixed so a diff is always a prompt change. */
const RENDERED: Record<string, () => string> = {
  "explorer": () => `${prompts.EXPLORER_SYSTEM}\n\n---\n\n${prompts.explorerBrief("Where are order transitions applied?", "Cancelling orders", prompts.explorerLimits({ commandSec: 120, idleSec: 600, totalSec: 1800 }))}`,
  "trier": () => `${prompts.TRY_SYSTEM}\n\n---\n\n${prompts.tryBrief("Does the ORM lock the row on update?", "Cancelling orders", prompts.probeLimits({ commandSec: 1800, longSec: 1800, totalSec: 900 }))}`,
  "planner-role": () => prompts.PLANNER_ROLE,
  "plan": () => prompts.planPrompt("Let customers cancel pending orders", "npm test", "", "running"),
  "approach": () => prompts.approachPrompt("", ""),
  "deps": () => prompts.depsPrompt("", { testCmd: "npm test", standards: "", baseline: "running", tools: [{ ecosystem: "Node (npm)", outdated: "npm outdated", audit: "npm audit" }, { ecosystem: "Rust", outdated: "cargo outdated", audit: "cargo audit", note: "the cargo-outdated and cargo-audit tools" }] }),
  "spec": () => prompts.specPrompt("", ["order-export"]),
  "finish-spec": () => prompts.finishSpecPrompt("order-cancellation"),
  "checkpoint": () => prompts.checkpointPrompt(72, ["order-cancellation"]),
  "continue-plan": () => prompts.continuePlanPrompt("order-cancellation", SPEC, ""),
  "build-intro": () => prompts.buildIntro("order-cancellation", parsed, "npx tsc --noEmit", false, ""),
  "task": () => prompts.taskPrompt(task, 1, 3, ["npx tsc --noEmit", task.test!], true, reference, "Already done: T0 (src/order.ts [Order])", "npm run lint --silent"),
  "cohere": () => prompts.coherePrompt("abc1234", 1, 3, reference),
  "check-failed": () => prompts.fixText("T1", "`npm test -- order-cancel`", "1 failing: expected 409, got 200", 1, 3, false, reference),
  "nudge": () => prompts.nudgePrompt("T1"),
  "fix-seed": () => prompts.fixSeedPrompt("order-cancellation", findings, reference),
  "reviewer": () => prompts.reviewSessionPrompt("(the brief: see reviewer-brief)"),
  "reviewer-brief": () =>
    prompts.reviewerBrief({
      spec: { name: "order-cancellation", parsed },
      acceptance: [
        { id: "T1.1", text: "cancelling a pending order sets it to CANCELLED", task: "T1" },
        { id: "T1.2", text: "cancelling a shipped order returns 409", task: "T1" },
      ],
      base: "abc1234",
      diff: "diff --git a/src/order.ts b/src/order.ts\n+export function cancel() {}",
      changed: ["src/order.ts"],
      stat: " 1 file changed, 1 insertion(+)",
      check: "`npm test` → PASS in 3s",
      focus: "",
    }),
  "attacker": () => prompts.ATTACKER_SYSTEM,
  "verifier": () => `${prompts.VERIFIER_SYSTEM}\n\n---\n\n${prompts.verifierBrief(findings, "abc1234", ".pi/pb/specs/order-cancellation/spec.md", "+export function cancel() {}")}`,
  "spec-reviewer": () => `${prompts.SPEC_REVIEWER_SYSTEM}\n\n---\n\n${prompts.specReviewBrief("order-cancellation", SPEC)}`,
  "spec-fix": () => prompts.specFixPrompt({ name: "order-cancellation", work: "findings", items: ["1. [P1] The 409 is not pinned by any code path"], lap: 1 }),
  "claim-check": () => `${prompts.SPEC_CLAIM_CHECK_SYSTEM}\n\n---\n\n${prompts.claimCheckBrief("order-cancellation", SPEC)}`,
  "cartographer": () => CARTOGRAPHER_SYSTEM,
  "cartographer-brief": () => cartographerBrief({ current: "### Layout\n- `src/order.ts`: the order model" }),
  "cartographer-brief-change": () =>
    cartographerBrief({
      current: "### Layout\n- `src/order.ts`: the order model",
      spec: { name: "order-cancellation", findings: "- src/order.ts holds the order model." },
      changed: ["src/order.ts"],
      scope: "change",
      base: "abc1234",
      recheck: [{ heading: "### Layout", text: "- `src/order.ts`: the order model" }],
    }),
};

/** The tools as the model sees them: each name, description and parameter schema, in registration order. */
const toolDefinitions = (): string => {
  const tools: Array<{ name: string; description: string; parameters: unknown }> = [];
  const recordingPi = new Proxy({}, { get: (_target, key) => (key === "registerTool" ? (tool: (typeof tools)[number]) => tools.push(tool) : () => undefined) });
  pb(recordingPi as never);
  return tools.map((t) => `## ${t.name}\n\n${t.description}\n\n${JSON.stringify(t.parameters, null, 2)}`).join("\n\n");
};
RENDERED.tools = toolDefinitions;

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;
const snapshot = (text: string) => `words: ${words(text)}\n\n${text}\n`;

for (const [name, render] of Object.entries(RENDERED)) {
  test(`golden prompt: ${name}`, () => {
    const file = path.join(GOLDEN_DIR, `${name}.txt`);
    const actual = snapshot(render());
    if (UPDATE) {
      fs.mkdirSync(GOLDEN_DIR, { recursive: true });
      fs.writeFileSync(file, actual);
      return;
    }
    assert.ok(fs.existsSync(file), `no snapshot for "${name}": run UPDATE_GOLDEN=1 npm test, then review test/golden/${name}.txt`);
    assert.equal(actual, fs.readFileSync(file, "utf8"), `"${name}" changed: review the diff, then UPDATE_GOLDEN=1 npm test`);
  });
}

test("golden prompts: every snapshot belongs to a rendered prompt", () => {
  const stale = fs.existsSync(GOLDEN_DIR) ? fs.readdirSync(GOLDEN_DIR).filter((f) => !(f.replace(/\.txt$/, "") in RENDERED)) : [];
  assert.deepEqual(stale, [], "a snapshot whose prompt is gone: delete it");
});
