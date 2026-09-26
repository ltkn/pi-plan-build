/**
 * End-to-end tests of pb with a simulated Pi: commands, tools and events are the
 * extension's real ones; the "agent" is a script that reacts to each instruction by
 * writing files and calling pb's tools, and agent_settled fires after every run.
 * Run: npm test
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

process.env.PI_PB_PI_COMMAND = path.join(path.dirname(new URL(import.meta.url).pathname), "mock-pi.mjs");
const { default: pb } = await import("../extensions/pb/index.ts");
const { parseSpec, addDecision } = await import("../extensions/pb/spec.ts");

type Tool = (name: string, params: object) => Promise<{ error?: string }>;
type Script = (instruction: string, tool: Tool) => Promise<void> | void;

function setup(config: object = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pb-test-"));
  execSync("git init -q && git config user.email t@t && git config user.name t && echo hi > README && git add . && git commit -qm init", { cwd: repo });
  fs.mkdirSync(path.join(repo, ".pi/pb"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".pi/pb/config.json"), JSON.stringify({ build: null, maxAttempts: 2, ...config }));

  const posts: string[] = [];
  const notes: string[] = [];
  const instructions: string[] = [];
  const selects: string[] = [];
  const blocked: string[] = [];
  const agent: { script?: Script } = {};
  const names = new Map<string, string>();
  let sessions = 0;

  // Like Pi: every session gets its own runtime and extension instance; after a session
  // replacement, the old pi and ctx are stale and throw if used.
  type Runtime = {
    cmds: Record<string, any>;
    tools: Record<string, any>;
    handlers: Record<string, ((e: object, ctx: object) => unknown)[]>;
    pi: any;
    ctx: any;
    stale: boolean;
    model: { provider: string; id: string; contextWindow: number };
    thinking: string;
  };
  const MODELS = [
    { provider: "p", id: "m", contextWindow: 100000 },
    { provider: "p", id: "big", contextWindow: 262000 },
  ];
  let rt: Runtime;
  const guard = <T extends object>(r: () => Runtime, target: T): T =>
    new Proxy(target, {
      get(obj, key, recv) {
        if (r().stale) throw new Error(`stale: ${String(key)} used after session replacement`);
        return Reflect.get(obj, key, recv);
      },
    });
  const makeRuntime = (sessionFile: string): Runtime => {
    const self = {} as Runtime;
    const me = () => self;
    self.cmds = {};
    self.tools = {};
    self.handlers = {};
    self.stale = false;
    self.model = MODELS[0]; // like Pi: a new session starts from the settings defaults
    self.thinking = "off";
    self.pi = guard(me, {
      registerCommand: (n: string, o: object) => (self.cmds[n] = o),
      registerTool: (t: { name: string }) => (self.tools[t.name] = t),
      on: (e: string, h: (e: object, ctx: object) => unknown) => (self.handlers[e] ??= []).push(h),
      getActiveTools: () => ["read", "bash", "edit", "write"],
      setSessionName: (n: string) => names.set(sessionFile, n),
      getThinkingLevel: () => self.thinking,
      setThinkingLevel: (l: string) => (self.thinking = l),
      setModel: async (m: Runtime["model"]) => ((self.model = m), true),
      setActiveTools: () => {},
      sendMessage: (m: { content: string; display?: boolean }, o?: { triggerTurn?: boolean }) => {
        if (m.display) posts.push(m.content);
        if (o?.triggerTurn) turn(m.content);
      },
      sendUserMessage: (t: string) => turn(t),
    });
    self.ctx = guard(me, {
      cwd: repo,
      mode: "print",
      hasUI: true,
      get model() {
        return self.model;
      },
      modelRegistry: { find: (prov: string, id: string) => MODELS.find((m) => m.provider === prov && m.id === id) },
      isIdle: () => true,
      sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => path.basename(sessionFile, ".jsonl") },
      ui: {
        notify: (m: string) => notes.push(m),
        setWidget: () => {},
        setStatus: () => {},
        select: async (_t: string, opts: string[]) => selects.shift() ?? opts[0],
        confirm: async () => true,
        input: async () => "",
      },
      newSession: async (opts: { setup?: (sm: object) => Promise<void>; withSession?: (c: object) => Promise<void> }) => {
        self.stale = true;
        const file = path.join(repo, `build-session-${++sessions}.jsonl`);
        await opts.setup?.({ appendSessionInfo: (n: string) => names.set(file, n) });
        rt = makeRuntime(file);
        const fresh = rt;
        for (const h of fresh.handlers.session_start ?? []) await h({ type: "session_start", reason: "new" }, fresh.ctx); // before withSession, as in Pi
        await opts.withSession?.({ ...fresh.ctx, sessionManager: fresh.ctx.sessionManager, sendMessage: async (m: any, o: any) => fresh.pi.sendMessage(m, o) });
        return { cancelled: false };
      },
    });
    pb(self.pi);
    return self;
  };
  rt = makeRuntime(path.join(repo, "planning-session.jsonl"));

  // One agent run per instruction, queued like Pi's follow-ups; agent_settled after each, on the current runtime.
  let running: Promise<void> = Promise.resolve();
  const callTool: Tool = async (name, params) => {
    const call = { toolName: name, input: params };
    for (const h of rt.handlers.tool_call ?? []) {
      const r = (await h({ type: "tool_call", ...call }, rt.ctx)) as { block?: boolean; reason?: string } | undefined;
      if (r?.block) return blocked.push(`${name} ${(params as { path?: string }).path}`), { error: r.reason };
    }
    if (!rt.tools[name]) return {}; // a built-in tool: nothing to simulate
    try {
      return await rt.tools[name].execute("call", params, undefined, undefined, rt.ctx);
    } catch (e) {
      return { error: (e as Error).message };
    }
  };
  const turn = (text: string) => {
    instructions.push(text);
    running = running.then(async () => {
      await agent.script?.(text, callTool);
      const usage = { input: 1000, output: 100, cacheRead: 9000, cacheWrite: 0, cost: { total: 0.001 } };
      for (const h of rt.handlers.message_end ?? []) await h({ type: "message_end", message: { role: "assistant", usage } }, rt.ctx);
      for (const h of rt.handlers.agent_settled ?? []) await h({ type: "agent_settled" }, rt.ctx);
    });
  };

  const settle = async () => {
    let prev: Promise<void>;
    do {
      prev = running;
      await prev;
    } while (prev !== running);
  };
  const run = async (name: string, args = "") => {
    await rt.cmds[`pb:${name}`].handler(args, rt.ctx);
    await settle();
  };
  const read = (f: string) => fs.readFileSync(path.join(repo, f), "utf8");
  const progress = (name: string) => JSON.parse(read(`.pi/pb/specs/${name}/progress.json`));
  return { repo, names, posts, notes, instructions, selects, blocked, agent, run, read, progress, callTool, settle, runtime: () => rt };
}

const SPEC = (opts: { verification?: string; newTests?: string; tasks?: string } = {}) => `# Order cancellation
Depends on: none
Verification: ${opts.verification ?? "tests"}
New tests: ${opts.newTests ?? "yes"}

## Goal
Cancel orders.
## Out of scope
Refunds.
## Decisions
- Only PENDING orders can be cancelled.
- Not doing soft delete, because audit lives elsewhere.
## Context
src/order.ts holds the model.
## Acceptance criteria
- T1.txt and T2.txt exist.
## Tasks
${
  opts.tasks ??
  `### T1: first file
Create T1.txt.
- Acceptance: T1.txt exists
- Test: \`test -f T1.txt\`

### T2: second file
Create T2.txt.
- Acceptance: T2.txt exists
- Test: \`test -f T2.txt\``
}
`;

/** An agent that does each task by creating <task>.txt. */
const diligent: Script = async (text, tool) => {
  const task = text.match(/Task (T\d+)/)?.[1] ?? text.match(/task "(\w+)"/)?.[1];
  if (!task) return;
  if (task !== "final") fs.writeFileSync(`${task}.txt`, "x");
  await tool("pb_task_done", { task, status: "done", summary: `did ${task}` });
};

