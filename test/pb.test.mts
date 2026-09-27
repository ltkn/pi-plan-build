/**
 * End-to-end tests of pb with a simulated Pi: commands, tools and events are the
 * extension's real ones; the "agent" is a script that reacts to each instruction (or tool
 * result) by writing files and calling tools. Like Pi, one run goes on while tool results
 * ask for more, turn_end fires after every turn, agent_before_settle may continue a run,
 * and agent_settled fires at its end. Sessions are trees of entries with a leaf.
 * Run: npm test
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

process.env.PI_PB_PI_COMMAND = path.join(path.dirname(new URL(import.meta.url).pathname), "mock-pi.mjs");
process.env.PI_CODING_AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pb-agent-dir-")); // never the real ~/.pi
const { default: pb } = await import("../extensions/pb/index.ts");
const { parseSpec, addDecision } = await import("../extensions/pb/spec.ts");

type Result = { error?: string; content?: { text: string }[]; terminate?: boolean; usage?: { totalTokens: number } };
type Tool = (name: string, params: object) => Promise<Result>;
type Script = (instruction: string, tool: Tool) => Promise<void> | void;
type Entry = { id: string; parentId: string | null; type: string; message?: { role: string; content: { type: "text"; text: string }[] }; content?: string; summary?: string };

function setup(config: object = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pb-test-"));
  execSync("git init -q && git config user.email t@t && git config user.name t && echo hi > README && git add . && git commit -qm init", { cwd: repo });
  fs.mkdirSync(path.join(repo, ".pi/pb"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".pi/pb/config.json"), JSON.stringify({ build: null, maxAttempts: 2, baseline: false, ...config }));

  const posts: string[] = [];
  const notes: string[] = [];
  const instructions: string[] = [];
  const results: string[] = []; // every pb_task_done result, including the ones that end the run
  const selects: string[] = [];
  const selectTitles: string[] = [];
  const confirms: string[] = [];
  const dialogTimeouts: (number | undefined)[] = [];
  const editors: (string | undefined)[] = [];
  const views: { customType: string; data: any }[] = [];
  const navigations: { target: string; summary?: string }[] = [];
  const resets: { summary: string; firstKeptEntryId: string | null }[] = [];
  const blocked: string[] = [];
  const agent: { script?: Script } = {};
  const names = new Map<string, string>();
  const stat = { runs: 0, editorText: "" };
  let sessions = 0;

  // Session trees, by session file: entries and the current leaf.
  const trees = new Map<string, { entries: Map<string, Entry>; leaf: string | null }>();
  let ids = 0;
  const treeOf = (file: string) => {
    if (!trees.has(file)) trees.set(file, { entries: new Map(), leaf: null });
    return trees.get(file)!;
  };
  const append = (file: string, e: Omit<Entry, "id" | "parentId">) => {
    const t = treeOf(file);
    const entry = { ...e, id: `e${++ids}`, parentId: t.leaf } as Entry;
    t.entries.set(entry.id, entry);
    t.leaf = entry.id;
    return entry;
  };
  const branch = (file: string) => {
    const t = treeOf(file);
    const out: Entry[] = [];
    for (let id = t.leaf; id; id = t.entries.get(id)!.parentId) out.unshift(t.entries.get(id)!);
    // Like Pi's context: from the last compaction on (these tests' compactions keep nothing before them).
    const last = out.map((e) => e.type).lastIndexOf("compaction");
    return last < 0 ? out : out.slice(last);
  };
  const textOf = (e: Entry) => e.message?.content.map((c) => c.text).join("") ?? e.content ?? e.summary ?? "";

  // Like Pi: every session gets its own runtime and extension instance; after a session
  // replacement, the old pi and ctx are stale and throw if used.
  type Runtime = {
    file: () => string;
    cmds: Record<string, any>;
    tools: Record<string, any>;
    handlers: Record<string, ((e: object, ctx: object) => unknown)[]>;
    renderers: string[];
    pi: any;
    ctx: any;
    stale: boolean;
    model: { provider: string; id: string; contextWindow: number };
    thinking: string;
    usage: number;
    hasUI: boolean;
    contextFiles: { path: string; content: string }[];
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
  const fire = async (event: string, e: object, ctx = rt.ctx) => {
    const out: unknown[] = [];
    for (const h of rt.handlers[event] ?? []) out.push(await h({ type: event, ...e }, ctx));
    return out;
  };
  const makeRuntime = (sessionFile: string): Runtime => {
    const self = {} as Runtime;
    const me = () => self;
    const file = () => self.ctx.sessionManager.getSessionFile();
    self.file = file;
    self.cmds = {};
    self.tools = {};
    self.handlers = {};
    self.renderers = [];
    self.stale = false;
    self.model = MODELS[0]; // like Pi: a new session starts from the settings defaults
    self.thinking = "off";
    self.usage = 10;
    self.hasUI = true;
    self.contextFiles = [];
    self.pi = guard(me, {
      registerCommand: (n: string, o: object) => (self.cmds[n] = o),
      registerTool: (t: { name: string }) => (self.tools[t.name] = t),
      registerEntryRenderer: (n: string) => self.renderers.push(n),
      registerMessageRenderer: (n: string) => self.renderers.push(n),
      on: (e: string, h: (e: object, ctx: object) => unknown) => (self.handlers[e] ??= []).push(h),
      getActiveTools: () => ["read", "bash", "edit", "write"],
      setSessionName: (n: string) => names.set(file(), n),
      getThinkingLevel: () => self.thinking,
      setThinkingLevel: (l: string) => (self.thinking = l),
      setModel: async (m: Runtime["model"]) => ((self.model = m), true),
      setActiveTools: () => {},
      appendEntry: (customType: string, data: unknown) => {
        views.push({ customType, data });
        append(file(), { type: "custom" });
      },
      sendMessage: (m: { content: string; display?: boolean }, o?: { triggerTurn?: boolean }) => {
        if (m.display) posts.push(m.content);
        append(file(), { type: "custom_message", content: m.content });
        if (o?.triggerTurn) turn(m.content);
      },
      sendUserMessage: (t: string) => {
        append(file(), { type: "message", message: { role: "user", content: [{ type: "text", text: t }] } });
        turn(t);
      },
    });
    self.ctx = guard(me, {
      cwd: repo,
      mode: "print",
      get hasUI() {
        return self.hasUI;
      },
      get model() {
        return self.model;
      },
      get thinkingLevel() {
        return self.thinking;
      },
      modelRegistry: { find: (prov: string, id: string) => MODELS.find((m) => m.provider === prov && m.id === id), getAvailable: () => MODELS },
      isIdle: () => queued === 0,
      waitForIdle: () => settle(),
      getContextUsage: () => ({ tokens: self.usage * 1000, contextWindow: 100000, percent: self.usage }),
      getSystemPromptOptions: () => ({ contextFiles: self.contextFiles }),
      sessionManager: {
        getSessionFile: () => sessionFile,
        getSessionId: () => path.basename(sessionFile, ".jsonl"),
        getSessionName: () => names.get(file()),
        getLeafId: () => treeOf(file()).leaf,
        getEntry: (id: string) => treeOf(file()).entries.get(id),
        getBranch: () => {
          const t = treeOf(file());
          const out: Entry[] = [];
          for (let id = t.leaf; id; id = t.entries.get(id)!.parentId) out.unshift(t.entries.get(id)!);
          return out;
        },
      },
      ui: {
        notify: (m: string) => notes.push(m),
        setWidget: () => {},
        setStatus: () => {},
        setEditorText: (t: string) => (stat.editorText = t),
        select: async (title: string, opts: string[], o?: { timeout?: number }) => {
          selectTitles.push(title);
          dialogTimeouts.push(o?.timeout);
          const pick = selects.shift();
          if (pick === "<timeout>") return undefined;
          return pick ?? opts[0];
        },
        confirm: async (title: string) => (confirms.push(title), true),
        input: async () => selects.shift() ?? "",
        editor: async () => editors.shift(),
      },
      navigateTree: async (target: string, o: { summarize?: boolean } = {}) => {
        const [r] = (await fire("session_before_tree", { preparation: { targetId: target } })) as { summary?: { summary: string } }[];
        const t = treeOf(file());
        const e = t.entries.get(target)!;
        t.leaf = e.type === "custom_message" || e.message?.role === "user" ? e.parentId : target;
        const summary = o.summarize ? r?.summary?.summary : undefined;
        if (summary) append(file(), { type: "branch_summary", summary });
        navigations.push({ target, summary });
        return { cancelled: false };
      },
      newSession: async (opts: { setup?: (sm: object) => Promise<void>; withSession?: (c: object) => Promise<void> }) => {
        self.stale = true;
        const next = path.join(repo, `build-session-${++sessions}.jsonl`);
        await opts.setup?.({ appendSessionInfo: (n: string) => names.set(next, n) });
        rt = makeRuntime(next);
        const fresh = rt;
        await fire("session_start", { reason: "new" }, fresh.ctx); // before withSession, as in Pi
        await opts.withSession?.({ ...fresh.ctx, ui: fresh.ctx.ui, sessionManager: fresh.ctx.sessionManager, sendMessage: async (m: any, o: any) => fresh.pi.sendMessage(m, o) });
        return { cancelled: false };
      },
    });
    pb(self.pi);
    return self;
  };
  rt = makeRuntime(path.join(repo, "planning-session.jsonl"));

  // A tool result that asks for more (pb_task_done without terminate) continues the run, as in Pi.
  let continuation: string | undefined;
  let running: Promise<void> = Promise.resolve();
  let queued = 0; // runs queued or going: Pi isn't idle
  const callTool: Tool = async (name, params) => {
    const call = { toolName: name, input: params };
    for (const h of rt.handlers.tool_call ?? []) {
      const r = (await h({ type: "tool_call", ...call }, rt.ctx)) as { block?: boolean; reason?: string } | undefined;
      if (r?.block) return blocked.push(`${name} ${(params as { path?: string }).path}`), { error: r.reason };
    }
    let result: Result = {};
    if (rt.tools[name]) {
      try {
        result = await rt.tools[name].execute("call", params, undefined, undefined, rt.ctx);
      } catch (e) {
        result = { error: (e as Error).message };
      }
    }
    const out = result.content?.map((c) => c.text).join("") ?? result.error ?? String((params as { output?: string }).output ?? "");
    append(rt.file(), { type: "message", message: { role: "toolResult", content: [{ type: "text", text: out }] } });
    if (name === "pb_task_done" && !result.error) {
      results.push(out);
      continuation = result.terminate ? undefined : out;
    }
    return result;
  };
  // Entries a boundary handler (turn_end, agent_before_settle) asks Pi to append.
  type Draft = { type: string; content?: string; display?: boolean; summary?: string; firstKeptEntryId?: string | null };
  const applyDrafts = (drafts: Draft[] = []) => {
    for (const d of drafts) {
      if (d.type === "compaction") {
        resets.push({ summary: d.summary!, firstKeptEntryId: d.firstKeptEntryId ?? null });
        append(rt.file(), { type: "compaction", summary: d.summary });
      } else if (d.type === "custom_message") {
        append(rt.file(), { type: "custom_message", content: d.content });
        if (d.display) posts.push(d.content!);
      }
    }
  };
  const turn = (first: string) => {
    instructions.push(first);
    stat.runs++;
    queued++;
    running = running.then(async () => {
      let input: string | undefined = first;
      while (input !== undefined) {
        continuation = undefined;
        // As in Pi: the assistant message (with its tool calls) first, then the tool results.
        append(rt.file(), { type: "message", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } });
        await agent.script?.(input, callTool);
        const usage = { input: 1000, output: 100, cacheRead: 9000, cacheWrite: 0, cost: { total: 0.001 } };
        await fire("message_end", { message: { role: "assistant", usage } });
        for (const r of (await fire("turn_end", {})) as { entries?: Draft[] }[]) applyDrafts(r?.entries);
        input = continuation;
        if (input !== undefined) {
          instructions.push(input);
          continue;
        }
        for (const r of (await fire("agent_before_settle", { outcome: "completed", entries: [], continue: false })) as { continue?: boolean; entries?: Draft[] }[]) {
          applyDrafts(r?.entries);
          if (r?.continue) {
            input = r.entries!.find((d) => d.type === "custom_message")!.content!;
            instructions.push(input);
          }
        }
      }
      await fire("agent_settled", {});
      queued--;
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
  const events = (name: string) =>
    read(`.pi/pb/specs/${name}/events.jsonl`)
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  return {
    repo,
    names,
    posts,
    notes,
    instructions,
    results,
    selects,
    selectTitles,
    confirms,
    dialogTimeouts,
    editors,
    views,
    navigations,
    resets,
    blocked,
    agent,
    stat,
    run,
    read,
    progress,
    events,
    callTool,
    settle,
    fire: (event: string, e: object) => fire(event, e),
    entry: (id: string) => treeOf(rt.file()).entries.get(id),
    /** The human types a message into the current session (no run). */
    say: (text: string) => append(rt.file(), { type: "message", message: { role: "user", content: [{ type: "text", text }] } }),
    text: (id: string) => textOf(treeOf(rt.file()).entries.get(id)!),
    /** What the model sees now: the session's context, as text. */
    context: () => branch(rt.file()).map(textOf).join("\n"),
    runtime: () => rt,
  };
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

