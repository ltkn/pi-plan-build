/**
 * Fresh-context runner: the explorer, the reviewer, the abuse pass, the verifier and the cartographer
 * each run as a separate `pi` process with no history. It only knows what the brief and the repo tell it.
 * Its session is saved (when a directory is given), so you can open the whole run afterwards.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface RunOptions {
  cwd: string;
  role: string;
  systemPrompt: string;
  /** attached as a file */
  brief: string;
  /** The user message sent with the attached brief: what to do with it. */
  prompt: string;
  tools: string[];
  /** extensions to load explicitly (e.g. the reviewer's reporting tools); everything else stays off */
  extensions?: string[];
  model?: string;
  thinking?: string;
  /** Cap on concurrent fresh runs, from the config's `maxConcurrent` (0 = uncapped); the PI_PB_MAX_CONCURRENT env var outranks it; unset = uncapped. */
  maxConcurrent?: number;
  signal?: AbortSignal;
  /** Each tool call the fresh model makes, as it happens: a one-line preview and the call itself. */
  onActivity?: (line: string, call: ToolCall) => void;
  /** The model's current message (text and thinking) as it's written. */
  onText?: (text: string) => void;
  /** Save the run's session here, to open it later with `pi --session <file>`; unset = not saved. */
  sessionDir?: string;
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface RunResult {
  text: string; // final assistant text
  /** every tool call the model made, in order (the structured channel for reviewer and verifier) */
  toolCalls: ToolCall[];
  stopReason?: string;
  error?: string;
  exitCode: number;
  cost: number;
  turns: number;
  /** token usage summed over all turns; peakContext = the largest prompt one turn sent (how full the context got) */
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; peakContext: number };
  /** wall-clock duration of the call */
  ms: number;
  aborted: boolean;
  /** the saved session file (with sessionDir) */
  sessionFile?: string;
}

/**
 * Concurrent fresh runs all land on the same engine, and every admitted
 * prompt holds KV memory for its whole lifetime: cap how many spawned `pi`
 * processes run at once. FIFO queue — queued tasks start as a running
 * sibling exits. pb's built-in default is uncapped; the config's
 * `maxConcurrent` sets a cap (project-level, or machine-wide in
 * ~/.pi/agent/pb/config.json), and the PI_PB_MAX_CONCURRENT env var
 * outranks both; 0 disables the cap.
 */
const DEFAULT_CONCURRENCY = 0;

function concurrencyLimit(configured?: number): number | null {
  const raw = process.env.PI_PB_MAX_CONCURRENT?.trim();
  const envOk = raw !== undefined && raw !== "" && Number.isFinite(Number(raw)) && Number(raw) >= 0;
  const n = envOk
    ? Number(raw) // env wins, even against a config value
    : typeof configured === "number" && Number.isFinite(configured) && configured >= 0
      ? configured
      : DEFAULT_CONCURRENCY; // pb's built-in default when neither the env nor the config spoke
  return n === 0 ? null : Math.max(1, Math.floor(n)); // 0 = uncapped, in every source
}

let activeRuns = 0;
/** Callers waiting for a slot; `gone` says a waiter left (aborted) before it could be woken. */
interface Waiter {
  wake: () => void;
  gone: () => boolean;
}
const waitingSlots: Waiter[] = [];

/** A freed slot goes to the first waiter still waiting: aborted ones are dropped, not woken. */
function wakeNextWaiting(): void {
  while (waitingSlots.length) {
    const waiter = waitingSlots.shift()!;
    if (waiter.gone()) continue;
    waiter.wake();
    return;
  }
}

async function acquireRunSlot(signal?: AbortSignal, configured?: number): Promise<(() => void) | null> {
  const limit = concurrencyLimit(configured);
  if (limit === null) return () => {};
  while (activeRuns >= limit) {
    if (signal?.aborted) return null;
    let onAbort: (() => void) | undefined;
    let leaving = false;
    // One release wakes exactly one waiter: an aborted one still in the queue would eat
    // that wakeup and strand everyone behind it, so it leaves — and is skipped meanwhile.
    const waiter: Waiter = { wake: () => {}, gone: () => leaving || !!signal?.aborted };
    const queued = new Promise<void>((resolve) => {
      waiter.wake = resolve;
      waitingSlots.push(waiter);
    });
    const race = signal
      ? new Promise<never>((_, reject) => {
          onAbort = () => reject(new Error("stopped while queued"));
          signal.addEventListener("abort", onAbort, { once: true });
        })
      : undefined;
    try {
      await (race ? Promise.race([queued, race]) : queued);
    } catch {
      leaving = true; // the caller's signal aborted while queued
      const i = waitingSlots.indexOf(waiter);
      if (i >= 0) waitingSlots.splice(i, 1);
      return null;
    } finally {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  }
  activeRuns++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeRuns--;
    wakeNextWaiting();
  };
}

