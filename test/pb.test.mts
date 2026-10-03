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
const { parseSpec, addDecision, needsRed, redExemption } = await import("../extensions/pb/spec.ts");

type Result = { error?: string; content?: { text: string }[]; terminate?: boolean; usage?: { totalTokens: number } };
type Tool = (name: string, params: object) => Promise<Result>;
type Script = (instruction: string, tool: Tool) => Promise<void> | void;
type Entry = { id: string; parentId: string | null; type: string; message?: { role: string; content: { type: "text"; text: string }[] }; content?: string; summary?: string };

function setup(config: object = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pb-test-"));
  execSync("git init -q && git config user.email t@t && git config user.name t && echo hi > README && git add . && git commit -qm init", { cwd: repo });
  fs.mkdirSync(path.join(repo, ".pi/pb"), { recursive: true });
  const c = config as { reviewer?: object };
  fs.writeFileSync(path.join(repo, ".pi/pb/config.json"), JSON.stringify({ build: null, maxAttempts: 2, baseline: false, notify: false, ...config, reviewer: { idleSec: 0.2, ...(c.reviewer ?? {}) } }));

  const posts: string[] = [];
  const notes: string[] = [];
  const instructions: string[] = [];
  const results: string[] = []; // every pb_task_done result, including the ones that end the run
  const selects: string[] = [];
  const selectTitles: string[] = [];
  const selectOptions: string[][] = [];
  const confirms: string[] = [];
  const dialogTimeouts: (number | undefined)[] = [];
  const terminalInput: ((d: string) => void)[] = [];
  const editors: (string | undefined)[] = [];
  const views: { customType: string; data: any }[] = [];
  const navigations: { target: string; summary?: string }[] = [];
  const resets: { summary: string; firstKeptEntryId: string | null }[] = [];
  const blocked: string[] = [];
  const agent: { script?: Script } = {};
  /** What the stand-in reviewer and abuse pass report (in their review sessions). */
  const reviewer: { review: object[]; abuse: object[]; prose: string; silent?: boolean; write?: string; script?: boolean } = {
    review: [
      { priority: "P3", file: "src/order.ts", line: 12, title: "consider a guard clause", fix: "return early" },
      { priority: "P2", file: "src/order.ts", line: 30, title: "name the constant" },
    ],
    abuse: [],
    prose: "Acceptance: all met.",
  };
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
    activeTools?: string[];
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
      getActiveTools: () => self.activeTools ?? ["read", "bash", "edit", "write", ...Object.keys(self.tools)],
      setSessionName: (n: string) => names.set(file(), n),
      getThinkingLevel: () => self.thinking,
      setThinkingLevel: (l: string) => (self.thinking = l),
      setModel: async (m: Runtime["model"]) => ((self.model = m), true),
      setActiveTools: (t: string[]) => (self.activeTools = t),
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
        select: async (title: string, opts: string[], o?: { timeout?: number; signal?: AbortSignal }) => {
          selectTitles.push(title);
          selectOptions.push(opts);
          dialogTimeouts.push(o?.timeout);
          const pick = selects.shift();
          if (pick === "<hang>") {
            // A dialog that stays open until dismissed: resolves on abort, like a real timeout.
            if (o?.signal?.aborted) return undefined;
            if (o?.signal) await new Promise<void>((res) => o.signal!.addEventListener("abort", () => res(), { once: true }));
            return undefined;
          }
          if (pick === "<timeout>") return undefined;
          return pick ?? opts[0];
        },
        onTerminalInput: (h: (d: string) => void) => {
          terminalInput.push(h);
          return () => {
            const i = terminalInput.indexOf(h);
            if (i >= 0) terminalInput.splice(i, 1);
          };
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
        rt = makeRuntime(next);
        const fresh = rt;
        await fire("session_start", { reason: "new" }, fresh.ctx); // as in Pi: the new runtime starts first,
        await opts.setup?.({ appendSessionInfo: (n: string) => names.set(next, n), getSessionFile: () => next }); // then setup,
        await opts.withSession?.(handover(fresh)); // then withSession
        return { cancelled: false };
      },
      switchSession: async (file: string, opts: { withSession?: (c: object) => Promise<void> } = {}) => {
        self.stale = true;
        rt = makeRuntime(file);
        const back = rt;
        await fire("session_start", { reason: "resume" }, back.ctx);
        await opts.withSession?.(handover(back));
        return { cancelled: false };
      },
    });
    pb(self.pi);
    return self;
  };
  /** The context Pi hands to withSession: the new runtime's, with sendMessage. */
  const handover = (r: Runtime) => guard(() => r, { ...r.ctx, ui: r.ctx.ui, sessionManager: r.ctx.sessionManager, sendMessage: async (m: any, o: any) => r.pi.sendMessage(m, o) });
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
     try {
      let input: string | undefined = first;
      while (input !== undefined) {
        continuation = undefined;
        // As in Pi: the assistant message (with its tool calls) first, then the tool results.
        append(rt.file(), { type: "message", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } });
        // In a review session, every message goes to the stand-in reviewer (its first one, and pb's reminder).
        const kind = names.get(rt.file())?.match(/^review: .* · (spec|intent|adversarial)$/)?.[1];
        const pass = kind && (kind === "adversarial" ? "abuse" : "review");
        if (pass && !reviewer.script) {
          // The stand-in reviewer and abuse pass: report the configured findings, then a short reply.
          if (reviewer.write && pass === "review") fs.writeFileSync(reviewer.write, "reviewer was here");
          const findings = pass === "review" ? reviewer.review : reviewer.abuse;
          if (!reviewer.silent) await callTool("pb_report_findings", { findings });
          append(rt.file(), { type: "message", message: { role: "assistant", content: [{ type: "text", text: pass === "review" ? reviewer.prose : "Done." }] } });
        } else await agent.script?.(input, callTool);
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
     } finally {
      queued--;
     }
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
    selectOptions,
    confirms,
    dialogTimeouts,
    editors,
    views,
    navigations,
    resets,
    blocked,
    agent,
    reviewer,
    stat,
    run,
    read,
    progress,
    events,
    callTool,
    /** Simulate terminal activity (arrow keys, typing): resets idle dialog countdowns. */
    key: (d = "key") => terminalInput.slice().forEach((f) => f(d)),
    settle,
    fire: (event: string, e: object, ctx?: Parameters<typeof fire>[2]) => fire(event, e, ctx),
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

/**
 * An agent that does each task the way it is asked: its test seen failing first (`test -f <task>.txt`,
 * nothing written yet), then the file it wanted, then the task done.
 */
const diligent: Script = async (text, tool) => {
  const task = taskOf(text);
  if (!task) return;
  if (task !== "final") {
    await tool("pb_tests_red", { task, tests: `${task}.txt exists` });
    fs.writeFileSync(`${task}.txt`, "x");
  }
  await tool("pb_task_done", { task, status: "done", summary: `did ${task}` });
};

/** A spec written as if a /pb:plan came first: its one-time standards offer is already answered. */
async function written(t: ReturnType<typeof setup>, spec = SPEC()) {
  process.chdir(t.repo);
  const { Store } = await import("../extensions/pb/store.ts");
  new Store(t.repo).markAsked("standards");
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
  assert.deepEqual(t.progress("order-cancellation").tasks.map((x: any) => [x.id, x.status]), [["T1", "todo"], ["T2", "todo"]]); // the spec's tasks, and nothing else
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
  assert.match(t.notes.find((n) => n.startsWith("Added to"))!, /\(the backend ones, with Java 25\)/);
});

test("standards: a Vue project gets the frontend section, without the database rules", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  fs.writeFileSync(path.join(t.repo, "package.json"), JSON.stringify({ dependencies: { vue: "^3.5.0" } }));
  await t.run("plan", "x");
  const agents = fs.readFileSync(path.join(t.repo, "AGENTS.md"), "utf8");
  assert.match(agents, /- Quality: [\s\S]*- One source of truth: every rule lives in the backend[\s\S]*- Backend refusals: RFC 9457[\s\S]*- Vue: Vue 3\.5[\s\S]*a double click, a session that expires mid-edit, a URL from the query string\. Search for existing copies of any rule you touched\.\n<!-- \/pb:standards -->/);
  assert.doesNotMatch(agents, /Consistency and concurrency|Java 25|Compare against the database/);
  assert.ok(t.selectTitles.some((x) => /^Engineering standards \(.*browser security, Vue\)$/.test(x)));
  assert.match(t.notes.find((n) => n.startsWith("Added to"))!, /the frontend ones, for a Vue project/);
});

test("standards: a Java project that also has a Vue package.json keeps the backend section", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  fs.writeFileSync(path.join(t.repo, "pom.xml"), "<project/>");
  fs.writeFileSync(path.join(t.repo, "package.json"), JSON.stringify({ devDependencies: { vue: "^3.5.0" } }));
  await t.run("plan", "x");
  const agents = fs.readFileSync(path.join(t.repo, "AGENTS.md"), "utf8");
  assert.match(agents, /Consistency and concurrency[\s\S]*- Java 25/);
  assert.doesNotMatch(agents, /Frontend role/);
});

test("standards: /pb:build without a /pb:plan first offers them too, once", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  const r = await t.callTool("pb_write_spec", { name: "order-cancellation", content: SPEC() });
  assert.equal(r.error, undefined);
  t.agent.script = diligent;
  await t.run("build");
  assert.match(t.selectTitles[0], /^Engineering standards \(/);
  assert.match(t.read("AGENTS.md"), /<!-- pb:standards -->/);
  assert.equal(t.progress("order-cancellation").phase, "built");
  const asked = t.selectTitles.length;
  await t.run("plan", "next");
  assert.equal(t.selectTitles.length, asked); // not asked again
});