/** The task an instruction or tool result is about. */
const taskOf = (text: string) => text.match(/Task (T\d+)/)?.[1] ?? text.match(/task "(\w+)"/)?.[1];

/** An agent that does each task by creating <task>.txt. */
const diligent: Script = async (text, tool) => {
  const task = taskOf(text);
  if (!task) return;
  if (task !== "final") fs.writeFileSync(`${task}.txt`, "x");
  await tool("pb_task_done", { task, status: "done", summary: `did ${task}` });
};

async function written(t: ReturnType<typeof setup>, spec = SPEC()) {
  process.chdir(t.repo);
  const r = await t.callTool("pb_write_spec", { name: "order-cancellation", content: spec });
  assert.equal(r.error, undefined, r.error ?? "");
}

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(cond(), "timed out");
};

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
  assert.match(t.instructions.at(-1)!, /\[pb:plan\] let admins cancel pending orders[\s\S]*curl, one-off scripts in a temp directory[\s\S]*call pb_explore[\s\S]*Run `true` once[\s\S]*pb_ask/);
  const scratch = path.join(os.tmpdir(), "pb-scratch.py");
  assert.equal((await t.callTool("write", { path: scratch, content: "print(1)" })).error, undefined); // outside the project: fine
  assert.match((await t.callTool("write", { path: "src/Order.java", content: "x" })).error!, /Planning mode: the project's files stay untouched/);
  assert.match((await t.callTool("edit", { path: path.join(t.repo, "README"), edits: [] })).error!, /Planning mode/);
  await t.run("plan", "off");
  assert.equal((await t.callTool("write", { path: "src/Order.java", content: "x" })).error, undefined);
  await t.run("plan");
  assert.match(t.notes.at(-1)!, /Describe what you want, in your own words/);
  await t.run("spec");
  assert.match(t.instructions.at(-1)!, /with the pb_write_spec tool[\s\S]*Not doing X, because[\s\S]*as tasks titled "\(refactor\) …" that keep behaviour/);
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

test("plan: files changed while planning (e.g. through bash) are shown before the build: keep or restore", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  t.selects.push("No thanks"); // the standards offer
  await t.run("plan", "x");
  fs.writeFileSync(path.join(t.repo, "stray.txt"), "written by a shell command");
  fs.writeFileSync(path.join(t.repo, "README"), "changed");
  await written(t);
  t.agent.script = diligent;
  t.selects.push("Restore them to how they were when planning began");
  await t.run("build");
  assert.match(t.selectTitles[1], /These project files changed while planning: (README, stray\.txt|stray\.txt, README)/);
  assert.ok(!fs.existsSync(path.join(t.repo, "stray.txt")));
  assert.equal(t.read("README"), "hi\n");
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

test("plan: the baseline runs in the background (no tokens) and a red suite warns before building", async () => {
  const t = setup({ verify: "exit 1", baseline: true });
  process.chdir(t.repo);
  await t.run("plan", "cancel orders");
  assert.match(t.instructions.at(-1)!, /The harness is running `exit 1` in the background/);
  assert.match(t.posts.find((p) => p.startsWith("▶ /pb:plan"))!, /running `exit 1` in the background for a baseline/);
  await until(() => t.posts.some((p) => p.startsWith("**Baseline**")));
  assert.match(t.posts.find((p) => p.startsWith("**Baseline**"))!, /FAIL \(exit 1\)[\s\S]*the final check runs the whole suite/i);
  assert.equal(JSON.parse(t.read(".pi/pb/baseline.json")).ok, false);
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  assert.ok(t.selectTitles.some((x) => /^The test suite already failed when planning began \(`exit 1` → FAIL/.test(x)));
});

test("standards: a Java project gets the Java 25 defaults with pb's section", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  fs.writeFileSync(path.join(t.repo, "pom.xml"), "<project/>");
  await t.run("plan", "x");
  const agents = fs.readFileSync(path.join(t.repo, "AGENTS.md"), "utf8");
  assert.match(agents, /even where the surrounding code doesn't[\s\S]*- Java 25: records, sealed types, pattern matching, virtual threads and scoped values; no Lombok\.\n<!-- \/pb:standards -->/);
  assert.match(t.notes.find((n) => n.startsWith("Added to"))!, /with Java 25 defaults/);
});

test("plan: the baseline runs in a separate worktree, so it can't collide with builds in the working copy", async () => {
  const where = path.join(os.tmpdir(), `pb-baseline-pwd-${process.pid}`);
  const t = setup({ verify: `pwd > ${where}`, baseline: true });
  process.chdir(t.repo);
  await t.run("plan", "x");
  await until(() => t.posts.some((p) => p.startsWith("**Baseline**")));
  const dir = fs.readFileSync(where, "utf8").trim();
  assert.match(dir, /pb-worktree-[^/]+\/tree$/); // not the working copy
  assert.ok(!fs.existsSync(dir)); // removed afterwards
  assert.doesNotMatch(execSync("git worktree list", { cwd: t.repo, encoding: "utf8" }), /pb-worktree-/);
});

test("pb_explore answers from a separate context; its usage is reported and counted", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  await t.run("plan", "cancel orders");
  const r = await t.callTool("pb_explore", { question: "How are order transitions built?" });
  assert.match(r.content![0].text, /OrderService applies transitions\. \(asked: How are order transitions built\?\)/);
  assert.equal(r.usage!.totalTokens, 3400);
  const d = (r as { details?: any }).details;
  assert.equal(d.tokens, 3400);
  assert.equal(typeof d.ms, "number");
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  await t.run("stats");
  assert.match(t.posts.at(-1)!, /Explorer +1 calls · prompt 3\.0k · output 400 · \$0\.02/);
});

test("/pb:deps investigates dependencies as a change of its own, in planning mode", async () => {
  const t = setup();
  process.chdir(t.repo);
  await t.run("deps", "jackson");
  assert.match(t.instructions.at(-1)!, /\[pb:deps\] jackson[\s\S]*latest stable[\s\S]*Don't change the project's files/);
  assert.match((await t.callTool("write", { path: "pom.xml", content: "x" })).error!, /Planning mode/);
});

/* ------------------------------------- build ------------------------------------- */

test("build --fresh: a new session seeded with the spec, tasks behind their tests, then the full suite", async () => {
  const t = setup({ taskChecks: "each",  verify: "test -f T1.txt && test -f T2.txt" });
  await written(t);
  t.agent.script = diligent;
  await t.run("build", "--fresh");
  const p = t.progress("order-cancellation");
  assert.equal(p.phase, "built");
  assert.match(p.session, /build-session-1\.jsonl$/);
  assert.equal(t.names.get(p.session), "build: order-cancellation");
  assert.ok(t.posts.some((x) => /This session: "build: order-cancellation" · back to it with \/resume, or `pi --session build-session-1`/.test(x)));
  assert.deepEqual(p.tasks.map((x: any) => [x.id, x.status]), [["T1", "done"], ["T2", "done"]]);
  assert.match(t.instructions[0], /Build this feature from the spec below[\s\S]*# Order cancellation[\s\S]*Task T1\. Do only this task/);
  assert.match(t.posts.at(-1)!, /BUILD COMPLETE — order-cancellation[\s\S]*PASS/);
  assert.match(t.read(".pi/pb/specs/order-cancellation/events.jsonl"), /"type":"check","task":"final"/); // full suite after the task tests
});

test("build: with taskChecks each, the check runs inside pb_task_done: one agent run from the first task to the end", async () => {
  const t = setup({ taskChecks: "each",  verify: "true" });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  assert.equal(t.stat.runs, 1); // no stop and restart between tasks
  const next = t.instructions.find((i) => i.startsWith("✓ T1 passed"))!;
  assert.match(next, /✓ T1 passed \(`test -f T1\.txt`\)\n\n\[pb:build\] Task T2\. Do only this task[\s\S]*it runs `test -f T2\.txt` itself, so don't run that just before/);
  assert.equal(t.instructions.length, 2); // the first message, then T2 as T1's tool result; the last result ends the run
  assert.match(t.results.at(-1)!, /✓ T2 passed[\s\S]*Running `true`…[\s\S]*Build complete: every check passed\. Stop here/);
});

test("build: with taskChecks each, a task without a Test: line is compiled, not run against the full suite", async () => {
  const t = setup({ taskChecks: "each",  verify: "true", build: "echo compiled" });
  await written(t, SPEC({ tasks: "### T1: first file\nCreate T1.txt.\n- Acceptance: T1.txt exists\n\n### T2: second file\nCreate T2.txt.\n- Acceptance: T2.txt exists" }));
  t.agent.script = diligent;
  await t.run("build");
  const checks = t.events("order-cancellation").filter((e) => e.type === "check");
  assert.deepEqual(checks.map((c) => [c.task, c.command]), [["T1", "echo compiled"], ["T2", "echo compiled"], ["final", "true"]]);
});

test("build: a failing check goes back to the agent, and passes on the next attempt", async () => {
  const t = setup({ taskChecks: "each",  verify: "true" });
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
  assert.ok(t.instructions.some((i) => /The check for T1 failed \(attempt 2 of 2\)[\s\S]*test -f T1\.txt[\s\S]*call pb_task_done again/.test(i)));
  assert.equal(t.progress("order-cancellation").phase, "built");
});

test("build: after the last attempt it pauses; /pb:build resumes with a fresh set", async () => {
  const t = setup({ taskChecks: "each",  verify: "true" });
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
  assert.match(t.results.at(-1)!, /That was the last attempt: the build is paused\. Stop here/);
  give = true;
  await t.run("build", "create the file in the repo root");
  assert.equal(t.progress("order-cancellation").phase, "built");
  assert.match(t.read(".pi/pb/specs/order-cancellation/spec.md"), /- create the file in the repo root/); // guidance recorded as a decision
  assert.match(t.instructions.find((i) => /From the human: create the file/.test(i))!, /Task T1 \(attempt 1 of 2\)|Task T1\. Do only/);
});

test("build: ambiguities become recorded assumptions; questions are asked without pausing", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  let answer: Result | undefined;
  t.agent.script = async (text, tool) => {
    if (text.includes("Task T1")) await tool("pb_record_decision", { decision: "Follow the layout rules over the mockup: the rules are marked exact.", assumption: true });
    if (text.includes("Task T2")) answer = await tool("pb_ask", { question: "Which file name?", options: ["t2.txt", "T2.txt"], recommended: "T2.txt" });
    return diligent(text, tool);
  };
  t.selects.push("T2.txt (recommended)");
  await t.run("build");
  assert.equal(answer!.content![0].text, "The human answered: T2.txt (recorded in the spec's Decisions)");
  assert.equal(t.stat.runs, 1); // no pause, no resume
  const spec = t.read(".pi/pb/specs/order-cancellation/spec.md");
  assert.match(spec, /- Assumption \(build, T1\): Follow the layout rules over the mockup/);
  assert.match(spec, /- Which file name\? → T2\.txt/);
  assert.match(t.posts.at(-1)!, /BUILD COMPLETE[\s\S]*Choices the build made where the spec was unclear[\s\S]*Assumption \(build, T1\): Follow the layout rules/);
});

test("build: an unanswered question goes on with the recommendation after askTimeoutSec, recorded as an assumption", async () => {
  const t = setup({ verify: "true", askTimeoutSec: 0.001 });
  await written(t);
  let answer: Result | undefined;
  t.agent.script = async (text, tool) => {
    if (text.includes("Task T2")) answer = await tool("pb_ask", { question: "Which file name?", options: ["t2.txt", "T2.txt"], recommended: "T2.txt" });
    return diligent(text, tool);
  };
  t.selects.push("<timeout>");
  await t.run("build");
  assert.equal(t.dialogTimeouts.at(-1), 1);
  assert.match(answer!.content![0].text, /No answer within 0 min: go on with your recommendation \(T2\.txt\)/);
  assert.match(t.read(".pi/pb/specs/order-cancellation/spec.md"), /- Assumption \(build, T2, no answer within 0 min\): Which file name\? → T2\.txt/);
  assert.match(t.posts.at(-1)!, /BUILD COMPLETE[\s\S]*no answer within 0 min/);
});

test("pb_ask runs one at a time: two questions in one message come as two dialogs, not one dismissing the other", async () => {
  const t = setup();
  process.chdir(t.repo);
  assert.equal(t.runtime().tools.pb_ask.executionMode, "sequential");
  assert.match(t.runtime().tools.pb_ask.description, /ask a question that depends on another's answer only after you have that answer/);
});

test("build: without a UI, a question pauses the build; answering costs the task no attempt", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  t.runtime().hasUI = false;
  let asked = false;
  t.agent.script = async (text, tool) => {
    if (text.includes("Task T2") && !asked) {
      asked = true;
      const r = await tool("pb_ask", { question: "Which file name?" });
      assert.equal(r.terminate, true);
      return;
    }
    if (text.includes("Continue task T2")) return diligent("Task T2", tool);
    return diligent(text, tool);
  };
  await t.run("build");
  assert.match(t.posts.at(-1)!, /Build paused\*\* — T2 question: Which file name\?/);
  await t.run("build", "call it T2.txt");
  assert.ok(t.instructions.some((i) => /^\[pb:build\] Continue task T2: second file\. Finish it with pb_task_done\.\n\nFrom the human: call it T2\.txt$/.test(i)));
  const p = t.progress("order-cancellation");
  assert.equal(p.phase, "built");
  assert.equal(p.tasks.find((x: any) => x.id === "T2").attempts, 1);
});

test("build: an agent that stops mid-task is reminded once, like a stop hook, before the build pauses", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  let idle = true;
  t.agent.script = async (text, tool) => {
    if (text.includes("Task T2") && idle) {
      idle = false; // stops with a prose summary instead of pb_task_done
      return;
    }
    if (text.includes("You stopped without finishing T2")) return diligent("Task T2", tool);
    return diligent(text, tool);
  };
  await t.run("build");
  assert.equal(t.progress("order-cancellation").phase, "built");
  assert.equal(t.events("order-cancellation").filter((e) => e.type === "nudge").length, 1);
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
  assert.match(t.instructions[0], /Tests: add none for this feature \(the human said so\)[\s\S]*no checks run \(docs only\)/);
});

test("build: existing tests cut down or skipped don't fail a task: they are listed and handed to the reviewer", async () => {
  const t = setup({ verify: "true" });
  fs.mkdirSync(path.join(t.repo, "tests"));
  fs.writeFileSync(path.join(t.repo, "tests/test_a.py"), "def test_a():\n    pass\ndef test_b():\n    pass\n");
  execSync("git add . && git commit -qm tests", { cwd: t.repo });
  await written(t);
  t.agent.script = async (text, tool) => {
    if (text.includes("Task T1")) fs.writeFileSync("tests/test_a.py", "def test_parametrized():\n    pass\n"); // a refactor merged them
    return diligent(text, tool);
  };
  await t.run("build");
  const p = t.progress("order-cancellation");
  assert.equal(p.phase, "built");
  assert.equal(t.stat.runs, 1);
  assert.deepEqual(p.testChanges, ["T1: tests/test_a.py: 2 → 1 test cases"]);
  assert.match(t.results[0], /⚠ existing tests changed \(the review checks them\): tests\/test_a\.py: 2 → 1 test cases/);
  assert.match(t.posts.at(-1)!, /BUILD COMPLETE[\s\S]*Existing tests the build changed[\s\S]*- T1: tests\/test_a\.py: 2 → 1 test cases/);
  const briefFile = path.join(os.tmpdir(), `pb-brief-tc-${process.pid}.md`);
  process.env.MOCK_BRIEF_OUT = briefFile;
  await t.run("review");
  delete process.env.MOCK_BRIEF_OUT;
  assert.match(fs.readFileSync(briefFile, "utf8"), /## Existing tests the build changed[\s\S]*judge whether each was justified:\n- T1: tests\/test_a\.py: 2 → 1 test cases/);
});

test("build: by default, tasks aren't checked one by one; the full suite runs after the last, and a failure goes back", async () => {
  const t = setup({ verify: "test -f T1.txt && test -f T2.txt && test -f fixed.txt" });
  await written(t);
  t.agent.script = async (text, tool) => {
    if (text.includes('task "final"')) fs.writeFileSync("fixed.txt", "x");
    return diligent(text, tool);
  };
  await t.run("build");
  const checks = t.events("order-cancellation").filter((e) => e.type === "check");
  assert.deepEqual(checks.map((c) => [c.task, c.command, c.ok]), [
    ["T1", null, true],
    ["T2", null, true],
    ["final", "test -f T1.txt && test -f T2.txt && test -f fixed.txt", false],
    ["final", "test -f T1.txt && test -f T2.txt && test -f fixed.txt", true],
  ]);
  assert.match(t.instructions[0], /after the last task the harness runs the full suite; check each task yourself/);
  assert.match(t.instructions[0], /When done, call pb_task_done with task "T1" once `test -f T1\.txt` passes/);
  assert.match(t.results[0], /✓ T1 done \(checked after the last task\)/);
  assert.match(t.results[1], /The final check failed \(attempt 2 of 2\)/);
  assert.equal(t.progress("order-cancellation").phase, "built");
  assert.equal(t.stat.runs, 1);
});

test("build: a compaction in the middle of a task: pb's summary carries the rules, the task, and what it changed so far", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  t.agent.script = async (text, tool) => {
    if (text.includes("Task T2")) {
      fs.writeFileSync("T2.txt", "halfway");
      const prep = { firstKeptEntryId: "e9", tokensBefore: 90000, previousSummary: "We discussed audit.", fileOps: { read: new Set(["src/order.ts", "T2.txt"]), edited: new Set(), written: new Set() } };
      const [r] = (await t.fire("session_before_compact", { preparation: prep, reason: "threshold" })) as any[];
      assert.equal(r.compaction.firstKeptEntryId, "e9");
      assert.match(
        r.compaction.summary,
        /^\[pb build state: order-cancellation\] This conversation was compacted in the middle of T2\. Carry on[\s\S]*How this build works:\n- Where the spec is unclear[\s\S]*Finish each task with pb_task_done[\s\S]*- T1 first file: done — did T1[\s\S]*- T2 second file: doing \(current\)[\s\S]*Files T2 has changed so far:\n- T2\.txt[\s\S]*Files read before this point \(read again what you need\):\n- src\/order\.ts\n[\s\S]*We discussed audit\.[\s\S]*--- spec ---\n# Order cancellation[\s\S]*--- current ---\n\[pb:build\] Task T2\. Do only this task/,
      );
      // A planning checkpoint as the previous summary isn't repeated: the spec is there already.
      const [again] = (await t.fire("session_before_compact", { preparation: { ...prep, previousSummary: "[pb plan checkpoint] … the whole spec …" }, reason: "threshold" })) as any[];
      assert.doesNotMatch(again.compaction.summary, /the whole spec/);
    }
    return diligent(text, tool);
  };
  await t.run("build");
  assert.equal(t.progress("order-cancellation").phase, "built");
  assert.ok(t.events("order-cancellation").some((e) => e.type === "compact" && e.task === "T2"));
});

test("build: past checkpointAt, the session is reset at the next task boundary; undo works on both sides of it", async () => {
  /** T1 fills the context to 73%. */
  const filling = (x: ReturnType<typeof setup>): Script => async (text, tool) => {
    if (text.includes("Task T1")) x.runtime().usage = 73;
    if (text.includes("Task T2")) x.runtime().usage = 5;
    return diligent(text, tool);
  };
  const t = setup({ verify: "true" });
  await written(t);
  t.agent.script = filling(t);
  await t.run("build");
  assert.equal(t.resets.length, 1);
  assert.equal(t.resets[0].firstKeptEntryId, null);
  assert.match(t.resets[0].summary, /^\[pb build state: order-cancellation\] The build session was reset between two tasks[\s\S]*How this build works:[\s\S]*- T1 first file: done — did T1[\s\S]*--- spec ---[\s\S]*--- next ---\n\[pb:build\] Task T2\. Do only this task/);
  assert.ok(t.posts.some((p) => /\*\*Context reset\*\* before T2 \(it was 73% full\)/.test(p)));
  assert.doesNotMatch(t.context(), /\[pb:build order-cancellation\] Build the spec/); // T1's conversation is gone
  assert.equal(t.progress("order-cancellation").phase, "built");
  const cps = JSON.parse(t.read(".pi/pb/specs/order-cancellation/checkpoints.json"));
  const t2 = cps.find((c: any) => c.id === "T2");
  assert.equal(t.entry(t2.entry)!.type, "compaction"); // T2 starts at the reset
  assert.ok(t.events("order-cancellation").some((e) => e.type === "reset" && e.task === "T2" && e.percent === 73));

  await t.run("undo", "T2"); // back to the reset: the summary with T2 to do
  assert.equal(t.navigations.at(-1)!.target, t2.entry);
  const n = t.navigations.length;
  await t.run("undo", "T1"); // before the reset: files only, with a note
  assert.equal(t.navigations.length, n);
  assert.ok(!fs.existsSync(path.join(t.repo, "T1.txt")));
  assert.match(t.posts.at(-1)!, /The conversation wasn't rewound \(that point is before a context reset or compaction\)/);

  const u = setup({ verify: "true", checkpointAt: 0 }); // off: Pi compacts when full, with pb's summary
  await written(u);
  u.agent.script = filling(u);
  await u.run("build");
  assert.equal(u.resets.length, 0);
});

/* ------------------------------------- undo -------------------------------------- */

test("undo restores the files and tasks to before a task, rewinds the conversation, and can be undone", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  t.say("name files in lower case from now on");
  const leafBefore = t.runtime().ctx.sessionManager.getLeafId();
  t.agent.script = undefined;
  await t.run("undo", "T2");
  assert.ok(!fs.existsSync(path.join(t.repo, "T2.txt")) && fs.existsSync(path.join(t.repo, "T1.txt")));
  assert.deepEqual(t.progress("order-cancellation").tasks.map((x: any) => [x.id, x.status]), [["T1", "done"], ["T2", "todo"]]);
  assert.match(t.posts.at(-1)!, /Undone to before T2\*\* — 1 file\(s\) restored, the conversation rewound/);
  // Back to where T2 was handed out, with pb's own summary of what was undone.
  const nav = t.navigations.at(-1)!;
  assert.match(t.text(nav.target), /✓ T1 done[\s\S]*Task T2\. Do only this task/);
  assert.match(nav.summary!, /The human undid the work from T2 on[\s\S]*T2 ✓ · 1 files · did T2[\s\S]*What the human said meanwhile, still valid unless they say otherwise: "name files in lower case from now on"/);

  await t.run("undo", "u1");
  assert.ok(fs.existsSync(path.join(t.repo, "T2.txt")));
  assert.equal(t.navigations.at(-1)!.target, leafBefore);
  assert.equal(t.navigations.at(-1)!.summary, undefined);
});

test("undo to the start of the build: a resume sends the build's instructions again", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  await t.run("undo", "start");
  assert.equal(t.progress("order-cancellation").needsIntro, true);
  const n = t.instructions.length;
  await t.run("build");
  assert.match(t.instructions[n], /^\[pb:build order-cancellation\] Build the spec you wrote[\s\S]*Task T1\. Do only this task/);
  assert.equal(t.progress("order-cancellation").phase, "built");
});

test("status lists every spec with its state and tasks", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  await t.run("status");
  assert.match(t.notes.at(-1)!, /order-cancellation — written · verification tests/);
});