async function written(t: ReturnType<typeof setup>, spec = SPEC()) {
  process.chdir(t.repo);
  const r = await t.callTool("pb_write_spec", { name: "order-cancellation", content: spec });
  assert.equal(r.error, undefined, r.error ?? "");
}

/* --------------------------------- spec format --------------------------------- */

test("spec: parses the header, sections and tasks; says what's wrong otherwise", () => {
  const { spec, errors } = parseSpec(SPEC({ verification: "build — no suite for this module", newTests: "no — covered by T9" }));
  assert.deepEqual(errors, []);
  assert.equal(spec!.gate, "build");
  assert.equal(spec!.gateReason, "no suite for this module");
  assert.equal(spec!.newTests, false);
  assert.deepEqual(spec!.tasks.map((t) => [t.id, t.title, t.test]), [["T1", "first file", "test -f T1.txt"], ["T2", "second file", "test -f T2.txt"]]);

  const bad = parseSpec("# X\nVerification: none\n\n## Goal\n## Tasks\n### T1: a\nno acceptance\n");
  assert.ok(bad.errors.some((e) => e.includes('"Verification: none" needs a reason')));
  assert.ok(bad.errors.some((e) => e.includes('missing the "## Decisions" section')));
  assert.ok(bad.errors.some((e) => e.includes('T1 has no "- Acceptance:" line')));
});