function piInvocation(args: string[]): { command: string; args: string[] } {
  // Override for custom installs and for the test suite's mock.
  const override = process.env.PI_PB_PI_COMMAND;
  if (override) return { command: override, args };
  // Same resolution strategy as Pi's own subagent example.
  const script = process.argv[1];
  if (script && !script.startsWith("/$bunfs/root/") && fs.existsSync(script)) {
    // The extension may be embedded in another JS host (a different CLI, a test runner):
    // only reuse the entry script when it is Pi's own, otherwise the host would get Pi's args.
    const base = path.basename(script).toLowerCase();
    if (/^pi(\.(mjs|cjs|js|ts|exe))?$/.test(base)) return { command: process.execPath, args: [script, ...args] };
  }
  const exe = path.basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(exe)) return { command: process.execPath, args };
  return { command: "pi", args };
}

/** One-line live activity for fresh runs: what is being searched, and where. */
export function previewCall(name: string, args: Record<string, unknown>): string {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const cmd = str(args.command).replace(/\s+/g, " ");
  if (cmd) return cmd.length > 120 ? `${cmd.slice(0, 119)}…` : cmd;
  const pattern = str(args.pattern);
  const at = str(args.path ?? args.file_path);
  if (pattern && at) return `${pattern} in ${at}`;
  return (pattern || at).replace(/\s+/g, " ");
}