/* ------------------------------ review, stats, archive ------------------------------ */

test("review: fresh check, then a fresh reviewer with the spec first and the diff; pass marks it reviewed", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  const briefFile = path.join(os.tmpdir(), `pb-brief-${process.pid}.md`);
  process.env.MOCK_BRIEF_OUT = briefFile;
  await t.run("review");
  delete process.env.MOCK_BRIEF_OUT;
  const brief = fs.readFileSync(briefFile, "utf8");
  assert.match(brief, /^# The spec[\s\S]*Not doing soft delete[\s\S]*## Changed files\n\n(T1\.txt\n)?[\s\S]*T2\.txt/);
  assert.match(brief, /## The check the harness ran\n\n`true` → PASS/);
  assert.match(t.posts.at(-1)!, /Review of order-cancellation\*\* — ✅ PASS[\s\S]*Acceptance: all met\.[\s\S]*1\. \[P2\] src\/order\.ts:30 — name the constant\n2\. \[P3\] src\/order\.ts:12 — consider a guard clause\n   Fix: return early/);
  assert.equal(t.progress("order-cancellation").phase, "reviewed");

  await t.run("review");
  assert.match(t.notes.at(-1)!, /Nothing changed since the last review \(pass\)/);
  process.env.MOCK_REVIEW = "changes_needed";
  await t.run("review", "--full");
  delete process.env.MOCK_REVIEW;
  assert.match(t.posts.at(-1)!, /✗ CHANGES NEEDED/);
});

test("review: a follow-up looks at the previous findings and what changed since", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  process.env.MOCK_REVIEW = "changes_needed";
  await t.run("review");
  fs.writeFileSync(path.join(t.repo, "T1.txt"), "fixed");
  const briefFile = path.join(os.tmpdir(), `pb-brief2-${process.pid}.md`);
  process.env.MOCK_BRIEF_OUT = briefFile;
  delete process.env.MOCK_REVIEW;
  await t.run("review");
  delete process.env.MOCK_BRIEF_OUT;
  const brief = fs.readFileSync(briefFile, "utf8");
  assert.match(brief, /## This is a follow-up review[\s\S]*1\. \[P1\] src\/order\.ts:12 — consider a guard clause[\s\S]*Changed since the previous review[\s\S]*T1\.txt/);
  assert.match(t.posts.at(-1)!, /Review of order-cancellation\*\* \(follow-up\) — ✅ PASS/);
});

test("review: findings carry priorities; P0/P1 are double-checked; only line-leading tags count in prose", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  process.env.MOCK_REVIEW = "changes_needed";
  await t.run("review");
  assert.match(t.posts.at(-1)!, /✗ CHANGES NEEDED · P0 0 · P1 1 · P2 1 · P3 0/);
  process.env.MOCK_VERIFY = "reject"; // the verifier finds the P1 isn't real
  await t.run("review", "--full");
  delete process.env.MOCK_VERIFY;
  assert.match(t.posts.at(-1)!, /✅ PASS · P0 0 · P1 0 · P2 1 · P3 0[\s\S]*Dismissed after a second look:\n- \[P1\] consider a guard clause — src\/order\.ts:11 already guards it/);
  process.env.MOCK_REVIEW = "pass";
  await t.run("review", "--full");
  assert.match(t.posts.at(-1)!, /✅ PASS · P0 0 · P1 0 · P2 1 · P3 1/);
  process.env.MOCK_REVIEW = "untagged";
  await t.run("review", "--full");
  assert.match(t.posts.at(-1)!, /✅ PASS\n/); // no tool call, no tags: the VERDICT line decides
  process.env.MOCK_REVIEW = "prose";
  await t.run("review", "--full");
  delete process.env.MOCK_REVIEW;
  assert.match(t.posts.at(-1)!, /✅ PASS · P0 0 · P1 0 · P2 1 · P3 0/); // "No [P0] or [P1] issues" isn't a finding
});

