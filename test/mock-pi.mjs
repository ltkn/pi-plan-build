#!/usr/bin/env node
// Stand-in for the fresh `pi --mode json -p` explorer, reviewer and verifier.
// MOCK_VERIFY=reject makes the verifier reject findings (MOCK_VERIFY=crash blows it up).
import * as fs from "node:fs";
const argv = process.argv.slice(2);
const sys = fs.readFileSync(argv[argv.indexOf("--append-system-prompt") + 1], "utf8");
const brief = fs.readFileSync(argv.find((a) => a.startsWith("@")).slice(1), "utf8");
const usage = { input: 3000, output: 400, cacheRead: 0, cacheWrite: 0, cost: { total: 0.02 } };
// Like pi: a session header first; with --session-dir, the session is saved there.
const id = `mock-${process.pid}-${Date.now()}`;
const dirAt = argv.indexOf("--session-dir");
if (dirAt >= 0) fs.writeFileSync(`${argv[dirAt + 1]}/2026-01-01T00-00-00-000Z_${id}.jsonl`, "{}\n");
console.log(JSON.stringify({ type: "session", version: 3, id }));
// Concurrency probe: mark the live interval so a test can measure overlap.
if (process.env.MOCK_CONCURRENCY_LOG) fs.appendFileSync(process.env.MOCK_CONCURRENCY_LOG, `s ${Date.now()}\n`);
if (process.env.MOCK_HOLD_MS) await new Promise((r) => setTimeout(r, +process.env.MOCK_HOLD_MS));
if (process.env.MOCK_CONCURRENCY_LOG) fs.appendFileSync(process.env.MOCK_CONCURRENCY_LOG, `e ${Date.now()}\n`);
const say = (content) => {
  // The text is streamed in pieces before the message ends.
  for (const part of content.filter((c) => c.type === "text"))
    for (const piece of part.text.match(/[\s\S]{1,12}/g) ?? []) console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: piece } }));
  console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", usage, content } }));
};
const call = (name, args) => ({ type: "toolCall", id: `call-${name}`, name, arguments: args });
// Like Pi: `--tools` replaces the whole tool selection, extension tools included, so a tool it does
// not name is never declared and the model cannot call it. pb's reporting tools must be named there.
const toolsAt = argv.indexOf("--tools");
const declared = toolsAt >= 0 ? new Set(argv[toolsAt + 1].split(",").filter(Boolean)) : null;
const report = (name, args) => {
  if (!declared || declared.has(name)) return say([call(name, args)]);
  say([{ type: "text", text: `(I cannot report: no ${name} tool is declared to me.)` }]);
};