test("spec: decisions are added under Decisions, before the next section", () => {
  const md = addDecision(SPEC(), "Cancelling twice is a no-op.");
  assert.match(md, /- Not doing soft delete, because audit lives elsewhere\.\n- Cancelling twice is a no-op\.\n\n## Context/);
});

/* --------------------------------- plan and spec --------------------------------- */

test("plan: investigation is free, project files are protected until /pb:plan off; spec asks for pb_write_spec", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  await t.run("plan", "let admins cancel pending orders");
  assert.equal(t.names.get(path.join(t.repo, "planning-session.jsonl")), "plan: let admins cancel pending orders");
  assert.match(t.posts.at(-1)!, /back to it any time with \/resume, or `pi --session planning-session`/);
  assert.match(t.instructions.at(-1)!, /\[pb:plan\] let admins cancel pending orders[\s\S]*curl, one-off scripts in a temp directory[\s\S]*run `true` once/);
  const scratch = path.join(os.tmpdir(), "pb-scratch.py");
  assert.equal((await t.callTool("write", { path: scratch, content: "print(1)" })).error, undefined); // outside the project: fine
  assert.match((await t.callTool("write", { path: "src/Order.java", content: "x" })).error!, /Planning mode: the project's files stay untouched/);
  assert.match((await t.callTool("edit", { path: path.join(t.repo, "README"), edits: [] })).error!, /Planning mode/);
  await t.run("plan", "off");
  assert.equal((await t.callTool("write", { path: "src/Order.java", content: "x" })).error, undefined);
  await t.run("plan");
  assert.match(t.notes.at(-1)!, /Describe what you want, in your own words/);
  await t.run("spec");
  assert.match(t.instructions.at(-1)!, /with the pb_write_spec tool[\s\S]*Not doing X, because/);
});

test("plan mode stays with its session, not with the build session", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  await t.run("plan", "x");
  await written(t);
  t.agent.script = async (text, tool) => {
    if (text.includes("Task T1")) assert.equal((await tool("write", { path: "T1.src", content: "x" })).error, undefined); // editing works in the build
    return diligent(text, tool);
  };
  await t.run("build");
  assert.equal(t.progress("order-cancellation").phase, "built");
});