test("review: offers once to run the reviewer on another model than the one that built the change", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  t.selects.push("p/big");
  await t.run("review");
  assert.match(t.selectTitles.at(-1)!, /The reviewer runs on p\/m, which likely built this too/);
  assert.equal(JSON.parse(t.read(".pi/pb/config.json")).reviewer.model, "p/big");
  assert.equal(JSON.parse(t.read(".pi/pb/config.json")).maxAttempts, 2); // the rest kept as written
  const n = t.selectTitles.length;
  await t.run("review", "--full");
  assert.equal(t.selectTitles.length, n); // asked once
});

test("review: works without a spec, on the uncommitted change and its intent", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  await t.run("review");
  assert.match(t.notes.at(-1)!, /Nothing to review: there are no uncommitted changes/);
  fs.writeFileSync(path.join(t.repo, "README"), "hello\n");
  const briefFile = path.join(os.tmpdir(), `pb-brief3-${process.pid}.md`);
  process.env.MOCK_BRIEF_OUT = briefFile;
  await t.run("review", "greet more warmly");
  delete process.env.MOCK_BRIEF_OUT;
  assert.match(fs.readFileSync(briefFile, "utf8"), /^# No spec[\s\S]*Intent: greet more warmly[\s\S]*## Changed files\n\nREADME/);
  assert.match(t.posts.at(-1)!, /Review of the uncommitted change\*\* — ✅ PASS/);
});