async function runFreshUncapped(o: RunOptions): Promise<RunResult> {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), `pi-pb-${o.role}-`));
  const sysFile = path.join(tmp, "system.md");
  const briefFile = path.join(tmp, "brief.md");
  await fs.promises.writeFile(sysFile, o.systemPrompt, { mode: 0o600 });
  await fs.promises.writeFile(briefFile, o.brief, { mode: 0o600 });

  const args = ["--mode", "json", "-p", ...(o.sessionDir ? ["--session-dir", o.sessionDir] : ["--no-session"]), "--no-extensions"];
  for (const e of o.extensions ?? []) args.push("-e", e);
  if (o.model) args.push("--model", o.model);
  if (o.thinking) args.push("--thinking", o.thinking);
  if (o.tools.length) args.push("--tools", o.tools.join(","));
  else args.push("--no-tools"); // an empty allowlist means none: omitting the flag would leave Pi's defaults on
  args.push("--append-system-prompt", sysFile, `@${briefFile}`, o.prompt);

  const started = Date.now();
  let sessionId: string | undefined;
  let streaming = "";
  const res: RunResult = {
    text: "",
    toolCalls: [],
    exitCode: 0,
    cost: 0,
    turns: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, peakContext: 0 },
    ms: 0,
    aborted: false,
  };

  try {
    res.exitCode = await new Promise<number>((resolve) => {
      const inv = piInvocation(args);
      const posix = process.platform !== "win32";
      const proc = spawn(inv.command, inv.args, { cwd: o.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"], detached: posix });
      let buf = "";
      let stderr = "";
      let closed = false;

      const onLine = (line: string) => {
        if (!line.trim()) return;
        let ev: any;
        try {
          ev = JSON.parse(line);
        } catch {
          return;
        }
        if (ev.type === "session") sessionId = ev.id ?? ev.sessionId ?? ev.session_id;
        if (ev.type === "message_update") {
          const d = ev.assistantMessageEvent;
          if ((d?.type === "text_delta" || d?.type === "thinking_delta") && typeof d.delta === "string") {
            streaming += d.delta;
            o.onText?.(streaming);
          }
          return;
        }
        if (ev.type !== "message_end" || ev.message?.role !== "assistant") return;
        streaming = "";
        const m = ev.message;
        res.turns++;
        res.cost += m.usage?.cost?.total ?? (typeof m.usage?.cost === "number" ? m.usage.cost : 0);
        const u = m.usage ?? {};
        const t = res.tokens;
        t.input += u.input ?? u.inputTokens ?? u.prompt_tokens ?? 0;
        t.output += u.output ?? u.outputTokens ?? u.completion_tokens ?? 0;
        t.cacheRead += u.cacheRead ?? u.cached_tokens ?? 0;
        t.cacheWrite += u.cacheWrite ?? 0;
        t.peakContext = Math.max(t.peakContext, (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0));
        if (m.stopReason) res.stopReason = m.stopReason;
        if (m.errorMessage) res.error = m.errorMessage;
        const texts: string[] = [];
        for (const part of m.content ?? []) {
          if (part.type === "text" && part.text?.trim()) texts.push(part.text);
          else if (part.type === "toolCall") {
            const call = { name: part.name, arguments: part.arguments ?? {} };
            res.toolCalls.push(call);
            o.onActivity?.(`${part.name} ${previewCall(part.name, call.arguments)}`, call);
          }
        }
        // Every message's text is kept: answers routinely span turns (analysis, calls, conclusion).
        if (texts.length) res.text = res.text ? `${res.text}\n${texts.join("\n")}` : texts.join("\n");
      };

      proc.stdout.on("data", (d) => {
        buf += d.toString();
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const l of lines) onLine(l);
      });
      proc.stderr.on("data", (d) => {
        stderr += d.toString();
      });
      proc.on("close", (code, signal) => {
        closed = true;
        if (o.signal) o.signal.removeEventListener("abort", kill);
        if (buf.trim()) onLine(buf);
        if (res.aborted) return resolve(1);
        if (signal) {
          res.error = res.error || `killed by ${signal}${stderr.trim() ? `: ${stderr.trim().slice(-2000)}` : ""}`;
          return resolve(1);
        }
        if ((code ?? 1) !== 0 && !res.error) res.error = stderr.trim().slice(-2000) || `exit code ${code}`;
        resolve(code ?? 1);
      });
      proc.on("error", (e) => {
        closed = true;
        if (o.signal) o.signal.removeEventListener("abort", kill);
        res.error = e.message;
        resolve(1);
      });
      const kill = () => {
        if (closed) return;
        res.aborted = true;
        try {
          // Kill the whole process group so grandchildren don't outlive the abort (verify.ts kills the same way).
          if (posix && proc.pid) process.kill(-proc.pid, "SIGTERM");
          else proc.kill("SIGTERM");
        } catch {
          /* ignore */
        }
        setTimeout(() => {
          if (!closed) {
            try {
              if (posix && proc.pid) process.kill(-proc.pid, "SIGKILL");
              else proc.kill("SIGKILL");
            } catch {
              /* ignore */
            }
          }
        }, 5000);
      };
      if (o.signal) {
        if (o.signal.aborted) kill();
        else o.signal.addEventListener("abort", kill, { once: true });
      }
    });
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
  res.ms = Date.now() - started;
  if (o.sessionDir && sessionId) {
    const files = await fs.promises.readdir(o.sessionDir).catch(() => [] as string[]);
    const exact = files.find((f) => f === `${sessionId}.jsonl`);
    const contains = files.filter((f) => f.endsWith(".jsonl") && f.includes(sessionId!));
    const file = exact ?? (contains.length === 1 ? contains[0] : undefined);
    if (file) res.sessionFile = path.join(o.sessionDir, file);
  }
  return res;
}

/** The run's usage in Pi's shape, so a tool that made the call can report it and session totals stay right. */
export function usageOf(r: RunResult) {
  const t = r.tokens;
  return {
    input: t.input,
    output: t.output,
    cacheRead: t.cacheRead,
    cacheWrite: t.cacheWrite,
    totalTokens: t.input + t.output + t.cacheRead + t.cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: r.cost },
  };
}

/**
 * Fresh-context runner with the concurrency cap applied: at most
 * PI_PB_MAX_CONCURRENT spawned `pi` processes (the config's `maxConcurrent`
 * when it set a cap; built-in default uncapped) run at once, the rest queue
 * FIFO and start as a running sibling exits. Aborting the caller's signal
 * while queued stops before any process starts.
 */
export async function runFresh(o: RunOptions): Promise<RunResult> {
  const release = await acquireRunSlot(o.signal, o.maxConcurrent);
  if (release === null) {
    return {
      text: "",
      toolCalls: [],
      exitCode: 1,
      cost: 0,
      turns: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, peakContext: 0 },
      ms: 0,
      aborted: true,
    };
  }
  try {
    return await runFreshUncapped(o);
  } finally {
    release();
  }
}