test("pb_write_spec rejects a spec that doesn't parse, and a bad name", async () => {
  const t = setup();
  process.chdir(t.repo);
  assert.match((await t.callTool("pb_write_spec", { name: "x", content: "# only a title" })).error!, /doesn't parse[\s\S]*Verification/);
  assert.match((await t.callTool("pb_write_spec", { name: "Bad Name", content: SPEC() })).error!, /not a valid name/);
  await written(t);
  assert.deepEqual(t.progress("order-cancellation").tasks.map((x: any) => [x.id, x.status]), [["T1", "todo"], ["T2", "todo"]]);
});

/* ------------------------------------- build ------------------------------------- */

test("build: fresh session starting with T1, tasks behind their tests, then the full suite", async () => {
  const t = setup({ verify: "test -f T1.txt && test -f T2.txt" });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  const p = t.progress("order-cancellation");
  assert.equal(p.phase, "built");
  assert.match(p.session, /build-session-1\.jsonl$/);
  assert.equal(t.names.get(p.session), "build: order-cancellation");
  assert.ok(t.posts.some((x) => /This session: "build: order-cancellation" · back to it with \/resume, or `pi --session build-session-1`/.test(x)));
  assert.deepEqual(p.tasks.map((x: any) => [x.id, x.status]), [["T1", "done"], ["T2", "done"]]);
  assert.match(t.instructions[0], /Build this feature from the spec below[\s\S]*# Order cancellation[\s\S]*Task T1\. Do only this task/);
  assert.doesNotMatch(t.instructions[0], /pb_spec_gaps/);
  assert.match(t.posts.at(-1)!, /BUILD COMPLETE — order-cancellation[\s\S]*PASS/);
  assert.match(t.read(".pi/pb/specs/order-cancellation/events.jsonl"), /"type":"check","task":"final"/); // full suite after the task tests
});

test("build: a failing check goes back to the agent, and passes on the next attempt", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  let lazy = true;
  t.agent.script = async (text, tool) => {
    if (text.includes("Task T1") && lazy) {
      lazy = false; // first attempt forgets the file
      return void (await tool("pb_task_done", { task: "T1", status: "done", summary: "claimed" }));
    }
    return diligent(text, tool);
  };
  await t.run("build");
  assert.ok(t.instructions.some((i) => /The check for T1 failed \(attempt 2 of 2\)[\s\S]*test -f T1\.txt/.test(i)));
  assert.equal(t.progress("order-cancellation").phase, "built");
});

test("build: after the last attempt it pauses; /pb:build resumes with a fresh set", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  let give = false;
  t.agent.script = async (text, tool) => {
    const task = text.match(/(?:Task|check for) (T\d+)/)?.[1];
    if (task === "T1" && !give) return void (await tool("pb_task_done", { task, status: "done", summary: "claimed" }));
    return diligent(text, tool);
  };
  await t.run("build");
  const p = t.progress("order-cancellation");
  assert.equal(p.phase, "paused");
  assert.match(t.posts.at(-1)!, /Build paused\*\* — T1 still fails after 2 attempts/);
  give = true;
  await t.run("build", "create the file in the repo root");
  assert.equal(t.progress("order-cancellation").phase, "built");
  assert.match(t.read(".pi/pb/specs/order-cancellation/spec.md"), /- create the file in the repo root/); // guidance recorded as a decision
});

test("build: ambiguities become recorded assumptions (no pause); only real questions pause", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  t.agent.script = async (text, tool) => {
    if (text.includes("Task T1")) await tool("pb_record_decision", { decision: "Follow the layout rules over the mockup: the rules are marked exact.", assumption: true });
    if (text.includes("Task T2")) return void (await tool("pb_task_done", { task: "T2", status: "question", summary: "", question: "Which file name?" }));
    return diligent(text, tool);
  };
  await t.run("build");
  assert.ok(fs.existsSync(path.join(t.repo, "T1.txt"))); // T1 went through without stopping
  assert.match(t.read(".pi/pb/specs/order-cancellation/spec.md"), /- Assumption \(build, T1\): Follow the layout rules over the mockup/);
  assert.match(t.posts.at(-1)!, /Build paused\*\* — T2 question: Which file name\?/);

  t.agent.script = diligent;
  await t.run("build", "call it T2.txt");
  const done = t.posts.at(-1)!;
  assert.match(done, /BUILD COMPLETE[\s\S]*Choices the build made where the spec was unclear[\s\S]*Assumption \(build, T1\): Follow the layout rules/);
});

test("build: pb_task_done must name the current task", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  let err: string | undefined;
  t.agent.script = async (text, tool) => {
    if (text.includes("Task T1")) err ??= (await tool("pb_task_done", { task: "T2", status: "done", summary: "" })).error;
    return diligent(text, tool);
  };
  await t.run("build");
  assert.equal(err, "The current task is T1, not T2.");
});

test("build: verification none runs no checks; no new tests reaches the agent", async () => {
  const t = setup({ verify: "false" }); // would fail if it ran
  await written(t, SPEC({ verification: "none — docs only", newTests: "no — the human said so" }));
  t.agent.script = diligent;
  await t.run("build");
  assert.equal(t.progress("order-cancellation").phase, "built");
  assert.match(t.instructions[0], /Tests: add none for this feature \(the human said so\)[\s\S]*runs no checks \(docs only\)/);
});

