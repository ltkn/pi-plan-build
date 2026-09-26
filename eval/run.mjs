#!/usr/bin/env node
/**
 * A/B eval: the same feature tasks built by a bare Pi agent and with pb, compared on what the
 * workflow is for: hidden acceptance tests, a fixed judge's P0/P1 count, cost, cache share, wall
 * time, and how often a human was asked something. It drives real Pi sessions over RPC, so it
 * needs a model and costs real money.
 *
 *   node eval/run.mjs --model provider/id [--thinking medium] [--judge provider/id]
 *                     [--arms bare,review,pb] [--runs 1] [--only task-name] [--out eval/results] [--keep]
 *
 * Arms: bare = Pi alone; review = Pi alone, then /pb:review and one fix round; pb = plan, build, review.
 * --dry checks the wiring without a model call: it starts each arm's Pi, runs /pb:status, and scores the untouched fixture.
 */
import { spawn, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const PB = path.join(HERE, "..", "extensions", "pb", "index.ts");

const { values: opt } = parseArgs({
  options: {
    model: { type: "string" },
    thinking: { type: "string" },
    judge: { type: "string" },
    arms: { type: "string", default: "bare,review,pb" },
    runs: { type: "string", default: "1" },
    tasks: { type: "string", default: path.join(HERE, "tasks") },
    only: { type: "string" },
    out: { type: "string", default: path.join(HERE, "results") },
    keep: { type: "boolean", default: false },
    dry: { type: "boolean", default: false },
    "idle-ms": { type: "string", default: "3000" },
  },
});
if (!opt.model && !opt.dry) {
  console.error("--model provider/id is required (see the header of eval/run.mjs)");
  process.exit(2);
}
const IDLE_MS = Number(opt["idle-ms"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------ a small RPC client ------------------------------ */

class Rpc {
  constructor(cwd, args, answer) {
    this.proc = spawn("pi", ["--mode", "rpc", ...args], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.pending = new Map();
    this.lastEvent = Date.now();
    this.stderr = "";
    this.answer = answer;
    this.n = 0;
    let buf = "";
    this.proc.stdout.on("data", (d) => {
      buf += d.toString();
      // Split on LF only: JSON strings may contain U+2028, which readline would split on.
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, "");
        buf = buf.slice(i + 1);
        if (line.trim()) this.#onRecord(JSON.parse(line));
      }
    });
    this.proc.stderr.on("data", (d) => (this.stderr += d.toString()));
    // Pi gone: fail whatever waits on it instead of hanging.
    this.proc.on("exit", (code) => {
      this.exited = `pi exited (${code}): ${this.stderr.trim().slice(-800)}`;
      for (const resolve of this.pending.values()) resolve({ success: false, error: this.exited });
      this.pending.clear();
    });
  }
  #onRecord(r) {
    if (r.type !== "response") this.lastEvent = Date.now(); // session activity; our own polling doesn't count
    if (r.type === "response" && r.id && this.pending.has(r.id)) {
      this.pending.get(r.id)(r);
      this.pending.delete(r.id);
    } else if (r.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(r.method)) {
      this.#write({ type: "extension_ui_response", id: r.id, ...this.answer(r) });
    }
  }
  #write(obj) {
    this.proc.stdin.write(`${JSON.stringify(obj)}\n`);
  }
  send(cmd) {
    if (this.exited) return Promise.resolve({ success: false, error: this.exited });
    const id = `r${++this.n}`;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.#write({ id, ...cmd });
    });
  }
  /** Send a prompt (or a /command, whose response comes once its handler finished), then wait until Pi is quiet. */
  async prompt(message) {
    const r = await this.send({ type: "prompt", message });
    if (!r.success) throw new Error(`prompt failed: ${r.error}`);
    await this.quiet();
  }
  async quiet() {
    for (let calm = 0; calm < 2; ) {
      await sleep(1000);
      const r = await this.send({ type: "get_state" });
      if (!r.success) throw new Error(r.error);
      const s = r.data;
      const idle = !s.isStreaming && !s.isCompacting && !s.pendingMessageCount && Date.now() - this.lastEvent > IDLE_MS;
      calm = idle ? calm + 1 : 0;
    }
  }
  async lastText() {
    return (await this.send({ type: "get_last_assistant_text" })).data?.text ?? "";
  }
  stop() {
    this.proc.kill("SIGTERM");
  }
}