if (sys.includes("ATTACKER")) {
  if (process.env.MOCK_ABUSE === "crash") {
    console.error("abuse pass exploded");
    process.exit(1);
  }
  if (process.env.MOCK_ABUSE_BRIEF_OUT) fs.writeFileSync(process.env.MOCK_ABUSE_BRIEF_OUT, brief);
  if (process.env.MOCK_ABUSE_ARGS_OUT) fs.writeFileSync(process.env.MOCK_ABUSE_ARGS_OUT, argv.join("\n"));
  if (process.env.MOCK_SYSTEM_OUT) fs.writeFileSync(process.env.MOCK_SYSTEM_OUT, sys);
  const findings = process.env.MOCK_ABUSE_FINDINGS ? JSON.parse(process.env.MOCK_ABUSE_FINDINGS) : [];
  report("report_findings", { findings });
  say([{ type: "text", text: "Done." }]);
} else if (sys.includes("SPEC REVIEWER")) {
  // One structured pass: the reviewer reports findings with report_findings; only P0 blocks.
  // =block: a P0; =block-advisory: a P0 plus a P2; =advisory: a P1 plus a P2 (pass);
  // =mixed: a P0 plus a P1; =prose: a report written as prose, no tool call; =crash: exits nonzero
  // with no report. MOCK_SPEC_BRIEF_OUT captures
  // the brief; MOCK_SPEC_EDIT simulates a human editing the spec mid-review.
  if (process.env.MOCK_SPEC_BRIEF_OUT) fs.writeFileSync(process.env.MOCK_SPEC_BRIEF_OUT, brief);
  if (process.env.MOCK_SPEC_ARGS_OUT) fs.writeFileSync(process.env.MOCK_SPEC_ARGS_OUT, argv.join("\n"));
  if (process.env.MOCK_SPEC_EDIT) fs.appendFileSync(process.env.MOCK_SPEC_EDIT, "- Note: edited while the review ran.\n");
  const mode = process.env.MOCK_SPEC_REVIEW;
  if (mode === "crash") {
    console.error("reviewer exploded");
    process.exit(1);
  }
  const p0 = { priority: "P0", file: "spec.md", line: 63, title: "Decisions — unguarded transition", fix: "guard it: src/order.ts:42 has none" };
  const p1 = { priority: "P1", file: "src/order.ts", line: 42, title: "Context — the transition has no guard", fix: "guard it" };
  const p2 = { priority: "P2", file: "spec.md", line: 12, title: "Contracts — unmeasured window", fix: "measure it" };
  if (mode === "prose") {
    // The reviewer did the work and wrote it as prose: no tool call, so pb has nothing to record.
    say([{ type: "text", text: "One P0: the reuse predicate can never match what the script records. Fix: pass $NGRAM_LABEL at scripts/run.sh:460." }]);
  } else if (mode === "block") report("report_findings", { findings: [p0] });
  else if (mode === "block-advisory") report("report_findings", { findings: [p0, p2] });
  else if (mode === "advisory") report("report_findings", { findings: [p1, p2] });
  else if (mode === "mixed") report("report_findings", { findings: [p0, p1] });
  else report("report_findings", { findings: [] });
  say([{ type: "text", text: "Done." }]);
} else if (sys.includes("REVIEWER")) {
  if (process.env.MOCK_BRIEF_OUT) fs.writeFileSync(process.env.MOCK_BRIEF_OUT, brief);
  const findings = [
    { priority: "P3", file: "src/order.ts", line: 12, title: "consider a guard clause", fix: "return early" },
    { priority: "P2", file: "src/order.ts", line: 30, title: "name the constant" },
  ];
  report("report_findings", { findings });
  say([{ type: "text", text: "Acceptance: all met." }]);
} else if (sys.includes("VERIFIER")) {
  if (process.env.MOCK_VERIFIER_BRIEF_OUT) fs.writeFileSync(process.env.MOCK_VERIFIER_BRIEF_OUT, brief);
  if (process.env.MOCK_VERIFY === "crash") {
    console.error("verifier exploded");
    process.exit(1);
  }
  const n = (brief.match(/^\d+\. \[P/gm) ?? []).length;
  const verdict = process.env.MOCK_VERIFY === "reject" ? "rejected" : "confirmed";
  report("report_verdicts", { verdicts: Array.from({ length: n }, (_, i) => ({ finding: i + 1, verdict, evidence: "src/order.ts:11 already guards it" })) });
} else if (sys.includes("CARTOGRAPHER")) {
  // MOCK_MAP_BIG: the first map is far over the budget; the repair call trims it.
  const repairing = brief.startsWith("# Your proposed map");
  if (process.env.MOCK_BRIEF_OUT && !repairing) fs.writeFileSync(process.env.MOCK_BRIEF_OUT, brief);
  if (process.env.MOCK_REPAIR_OUT && repairing) fs.writeFileSync(process.env.MOCK_REPAIR_OUT, brief);
  if (process.env.MOCK_SYSTEM_OUT) fs.writeFileSync(process.env.MOCK_SYSTEM_OUT, sys);
  const gone = (!repairing && !process.env.MOCK_MAP_BIG) || process.env.MOCK_MAP_STUBBORN ? "\n- `src/gone.ts`: removed long ago" : "";
  const big = process.env.MOCK_MAP_BIG && !repairing ? `\n### Filler\n${"- `src/order.ts`: a line that saves nobody anything at all.\n".repeat(2000)}` : "";
  const map = `## Layout\n- \`src/\`: the application\n### Orders\n- \`src/order.ts\`: the order model and its transitions\n- Sign-in: follow \`auth/Login\`.${gone}\n- Services own transactions; controllers never call repositories.\n### Empty${big}`;
  report("report_map", { map, changes: ["added Orders", "noted transactions"] });
} else if (sys.includes("EXPLORER")) {
  if (process.env.MOCK_EXPLORE_WRITE) fs.writeFileSync(process.env.MOCK_EXPLORE_WRITE, "explorer was here");
  const answer = `src/order/Order.java holds the model; OrderService applies transitions. (asked: ${brief.split("\n")[2]})`;
  if (process.env.MOCK_SPLIT_TEXT === "1") {
    const mid = Math.floor(answer.length / 2);
    say([{ type: "text", text: answer.slice(0, mid) }]);
    say([{ type: "text", text: answer.slice(mid) }]);
  } else say([{ type: "text", text: answer }]);
} else if (sys.includes("TRIER")) {
  if (process.env.MOCK_TRY_WRITE) fs.writeFileSync(process.env.MOCK_TRY_WRITE, "trier was here");
  say([{ type: "text", text: `## Commands\n- python3 /tmp/probe.py\n## Result\n- exit 0, 1.2s for 10k rows\n## Conclusion\nProbing is fast enough. (goal: ${brief.split("\n")[2]})` }]);
} else say([{ type: "text", text: "unexpected role" }]);