test("review: files the reviewer changes are put back", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  process.env.MOCK_REVIEW_WRITE = path.join(t.repo, "T1.txt");
  await t.run("review");
  delete process.env.MOCK_REVIEW_WRITE;
  assert.equal(t.read("T1.txt"), "x");
  assert.ok(t.notes.some((n) => /The reviewer changed T1\.txt; put back as it was/.test(n)));
});

test("stats: tasks, first try, checks, pauses, review, and the build session's tokens and cache", async () => {
  const t = setup({ taskChecks: "each",  verify: "true" });
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
  assert.match(card, /Reviewer +prompt 12\.0k · output 1\.6k · \$0\.08/); // reviewer and abuse pass, two mock messages each

  await t.run("stats", "all");
  assert.match(t.posts.at(-1)!, /order-cancellation +2\/2 +50%/);
});

test("stats: after a new plan in the build's session, its turns stop counting for the finished spec", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  await t.run("plan", "cancel orders");
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  const usage = () => t.events("order-cancellation").filter((e) => e.type === "usage").length;
  const before = usage();
  await t.run("plan", "the next feature");
  assert.equal(usage(), before);
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
    if (stop && (text.includes("Task T2") || text.includes("finishing T2"))) return; // the session "dies" before T2 finishes
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
  assert.match(p.session, /elsewhere\.jsonl$/); // restarted here, in the session that ran /pb:build
  assert.ok(t.instructions.some((i) => /Build this feature from the spec below[\s\S]*# Order cancellation/.test(i))); // this session never saw the spec, so it comes along
  assert.equal(t.instructions.filter((i) => /Task T1/.test(i)).length, 1); // T1 wasn't redone
});

test("prompts: short mechanics plus your standards; a minimal spec is enough", async () => {
  const { buildMechanics } = await import("../extensions/pb/prompts.ts");
  const mech = buildMechanics(parseSpec(SPEC()).spec!, null, true);
  assert.ok(mech.length < 900, `build mechanics grew to ${mech.length} chars`); // keep them short
  assert.match(mech, /take the sensible reading, record it with pb_record_decision \(assumption: true\)[\s\S]*Ask with pb_ask only/);
  assert.match(mech, /leave \.pi\/ alone/);
  assert.match(mech, /Finish each task with pb_task_done: it runs the task's Test: command \(a compile when there is none\)/);
  assert.match(mech, /Change or remove an existing test only when what it covers changes; never skip or weaken one/);
  assert.ok(buildMechanics(parseSpec(SPEC()).spec!, null).length < 900);

  const t = setup({ taskChecks: "each", verify: "true" });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  const first = t.instructions[0];
  assert.match(first, /Build the spec you wrote[\s\S]*The planning is done: implement it as written/);
  assert.doesNotMatch(first, /Engineering standards/); // none in this project's AGENTS.md: nothing to add
  assert.match(t.instructions.find((i) => /Task T2/.test(i))!, /Comments: the code as it is; no history, dates or decisions/);

  await t.run("spec");
  assert.match(t.instructions.at(-1)!, /Each decision with its reason, as it stands now: no dates, no history/);

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
  await t.run("build", "--fresh");
  const build = t.runtime();
  assert.notEqual(build, planning);
  assert.deepEqual([build.model.id, build.thinking], ["big", "high"]);
  assert.ok(t.posts.some((x) => /Building \*\*order-cancellation\*\*[^\n]*, on p\/big, thinking high\./.test(x)));
  assert.ok(!fs.existsSync(path.join(t.repo, ".pi/pb/carry.json"))); // handed over once
});

/* ------------------------------ same session, auto spec, standards ------------------------------ */

test("build: by default in this session: the planning protection lifts, the spec isn't repeated", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  await t.run("plan", "cancel orders");
  await written(t);
  t.agent.script = async (text, tool) => {
    if (text.includes("Task T1")) assert.equal((await tool("write", { path: "Order.java", content: "x" })).error, undefined); // editing allowed now
    return diligent(text, tool);
  };
  const planning = t.runtime();
  await t.run("build");
  assert.equal(t.runtime(), planning); // no new session
  const p = t.progress("order-cancellation");
  assert.equal(p.phase, "built");
  assert.match(p.session, /planning-session\.jsonl$/);
  assert.doesNotMatch(t.instructions.find((i) => /\[pb:build order-cancellation\]/.test(i))!, /# Order cancellation/); // it wrote it: no copy
  assert.match(t.posts.find((x) => /Building \*\*order-cancellation\*\* here/.test(x))!, /▶ T1: first file/);
});

test("build: when the session is getting full, it offers a fresh session", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  t.runtime().usage = 72;
  t.agent.script = diligent;
  await t.run("build");
  assert.match(t.selectTitles[0], /Build order-cancellation: this session is 72% full/);
  assert.match(t.progress("order-cancellation").session, /build-session-1\.jsonl$/);
  assert.equal(t.progress("order-cancellation").phase, "built");
});

test("build without a spec: it asks first, then writes the spec and builds it with no dialog after", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  await t.run("plan", "cancel orders");
  t.agent.script = async (text, tool) => {
    if (/pb_write_spec tool/.test(text)) return void (await tool("pb_write_spec", { name: "order-cancellation", content: SPEC() }));
    return diligent(text, tool);
  };
  await t.run("build");
  assert.equal(t.selectTitles.at(-1), "Pi writes the spec first. Then?"); // asked before the spec, while you're here
  assert.match(t.instructions.find((i) => /pb_write_spec tool/.test(i))!, /After writing it, stop: the build starts by itself/);
  assert.ok(t.posts.some((x) => /\*\*Spec written: order-cancellation\*\*[\s\S]*- T1: first file · `test -f T1\.txt`/.test(x)));
  assert.deepEqual(t.views.map((v) => [v.customType, v.data.name]), [["pb-spec", "order-cancellation"]]); // the whole spec, shown, not sent to the model
  assert.equal(t.progress("order-cancellation").phase, "built"); // built here, with no dialog after the spec
  assert.match(t.progress("order-cancellation").session, /planning-session\.jsonl$/);
});