/* ------------------------------------ helpers ------------------------------------ */

const readJsonl = (file) =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .flatMap((l) => {
          try {
            return [JSON.parse(l)];
          } catch {
            return [];
          }
        })
    : [];

function prepare(task) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `pb-eval-${task.name}-`));
  const sessions = fs.mkdtempSync(path.join(os.tmpdir(), `pb-eval-sessions-`));
  if (task.fixture) fs.cpSync(path.join(HERE, task.fixture), work, { recursive: true });
  else execSync(`git clone -q ${task.repo} . && git checkout -q ${task.commit}`, { cwd: work });
  if (task.fixture) execSync("git init -q && git add -A && git -c user.name=eval -c user.email=eval@local commit -qm fixture", { cwd: work });
  if (task.pbConfig) {
    fs.mkdirSync(path.join(work, ".pi", "pb"), { recursive: true });
    fs.writeFileSync(path.join(work, ".pi", "pb", "config.json"), JSON.stringify(task.pbConfig));
  }
  return { work, sessions };
}

/** Tokens and cost from every session file (assistant turns plus usage entries such as cache warming and tool calls). */
function sessionUsage(dir) {
  const u = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, toolUsage: false };
  const files = fs.readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith(".jsonl"));
  for (const f of files)
    for (const e of readJsonl(path.join(dir, String(f)))) {
      const usage = e.type === "message" && e.message?.role === "assistant" ? e.message.usage : e.type === "usage" ? e.usage : undefined;
      if (!usage) continue;
      if (e.type === "usage" && e.kind !== "cache_warm") u.toolUsage = true;
      u.input += usage.input ?? 0;
      u.output += usage.output ?? 0;
      u.cacheRead += usage.cacheRead ?? 0;
      u.cacheWrite += usage.cacheWrite ?? 0;
      u.cost += usage.cost?.total ?? 0;
    }
  return u;
}

/** Calls pb made outside the session (reviewer, verifier; the explorer unless Pi already counted it). */
function pbUsage(work, exploreCounted) {
  const u = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, reviews: [] };
  const root = path.join(work, ".pi", "pb");
  const events = [
    ...(fs.existsSync(path.join(root, "specs")) ? fs.readdirSync(path.join(root, "specs")).flatMap((s) => readJsonl(path.join(root, "specs", s, "events.jsonl"))) : []),
    ...readJsonl(path.join(root, "reviews.jsonl")), // reviews without a spec
    ...(exploreCounted ? [] : readJsonl(path.join(root, "explore.jsonl")).map((e) => ({ ...e, type: "explore" }))),
  ];
  for (const e of events) {
    if (e.type !== "review" && e.type !== "explore") continue;
    if (e.type === "review") u.reviews.push(e.verdict);
    for (const k of ["input", "output", "cacheRead", "cacheWrite"]) u[k] += e[k] ?? 0;
    u.cost += e.cost ?? 0;
  }
  return u;
}

function hiddenTests(task, work) {
  if (!task.hidden) return { ok: null };
  fs.cpSync(path.join(HERE, task.hidden.dir), path.join(work, task.hidden.to ?? "."), { recursive: true });
  try {
    const out = execSync(task.hidden.command, { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 600_000 });
    return { ok: true, ...counts(out) };
  } catch (e) {
    return { ok: false, ...counts(`${e.stdout ?? ""}${e.stderr ?? ""}`) };
  }
}
const counts = (out) => ({ pass: Number(out.match(/^ℹ pass (\d+)/m)?.[1] ?? NaN), fail: Number(out.match(/^ℹ fail (\d+)/m)?.[1] ?? NaN) });

const JUDGE_SYSTEM = `You are a JUDGE in a fresh context, scoring a code change made for the task in the brief. Do not modify files, and never run git commands that change the working tree or index. Read the diff (git diff HEAD -- . ':(exclude).pi' and the untracked files from git status) and the code around it. Count real problems only: P0 = broken behaviour, security problem, data loss; P1 = the task not done as asked, a bug, missing tests for new behaviour, a weakened test, a workaround; P2 = worth fixing (clarity, conventions, comments). End your reply with a fenced json block: {"p0": n, "p1": n, "p2": n, "summary": "one line"}`;