test("standards: a Vue project under shared standards is offered its frontend section; stack sections never go global", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  const { agentDir, DEFAULT_STANDARDS } = await import("../extensions/pb/standards.ts");
  const global = path.join(agentDir(), "AGENTS.md");
  fs.mkdirSync(agentDir(), { recursive: true });
  fs.writeFileSync(global, DEFAULT_STANDARDS);
  try {
    fs.writeFileSync(path.join(t.repo, "package.json"), JSON.stringify({ dependencies: { vue: "^3.5.0" } }));
    await t.run("plan", "x");
    assert.match(t.selectTitles[0], /only gets the standards in .*AGENTS\.md, not its own \(the frontend ones, for a Vue project\)[\s\S]*keep the shared AGENTS\.md free of stack-specific rules/);
    assert.match(t.read("AGENTS.md"), /- Frontend role:/);
    assert.equal(fs.readFileSync(global, "utf8"), DEFAULT_STANDARDS); // untouched

    const u = setup({ verify: "true" });
    process.chdir(u.repo);
    fs.writeFileSync(path.join(u.repo, "pom.xml"), "<project/>");
    fs.rmSync(global);
    u.selects.push("<timeout>");
    await u.run("plan", "x");
    assert.deepEqual(u.selectOptions[0], ["Add pb's engineering standards to this project's AGENTS.md", "No thanks"]); // no "all projects" for a Java section
    assert.ok(!fs.existsSync(global));
  } finally {
    fs.rmSync(global, { force: true });
  }
});