test("spec approval: edit the spec first; the build then gets your version", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  await t.run("plan", "cancel orders");
  t.agent.script = async (text, tool) => {
    if (/pb_write_spec tool/.test(text)) return void (await tool("pb_write_spec", { name: "order-cancellation", content: SPEC() }));
    return diligent(text, tool);
  };
  t.selects.push("Show me the spec first", "Edit the spec first", "Build here (keeps our discussion; the cache stays warm)");
  t.editors.push("# broken", SPEC().replace("### T2: second file", "### T2: the second file"));
  await t.run("build");
  assert.ok(t.notes.some((n) => /Not saved, the spec doesn't parse/.test(n)));
  assert.match(t.read(".pi/pb/specs/order-cancellation/spec.md"), /### T2: the second file/);
  assert.match(t.instructions.find((i) => /\[pb:build order-cancellation\]/.test(i))!, /Build this feature from the spec below[\s\S]*T2: the second file/);
  assert.equal(t.progress("order-cancellation").phase, "built");
});

test("standards: offered once into AGENTS.md; repeated in a message only when the session hasn't loaded them", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  await t.run("plan", "x"); // default choice: this project's AGENTS.md
  const agents = path.join(t.repo, "AGENTS.md");
  assert.match(fs.readFileSync(agents, "utf8"), /<!-- pb:standards -->[\s\S]*Dependencies: use current, non-deprecated APIs[\s\S]*<!-- \/pb:standards -->/);
  assert.doesNotMatch(fs.readFileSync(agents, "utf8"), /even when it is more work|latest stable versions|inconsistent with its surroundings/);
  assert.match(fs.readFileSync(agents, "utf8"), /even where the surrounding code doesn't[\s\S]*refactor it to current practice: when planning, propose it as a task of its own/);
  assert.match(t.instructions.at(-1)!, /Engineering standards \(from AGENTS\.md\)[\s\S]*a proper fix, never a workaround/); // this session started before they existed
  fs.writeFileSync(agents, fs.readFileSync(agents, "utf8").replace("Tests: test behaviour", "Java 21: records, no Lombok. Tests: test behaviour"));

  await t.run("plan", "y"); // asked once only; now the session has them loaded
  t.runtime().contextFiles = [{ path: agents, content: fs.readFileSync(agents, "utf8") }];
  await t.run("plan", "z");
  assert.doesNotMatch(t.instructions.at(-1)!, /Engineering standards \(from AGENTS\.md\)/);
  assert.equal((fs.readFileSync(agents, "utf8").match(/<!-- pb:standards -->/g) ?? []).length, 1); // not added twice

  t.runtime().contextFiles = [];
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  assert.match(t.instructions.find((i) => /\[pb:build order-cancellation\]/.test(i))!, /Java 21: records, no Lombok/);
});

test("build: a different buildModel builds in a fresh session, since switching here would re-send everything uncached", async () => {
  const t = setup({ verify: "true", buildModel: "p/big" });
  await written(t);
  t.agent.script = diligent;
  const planning = t.runtime();
  await t.run("build");
  assert.match(t.selectTitles[0], /building on p\/big here sends this whole conversation to it again, uncached/);
  assert.notEqual(t.runtime(), planning);
  assert.equal(t.runtime().model.id, "big");
  assert.ok(t.posts.some((x) => /Building \*\*order-cancellation\*\* from [^\n]*, on p\/big/.test(x)));

  const u = setup({ verify: "true", buildModel: "p/big" });
  await written(u);
  u.agent.script = diligent;
  u.selects.push("Build here anyway");
  await u.run("build");
  assert.equal(u.runtime().model.id, "big");
  assert.ok(u.posts.some((x) => /Building \*\*order-cancellation\*\* here on p\/big/.test(x)));
});

/* ------------------------------ the spec as the planning checkpoint ------------------------------ */

const PLANNING = `# Order cancellation
Status: planning

## Goal
Cancel pending orders.
## Findings
- src/order/OrderService.java owns the transitions; follow refund() (lines 40-80).
## Decisions
- Only PENDING orders can be cancelled.
- Not doing soft delete, because audit lives elsewhere.
## Open questions
- Notify the customer by mail or by event?
`;

test("spec: a planning spec needs no tasks or verification yet; a ready one does", () => {
  const { spec, errors } = parseSpec(PLANNING);
  assert.deepEqual(errors, []);
  assert.equal(spec!.status, "planning");
  assert.ok(parseSpec(PLANNING.replace("Status: planning", "Status: ready")).errors.some((e) => /no tasks/.test(e)));
  assert.equal(parseSpec(SPEC()).spec!.status, "ready");
});

test("pb_update_spec changes one section or the status, and writes nothing that wouldn't parse", async () => {
  const t = setup();
  process.chdir(t.repo);
  assert.match((await t.callTool("pb_write_spec", { name: "order-cancellation", content: PLANNING })).content![0].text, /status planning; ~\d+ tokens\.$/);
  const r = await t.callTool("pb_update_spec", { name: "order-cancellation", section: "Decisions", content: "- Notify by event: mail belongs to the notification service.", mode: "append" });
  assert.match(r.content![0].text, /Updated .*spec\.md \(Decisions\): status planning/);
  assert.match(t.read(".pi/pb/specs/order-cancellation/spec.md"), /- Not doing soft delete, because audit lives elsewhere\.\n- Notify by event: mail belongs to the notification service\.\n\n## Open questions/);
  assert.match((await t.callTool("pb_update_spec", { name: "order-cancellation", status: "ready" })).error!, /Not written: the spec wouldn't parse[\s\S]*Verification[\s\S]*no tasks/);
  assert.match(t.read(".pi/pb/specs/order-cancellation/spec.md"), /Status: planning/);
  assert.match((await t.callTool("pb_update_spec", { name: "nope", section: "Goal", content: "x" })).error!, /No spec "nope"/);
});

test("spec size is reported, with a gentle note (never a rejection) when it's long", async () => {
  const t = setup();
  process.chdir(t.repo);
  const long = SPEC().replace("Cancel orders.", "Cancel orders. " + "Detail. ".repeat(7000));
  const r = await t.callTool("pb_write_spec", { name: "order-cancellation", content: long });
  assert.equal(r.error, undefined);
  assert.match(r.content![0].text, /~1\d{4} tokens\. That's long: if it copies code or repeats facts, pointing to the code/);
});

test("checkpoint: a planning session past checkpointAt writes its spec, then is reset to it without a compaction call", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  t.selects.push("No thanks");
  await t.run("plan", "cancel orders");
  let checkpointAsked = "";
  t.agent.script = async (text, tool) => {
    if (text.startsWith("[pb:checkpoint]")) {
      checkpointAsked = text;
      await tool("pb_write_spec", { name: "order-cancellation", content: PLANNING });
    }
  };
  t.runtime().usage = 70; // below the cap (100k window: min(75k, 100k - 16k reserve - 12k margin) = 71.6k)
  t.runtime().pi.sendUserMessage("what about notifications?");
  await t.settle();
  assert.equal(t.resets.length, 0);

  t.runtime().usage = 73;
  t.runtime().pi.sendUserMessage("and refunds are out of scope");
  await t.settle();
  assert.match(checkpointAsked, /at 73% of its context[\s\S]*pb_write_spec, Status: planning[\s\S]*the dead ends[\s\S]*each option still being weighed, with what was found for and against it/);
  assert.equal(t.resets.length, 1);
  assert.equal(t.resets[0].firstKeptEntryId, null); // nothing kept but the spec
  assert.match(t.resets[0].summary, /^\[pb plan checkpoint\][\s\S]*Planning mode is still on[\s\S]*--- \.pi\/pb\/specs\/order-cancellation\/spec\.md ---[\s\S]*## Open questions[\s\S]*--- the last exchange before the checkpoint, word for word ---\n\nHuman: and refunds are out of scope\n\nAssistant: ok$/);
  assert.match(t.posts.at(-1)!, /\*\*Plan checkpointed\*\* to \.pi\/pb\/specs\/order-cancellation\/spec\.md: the conversation was reset to it \(it was 73% full\)/);
  assert.doesNotMatch(t.context(), /\[pb:plan\]|what about notifications/); // the discussion is gone from the context: the spec and the last exchange are there
  assert.equal(t.context().match(/and refunds are out of scope/g)?.length, 1);
  assert.match(t.context(), /Only PENDING orders can be cancelled/);
  assert.ok(t.events("order-cancellation").some((e) => e.type === "checkpoint" && e.percent === 73));

  // The next checkpoint updates the existing spec instead of writing a new one.
  checkpointAsked = "";
  t.runtime().pi.sendUserMessage("more");
  await t.settle();
  assert.match(checkpointAsked, /Update \.pi\/pb\/specs\/order-cancellation\/spec\.md with pb_update_spec/);
});

test("checkpoint: when the plan isn't written, the conversation goes on as it is, without asking every turn", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  t.selects.push("No thanks");
  await t.run("plan", "cancel orders");
  t.agent.script = async () => {};
  t.runtime().usage = 80;
  t.runtime().pi.sendUserMessage("go on");
  await t.settle();
  assert.equal(t.resets.length, 0);
  assert.match(t.posts.at(-1)!, /the plan wasn't written to a spec, so the conversation goes on as it is/);
  const asked = t.instructions.filter((i) => i.startsWith("[pb:checkpoint]")).length;
  t.runtime().pi.sendUserMessage("again");
  await t.settle();
  assert.equal(t.instructions.filter((i) => i.startsWith("[pb:checkpoint]")).length, asked);
});

test("checkpoint: sessions that aren't planning are left to Pi; checkpointAt 0 turns it off", async () => {
  const t = setup({ verify: "true", checkpointAt: 0 });
  process.chdir(t.repo);
  t.selects.push("No thanks");
  await t.run("plan", "cancel orders");
  t.runtime().usage = 90;
  t.runtime().pi.sendUserMessage("go on");
  await t.settle();
  assert.ok(!t.instructions.some((i) => i.startsWith("[pb:checkpoint]")));
});

test("compaction: a planning session's summary is its spec; elsewhere a compacted session gets the spec sent along at build", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  t.selects.push("No thanks");
  await t.run("plan", "cancel orders");
  await t.callTool("pb_write_spec", { name: "order-cancellation", content: PLANNING });
  const [r] = (await t.fire("session_before_compact", { preparation: { firstKeptEntryId: "e3", tokensBefore: 90000 }, reason: "overflow" })) as any[];
  assert.equal(r.compaction.firstKeptEntryId, "e3");
  assert.match(r.compaction.summary, /^\[pb plan checkpoint\][\s\S]*Not doing soft delete/);

  const u = setup({ verify: "true" });
  await written(u); // written in a session that isn't planning
  const [none] = (await u.fire("session_before_compact", { preparation: { firstKeptEntryId: "e3", tokensBefore: 90000 }, reason: "threshold" })) as any[];
  assert.equal(none, undefined); // Pi summarizes
  assert.equal(u.progress("order-cancellation").compacted, true);
  u.agent.script = diligent;
  await u.run("build");
  assert.match(u.instructions[0], /Build this feature from the spec below[\s\S]*# Order cancellation/); // not "the spec you wrote"
});

test("/pb:build on a planning spec finishes it first, then offers the build", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  t.selects.push("No thanks");
  await t.run("plan", "cancel orders");
  await t.callTool("pb_write_spec", { name: "order-cancellation", content: PLANNING });
  t.agent.script = async (text, tool) => {
    if (text.startsWith("[pb:spec order-cancellation] Finish the spec")) return void (await tool("pb_write_spec", { name: "order-cancellation", content: SPEC() }));
    return diligent(text, tool);
  };
  await t.run("build");
  assert.match(t.posts.find((p) => p.startsWith("▶ /pb:build"))!, /finishing the spec order-cancellation first/);
  assert.match(t.instructions.find((i) => i.startsWith("[pb:spec order-cancellation]"))!, /add the Tasks and the Verification line, remove Open questions, and set Status: ready/);
  assert.equal(t.progress("order-cancellation").phase, "built");
});

test("/pb:plan <spec> continues planning in a fresh session seeded from the spec", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  await t.callTool("pb_write_spec", { name: "order-cancellation", content: PLANNING });
  const before = t.runtime();
  before.model = { provider: "p", id: "big", contextWindow: 262000 };
  await t.run("plan", "order-cancellation");
  const r = t.runtime();
  assert.notEqual(r, before);
  const session = r.ctx.sessionManager.getSessionFile();
  assert.equal(t.names.get(session), "plan: order-cancellation");
  assert.equal(r.model.id, "big");
  assert.match(t.instructions.at(-1)!, /^\[pb:plan order-cancellation\] Let's continue planning this[\s\S]*Don't redo the analysis or reopen rejected ideas[\s\S]*Start with the open questions[\s\S]*## Open questions/);
  assert.equal(t.progress("order-cancellation").writtenIn, session); // it knows the spec now
  assert.match((await t.callTool("write", { path: "x.java", content: "x" })).error!, /Planning mode/); // planning mode in the new session
});

test("/pb:spec <name> revises the spec from the file, not from memory", async () => {
  const t = setup();
  process.chdir(t.repo);
  await t.callTool("pb_write_spec", { name: "order-cancellation", content: PLANNING });
  await t.run("spec", "order-cancellation");
  assert.match(t.instructions.at(-1)!, /--- current \.pi\/pb\/specs\/order-cancellation\/spec\.md \(revise this\) ---[\s\S]*follow refund\(\) \(lines 40-80\)/);
  await t.run("spec");
  assert.match(t.instructions.at(-1)!, /Existing: order-cancellation \(reusing a name rewrites it; read its spec\.md first/);
});

test("/pb:checkpoint writes and resets on demand (e.g. before quitting); undo brings the whole discussion back", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  t.selects.push("No thanks");
  await t.run("plan", "cancel orders");
  t.agent.script = async (text, tool) => {
    if (text.startsWith("[pb:checkpoint]")) await tool("pb_write_spec", { name: "order-cancellation", content: PLANNING });
  };
  t.runtime().pi.sendUserMessage("refunds are out of scope");
  await t.settle();
  assert.equal(t.resets.length, 0); // 10%: far below the checkpoint
  await t.run("checkpoint");
  assert.equal(t.resets.length, 1);
  assert.match(t.context(), /^\[pb plan checkpoint\][\s\S]*Only PENDING orders[\s\S]*Human: refunds are out of scope/);
  assert.doesNotMatch(t.context(), /\[pb:plan\] cancel orders/);

  t.runtime().usage = 73; // the whole discussion, back
  await t.run("checkpoint", "undo");
  assert.match(t.posts.at(-1)!, /Checkpoint undone\*\*: the whole discussion is back/);
  assert.match(t.context(), /\[pb:plan\] cancel orders[\s\S]*refunds are out of scope/);
  assert.doesNotMatch(t.context(), /\[pb plan checkpoint\]/);
  t.runtime().usage = 76; // past the threshold, but just undone: no new checkpoint before it grows another 5%
  t.runtime().pi.sendUserMessage("go on");
  await t.settle();
  assert.equal(t.resets.length, 1);
  await t.run("checkpoint", "undo");
  assert.match(t.notes.at(-1)!, /No checkpoint to undo/);

  const u = setup();
  process.chdir(u.repo);
  await u.run("checkpoint");
  assert.match(u.notes.at(-1)!, /Checkpoints are for planning sessions/);
});

test("pb_explore shows what it's doing: the question, its live steps, then a one-line summary (all of it expanded)", async () => {
  const { exploreLines } = await import("../extensions/pb/render.ts");
  const details = { steps: ["grep transition src/order", "read src/order/OrderService.java", "read src/order/Order.java"], count: 7, files: ["src/order/OrderService.java", "src/order/Order.java"], started: 1000 };
  assert.deepEqual(
    exploreLines({ details, answer: "", partial: true, expanded: false, now: 19_000 }).map((l) => l.text),
    ["↳ grep transition src/order", "↳ read src/order/OrderService.java", "↳ read src/order/Order.java", "7 steps · 18s"],
  );
  const answer = "OrderService applies the transitions.\nOrder holds the state.";
  const done = { ...details, ms: 34_000, tokens: 3200 };
  assert.deepEqual(exploreLines({ details: done, answer, partial: false, expanded: false }).map((l) => l.text), ["explored in 34s · 2 files read · 3.2k tokens", "OrderService applies the transitions."]);
  const all = exploreLines({ details: done, answer, partial: false, expanded: true }).map((l) => l.text);
  assert.deepEqual(all, ["explored in 34s · 2 files read · 3.2k tokens", "OrderService applies the transitions.", "Order holds the state.", "files read:", "  src/order/OrderService.java", "  src/order/Order.java"]);
  assert.deepEqual(exploreLines({ answer: "Exploration stopped.", partial: false, expanded: false, error: true }).map((l) => l.kind), ["error"]);
});

test("build: asked up front for a fresh session, the command waits for the spec and opens it itself", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  t.selects.push("No thanks");
  await t.run("plan", "cancel orders");
  t.agent.script = async (text, tool) => {
    if (/pb_write_spec tool/.test(text)) return void (await tool("pb_write_spec", { name: "order-cancellation", content: SPEC() }));
    return diligent(text, tool);
  };
  const planning = t.runtime();
  t.selects.push("Build in a fresh session as soon as the spec is written (lean context)");
  await t.run("build");
  assert.notEqual(t.runtime(), planning);
  const p = t.progress("order-cancellation");
  assert.match(p.session, /build-session-1\.jsonl$/);
  assert.equal(p.phase, "built");
});

test("build: nobody answers: after askTimeoutSec every dialog goes on with pb's choice, and the summary says so", async () => {
  const t = setup({ verify: "true", askTimeoutSec: 0.001 });
  process.chdir(t.repo);
  t.selects.push("No thanks");
  await t.run("plan", "cancel orders");
  t.agent.script = async (text, tool) => {
    if (/pb_write_spec tool/.test(text)) return void (await tool("pb_write_spec", { name: "order-cancellation", content: SPEC() }));
    return diligent(text, tool);
  };
  t.selects.push("Show me the spec first", "<timeout>"); // you asked to see it, then went to bed
  await t.run("build");
  assert.match(t.selectTitles.at(-1)!, /Build order-cancellation now\? 2 tasks/);
  assert.equal(t.progress("order-cancellation").phase, "built");
  assert.match(t.posts.at(-1)!, /BUILD COMPLETE[\s\S]*Decided without you \(no answer in time\):\n- Build order-cancellation now\? 2 tasks → Build here/);
});

test("build: Esc on the first dialog cancels; a spec that isn't written yet is offered once it is", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  t.selects.push("No thanks");
  await t.run("plan", "cancel orders");
  t.selects.push("<timeout>"); // with the default timeout, an immediate undefined is Esc
  await t.run("build");
  assert.ok(!t.instructions.some((i) => /pb_write_spec tool/.test(i)));

  let asked = false;
  t.agent.script = async (text, tool) => {
    if (/pb_write_spec tool/.test(text) && !asked) {
      asked = true; // a question in chat first
      return;
    }
    if (/refunds/.test(text)) return void (await tool("pb_write_spec", { name: "order-cancellation", content: SPEC() }));
    return diligent(text, tool);
  };
  await t.run("build");
  assert.match(t.posts.at(-1)!, /No spec ready to build yet/);
  t.runtime().pi.sendUserMessage("refunds are out of scope");
  await t.settle();
  assert.match(t.selectTitles.at(-1)!, /Build order-cancellation now\? 2 tasks/);
  assert.equal(t.progress("order-cancellation").phase, "built");
});

test("spec writing settles small things as assumptions; the checkpoint asks nothing; questions while writing count down", async () => {
  const { specPrompt, checkpointPrompt, finishSpecPrompt } = await import("../extensions/pb/prompts.ts");
  assert.match(specPrompt("", []), /Settle what the discussion left open yourself[\s\S]*"Assumption: … because …"[\s\S]*only about a choice that changes behaviour, an API or data/);
  assert.match(finishSpecPrompt("x"), /settle its open questions yourself where you can/);
  assert.match(checkpointPrompt(80, []), /Don't ask me anything now: what's undecided goes into Open questions/);

  const t = setup({ verify: "true", askTimeoutSec: 0.001 });
  process.chdir(t.repo);
  t.selects.push("No thanks");
  await t.run("plan", "cancel orders");
  let answer: Result | undefined;
  const withAssumption = SPEC().replace("- Not doing soft delete, because audit lives elsewhere.", "- Not doing soft delete, because audit lives elsewhere.\n- Assumption: cancelling twice is a no-op, because the API is idempotent elsewhere.");
  t.agent.script = async (text, tool) => {
    if (/pb_write_spec tool/.test(text)) {
      answer = await tool("pb_ask", { question: "Which HTTP verb?", options: ["POST", "DELETE"], recommended: "POST" });
      return void (await tool("pb_write_spec", { name: "order-cancellation", content: withAssumption }));
    }
    return diligent(text, tool);
  };
  t.selects.push("Build here as soon as the spec is written (keeps our discussion; the cache stays warm)", "<timeout>");
  await t.run("build");
  assert.equal(t.dialogTimeouts.at(-1), 1); // the question counted down, though no build was running yet
  assert.match(answer!.content![0].text, /No answer in time: take the sensible reading \(your recommendation: POST\), write it into the spec's Decisions as "Assumption/);
  assert.match(t.posts.find((p) => p.startsWith("**Spec written"))!, /Settled without asking you \(the review checks them\):\n- Assumption: cancelling twice is a no-op/);
  assert.equal(t.progress("order-cancellation").phase, "built");

  // During a checkpoint, a question is turned away.
  const u = setup({ verify: "true" });
  process.chdir(u.repo);
  u.selects.push("No thanks");
  await u.run("plan", "cancel orders");
  let refused: Result | undefined;
  u.agent.script = async (text, tool) => {
    if (text.startsWith("[pb:checkpoint]")) {
      refused = await tool("pb_ask", { question: "Mail or event?" });
      await tool("pb_write_spec", { name: "order-cancellation", content: PLANNING });
    }
  };
  await u.run("checkpoint");
  assert.match(refused!.content![0].text, /Not now: this is a checkpoint\. Write the question under Open questions/);
  assert.equal(u.resets.length, 1);
});

/* ------------------------------------ project map ------------------------------------ */

test("map: helpers read and write the AGENTS.md section, resolve its paths leniently, normalize and diff it", async () => {
  const { readMap, writeMap, mapPaths, unresolvedPaths, normalizeMap, mapDiff } = await import("../extensions/pb/map.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pb-map-"));
  execSync("git init -q", { cwd: dir });
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "# Mine\n\nMy own notes.\n");
  writeMap(dir, "- `src/a.ts`: a");
  writeMap(dir, "- `src/b.ts`: b");
  const md = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8");
  assert.match(md, /^# Mine\n\nMy own notes\.\n\n<!-- pb:map -->\n## Project map\n\n- `src\/b\.ts`: b\n<!-- \/pb:map -->\n$/); // replaced, your text kept
  assert.equal(readMap(dir), "- `src/b.ts`: b");
  assert.deepEqual(mapPaths("- `src/a.ts:12` and `pom.xml`, `./mvnw -pl api`, `http://x/y`, `**/*.ts`, `/signin/**`, `a/.../b.imports`, `harness.jdbcAs(X)`"), ["src/a.ts", "pom.xml"]);
  fs.mkdirSync(path.join(dir, "platform-core/src/main/java/app/auth"), { recursive: true });
  fs.writeFileSync(path.join(dir, "platform-core/src/main/java/app/auth/LoginController.java"), "");
  fs.mkdirSync(path.join(dir, "platform-core/ops"), { recursive: true });
  fs.writeFileSync(path.join(dir, "platform-core/ops/check.sh"), "");
  const body = [
    "### Runtime (platform-core/src/main/java/app/)",
    "- `auth/`: sign-in", // under the heading's path
    "- `auth/LoginController`: without extension, found as the end of a real path",
    "- `ops/check.sh`: relative to a module",
    "- `platform-core/Gone`: stale",
  ].join("\n");
  assert.deepEqual(unresolvedPaths(dir, body).map((u) => u.path), ["platform-core/Gone"]);
  assert.equal(normalizeMap("## Layout\n- a\n### Empty\n\n\n\n### Tests\n- t\n### Also empty"), "### Layout\n- a\n\n### Tests\n- t");
  assert.deepEqual(mapDiff("- a\n- b", "- a\n- c"), ["- - b", "+ - c"]);
});

test("map: /pb:archive updates it by itself: paths that don't resolve go back once to be fixed, then it's written, and undo swaps back", async () => {
  const t = setup({ verify: "true" });
  fs.mkdirSync(path.join(t.repo, "src/main/auth"), { recursive: true });
  fs.writeFileSync(path.join(t.repo, "src/order.ts"), "export {}\n");
  fs.writeFileSync(path.join(t.repo, "src/main/auth/Login.java"), "class Login {}\n");
  fs.writeFileSync(path.join(t.repo, "AGENTS.md"), "# Shop\n");
  execSync("git add . && git commit -qm src", { cwd: t.repo });
  await written(t, SPEC().replace("## Context\nsrc/order.ts holds the model.", "## Findings\n- `src/order.ts` holds the model."));
  t.agent.script = diligent;
  await t.run("build");
  const briefFile = path.join(os.tmpdir(), `pb-map-brief-${process.pid}.md`);
  process.env.MOCK_BRIEF_OUT = briefFile;
  const asked = t.selectTitles.length;
  await t.run("archive");
  delete process.env.MOCK_BRIEF_OUT;
  assert.equal(t.selectTitles.length, asked); // no question
  assert.match(fs.readFileSync(briefFile, "utf8"), /# The current map\n\n\(none yet[\s\S]*# The feature just finished: order-cancellation[\s\S]*`src\/order\.ts` holds the model[\s\S]*# Files that feature changed/);
  const agents = t.read("AGENTS.md");
  assert.match(agents, /^# Shop\n\n<!-- pb:map -->\n## Project map\n\n### Layout\n- `src\/`: the application\n### Orders\n- `src\/order\.ts`[\s\S]*follow `auth\/Login`[\s\S]*Services own transactions[\s\S]*<!-- \/pb:map -->/);
  assert.doesNotMatch(agents, /gone\.ts|### Empty/); // corrected by the cartographer, not cut by pb; empty headings go
  assert.deepEqual(t.views.find((v) => v.customType === "pb-map")!.data.warnings, []);
  assert.match(t.notes.at(-1)!, /Project map written in AGENTS\.md \(~\d+ tokens: added Orders; noted transactions\)\. `\/pb:map undo` puts the previous one back/);

  await t.run("map", "undo");
  assert.doesNotMatch(t.read("AGENTS.md"), /### Orders/); // back to no map
  await t.run("map", "undo");
  assert.match(t.read("AGENTS.md"), /### Orders/); // and forth
});

test("map: it asks only when something looks off (unanswered: the current map stays); /pb:plan warns about paths that vanished", async () => {
  const t = setup({ verify: "true", askTimeoutSec: 0.001 });
  fs.mkdirSync(path.join(t.repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(t.repo, "src/order.ts"), "export {}\n");
  process.chdir(t.repo);
  process.env.MOCK_MAP_STUBBORN = "1"; // the cartographer doesn't fix src/gone.ts
  t.selects.push("<timeout>");
  await t.run("map");
  assert.match(t.selectTitles.at(-1)!, /The proposed project map needs a look: `auth\/Login` doesn't resolve; `src\/gone\.ts` doesn't resolve/);
  assert.ok(!fs.existsSync(path.join(t.repo, "AGENTS.md"))); // nobody answered: nothing written
  t.selects.push("Apply it anyway");
  await t.run("map");
  delete process.env.MOCK_MAP_STUBBORN;
  assert.match(t.read("AGENTS.md"), /gone\.ts/);

  const u = setup({ verify: "true", mapOnArchive: false });
  await written(u);
  u.agent.script = diligent;
  await u.run("build");
  await u.run("archive");
  assert.ok(!fs.existsSync(path.join(u.repo, "AGENTS.md")));

  const { writeMap } = await import("../extensions/pb/map.ts");
  writeMap(u.repo, "- `README`: readme\n- `src/billing/Invoice.java`: invoices");
  process.chdir(u.repo);
  u.selects.push("No thanks");
  await u.run("plan", "next feature");
  assert.ok(u.notes.some((n) => /The project map in AGENTS\.md names 1 path\(s\) that no longer exist \(src\/billing\/Invoice\.java\): \/pb:map refreshes it/.test(n)));
});