test("build: fewer test cases in an existing test fail the task (gate: tests)", async () => {
  const t = setup({ verify: "true" });
  fs.mkdirSync(path.join(t.repo, "tests"));
  fs.writeFileSync(path.join(t.repo, "tests/test_a.py"), "def test_a():\n    pass\ndef test_b():\n    pass\n");
  execSync("git add . && git commit -qm tests", { cwd: t.repo });
  await written(t);
  t.agent.script = async (text, tool) => {
    if (text.includes("Task T1")) fs.writeFileSync("tests/test_a.py", "def test_a():\n    pass\n");
    if (text.includes("check for T1")) fs.writeFileSync("tests/test_a.py", "def test_a():\n    pass\ndef test_b():\n    pass\n");
    return diligent(text, tool);
  };
  await t.run("build");
  assert.ok(t.instructions.some((i) => /The check for T1 failed[\s\S]*existing tests were changed[\s\S]*2 → 1 test cases/.test(i)));
  assert.equal(t.progress("order-cancellation").phase, "built");
});

/* ------------------------------------- undo -------------------------------------- */

test("undo restores the files and tasks to before a task, and can be undone", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  t.agent.script = undefined;
  await t.run("undo", "T2");
  assert.ok(!fs.existsSync(path.join(t.repo, "T2.txt")) && fs.existsSync(path.join(t.repo, "T1.txt")));
  assert.deepEqual(t.progress("order-cancellation").tasks.map((x: any) => [x.id, x.status]), [["T1", "done"], ["T2", "todo"]]);
  assert.match(t.posts.at(-1)!, /Undone to before T2/);
  await t.run("undo", "u1");
  assert.ok(fs.existsSync(path.join(t.repo, "T2.txt")));
});

test("status lists every spec with its state and tasks", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  await t.run("status");
  assert.match(t.notes.at(-1)!, /order-cancellation — written · verification tests/);
});

/* ------------------------------ review, stats, archive ------------------------------ */

test("review: fresh check, then a fresh reviewer with the spec and the diff; pass marks it reviewed", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  const briefFile = path.join(os.tmpdir(), `pb-brief-${process.pid}.md`);
  process.env.MOCK_BRIEF_OUT = briefFile;
  await t.run("review");
  delete process.env.MOCK_BRIEF_OUT;
  const brief = fs.readFileSync(briefFile, "utf8");
  assert.match(brief, /## Changed files\n\n(T1\.txt\n)?[\s\S]*T2\.txt/);
  assert.match(brief, /## The check the harness ran\n\n`true` → PASS/);
  assert.match(brief, /## The spec[\s\S]*Not doing soft delete/);
  assert.match(t.posts.at(-1)!, /Review of order-cancellation\*\* — ✅ PASS[\s\S]*src\/order\.ts:12/);
  assert.doesNotMatch(t.posts.at(-1)!, /VERDICT:/);
  assert.equal(t.progress("order-cancellation").phase, "reviewed");

  process.env.MOCK_REVIEW = "changes_needed";
  await t.run("review");
  delete process.env.MOCK_REVIEW;
  assert.match(t.posts.at(-1)!, /✗ CHANGES NEEDED/);
});

test("stats: tasks, first try, checks, pauses, review, and the build session's tokens and cache", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  let lazy = true;
  t.agent.script = async (text, tool) => {
    if (text.includes("Task T1") && lazy) {
      lazy = false;
      return void (await tool("pb_task_done", { task: "T1", status: "done", summary: "claimed" }));
    }
    return diligent(text, tool);
  };
  await t.run("build");
  await t.run("review");
  await t.run("stats");
  const card = t.posts.at(-1)!;
  if (process.env.SHOW_STATS) console.log(card);
  assert.match(card, /Tasks +2 of 2 done · first try 1\/2 \(50%\) · 3 task checks · most: T1 \(2\)/);
  assert.match(card, /Checks +4 run, 1 failed/); // T1 ×2, T2, final
  assert.match(card, /Review +pass/);
  assert.match(card, /prompt [\d.]+k \(90% from cache\)/);
  assert.match(card, /Context +peak 10\.0k \(10% of 100\.0k\)/);
  assert.match(card, /Reviewer +prompt 3\.0k · output 400 · \$0\.02/);

  await t.run("stats", "all");
  assert.match(t.posts.at(-1)!, /order-cancellation +2\/2 +50%/);
});

test("archive moves a finished spec out of .pi/pb/, and stats still see it", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  await t.run("archive");
  assert.ok(!fs.existsSync(path.join(t.repo, ".pi/pb/specs/order-cancellation")));
  const archived = fs.readdirSync(path.join(t.repo, ".pi/pb-archive")).filter((d) => d.endsWith("order-cancellation"));
  assert.equal(archived.length, 1);
  assert.doesNotMatch(execSync("git status --porcelain", { cwd: t.repo, encoding: "utf8" }), /pb-archive/);
  await t.run("stats", "all");
  assert.match(t.posts.at(-1)!, /order-cancellation +2\/2/);
});

