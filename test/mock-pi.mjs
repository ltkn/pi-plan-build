#!/usr/bin/env node
// Stand-in for the fresh `pi --mode json -p` explorer, reviewer and verifier.
// MOCK_REVIEW picks the reviewer's findings, MOCK_VERIFY=reject makes the verifier reject them,
// MOCK_REVIEW_WRITE makes the reviewer write that file (it mustn't).
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
const say = (content) => {
  // The text is streamed in pieces before the message ends.
  for (const part of content.filter((c) => c.type === "text"))
    for (const piece of part.text.match(/[\s\S]{1,12}/g) ?? []) console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: piece } }));
  console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", usage, content } }));
};
const call = (name, args) => ({ type: "toolCall", id: `call-${name}`, name, arguments: args });

if (sys.includes("ATTACKER")) {
  const findings = process.env.MOCK_ATTACK !== "finding" ? [] : [{ priority: "P1", file: "src/account.ts", line: 7, title: "a stolen session alone can set a password the owner never set", fix: "require proof for a first password" }];
  say([call("report_findings", { findings })]);
  say([{ type: "text", text: "Done." }]);
} else if (sys.includes("REVIEWER")) {
  if (process.env.MOCK_BRIEF_OUT) fs.writeFileSync(process.env.MOCK_BRIEF_OUT, brief);
  if (process.env.MOCK_REVIEW_WRITE) fs.writeFileSync(process.env.MOCK_REVIEW_WRITE, "reviewer was here");
  const verdict = process.env.MOCK_REVIEW ?? "pass";
  if (verdict === "untagged") say([{ type: "text", text: "1. src/order.ts:12 — consider a guard clause.\n\nVERDICT: pass" }]);
  else if (verdict === "prose") say([{ type: "text", text: "No [P0] or [P1] issues found.\n\n1. [P2] src/order.ts:30 — name the constant.\n\nVERDICT: pass" }]);
  else {
    const findings = [
      { priority: verdict === "pass" ? "P3" : "P1", file: "src/order.ts", line: 12, title: "consider a guard clause", fix: "return early" },
      { priority: "P2", file: "src/order.ts", line: 30, title: "name the constant" },
    ];
    say([call("report_findings", { findings })]);
    say([{ type: "text", text: "Acceptance: all met." }]);
  }
} else if (sys.includes("VERIFIER")) {
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
  say([{ type: "text", text: `src/order/Order.java holds the model; OrderService applies transitions. (asked: ${brief.split("\n")[2]})` }]);
} else say([{ type: "text", text: "unexpected role" }]);