test("/pb:standards: creates AGENTS.md, replaces only pb's section, and recovers from a missing file", async () => {
  const t = setup();
  process.chdir(t.repo);
  const { DEFAULT_STANDARDS, FRONTEND_STANDARDS } = await import("../extensions/pb/standards.ts");
  const agents = path.join(t.repo, "AGENTS.md");

  await t.run("standards");
  assert.equal(fs.readFileSync(agents, "utf8"), DEFAULT_STANDARDS); // created, plain: no stack detected
  assert.match(t.notes.at(-1)!, /^Created .*AGENTS\.md \(the plain ones\), with pb's standards\./);
  const asked = t.selectTitles.length;
  await t.run("plan", "x");
  assert.equal(t.selectTitles.length, asked); // the offer counts as answered

  const before = "# Shop\n\nOur notes.\n\n";
  const after = "\n<!-- pb:map -->\n## Project map\n- `src/`\n<!-- /pb:map -->\n";
  fs.writeFileSync(agents, `${before}<!-- pb:standards -->\n## Engineering standards\n\n- Old rule.\n<!-- /pb:standards -->\n${after}`);
  await t.run("standards", "vue");
  assert.equal(fs.readFileSync(agents, "utf8"), `${before}${FRONTEND_STANDARDS}${after}`); // the rest, byte for byte
  assert.match(t.notes.at(-1)!, /^Replaced pb's standards in .*\(the frontend ones, for a Vue project\)\. The rest of the file is untouched\./);
  await t.run("standards", "vue");
  assert.match(t.notes.at(-1)!, /^pb's standards are already current in/);

  fs.writeFileSync(agents, "# Shop\n");
  fs.writeFileSync(path.join(t.repo, "pom.xml"), "<project/>");
  await t.run("standards");
  assert.match(fs.readFileSync(agents, "utf8"), /^# Shop\n\n<!-- pb:standards -->[\s\S]*- Java 25: [^\n]*\n<!-- \/pb:standards -->\n$/);
  assert.match(t.notes.at(-1)!, /^Added pb's standards to .*\(the backend ones, with Java 25\)/);

  const broken = "# Shop\n<!-- pb:standards -->\n- mine\n";
  fs.writeFileSync(agents, broken);
  await t.run("standards");
  assert.equal(fs.readFileSync(agents, "utf8"), broken); // left alone
  assert.match(t.notes.at(-1)!, /without its "<!-- \/pb:standards -->"/);

  await t.run("standards", "react");
  assert.match(t.notes.at(-1)!, /takes java, vue, plain \(default: detected from the project\)/);
});

test("standards templates: yours are detected before pb's, replace a built-in of the same name, and /pb:standards takes them", async () => {
  const { templatesDir, stackNames } = await import("../extensions/pb/standards.ts");
  const dir = templatesDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "go.md"), "detect: go.mod\n- Go 1.25: errors wrapped with %w; no panics across packages.\n");
  fs.writeFileSync(path.join(dir, "java.md"), "## Our Java rules\n\n- Java 25 and Spring Boot 4.\n");
  try {
    assert.deepEqual(stackNames(), ["go", "java", "vue", "plain"]);
    const t = setup({ verify: "true" });
    process.chdir(t.repo);
    fs.writeFileSync(path.join(t.repo, "go.mod"), "module x\n");
    await t.run("plan", "x");
    assert.equal(t.selectTitles[0], "Engineering standards (your go template)");
    assert.equal(t.read("AGENTS.md"), "<!-- pb:standards -->\n## Engineering standards\n\n- Go 1.25: errors wrapped with %w; no panics across packages.\n<!-- /pb:standards -->\n");
    assert.match(t.notes.find((n) => n.startsWith("Added to"))!, /\(your go template\)/);

    fs.writeFileSync(path.join(t.repo, "pom.xml"), "<project/>");
    await t.run("standards", "java"); // yours replaces pb's java, and keeps its detection
    assert.equal(t.read("AGENTS.md"), "<!-- pb:standards -->\n## Our Java rules\n\n- Java 25 and Spring Boot 4.\n<!-- /pb:standards -->\n");
    await t.run("standards", "rust");
    assert.match(t.notes.at(-1)!, /takes go, java, vue, plain[\s\S]*Your own go in .*pb\/standards/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
  // Anything the explorer changes in the project is put back.
  process.env.MOCK_EXPLORE_WRITE = path.join(t.repo, "EXPLORE_WAS_HERE");
  try {
    await t.callTool("pb_explore", { question: "Where else?" });
    assert.ok(!fs.existsSync(path.join(t.repo, "EXPLORE_WAS_HERE")));
  } finally {
    delete process.env.MOCK_EXPLORE_WRITE;
  }
  // A stopped run tells the planner how to retry.
  const stopped = new AbortController();
  stopped.abort();
  await assert.rejects(t.runtime().tools.pb_explore.execute("call", { question: "Where else?" }, stopped.signal, undefined, t.runtime().ctx), /Narrow the question/);
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  await t.run("stats");
  assert.match(t.posts.at(-1)!, /Explorer +3 calls · in 6\.0k · out 800( @ [\d.]+k? tok\/s)? · \$0\.04/);
});

test("pb_try probes by running in a separate context; project changes are put back", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  await t.run("plan", "cancel orders");
  const r = await t.callTool("pb_try", { goal: "Is probing fast enough for 10k rows?" });
  assert.match(r.content![0].text, /## Conclusion[\s\S]*fast enough\. \(goal: Is probing fast enough/);
  assert.equal(r.usage!.totalTokens, 3400);
  const d = (r as { details?: any }).details;
  assert.match(d.session, /^\.pi\/pb\/sessions\/try\/.+\.jsonl$/);
  assert.equal(execSync("git status --porcelain --untracked-files=no", { cwd: t.repo, encoding: "utf8" }).trim(), "");
  // Anything the probe changes in the project is put back.
  process.env.MOCK_TRY_WRITE = path.join(t.repo, "TRY_WAS_HERE");
  try {
    await t.callTool("pb_try", { goal: "Does the probe leave files behind?" });
    assert.ok(!fs.existsSync(path.join(t.repo, "TRY_WAS_HERE")));
  } finally {
    delete process.env.MOCK_TRY_WRITE;
  }
  // A stopped probe tells the planner how to retry.
  const stopped = new AbortController();
  stopped.abort();
  await assert.rejects(t.runtime().tools.pb_try.execute("call", { goal: "Is it still fast?" }, stopped.signal, undefined, t.runtime().ctx), /Split the goal/);
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
  assert.match(t.instructions[0], /Build this feature from the spec below[\s\S]*# Order cancellation[\s\S]*\[pb:build\] Task T1\. Do only this task/);
  assert.match(t.results[0], /^✓ T1 passed[\s\S]*Task T2\. Do only this task/); // T1 was behind its own failing test first
  assert.match(t.posts.at(-1)!, /BUILD COMPLETE — order-cancellation[\s\S]*PASS/);
  assert.match(t.read(".pi/pb/specs/order-cancellation/events.jsonl"), /"type":"check","task":"final"/); // full suite after the task tests
});

test("build complete: the other specs from the same plan are listed as still to build", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  await t.callTool("pb_write_spec", { name: "refunds", content: SPEC() });
  t.agent.script = diligent;
  await t.run("build", "order-cancellation");
  assert.match(t.posts.at(-1)!, /BUILD COMPLETE — order-cancellation[\s\S]*Still to build, from the same plan:\n- refunds: `\/pb:build refunds`/);
});

test("build: with taskChecks each, the check runs inside pb_task_done: one agent run from the first task to the end", async () => {
  const t = setup({ taskChecks: "each",  verify: "true" });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  assert.equal(t.stat.runs, 1); // no stop and restart between tasks
  const next = t.instructions.find((i) => i.startsWith("✓ T1 passed"))!;
  assert.match(next, /✓ T1 passed \(`test -f T1\.txt`\)\n\n\[pb:build\] Task T2\. Do only this task[\s\S]*it runs `test -f T2\.txt` itself, so don't run that just before/);
  assert.equal(t.instructions.length, 2); // the first message (with T1's prompt), then T1's tool result; T2's ends the run
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

test("the build: the first task that fixes a shape records it in the spec's Design, without naming the spec", async () => {
  const t = setup({ verify: "true" });
  await written(t, SPEC().replace("## Tasks", "## Contracts\n- `cancel(orderId)` returns the cancelled order.\n## Tasks"));
  let recorded = 0;
  t.agent.script = async (text, tool) => {
    if (taskOf(text) === "T1" && !recorded) {
      recorded++;
      await tool("pb_update_spec", { section: "Design", content: "- One `Order` aggregate per file." });
    }
    return diligent(text, tool);
  };
  await t.run("build");
  assert.match(t.read(".pi/pb/specs/order-cancellation/spec.md"), /## Design\n- One `Order` aggregate per file\.\n/);
  assert.ok(t.selectTitles.every((x) => !/The design of/.test(x))); // the design dialog is gone with the skeleton
  const p = t.progress("order-cancellation");
  assert.equal(p.phase, "built");
  assert.deepEqual(p.tasks.map((x: any) => [x.id, x.status]), [["T1", "done"], ["T2", "done"]]);
  await t.run("review");
  assert.match(t.instructions.filter((i) => i.startsWith("[pb:review]")).at(-1)!, /## Design provenance\n\nDesign provenance: recorded once, first (during the build|before any task proof)\./); // one build write (ties read as during)
});

test("red then green: a task's new tests are seen failing first; refactors and no-new-tests specs are exempt", async () => {
  const t = setup({ verify: "true" });
  await written(t, SPEC({ tasks: "### T1: first file\nCreate T1.txt.\n- Acceptance: T1.txt exists\n- Test: `test -f T1.txt`\n\n### T2: (refactor) tidy\nNothing new.\n- Acceptance: behaviour unchanged\n- Test: `true`" }));
  const said: string[] = [];
  t.agent.script = async (text, tool) => {
    const task = taskOf(text) ?? (text.includes("Continue task T1") ? "T1" : undefined);
    if (task === "T1" && !said.length) {
      fs.writeFileSync("T1.txt", "x"); // the change first
      said.push((await tool("pb_task_done", { task, status: "done", summary: "done" })).content![0].text);
      said.push((await tool("pb_tests_red", { task, tests: "T1.txt exists" })).content![0].text);
      fs.rmSync("T1.txt"); // set aside, as told
      said.push((await tool("pb_tests_red", { task, tests: "T1.txt exists" })).content![0].text);
      said.push((await tool("pb_tests_red", { task, tests: "T1.txt exists" })).content![0].text);
      fs.writeFileSync("T1.txt", "x");
      return void (await tool("pb_task_done", { task, status: "done", summary: "done" }));
    }
    if (task === "T2") said.push((await tool("pb_tests_red", { task, tests: "none" })).content![0].text);
    return diligent(text, tool);
  };
  await t.run("build");
  assert.match(said[0], /T1's new tests were never seen failing[\s\S]*set it aside first/);
  assert.match(said[1], /^`test -f T1\.txt` passes without the change, so these tests don't check it/);
  assert.match(said[2], /^Seen failing: `test -f T1\.txt`[\s\S]*fails for the reason you expect/);
  assert.match(said[3], /^Already seen failing/);
  assert.match(said[4], /^T2 doesn't need this/); // a refactor adds no behaviour
  const p = t.progress("order-cancellation");
  assert.equal(p.phase, "built");
  assert.deepEqual(p.tasks.map((x: any) => x.id), ["T1", "T2"]);

  const u = setup({ verify: "true" });
  await written(u, SPEC({ newTests: "no — a docs-only change" }));
  u.agent.script = async (text, tool) => {
    const task = taskOf(text);
    if (task && task !== "final") fs.writeFileSync(`${task}.txt`, "x");
    if (task) await tool("pb_task_done", { task, status: "done", summary: "done" });
  };
  await u.run("build");
  assert.equal(u.progress("order-cancellation").phase, "built"); // no new tests: nothing to see failing
  assert.deepEqual(u.progress("order-cancellation").tasks.map((x: any) => x.id), ["T1", "T2"]);
  assert.doesNotMatch(u.instructions[0], /Skeleton/);
});

test("build: a task with no Test: command gets no red proof, and that is recorded and handed to the reviewer", async () => {
  const t = setup({ verify: "true" });
  await written(
    t,
    SPEC({
      tasks: `### T1: first file
Create T1.txt.
- Acceptance: T1.txt exists
- Test: \`test -f T1.txt\`

### T2: second file
Create T2.txt.
- Acceptance: T2.txt exists`,
    }),
  );
  const said: string[] = [];
  t.agent.script = async (text, tool) => {
    const task = taskOf(text);
    if (task && task !== "final") {
      if (task === "T1") said.push((await tool("pb_tests_red", { task, tests: "T1.txt exists" })).content![0].text);
      fs.writeFileSync(`${task}.txt`, "x");
    }
    if (task) return void (await tool("pb_task_done", { task, status: "done", summary: `did ${task}` }));
  };
  await t.run("build");
  assert.match(said[0], /^Seen failing: `test -f T1\.txt`/);
  const p = t.progress("order-cancellation");
  assert.equal(p.phase, "built");
  assert.deepEqual(p.tasks.map((x: any) => [x.id, !!x.red]), [["T1", true], ["T2", false]]); // T2 has no command to run
  // T2's proof isn't there, and nothing pretends it is: the build says so, and so does the reviewer.
  assert.match(t.posts.at(-1)!, /BUILD COMPLETE[\s\S]*New tests never seen failing[\s\S]*- T2: no Test: command, so nothing proves its new tests fail without the change/);
  await t.run("review");
  const brief = t.instructions.filter((i) => i.startsWith("[pb:review]")).at(-1)!;
  assert.match(brief, /## New tests never seen failing[\s\S]*Judge each: does its acceptance still have a test that checks it\?/);
  assert.match(brief, /- T2: no Test: command, so nothing proves its new tests fail without the change/);
  assert.doesNotMatch(brief, /- T1: no Test: command/); // its own test proved it, so it isn't listed
});

test("build: one Test: command shared by two tasks proves only that something is missing, and is reported that way", async () => {
  const t = setup({ verify: "test -f T1.txt && test -f T2.txt" });
  await written(
    t,
    SPEC({
      tasks: `### T1: first file
Create T1.txt.
- Acceptance: T1.txt exists
- Test: \`test -f both.txt\`

### T2: second file
Create T2.txt.
- Acceptance: T2.txt exists
- Test: \`test -f both.txt\``,
    }),
  );
  t.agent.script = diligent;
  await t.run("build");
  const p = t.progress("order-cancellation");
  assert.equal(p.phase, "built");
  // Both tasks ran the same command, so each proof shows only that something is missing among them: recorded for the reviewer.
  assert.deepEqual(p.tasks.map((x: any) => [x.id, !!x.red, x.redShared]), [["T1", true, "T2"], ["T2", true, "T1"]]);
  assert.match(t.posts.at(-1)!, /New tests never seen failing[\s\S]*- T1: `test -f both\.txt` is also T2's Test: command, so that one run doesn't prove T1's own tests[\s\S]*- T2: `test -f both\.txt` is also T1's Test: command/);
  await t.run("review");
  assert.match(t.instructions.filter((i) => i.startsWith("[pb:review]")).at(-1)!, /## New tests never seen failing[\s\S]*- T1: `test -f both\.txt` is also T2's Test: command/);
});

test("build: pre-green — a task whose command an earlier proven task already satisfies auto-proceeds, disclosed", async () => {
  const t = setup({ verify: "test -f T1.txt && test -f T2.txt" });
  await written(
    t,
    SPEC({
      tasks: `### T1: first file
Create T1.txt.
- Acceptance: T1.txt exists
- Test: \`test -f both.txt\`

### T2: second file
Create T2.txt.
- Acceptance: T2.txt exists
- Test: \`test -f both.txt\``,
    }),
  );
  const said: string[] = [];
  t.agent.script = async (text, tool) => {
    const task = taskOf(text);
    if (task && task !== "final") {
      said.push((await tool("pb_tests_red", { task, tests: `${task}.txt exists` })).content![0].text);
      fs.writeFileSync(`${task}.txt`, "x");
      if (task === "T1") fs.writeFileSync("both.txt", "x"); // more than its slice: T2's command passes
    }
    if (task) return void (await tool("pb_task_done", { task, status: "done", summary: `did ${task}` }));
  };
  await t.run("build");
  assert.match(said[0], /^Seen failing: `test -f both\.txt`/); // T1 proved it
  assert.match(said[1], /`test -f both\.txt` already passes: T1 \(done, same Test: command\) proved it[\s\S]*reviewer is told/);
  const p = t.progress("order-cancellation");
  assert.equal(p.phase, "built");
  assert.deepEqual(p.tasks.map((x: any) => [x.id, !!x.red, x.preGreen]), [["T1", true, undefined], ["T2", false, "T1"]]);
  // Named, not blurred: the reviewer knows exactly whose run satisfies T2.
  assert.match(t.posts.at(-1)!, /New tests never seen failing[\s\S]*- T2: `test -f both\.txt` already satisfied by T1's proven run, so no run proves T2's own tests/);
  await t.run("review");
  assert.match(t.instructions.filter((i) => i.startsWith("[pb:review]")).at(-1)!, /- T2: `test -f both\.txt` already satisfied by T1's proven run/);
});

const THREE_TASKS = `### T1: first file
Create T1.txt.
- Acceptance: T1.txt exists
- Test: \`test -f T1.txt\`

### T2: second file
Create T2.txt.
- Acceptance: T2.txt exists
- Test: \`test -f T2.txt\`

### T3: third file
Create T3.txt.
- Acceptance: T3.txt exists
- Test: \`test -f T3.txt\``;

/** Like diligent, but finishes the coherence pass without pretending it wrote a file. */
const withCohere = (seen: string[], cohere: (text: string, tool: Tool) => Promise<void> | void): Script => async (text, tool) => {
  if (text.includes('task "cohere"')) {
    seen.push(text);
    return cohere(text, tool);
  }
  return diligent(text, tool);
};

test("build: coherence pass runs on 3+ task builds and is skipped on smaller ones", async () => {
  const t = setup({ verify: "true" });
  await written(t, SPEC({ tasks: THREE_TASKS }));
  const seen: string[] = [];
  t.agent.script = withCohere(seen, async (_text, tool) => {
    await tool("pb_task_done", { task: "cohere", status: "done", summary: "nothing to consolidate" });
  });
  await t.run("build");
  const p = t.progress("order-cancellation");
  assert.equal(p.phase, "built");
  assert.equal(seen.length, 1);
  assert.deepEqual(p.tasks.map((x: any) => [x.id, x.status]), [["T1", "done"], ["T2", "done"], ["T3", "done"], ["cohere", "done"]]);
  assert.match(t.posts.at(-1)!, /cohere/); // the completed build lists the pass

  const u = setup({ verify: "true" });
  await written(u);
  u.agent.script = diligent;
  await u.run("build");
  assert.equal(u.progress("order-cancellation").phase, "built");
  assert.ok(!u.progress("order-cancellation").tasks.some((x: any) => x.id === "cohere"));
});

test("build: pausing mid-coherence resumes the pass instead of stranding the build", async () => {
  const t = setup({ verify: "true" });
  await written(t, SPEC({ tasks: THREE_TASKS }));
  let coheres = 0;
  t.agent.script = withCohere([], async (_text, tool) => {
    coheres++;
    if (coheres === 1) return; // stop without finishing: nudge, then pause
    await tool("pb_task_done", { task: "cohere", status: "done", summary: "consolidated on retry" });
  });
  await t.run("build");
  assert.equal(t.progress("order-cancellation").phase, "paused");
  await t.run("build");
  const p = t.progress("order-cancellation");
  assert.equal(p.phase, "built");
  assert.equal(coheres, 2);
  assert.deepEqual(p.tasks.find((x: any) => x.id === "cohere").status, "done");
});

test("build: undoing the coherence pass restores files and the pass re-runs", async () => {
  const t = setup({ verify: "true" });
  await written(t, SPEC({ tasks: THREE_TASKS }));
  let coheres = 0;
  t.agent.script = withCohere([], async (_text, tool) => {
    coheres++;
    if (coheres === 1) fs.appendFileSync("T1.txt", "# consolidated\n");
    await tool("pb_task_done", { task: "cohere", status: "done", summary: coheres === 1 ? "consolidated" : "nothing left" });
  });
  await t.run("build");
  assert.equal(t.progress("order-cancellation").phase, "built");
  assert.match(t.read("T1.txt"), /consolidated/);
  await t.run("undo", "cohere");
  assert.equal(t.progress("order-cancellation").phase, "paused");
  assert.ok(!t.progress("order-cancellation").tasks.some((x: any) => x.id === "cohere"));
  assert.doesNotMatch(t.read("T1.txt"), /consolidated/);
  await t.run("build");
  assert.equal(t.progress("order-cancellation").phase, "built");
  assert.equal(coheres, 2);
});

test("build: without a shared proven command, a passing task still wedges honestly — blocked, for the human", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  const said: string[] = [];
  t.agent.script = async (text, tool) => {
    const task = taskOf(text) ?? (text.includes("Continue task T1") ? "T1" : undefined);
    if (task === "T1" && !said.length) {
      said.push((await tool("pb_tests_red", { task, tests: "T1.txt exists" })).content![0].text);
      fs.writeFileSync("T1.txt", "x");
      fs.writeFileSync("T2.txt", "x"); // more than its slice, under a different command
      return void (await tool("pb_task_done", { task, status: "done", summary: "did T1 and T2's bit" }));
    }
    if (task === "T2") {
      said.push((await tool("pb_tests_red", { task, tests: "T2.txt exists" })).content![0].text);
      said.push((await tool("pb_task_done", { task, status: "done", summary: "nothing left" })).content![0].text);
      return void (await tool("pb_task_done", { task, status: "blocked", summary: "T1 already did it; my command passes and no earlier task proved it" }));
    }
    return diligent(text, tool);
  };
  await t.run("build");
  assert.match(said[1], /`test -f T2\.txt` passes without the change/); // not pre-green: no earlier task proved this command
  assert.doesNotMatch(said[1], /already passes/);
  assert.match(said[2], /T2's new tests were never seen failing/); // the refusal: no legitimate move but blocked
  assert.equal(t.progress("order-cancellation").phase, "paused");
});

test("spec: a task needs red exactly when no exemption explains it", () => {
  const { spec } = parseSpec(SPEC());
  assert.deepEqual(spec!.tasks.map((t) => needsRed(spec!, t)), [true, true]);
  // One definition both ways: no Test: line, a refactor, no new tests, no tests to run.
  const noTest = parseSpec(SPEC({ tasks: "### T1: a\n- Acceptance: it works\n" })).spec!;
  assert.equal(needsRed(noTest, noTest.tasks[0]), false);
  assert.match(redExemption(noTest, noTest.tasks[0])!, /no Test: command/);
  const refactor = parseSpec(SPEC({ tasks: "### T1: (refactor) rename\n- Acceptance: renamed\n- Test: `true`\n" })).spec!;
  assert.match(redExemption(refactor, refactor.tasks[0])!, /refactor keeps behaviour/);
  const none = parseSpec(SPEC({ newTests: "no — covered by T9" })).spec!;
  assert.match(redExemption(none, none.tasks[0])!, /asks for no new tests \(covered by T9\)/);
  const build = parseSpec(SPEC({ verification: "build — no suite here" })).spec!;
  assert.match(redExemption(build, build.tasks[0])!, /verification is "build", so no test runs/);
  assert.equal(redExemption(spec!, spec!.tasks[0]), undefined);
  assert.equal(redExemption(spec!, undefined), undefined);
});

test("spec: design provenance states where the Design comes from", async () => {
  const { designProvenance } = await import("../extensions/pb/prompts.ts");
  const md = "# T\n\n## Design\n- shape\n";
  assert.equal(designProvenance("# T\n\n## Goal\n", []), undefined); // no Design section: silent
  assert.equal(
    designProvenance(md, [{ at: "t0", type: "build-start" }]),
    "Design provenance: from the plan, untouched by the build.",
  );
  assert.equal(
    designProvenance(md, [
      { at: "t0", type: "spec", update: "Design" },
      { at: "t1", type: "build-start" },
    ]),
    "Design provenance: from the plan, untouched by the build.", // written before the build started
  );
  assert.equal(
    designProvenance(md, [
      { at: "t0", type: "build-start" },
      { at: "t1", type: "red", task: "T1" },
      { at: "t2", type: "spec", update: "Design" },
      { at: "t3", type: "red", task: "T2" },
    ]),
    "Design provenance: recorded once, first during the build.",
  );
  assert.equal(
    designProvenance(md, [
      { at: "t0", type: "build-start" },
      { at: "t1", type: "red", task: "T1" },
      { at: "t2", type: "spec", update: "design" },
      { at: "t3", type: "check", task: "final" },
      { at: "t4", type: "spec", update: "Design" },
    ]),
    "Design provenance: rewritten 2 times, first during the build, last after the last check — every change should be in Decisions.",
  );
});

test("spec: Status: ready can't have Open questions; planning can", async () => {
  const t = setup();
  process.chdir(t.repo);
  assert.match(parseSpec(`${SPEC()}## Open questions\n- undecided\n`).errors.join("; "), /can't have "## Open questions"/);
  assert.deepEqual(parseSpec(SPEC().replace("# Order cancellation\n", "# Order cancellation\nStatus: planning\n") + "## Open questions\n- undecided\n").errors, []);
  assert.match((await t.callTool("pb_write_spec", { name: "x", content: `${SPEC()}## Open questions\n- undecided\n` })).error!, /can't have "## Open questions"/);
});

test("spec: a behaviour task without Test:, or with a no-op one, warns — refactors stay quiet", async () => {
  const t = setup();
  process.chdir(t.repo);
  const tasks = "### T1: real file\nCreate T1.txt.\n- Acceptance: T1.txt exists\n\n### T2: (refactor) tidy\nNothing new.\n- Acceptance: behaviour unchanged\n- Test: `true`";
  const w = (await t.callTool("pb_write_spec", { name: "a", content: SPEC({ tasks }) })).content![0].text;
  assert.match(w, /Note: T1 adds behaviour but has no Test:: add a targeted command, or leave it out/);
  assert.doesNotMatch(w, /T2/); // a refactor is exempt: nothing to warn
  const noop = (await t.callTool("pb_write_spec", { name: "b", content: SPEC({ tasks: "### T1: real file\nCreate T1.txt.\n- Acceptance: T1.txt exists\n- Test: `true`" }) })).content![0].text;
  assert.match(noop, /Note: T1's Test: `true` always passes — the build will wedge demanding red/);
});

test("spec: writing tasks without Contracts, or with a shared Test:, warns — advisory only", async () => {
  const t = setup();
  process.chdir(t.repo);
  const noContracts = (await t.callTool("pb_write_spec", { name: "a", content: SPEC() })).content![0].text;
  assert.match(noContracts, /\nNote: 2 tasks and no ## Contracts: pin every seam they share \(and which task owns each side\); if truly independent, ignore this\./);
  const withContracts = (await t.callTool("pb_write_spec", { name: "b", content: SPEC().replace("## Tasks", "## Contracts\n- x\n## Tasks") })).content![0].text;
  assert.doesNotMatch(withContracts, /Note: 2 tasks/);
  const shared = (await t.callTool("pb_write_spec", {
    name: "c",
    content: SPEC({ tasks: "### T1: a\n- Acceptance: a\n- Test: `true`\n\n### T2: b\n- Acceptance: b\n- Test: `true`" }),
  })).content![0].text;
  assert.match(shared, /\nNote: `true` is the Test: of T1, T2: the later auto-proceed as pre-green once the earlier proves it/);
  assert.doesNotMatch(noContracts, /is the Test: of/); // distinct commands: nothing shared
  // A Tasks edit re-warns; anything else stays quiet.
  const tasks = (await t.callTool("pb_update_spec", { name: "a", section: "Tasks", content: "### T1: a\n- Acceptance: a\n- Test: `true`\n\n### T2: b\n- Acceptance: b\n- Test: `true`\n\n### T3: c\n- Acceptance: c\n- Test: `true`" })).content![0].text;
  assert.match(tasks, /Note: 3 tasks and no ## Contracts/);
  assert.match(tasks, /Note: `true` is the Test: of T1, T2, T3/);
  const decisions = (await t.callTool("pb_update_spec", { name: "a", section: "Decisions", content: "- d" })).content![0].text;
  assert.doesNotMatch(decisions, /Note:/);
});

test("spec: showing it runs each red-eligible Test: once, for approval — small changes skip it", async () => {
  const t = setup({ verify: "true" });
  await written(t); // T1/T2 commands fail: nothing built yet
  const { Store } = await import("../extensions/pb/store.ts");
  new Store(t.repo).setPendingBuild(t.runtime().ctx.sessionManager.getSessionFile());
  t.selects.push("Not now");
  await t.fire("agent_settled", {});
  const shown = t.posts.find((p) => p.startsWith("**Spec written")!)!;
  assert.match(shown, /- T1: first file · `test -f T1\.txt`[\s\S]*Test commands, run once before you approve:\n- ✗ `test -f T1\.txt` fails \(expected: nothing built yet/);
  assert.match(shown, /- ✗ `test -f T2\.txt` fails \(expected/);

  const u = setup({ verify: "true" }); // docs-only: nothing red-eligible, nothing run
  await written(u, SPEC({ verification: "none — docs", newTests: "no — docs" }));
  new Store(u.repo).setPendingBuild(u.runtime().ctx.sessionManager.getSessionFile());
  u.selects.push("Not now");
  await u.fire("agent_settled", {});
  assert.doesNotMatch(u.posts.find((p) => p.startsWith("**Spec written")!)!, /Test commands, run once/);
});

test("build: a failing check goes back to the agent, and passes on the next attempt", async () => {
  const t = setup({ taskChecks: "each",  verify: "true" });
  await written(t);
  let lazy = true;
  t.agent.script = async (text, tool) => {
    if (text.includes("Task T1") && lazy) {
      lazy = false; // first attempt forgets the file
      await tool("pb_tests_red", { task: "T1", tests: "T1.txt exists" });
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
    if (task === "T1" && !give) {
      await tool("pb_tests_red", { task, tests: "T1.txt exists" });
      return void (await tool("pb_task_done", { task, status: "done", summary: "claimed" }));
    }
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
  assert.match(t.results[0], /⚠ existing tests changed \(the review checks them\): tests\/test_a\.py: 2 → 1 test cases/); // T1's
  assert.match(t.posts.at(-1)!, /BUILD COMPLETE[\s\S]*Existing tests the build changed[\s\S]*- T1: tests\/test_a\.py: 2 → 1 test cases/);
  await t.run("review");
  assert.match(t.instructions.filter((i) => i.startsWith("[pb:review]")).at(-1)!, /## Existing tests the build changed[\s\S]*judge whether each was justified:\n- T1: tests\/test_a\.py: 2 → 1 test cases/);
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
  assert.match(t.results[1], /The final check failed \(attempt 2 of 2\)/); // the last task's done runs the whole suite
  assert.equal(t.progress("order-cancellation").phase, "built");
  assert.equal(t.stat.runs, 1);
});

test("build: a compaction in the middle of a task: pb's summary carries the rules, the task, and what it changed so far", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  t.agent.script = async (text, tool) => {
    if (text.includes("Task T2")) {
      await tool("pb_tests_red", { task: "T2", tests: "T2.txt exists" });
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
  assert.match(t.instructions[n], /^\[pb:build order-cancellation\] Build the spec you wrote[\s\S]*\[pb:build\] Task T1\. Do only this task/); // from the start, T1 all over again
  assert.equal(t.progress("order-cancellation").phase, "built");
});

test("status lists every spec with its state and tasks", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  await t.run("status");
  assert.match(t.notes.at(-1)!, /order-cancellation — written · verification tests/);
});

/* ------------------------------ review, stats, archive ------------------------------ */

/** The review session's first message: the reviewer's brief. */
const briefOf = (t: ReturnType<typeof setup>) => t.instructions.filter((i) => i.startsWith("[pb:review]")).at(-1)!;
const CHANGES = [
  { priority: "P1", file: "src/order.ts", line: 12, title: "consider a guard clause", fix: "return early" },
  { priority: "P2", file: "src/order.ts", line: 30, title: "name the constant" },
];

test("review: a fresh review session with the spec first and the diff; you're brought back with the result", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  const home = t.runtime().ctx.sessionManager.getSessionFile();
  await t.run("review");
  const brief = briefOf(t);
  assert.match(brief, /^\[pb:review\] You are an independent REVIEWER in a fresh session[\s\S]*read-only for you[\s\S]*--- brief ---\n\n# The spec[\s\S]*Not doing soft delete[\s\S]*## Changed files\n\n(T1\.txt\n)?[\s\S]*T2\.txt/);
  assert.match(brief, /## The check the harness ran\n\n`true` → PASS/);
  assert.ok([...t.names.values()].includes("review: order-cancellation · spec") && [...t.names.values()].includes("review: order-cancellation · adversarial"));
  assert.equal(t.runtime().ctx.sessionManager.getSessionFile(), home); // back where you were
  assert.match(t.posts.at(-1)!, /Review of order-cancellation\*\* — ✅ PASS[\s\S]*Acceptance: all met\.[\s\S]*1\. \[P2\] src\/order\.ts:30 — name the constant\n2\. \[P3\] src\/order\.ts:12 — consider a guard clause\n   Fix: return early[\s\S]*The review sessions: spec `pi --session build-session-\d+\.jsonl` · adversarial `pi --session build-session-\d+\.jsonl`/);
  assert.equal(t.progress("order-cancellation").phase, "reviewed");
  assert.equal(t.progress("order-cancellation").reviewUnshown, undefined);
  assert.match(t.read(".pi/pb/specs/order-cancellation/review.md"), /Review of order-cancellation\*\* — ✅ PASS/); // kept with the spec

  await t.run("review");
  assert.match(t.notes.at(-1)!, /Nothing changed since the last review \(pass\)/);
  t.reviewer.review = CHANGES;
  await t.run("review", "--full");
  assert.match(t.posts.at(-1)!, /✗ CHANGES NEEDED/);
});

test("review: the review session is read-only for its model; /pb:review done ends a pass; a pass you leave can be continued", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  const home = t.runtime().ctx.sessionManager.getSessionFile();
  t.reviewer.script = true; // drive the review session by hand
  let blocked: string | undefined;
  t.agent.script = async (text, tool) => {
    if (text.startsWith("[pb:review]")) {
      assert.deepEqual(t.runtime().pi.getActiveTools(), ["read", "grep", "find", "ls", "bash", "pb_report_findings"]);
      blocked = (await tool("write", { path: "x.ts", content: "x" })).error;
      await tool("pb_report_findings", { findings: CHANGES });
      await t.runtime().cmds["pb:review"].handler("done", t.runtime().ctx);
    }
    if (text.startsWith("[pb:abuse]")) {
      // You go elsewhere mid-pass (like /resume): the review can't take you back; its result waits in review.md.
      await t.runtime().ctx.switchSession(home);
      return;
    }
    return diligent(text, tool);
  };
  await t.run("review");
  assert.match(blocked!, /This is a review session: read-only/);
  assert.equal(t.runtime().ctx.sessionManager.getSessionFile(), home); // you went home by yourself
  const md = t.read(".pi/pb/specs/order-cancellation/review.md");
  assert.match(md, /✗ CHANGES NEEDED[\s\S]*You left the review before it finished: the adversarial pass didn't finish[\s\S]*`\/pb:review` continues it/);

  // /pb:review offers to continue: back into the abuse session, which carries on where it was.
  t.reviewer.script = false;
  t.reviewer.abuse = [{ priority: "P2", file: "src/order.ts", line: 3, title: "cap the page size" }];
  await t.run("review");
  assert.match(t.selectTitles.at(-1)!, /A review was interrupted/);
  assert.ok(t.instructions.some((i) => i.startsWith("[pb] You were interrupted. Carry on where you were")));
  assert.ok(!t.notes.some((n) => /This review was interrupted/.test(n))); // pb was continuing it: no hint needed
  assert.equal(t.runtime().ctx.sessionManager.getSessionFile(), home); // and back home at the end
  assert.match(t.posts.at(-1)!, /✗ CHANGES NEEDED · P0 0 · P1 1 · P2 2 · P3 0 · with an adversarial pass[\s\S]*Adversarial: cap the page size/);
  assert.equal(JSON.parse(t.read(".pi/pb/config.json")).maxAttempts, 2);
  assert.ok(!fs.existsSync(path.join(t.repo, ".pi/pb/review-run.json"))); // finished: nothing left to continue
});

test("review: reopening an interrupted review session, /pb:review continue picks it up there", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  const home = t.runtime().ctx.sessionManager.getSessionFile();
  let reviewSession = "";
  t.reviewer.script = true;
  t.agent.script = async (text, tool) => {
    if (text.startsWith("[pb:review]")) {
      reviewSession = t.runtime().ctx.sessionManager.getSessionFile();
      await t.runtime().ctx.switchSession(home); // you leave mid-review
      return;
    }
    return diligent(text, tool);
  };
  await t.run("review");
  await t.runtime().ctx.switchSession(reviewSession); // later, /resume into it
  assert.match(t.notes.at(-1)!, /This review was interrupted: `\/pb:review continue` picks it up/);
  t.reviewer.script = false;
  await t.run("review", "continue");
  assert.equal(t.runtime().ctx.sessionManager.getSessionFile(), home);
  assert.match(t.posts.at(-1)!, /Review of order-cancellation\*\* — ✅ PASS[\s\S]*with an adversarial pass/);
});

test("review: the adversarial pass is asked for when the review is done; skipped, the result says so; unanswered, it runs", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  t.selects.push("Keep p/m", "Skip it"); // the one-time reviewer-model offer comes first
  await t.run("review");
  assert.ok(t.selectTitles.includes("The review is done. Run the adversarial pass now (someone trying to break the change)?"));
  assert.ok(![...t.names.values()].includes("review: order-cancellation · adversarial"));
  assert.match(t.posts.at(-1)!, /Review of order-cancellation\*\* — ✅ PASS · P0 0 · P1 0 · P2 1 · P3 1 · adversarial pass skipped/);

  const u = setup({ verify: "true", askTimeoutSec: 0.001 });
  await written(u);
  u.agent.script = diligent;
  await u.run("build");
  u.selects.push("<timeout>"); // nobody there: it runs
  await u.run("review");
  assert.ok([...u.names.values()].includes("review: order-cancellation · adversarial"));
  assert.match(u.posts.at(-1)!, /with an adversarial pass/);
});

test("review: a follow-up looks at the previous findings and what changed since", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  t.reviewer.review = CHANGES;
  await t.run("review");
  fs.writeFileSync(path.join(t.repo, "T1.txt"), "fixed");
  t.reviewer.review = [];
  await t.run("review");
  assert.match(briefOf(t), /## This is a follow-up review[\s\S]*1\. \[P1\] src\/order\.ts:12 — consider a guard clause[\s\S]*Changed since the previous review[\s\S]*T1\.txt/);
  assert.match(t.posts.at(-1)!, /Review of order-cancellation\*\* \(follow-up\) — ✅ PASS/);
});

test("review: findings carry priorities; P0/P1 are double-checked; only line-leading tags count in prose", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  t.reviewer.review = CHANGES;
  await t.run("review");
  assert.match(t.posts.at(-1)!, /✗ CHANGES NEEDED · P0 0 · P1 1 · P2 1 · P3 0/);
  process.env.MOCK_VERIFY = "reject"; // the verifier finds the P1 isn't real
  await t.run("review", "--full");
  delete process.env.MOCK_VERIFY;
  assert.match(t.posts.at(-1)!, /✅ PASS · P0 0 · P1 0 · P2 1 · P3 0[\s\S]*Dismissed after a second look:\n- \[P1\] consider a guard clause — src\/order\.ts:11 already guards it/);
  t.reviewer.silent = true; // no tool call: the prose's line-leading tags are the findings
  t.reviewer.prose = "No [P0] or [P1] issues found.\n\n1. [P2] src/order.ts:30 — name the constant.";
  await t.run("review", "--full");
  assert.match(t.posts.at(-1)!, /✅ PASS · P0 0 · P1 0 · P2 1 · P3 0/); // "No [P0] or [P1] issues" isn't a finding
});

test("review: offers once to run the reviewer on another model than the one that built the change", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  t.selects.push("p/big");
  await t.run("review");
  assert.ok(t.selectTitles.some((x) => /The reviewer runs on p\/m, which likely built this too/.test(x)));
  assert.equal(JSON.parse(t.read(".pi/pb/config.json")).reviewer.model, "p/big");
  assert.equal(JSON.parse(t.read(".pi/pb/config.json")).maxAttempts, 2); // the rest kept as written
  await t.run("review", "--full");
  assert.equal(t.selectTitles.filter((x) => /The reviewer runs on/.test(x)).length, 1); // asked once
});

test("review: works without a spec, on the uncommitted change and its intent", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  await t.run("review");
  assert.match(t.notes.at(-1)!, /Nothing to review: there are no uncommitted changes/);
  fs.writeFileSync(path.join(t.repo, "README"), "hello\n");
  await t.run("review", "greet more warmly");
  assert.match(briefOf(t), /--- brief ---\n\n# No spec[\s\S]*Intent: greet more warmly[\s\S]*## Changed files\n\nREADME/);
  assert.match(t.posts.at(-1)!, /Review of the uncommitted change\*\* — ✅ PASS/);
  assert.doesNotMatch(t.posts.at(-1)!, /Commit message/); // no spec to write it from
});

test("review: files changed during the review are put back", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  t.reviewer.write = path.join(t.repo, "T1.txt");
  await t.run("review");
  assert.equal(t.read("T1.txt"), "x");
  assert.match(t.posts.at(-1)!, /⚠ Files changed during the review were put back: T1\.txt/);
});

test("stats: tasks, first try, checks, pauses, review, and the build session's tokens and cache", async () => {
  const t = setup({ taskChecks: "each",  verify: "true" });
  await written(t);
  let lazy = true;
  t.agent.script = async (text, tool) => {
    if (text.includes("Task T1") && lazy) {
      lazy = false;
      await tool("pb_tests_red", { task: "T1", tests: "T1.txt exists" });
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
  assert.match(card, /in [\d.]+k \(90% cached\)/);
  assert.match(card, /Context +peak 10\.0k \(10% of 100\.0k\)/);
  assert.match(card, /Reviewer +in 20\.0k · out 200/); // the review and abuse sessions' own turns

  await t.run("stats", "all");
  assert.match(t.posts.at(-1)!, /order-cancellation +2\/2 +50%/);
});

test("stats: proof and confirmed counts render for the retirement bar", async () => {
  const { renderCard } = await import("../extensions/pb/stats.ts");
  const card = renderCard({
    name: "demo",
    phase: "built",
    events: [
      { type: "build-start", at: "2026-10-01 10:00:00" },
      { type: "red", task: "T1", ok: true, at: "2026-10-01 10:01:00" },
      { type: "check", task: "T1", ok: true, at: "2026-10-01 10:02:00" },
      { type: "red", task: "T2", ok: false, at: "2026-10-01 10:03:00" },
      { type: "check", task: "T2", ok: true, at: "2026-10-01 10:04:00" },
      { type: "red", task: "T3", ok: false, at: "2026-10-01 10:05:00" },
      { type: "review", verdict: "changes_needed", p: [1, 2, 0, 3], at: "2026-10-01 10:06:00" },
      { type: "built", at: "2026-10-01 10:07:00" },
    ],
    explore: [{ session: "s1", input: 3000, output: 400, cacheRead: 0, cacheWrite: 0, cost: 0.02, ms: 1000, at: "2026-10-01 09:59:00" }],
    progress: {
      spec: "demo",
      phase: "built",
      session: "s1",
      tasks: [
        { id: "T1", title: "a", status: "done", attempts: 1, red: "failing" },
        { id: "T2", title: "b", status: "done", attempts: 1, preGreen: "T1" },
        { id: "T3", title: "c", status: "done", attempts: 1 },
      ],
      updatedAt: "2026-10-01 10:07:00",
    },
  } as any);
  assert.match(card, /Proof +1 proven · 1 sent back · 1 pre-green/);
  assert.match(card, /Review.*P0\/P1 confirmed \(latest\): 3/);
  assert.match(card, /Explorer +1 calls · in 3\.0k · out 400 @ 3\.4k tok\/s · \$0\.02/);
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

test("commit message: from the spec, after the build, the review and the archive, whichever you stop at", async () => {
  const MESSAGE = "```text\nOrder cancellation\n\nCancel orders.\n\n- first file\n- second file\n```";
  // The paths the mock cartographer's map names, so the map is written without asking.
  const project = (repo: string) => {
    fs.mkdirSync(path.join(repo, "src/auth"), { recursive: true });
    fs.writeFileSync(path.join(repo, "src/order.ts"), "export {}\n");
    fs.writeFileSync(path.join(repo, "src/auth/Login.java"), "class Login {}\n");
    execSync("git add . && git commit -qm src", { cwd: repo });
  };
  const t = setup({ verify: "true" });
  project(t.repo);
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  assert.ok(t.posts.at(-1)!.includes(`**Commit message**, to paste:\n\n${MESSAGE}`)); // no task ids: they mean nothing in git
  await t.run("review");
  assert.ok(t.posts.at(-1)!.includes(MESSAGE));

  await t.run("archive"); // the feature isn't committed yet: its message, and the map it now includes
  assert.ok(t.posts.at(-1)!.includes("```text\nOrder cancellation\n\nCancel orders.\n\n- first file\n- second file\n\nAlso updates the project map in AGENTS.md.\n```"));

  const u = setup({ verify: "true" });
  project(u.repo);
  await written(u);
  u.agent.script = diligent;
  await u.run("build");
  execSync("git add -A -- . ':(exclude).pi' && git commit -qm feature", { cwd: u.repo });
  await u.run("archive"); // committed: only the map is left
  assert.ok(u.posts.at(-1)!.includes("```text\nUpdate the project map in AGENTS.md after Order cancellation\n\n- added Orders\n- noted transactions\n```"));

  const v = setup({ verify: "true", mapOnArchive: false });
  await written(v);
  v.agent.script = diligent;
  await v.run("build");
  execSync("git add -A -- . ':(exclude).pi' && git commit -qm feature", { cwd: v.repo });
  const posted = v.posts.length;
  await v.run("archive"); // nothing left to commit: no message
  assert.equal(v.posts.length, posted);
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
  assert.match(fs.readFileSync(agents, "utf8"), /<!-- pb:standards -->[\s\S]*Dependencies: current, non-deprecated APIs and versions only[\s\S]*Comments: concise, and only where they add what the code can't say[\s\S]*written to current best practice for this stack even where existing tests aren't[\s\S]*<!-- \/pb:standards -->/);
  assert.doesNotMatch(fs.readFileSync(agents, "utf8"), /even when it is more work|latest stable versions|inconsistent with its surroundings/);
  assert.match(fs.readFileSync(agents, "utf8"), /even where the surrounding code doesn't[\s\S]*refactor it to current practice, planned as a task of its own/);
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
    if (text.startsWith("[pb:compact]")) {
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
  const asked = t.instructions.filter((i) => i.startsWith("[pb:compact]")).length;
  t.runtime().pi.sendUserMessage("again");
  await t.settle();
  assert.equal(t.instructions.filter((i) => i.startsWith("[pb:compact]")).length, asked);
});

test("checkpoint: sessions that aren't planning are left to Pi; checkpointAt 0 turns it off", async () => {
  const t = setup({ verify: "true", checkpointAt: 0 });
  process.chdir(t.repo);
  t.selects.push("No thanks");
  await t.run("plan", "cancel orders");
  t.runtime().usage = 90;
  t.runtime().pi.sendUserMessage("go on");
  await t.settle();
  assert.ok(!t.instructions.some((i) => i.startsWith("[pb:compact]")));
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

test("compaction: a review session is reset to its role, the brief, and the findings so far", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  const { Store } = await import("../extensions/pb/store.ts");
  const store = new Store(t.repo);
  const session = path.join(t.repo, "review-session.jsonl");
  store.saveReviewSession(session, { role: "review", spec: "order-cancellation", findings: [{ priority: "P1", title: "missing test", file: "x.ts", line: 1 }] });
  store.saveReviewRun({ cwd: t.repo, label: "order-cancellation", brief: "# The brief", followUp: false, passes: [], home: t.repo });
  const ctx = { ...t.runtime().ctx, sessionManager: { getSessionFile: () => session } };
  const [r] = (await t.fire("session_before_compact", { preparation: { firstKeptEntryId: "e3", tokensBefore: 90000 }, reason: "threshold" }, ctx)) as any[];
  assert.equal(r.compaction.firstKeptEntryId, "e3"); // Pi's boundary kept; only the summary is pb's
  assert.match(r.compaction.summary, /^\[pb review state: order-cancellation\] This review session was compacted[\s\S]*--- brief ---\n\n# The brief[\s\S]*--- findings so far ---\n\n\[P1\] x\.ts:1 — missing test/);
});

test("compaction: compacting the same task over and over with no progress pauses instead of looping", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  const prep = { firstKeptEntryId: "e3", tokensBefore: 90000 };
  t.agent.script = async (text, tool) => {
    if (text.includes("Task T1")) {
      for (let i = 0; i < 4; i++) await t.fire("session_before_compact", { preparation: prep, reason: "threshold" });
      return; // the build paused underneath: nothing more to do this run
    }
    return diligent(text, tool);
  };
  await t.run("build");
  const p = t.progress("order-cancellation");
  assert.equal(p.phase, "paused");
  assert.match(t.posts.at(-1)!, /\*\*⏸ Build paused\*\* — compacted 3 times during T1 without getting anywhere[\s\S]*What now/);
  assert.deepEqual(t.events("order-cancellation").filter((e) => e.type === "pause").map((e) => e.why), ["thrash"]);
  // And it resumes where it paused: the guard counts forward progress, not compactions.
  t.agent.script = async (text, tool) => diligent(text.includes("Continue task") ? text.replace("Continue task", "Task") : text, tool);
  await t.run("build");
  assert.equal(t.progress("order-cancellation").phase, "built");
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

test("/pb:compact writes and resets on demand (e.g. before quitting); undo brings the whole discussion back", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  t.selects.push("No thanks");
  await t.run("plan", "cancel orders");
  t.agent.script = async (text, tool) => {
    if (text.startsWith("[pb:compact]")) await tool("pb_write_spec", { name: "order-cancellation", content: PLANNING });
  };
  t.runtime().pi.sendUserMessage("refunds are out of scope");
  await t.settle();
  assert.equal(t.resets.length, 0); // 10%: far below the checkpoint
  await t.run("compact");
  assert.equal(t.resets.length, 1);
  assert.match(t.context(), /^\[pb plan checkpoint\][\s\S]*Only PENDING orders[\s\S]*Human: refunds are out of scope/);
  assert.doesNotMatch(t.context(), /\[pb:plan\] cancel orders/);

  t.runtime().usage = 73; // the whole discussion, back
  await t.run("compact", "undo");
  assert.match(t.posts.at(-1)!, /Reset undone\*\*: the whole discussion is back/);
  assert.match(t.context(), /\[pb:plan\] cancel orders[\s\S]*refunds are out of scope/);
  assert.doesNotMatch(t.context(), /\[pb plan checkpoint\]/);
  t.runtime().usage = 76; // past the threshold, but just undone: no new checkpoint before it grows another 5%
  t.runtime().pi.sendUserMessage("go on");
  await t.settle();
  assert.equal(t.resets.length, 1);
  await t.run("compact", "undo");
  assert.match(t.notes.at(-1)!, /Nothing to undo: no planning reset in this session/);

  const u = setup();
  process.chdir(u.repo);
  await u.run("compact");
  assert.match(u.notes.at(-1)!, /\/pb:compact is for planning and build sessions; elsewhere, Pi's \/compact/);
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
  assert.deepEqual(
    exploreLines({ details: { ...done, tokens: undefined, tokensIn: 3000, tokensOut: 200 }, answer, partial: false, expanded: false }).map((l) => l.text),
    ["explored in 34s · 2 files read · 3.0k in · 200 out @ 5.9 tok/s", "OrderService applies the transitions."],
  );
  assert.deepEqual(
    exploreLines({ details: { ...done, ms: undefined, tokens: undefined, tokensIn: 3000, tokensOut: 200 }, answer, partial: false, expanded: false }).map((l) => l.text),
    ["explored in 0s · 2 files read · 3.0k in · 200 out", "OrderService applies the transitions."],
  );
  const all = exploreLines({ details: done, answer, partial: false, expanded: true }).map((l) => l.text);
  assert.deepEqual(all, ["explored in 34s · 2 files read · 3.2k tokens", "OrderService applies the transitions.", "Order holds the state.", "files read:", "  src/order/OrderService.java", "  src/order/Order.java"]);
  assert.deepEqual(exploreLines({ answer: "Exploration stopped.", partial: false, expanded: false, error: true }).map((l) => l.kind), ["error"]);
});

test("pb_explore live view keeps a wider, bounded window over bursts", async () => {
  const { exploreLines, LIVE_STEPS, LIVE_WRITING_LINES } = await import("../extensions/pb/render.ts");
  assert.equal(LIVE_STEPS, 8);
  assert.equal(LIVE_WRITING_LINES, 4);
  const steps = Array.from({ length: 12 }, (_, i) => `grep hit${i} src/`);
  const writing = ["l1", "l2", "l3", "l4", "l5", "l6"];
  const lines = exploreLines({ details: { steps, count: 12, files: [], started: 1000, writing }, answer: "", partial: true, expanded: false, now: 19_000 }).map((l) => l.text);
  assert.deepEqual(lines, [...steps.slice(-8).map((s) => `↳ ${s}`), ...writing.slice(-4).map((l) => `│ ${l}`), "12 steps · 18s"]);
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
    if (text.startsWith("[pb:compact]")) {
      refused = await tool("pb_ask", { question: "Mail or event?" });
      await tool("pb_write_spec", { name: "order-cancellation", content: PLANNING });
    }
  };
  await u.run("compact");
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
  t.agent.script = async (text, tool) => {
    if (taskOf(text) === "T1") await tool("pb_update_spec", { section: "Design", content: "- One file per task." });
    return diligent(text, tool);
  };
  await t.run("build");
  const briefFile = path.join(os.tmpdir(), `pb-map-brief-${process.pid}.md`);
  process.env.MOCK_BRIEF_OUT = briefFile;
  const asked = t.selectTitles.length;
  await t.run("archive");
  delete process.env.MOCK_BRIEF_OUT;
  assert.equal(t.selectTitles.length, asked); // no question
  assert.match(fs.readFileSync(briefFile, "utf8"), /# The current map\n\n\(none yet[\s\S]*# The feature just finished: order-cancellation[\s\S]*`src\/order\.ts` holds the model[\s\S]*# Files that feature changed/);
  assert.match(fs.readFileSync(briefFile, "utf8"), /The design as built \(its "## Design"\):\n- One file per task\./); // recorded by the build, in T1
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

test("map: a map over the budget goes back once to be trimmed, by the same cartographer that can read the code", async () => {
  const t = setup({ verify: "true" });
  fs.mkdirSync(path.join(t.repo, "src/auth"), { recursive: true });
  fs.writeFileSync(path.join(t.repo, "src/order.ts"), "export {}\n");
  fs.writeFileSync(path.join(t.repo, "src/auth/Login.java"), "class Login {}\n");
  process.chdir(t.repo);
  const repair = path.join(os.tmpdir(), `pb-map-repair-${process.pid}.md`);
  process.env.MOCK_MAP_BIG = "1";
  process.env.MOCK_REPAIR_OUT = repair;
  try {
    await t.run("map");
  } finally {
    delete process.env.MOCK_MAP_BIG;
    delete process.env.MOCK_REPAIR_OUT;
  }
  const { MAP_TOKENS } = await import("../extensions/pb/map.ts");
  const brief = fs.readFileSync(repair, "utf8");
  fs.rmSync(repair);
  assert.match(brief, /^# Your proposed map[\s\S]*# Over the budget\n\nIt is about [\d,]+ tokens over the /);
  assert.doesNotMatch(brief, /Paths in it that don't resolve/); // every path resolved: the budget alone sent it back
  assert.ok(brief.includes(`the ${MAP_TOKENS.toLocaleString("en-US")} budget`));
  assert.match(brief, /keep every security invariant with its enforcement point, and every known gap/);
  const agents = t.read("AGENTS.md");
  assert.doesNotMatch(agents, /### Filler/);
  assert.match(agents, /### Orders/);
  assert.equal(t.read(".pi/pb/explore.jsonl").trim().split("\n").length, 2); // both calls counted in the stats
});

test("map: its entry reads well: collapsed, what changed; expanded, the map as markdown and what was removed", async () => {
  const { mapView } = await import("../extensions/pb/render.ts");
  const { MAP_TOKENS } = await import("../extensions/pb/map.ts");
  const d = { diff: ["- - `old.ts`: gone", "+ ### Orders", "+ - `src/order.ts`: orders"], warnings: [], tokens: 420, map: "### Orders\n- `src/order.ts`: orders", changes: ["added Orders"] };
  const collapsed = mapView(d, false);
  assert.equal(collapsed.head, "~420 tokens · 2 lines added, 1 removed");
  assert.deepEqual(collapsed.lines.map((l) => l.text), ["• added Orders", "(expand to read the map)"]);
  assert.equal(collapsed.markdown, undefined);
  const expanded = mapView(d, true);
  assert.equal(expanded.markdown, "### Orders\n- `src/order.ts`: orders");
  assert.deepEqual(expanded.removed, ["- `old.ts`: gone"]);
  const over = mapView({ ...d, tokens: MAP_TOKENS + 1, warnings: ["`x/y` doesn't resolve"] }, false);
  assert.ok(over.over);
  assert.match(over.head, new RegExp(`over the ~${MAP_TOKENS.toLocaleString("en-US")} budget`));
  assert.equal(mapView({ ...d, tokens: MAP_TOKENS }, false).over, false);
});

test("map: the cartographer is told the budget the view warns at", async () => {
  const { CARTOGRAPHER_SYSTEM, MAP_TOKENS } = await import("../extensions/pb/map.ts");
  assert.ok(CARTOGRAPHER_SYSTEM.includes(`about ${MAP_TOKENS.toLocaleString("en-US")} tokens at most`));
  assert.match(CARTOGRAPHER_SYSTEM, /### Security invariants[\s\S]*Known gaps[\s\S]*Never write a verdict/);
  assert.match(CARTOGRAPHER_SYSTEM, /capable models that explore fast[\s\S]*Layout, only where exploring misleads[\s\S]*No module-by-module tour[\s\S]*Start with the security invariants/);
});

test("extra instructions: added to each role's prompt, global ones first, pb's own kept", async () => {
  const { agentDir } = await import("../extensions/pb/standards.ts");
  const global = path.join(agentDir(), "pb", "config.json");
  fs.mkdirSync(path.dirname(global), { recursive: true });
  fs.writeFileSync(global, JSON.stringify({ extra: { plan: "Global: think about rollout.", build: "Global: keep functions short." } }));
  try {
    const t = setup({ verify: "true", extra: { plan: "Project: mind the i18n keys.", spec: "Always include a rollout task.", review: "Check the i18n keys.", adversarial: "Try the admin API." } });
    process.chdir(t.repo);
    t.selects.push("No thanks");
    await t.run("plan", "x");
    assert.match(t.instructions.at(-1)!, /Keep it in proportion to the change\.\n\nAlso, from your pb config:\nGlobal: think about rollout\.\nProject: mind the i18n keys\./);
    await t.run("spec");
    assert.match(t.instructions.at(-1)!, /Name: short kebab-case\.[\s\S]*Also, from your pb config:\nAlways include a rollout task\./);
    await written(t);
    t.agent.script = diligent;
    await t.run("build");
    assert.match(t.instructions.find((i) => /\[pb:build order-cancellation\]/.test(i))!, /Finish each task with pb_task_done[^\n]*\n\nAlso, from your pb config:\nGlobal: keep functions short\./);
    await t.run("review");
    assert.match(briefOf(t), /You are an independent REVIEWER[\s\S]*Also, from your pb config:\nCheck the i18n keys\./);
    assert.ok(t.instructions.some((i) => /You are an ATTACKER[\s\S]*Also, from your pb config:\nTry the admin API\./.test(i)));
  } finally {
    fs.rmSync(global, { force: true });
  }
  const u = setup({ verify: "true", extra: { map: "List the Kafka topics." } });
  process.chdir(u.repo);
  const sys = path.join(os.tmpdir(), `pb-map-system-${process.pid}.md`);
  process.env.MOCK_SYSTEM_OUT = sys;
  try {
    await u.run("map");
  } finally {
    delete process.env.MOCK_SYSTEM_OUT;
  }
  assert.match(fs.readFileSync(sys, "utf8"), /^You are a CARTOGRAPHER[\s\S]*report_map tool[\s\S]*\n\nAlso, from your pb config:\nList the Kafka topics\.$/);
  fs.rmSync(sys);
  const { Store } = await import("../extensions/pb/store.ts");
  assert.equal(new Store(u.repo).extra("plan"), ""); // nothing set: nothing added
});

test("pb_ask counts down while planning too: unanswered, the recommendation is taken as an assumption to confirm", async () => {
  const t = setup({ askTimeoutSec: 0.001 });
  process.chdir(t.repo);
  t.selects.push("No thanks");
  await t.run("plan", "cancel orders");
  t.selects.push("<timeout>");
  const r = await t.callTool("pb_ask", { question: "Mail or event?", options: ["mail", "event"], recommended: "event" });
  assert.equal(t.dialogTimeouts.at(-1), 1);
  assert.match(r.content![0].text, /No answer in time: take the sensible reading \(your recommendation: event\), and tell the human it's an assumption to confirm[\s\S]*The question stays in the chat, its options lettered \(A\. mail; B\. event\): if the human answers later, by letter or in words, follow their answer\./);
  // The dialog is gone, the question isn't: it stays in the chat with its options, lettered for a short answer.
  assert.equal(t.posts.at(-1), "**Unanswered question** (no answer within 1 min; Pi went on with its recommendation, event):\n\nMail or event?\n\nA. mail\nB. event (recommended)\n\nTo answer, type it here any time (a letter is enough): if Pi is working, it reads it after its current step.");
});

test("pb_ask: a dialog closed before its time is kept in the chat too; an answered one isn't", async () => {
  const t = setup();
  process.chdir(t.repo);
  t.selects.push("No thanks");
  await t.run("plan", "cancel orders");
  const posted = t.posts.length;
  t.selects.push("mail");
  assert.match((await t.callTool("pb_ask", { question: "Mail or event?", options: ["mail", "event"] })).content![0].text, /^The human answered: mail$/);
  assert.equal(t.posts.length, posted);
  t.selects.push("<timeout>");
  const r = await t.callTool("pb_ask", { question: "Which name?", options: ["a", "b"] });
  assert.match(r.content![0].text, /^The human dismissed the question: take the sensible reading[\s\S]*The question stays in the chat/);
  assert.match(t.posts.at(-1)!, /^\*\*Unanswered question\*\* \(the dialog was closed; Pi went on with the sensible reading\):\n\nWhich name\?\n\nA\. a\nB\. b\n/);
});

test("pb_ask: terminal activity restarts the countdown — idle time, not wall time", async () => {
  const t = setup({ askTimeoutSec: 2 });
  process.chdir(t.repo);
  t.selects.push("No thanks");
  await t.run("plan", "cancel orders");
  (t.runtime().ctx as any).mode = "tui";
  t.selects.push("<hang>");
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let settled = false;
  const p = t.callTool("pb_ask", { question: "Mail or event?", options: ["mail", "event"], recommended: "event" }).then((r) => {
    settled = true;
    return r;
  });
  await sleep(1000);
  t.key();
  await sleep(500);
  t.key();
  await sleep(1000);
  assert.equal(settled, false); // 2.5s elapsed but 1s idle: an absolute timeout would have fired
  const r = await p;
  assert.equal(settled, true);
  assert.match(r.content![0].text, /No answer in time: take the sensible reading/);
  assert.ok(t.posts.some((x) => x.startsWith("**Unanswered question**")));
});

test("pb_ask: silence still times out the dialog", async () => {
  const t = setup({ askTimeoutSec: 1 });
  process.chdir(t.repo);
  t.selects.push("No thanks");
  await t.run("plan", "cancel orders");
  (t.runtime().ctx as any).mode = "tui";
  t.selects.push("<hang>");
  const r = await t.callTool("pb_ask", { question: "Mail or event?", options: ["mail", "event"], recommended: "event" });
  assert.match(r.content![0].text, /No answer in time: take the sensible reading/);
  assert.ok(t.posts.some((x) => x.startsWith("**Unanswered question**")));
});

test("pb_ask: picking Something else keeps the options visible while typing", async () => {
  const t = setup();
  process.chdir(t.repo);
  t.selects.push("Something else (type it)", "event, but only for refunds");
  const r = await t.callTool("pb_ask", { question: "Mail or event?", options: ["mail", "event"], recommended: "event" });
  assert.match(r.content![0].text, /^The human answered: event, but only for refunds$/);
  const posted = t.posts.find((x) => x.startsWith("**Answering with your own words:**"));
  assert.ok(posted);
  assert.match(posted!, /Mail or event\?[\s\S]*A\. mail[\s\S]*B\. event \(recommended\)/);
});

test("notify: a desktop notification when pb asks, and none when it's turned off", async () => {
  const { setNotifySink } = await import("../extensions/pb/notify.ts");
  const sent: string[][] = [];
  setNotifySink((title, body) => sent.push([title, body]));
  try {
    const t = setup({ notify: true });
    process.chdir(t.repo);
    t.selects.push("No thanks");
    await t.run("plan", "cancel orders");
    t.selects.push("mail");
    await t.callTool("pb_ask", { question: "Mail\nor event;\x07 now?", options: ["mail", "event"] });
    assert.deepEqual(sent.at(-1), ["pb: a question for you", "Mail or event now?"]); // one line, nothing that ends the escape sequence
    const v = setup({ verify: "true", notify: true }); // a dialog that goes on without you
    await written(v);
    v.runtime().usage = 72;
    v.agent.script = diligent;
    v.selects.push("Build here anyway");
    await v.run("build");
    assert.deepEqual(sent.at(-1), ["pb: your choice", "Build order-cancellation: this session is 72% full"]);

    const u = setup();
    process.chdir(u.repo);
    u.selects.push("No thanks");
    await u.run("plan", "x");
    const before = sent.length;
    u.selects.push("mail");
    await u.callTool("pb_ask", { question: "Mail or event?", options: ["mail", "event"] });
    assert.equal(sent.length, before);
  } finally {
    setNotifySink(undefined);
  }
});

test("fresh calls are saved as sessions to open afterwards, and stream their text while they run", async () => {
  const { runFresh } = await import("../extensions/pb/runner.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pb-sessions-"));
  const seen: string[] = [];
  const r = await runFresh({ cwd: dir, role: "explorer", systemPrompt: "You are an EXPLORER", brief: "# Question\n\nwhere?", prompt: "go", tools: ["read"], sessionDir: dir, onText: (t) => seen.push(t) });
  assert.match(r.sessionFile!, /_mock-\d+-\d+\.jsonl$/);
  assert.ok(seen.length > 2 && r.text.startsWith(seen.at(-1)!.slice(0, 20))); // grows piece by piece
  assert.equal(seen.at(-1), r.text);

  const t = setup({ verify: "true" });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  await t.run("review");
  assert.match(t.posts.at(-1)!, /The review sessions: spec `pi --session build-session-\d+\.jsonl` · adversarial `pi --session build-session-\d+\.jsonl`/);
  const e = await t.callTool("pb_explore", { question: "where?" });
  assert.match((e as any).details.session, /^\.pi\/pb\/sessions\/explorer\/.+\.jsonl$/);

  // The feature is done: its review runs and the explorer runs go with /pb:archive.
  t.selects.push("<timeout>");
  await t.run("archive");
  const archived = fs.readdirSync(path.join(t.repo, ".pi/pb-archive")).find((d) => d.endsWith("order-cancellation"))!;
  assert.ok(!fs.existsSync(path.join(t.repo, ".pi/pb-archive", archived, "sessions")));
  assert.deepEqual(fs.existsSync(path.join(t.repo, ".pi/pb/sessions/explorer")), false);
});

test("/pb:compact in a build session compacts to the build's state (Pi's compaction, pb's summary)", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  let compacted: unknown;
  t.agent.script = async (text, tool) => {
    if (text.includes("Task T2")) return; // stops mid-build: paused
    return diligent(text, tool);
  };
  await t.run("build");
  t.runtime().ctx.compact = (o: any) => {
    compacted = o;
    o.onComplete?.({});
  };
  await t.run("compact");
  assert.ok(compacted);
  assert.match(t.notes.at(-1)!, /Compacted to the build's state/);
});