async function judge(task, work) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pb-eval-judge-"));
  fs.writeFileSync(path.join(tmp, "system.md"), JUDGE_SYSTEM);
  fs.writeFileSync(path.join(tmp, "brief.md"), `# Task\n\n${task.prompt}`);
  const args = ["--mode", "json", "-p", "--no-session", "--no-extensions", "--model", opt.judge ?? opt.model, "--tools", "read,grep,find,ls,bash", "--append-system-prompt", path.join(tmp, "system.md"), `@${path.join(tmp, "brief.md")}`, "Judge the change for the task in the attached file."];
  const text = await new Promise((resolve) => {
    const p = spawn("pi", args, { cwd: work, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    let last = "";
    p.stdout.on("data", (d) => {
      out += d.toString();
      let i;
      while ((i = out.indexOf("\n")) >= 0) {
        const line = out.slice(0, i);
        out = out.slice(i + 1);
        try {
          const ev = JSON.parse(line);
          if (ev.type === "message_end" && ev.message?.role === "assistant") {
            const t = (ev.message.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
            if (t.trim()) last = t;
          }
        } catch {}
      }
    });
    p.on("close", () => resolve(last));
  });
  fs.rmSync(tmp, { recursive: true, force: true });
  const block = [...text.matchAll(/```json\s*([\s\S]*?)```/g)].at(-1)?.[1];
  try {
    return JSON.parse(block);
  } catch {
    return { p0: null, p1: null, p2: null, summary: `unparsed: ${text.slice(-200)}` };
  }
}

/* ------------------------------------- arms ------------------------------------- */

async function runArm(task, arm) {
  const { work, sessions } = prepare(task);
  const log = { dialogs: 0, chat: 0 };
  const answers = [...(task.answers ?? ["Go with your recommendation."])];
  // The stand-in human: pb's own recommendations, and "no" to anything that changes the setup.
  const answer = (r) => {
    log.dialogs++;
    if (r.method === "confirm") return { confirmed: true };
    if (r.method === "editor") return { cancelled: true };
    if (r.method === "input") return /meant to do/.test(r.title) ? { value: task.prompt } : { value: answers[0] ?? "Use your recommendation." };
    if (/Engineering standards/.test(r.title)) return { value: r.options.find((o) => /No thanks/.test(o)) };
    if (/changed while planning/.test(r.title)) return { value: r.options.find((o) => /^Keep/.test(o)) };
    return { value: r.options.find((o) => /\(recommended\)/.test(o)) ?? r.options[0] };
  };
  const args = ["--session-dir", sessions, ...(opt.model ? ["--model", opt.model] : []), ...(opt.thinking ? ["--thinking", opt.thinking] : []), "--no-extensions", ...(arm === "bare" ? [] : ["-e", PB])];
  const pi = new Rpc(work, args, answer);
  const started = Date.now();
  /** Answer the agent's open questions with the task's scripted answers, the same way in every arm. */
  const answerQuestions = async () => {
    for (let i = 0; i < 3 && /\?\s*(\n|$)/.test((await pi.lastText()).slice(-600)); i++) {
      log.chat++;
      await pi.prompt(answers[Math.min(i, answers.length - 1)]);
    }
  };
  const pbState = () => {
    const dir = path.join(work, ".pi", "pb", "specs");
    const specs = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    return specs.map((s) => JSON.parse(fs.readFileSync(path.join(dir, s, "progress.json"), "utf8")));
  };
  try {
    if (opt.dry) {
      if (arm !== "bare") await pi.prompt("/pb:status");
    } else if (arm === "pb") {
      await pi.prompt(`/pb:plan ${task.prompt}`);
      await answerQuestions();
      await pi.prompt("/pb:build");
      for (let i = 0; i < 2 && pbState().some((p) => p.phase === "paused"); i++) {
        log.chat++;
        await pi.prompt("/pb:build Use your best judgement.");
      }
    } else {
      await pi.prompt(`${task.prompt}\n\nInvestigate the code, implement it with tests, and run the tests.`);
      await answerQuestions();
    }
    if (arm !== "bare" && !opt.dry) {
      await pi.prompt("/pb:review");
      if (pbUsage(work, true).reviews.at(-1) === "changes_needed") {
        log.chat++;
        await pi.prompt("Fix the P0 and P1 findings of the review.");
      }
    }
  } finally {
    pi.stop();
  }
  const wallMs = Date.now() - started;
  const su = sessionUsage(sessions);
  const pu = pbUsage(work, su.toolUsage);
  const total = { input: su.input + pu.input, output: su.output + pu.output, cacheRead: su.cacheRead + pu.cacheRead, cacheWrite: su.cacheWrite + pu.cacheWrite, cost: su.cost + pu.cost };
  const prompt = total.input + total.cacheRead + total.cacheWrite;
  const diffLines = execSync("git add -A -N . && git diff --numstat HEAD -- . ':(exclude).pi' | awk '{a+=$1; d+=$2} END {print a+d}'", { cwd: work, encoding: "utf8" }).trim();
  const verdict = opt.dry ? { p0: null, p1: null, p2: null, summary: "dry run" } : await judge(task, work);
  const hidden = hiddenTests(task, work);
  const row = {
    task: task.name,
    arm,
    model: opt.model,
    thinking: opt.thinking ?? null,
    hidden,
    judge: verdict,
    tokens: total,
    cacheShare: prompt ? total.cacheRead / prompt : 0,
    cost: total.cost,
    wallMs,
    asked: log,
    phases: pbState().map((p) => `${p.spec}:${p.phase}`),
    reviews: pu.reviews,
    diffLines: Number(diffLines) || 0,
    at: new Date().toISOString(),
    work: opt.keep ? work : undefined,
  };
  if (!opt.keep) fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(sessions, { recursive: true, force: true });
  return row;
}

/* ------------------------------------- main ------------------------------------- */

const tasks = fs
  .readdirSync(opt.tasks)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(fs.readFileSync(path.join(opt.tasks, f), "utf8")))
  .filter((t) => !opt.only || t.name === opt.only);
const arms = opt.arms.split(",").map((a) => a.trim());
fs.mkdirSync(opt.out, { recursive: true });
const resultsFile = path.join(opt.out, "results.jsonl");
const rows = [];
for (const task of tasks)
  for (let run = 1; run <= Number(opt.runs); run++)
    for (const arm of arms) {
      process.stderr.write(`▶ ${task.name} · ${arm} · run ${run}\n`);
      const row = { ...(await runArm(task, arm)), run };
      rows.push(row);
      fs.appendFileSync(resultsFile, `${JSON.stringify(row)}\n`);
      process.stderr.write(`  hidden ${row.hidden.ok ? "pass" : "FAIL"} · judge P0 ${row.judge.p0} P1 ${row.judge.p1} · $${row.cost.toFixed(2)} · cache ${Math.round(row.cacheShare * 100)}% · ${Math.round(row.wallMs / 1000)}s\n`);
    }

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const lines = [
  opt.dry ? "# pb eval — dry run (wiring only, no model calls)" : `# pb eval — ${opt.model}${opt.thinking ? ` (thinking ${opt.thinking})` : ""}, judge ${opt.judge ?? opt.model}`,
  "",
  "| arm | runs | hidden tests pass | judge P0+P1 | cost | cache share | time | human asked |",
  "|---|---|---|---|---|---|---|---|",
  ...arms.map((arm) => {
    const r = rows.filter((x) => x.arm === arm);
    return `| ${arm} | ${r.length} | ${Math.round(100 * mean(r.map((x) => (x.hidden.ok ? 1 : 0))))}% | ${mean(r.map((x) => (x.judge.p0 ?? 0) + (x.judge.p1 ?? 0))).toFixed(1)} | $${mean(r.map((x) => x.cost)).toFixed(2)} | ${Math.round(100 * mean(r.map((x) => x.cacheShare)))}% | ${Math.round(mean(r.map((x) => x.wallMs)) / 1000)}s | ${mean(r.map((x) => x.asked.dialogs + x.asked.chat)).toFixed(1)} |`;
  }),
  "",
  `Per run: ${resultsFile}`,
];
fs.writeFileSync(path.join(opt.out, "summary.md"), `${lines.join("\n")}\n`);
console.log(lines.join("\n"));