test("help: every What-now block the code uses exists in the guide, and /pb:help lists the topics", async () => {
  const { tip } = await import("../extensions/pb/help.ts");
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname), "../extensions/pb");
  const src = ["index.ts", "prompts.ts"].map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
  const keys = new Set([...src.matchAll(/tip\(\s*"([\w.-]+)"/g)].map((m) => m[1]));
  for (const k of ["build.paused", "build.paused-attempts", "review.pass", "review.changes", "review.other"]) keys.add(k);
  for (const k of keys) assert.ok(tip(k).startsWith("**What now**"), `missing tip ${k}`);
  const t = setup();
  process.chdir(t.repo);
  await t.run("help");
  assert.match(t.posts.at(-1)!, /\/pb:help build` — Building/);
});

test("an unfinished build (e.g. after a crash) can be restarted in a new session; finished tasks stay done", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  let stop = true;
  t.agent.script = async (text, tool) => {
    if (text.includes("Task T2") && stop) return; // the session "dies" before T2 finishes
    return diligent(text, tool);
  };
  await t.run("build");
  assert.equal(t.progress("order-cancellation").phase, "paused");
  stop = false;
  process.chdir(t.repo);
  // Back in some other session: the spec is offered for a restart.
  const r = t.runtime();
  r.ctx.sessionManager.getSessionFile = () => path.join(t.repo, "elsewhere.jsonl");
  t.selects.push("order-cancellation (restart the build, finished tasks stay done)");
  await t.run("build");
  const p = t.progress("order-cancellation");
  assert.equal(p.phase, "built");
  assert.match(p.session, /build-session-2\.jsonl$/);
  assert.equal(t.instructions.filter((i) => /Task T1/.test(i)).length, 1); // T1 wasn't redone
});

test("prompts: short, settled, comments without history; a minimal spec is enough", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  const seed = t.instructions[0];
  assert.match(seed, /The planning is done: implement it as written/);
  assert.match(seed, /record it with pb_record_decision \(assumption: true\)/);
  assert.match(seed, /never its history: no dates, no "decided", "agreed", "user" or "spec", no previous values/);
  assert.match(seed, /leave \.pi\/ alone/);
  assert.doesNotMatch(seed, /even when it is more work/);
  const rules = seed.slice(0, seed.indexOf("--- spec:"));
  assert.ok(rules.length < 1800, `build instructions grew to ${rules.length} chars`); // keep them short
  assert.match(t.instructions[1] ?? t.instructions.find((i) => /Task T2/.test(i))!, /Comments: the code as it is; no history, dates or decisions/);

  await t.run("spec");
  const spec = t.instructions.at(-1)!;
  assert.match(spec, /Each decision with its reason, as it stands now: no dates, no history, not who decided/);
  assert.match(spec, /check the spec for contradictions and against the code/);

  const minimal = "# Tiny\nVerification: tests\n\n## Goal\ng\n## Decisions\n- d\n## Tasks\n### T1: a\nx\n- Acceptance: y\n";
  assert.deepEqual(parseSpec(minimal).errors, []);
});

test("the build session runs on the model and thinking level you planned with, not Pi's defaults", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  const planning = t.runtime();
  planning.model = { provider: "p", id: "big", contextWindow: 262000 };
  planning.thinking = "high";
  t.agent.script = diligent;
  await t.run("build");
  const build = t.runtime();
  assert.notEqual(build, planning);
  assert.deepEqual([build.model.id, build.thinking], ["big", "high"]);
  assert.ok(t.posts.some((x) => /Building \*\*order-cancellation\*\*[^\n]*, on p\/big, thinking high\./.test(x)));
  assert.ok(!fs.existsSync(path.join(t.repo, ".pi/pb/carry.json"))); // handed over once
});
