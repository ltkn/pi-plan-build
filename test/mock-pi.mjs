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

if (sys.includes("ATTACKER")) {
  say([call("report_findings", { findings: [] })]);
  say([{ type: "text", text: "Done." }]);
} else if (sys.includes("SPEC REVIEWER")) {
  // MOCK_SPEC_REVIEW=block: a P0 plus a block verdict; =block-bullets: the same finding written
  // as a Markdown list; =block-untagged: a block verdict with no parseable finding; =advisory:
  // a P2 that travels on; =empty: a P1 on a silent empty path plus a block verdict.
  // MOCK_SPEC_BRIEF_OUT captures the brief; MOCK_SPEC_EDIT simulates the human editing the spec mid-review.
  if (process.env.MOCK_SPEC_BRIEF_OUT) fs.writeFileSync(process.env.MOCK_SPEC_BRIEF_OUT, brief);
  if (process.env.MOCK_SPEC_EDIT) fs.appendFileSync(process.env.MOCK_SPEC_EDIT, "- Note: edited while the review ran.\n");
  const mode = process.env.MOCK_SPEC_REVIEW;
  if (mode === "block") say([{ type: "text", text: "[P0] Decisions — unguarded transition\nFix: guard it\n\nVERDICT: block" }]);
  else if (mode === "block-bullets")
    say([{ type: "text", text: "## Findings\n\n- [P1] Decisions — unguarded transition\n  Fix: guard it\n\n## Verdict — VERDICT: block" }]);
  else if (mode === "block-untagged") say([{ type: "text", text: "The spec has an unstated empty path.\n\nVERDICT: block" }]);
  else if (mode === "advisory") say([{ type: "text", text: "[P2] Contracts — unmeasured window\nFix: measure it\n\nVERDICT: pass" }]);
  else if (mode === "empty") say([{ type: "text", text: "[P1] Tasks — silent flush leaves a stale banner standing\nFix: reconcile it\n\nVERDICT: block" }]);
  else say([{ type: "text", text: "VERDICT: pass" }]);
} else if (sys.includes("REVIEWER")) {
  if (process.env.MOCK_BRIEF_OUT) fs.writeFileSync(process.env.MOCK_BRIEF_OUT, brief);
  const findings = [
    { priority: "P3", file: "src/order.ts", line: 12, title: "consider a guard clause", fix: "return early" },
    { priority: "P2", file: "src/order.ts", line: 30, title: "name the constant" },
  ];
  say([call("report_findings", { findings })]);
  say([{ type: "text", text: "Acceptance: all met." }]);
} else if (sys.includes("VERIFIER")) {
  if (process.env.MOCK_VERIFY === "crash") {
    console.error("verifier exploded");
    process.exit(1);
  }
  const n = (brief.match(/^\d+\. \[P/gm) ?? []).length;
  const verdict = process.env.MOCK_VERIFY === "reject" ? "rejected" : "confirmed";
  say([call("report_verdicts", { verdicts: Array.from({ length: n }, (_, i) => ({ finding: i + 1, verdict, evidence: "src/order.ts:11 already guards it" })) })]);
} else if (sys.includes("CARTOGRAPHER")) {
  // MOCK_MAP_BIG: the first map is far over the budget; the repair call trims it.
  const repairing = brief.startsWith("# Your proposed map");
  if (process.env.MOCK_BRIEF_OUT && !repairing) fs.writeFileSync(process.env.MOCK_BRIEF_OUT, brief);
  if (process.env.MOCK_REPAIR_OUT && repairing) fs.writeFileSync(process.env.MOCK_REPAIR_OUT, brief);
  if (process.env.MOCK_SYSTEM_OUT) fs.writeFileSync(process.env.MOCK_SYSTEM_OUT, sys);
  const gone = (!repairing && !process.env.MOCK_MAP_BIG) || process.env.MOCK_MAP_STUBBORN ? "\n- `src/gone.ts`: removed long ago" : "";
  const big = process.env.MOCK_MAP_BIG && !repairing ? `\n### Filler\n${"- `src/order.ts`: a line that saves nobody anything at all.\n".repeat(2000)}` : "";
  const map = `## Layout\n- \`src/\`: the application\n### Orders\n- \`src/order.ts\`: the order model and its transitions\n- Sign-in: follow \`auth/Login\`.${gone}\n- Services own transactions; controllers never call repositories.\n### Empty${big}`;
  say([call("report_map", { map, changes: ["added Orders", "noted transactions"] })]);
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
