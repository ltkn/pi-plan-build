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

function piInvocation(args: string[]): { command: string; args: string[] } {
  // Override for custom installs and for the test suite's mock.
  const override = process.env.PI_PB_PI_COMMAND;
  if (override) return { command: override, args };
  // Same resolution strategy as Pi's own subagent example.
  const script = process.argv[1];
  if (script && !script.startsWith("/$bunfs/root/") && fs.existsSync(script)) {
    return { command: process.execPath, args: [script, ...args] };
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

export async function runFresh(o: RunOptions): Promise<RunResult> {
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
      const proc = spawn(inv.command, inv.args, { cwd: o.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
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
        if (texts.length) res.text = texts.join("\n");
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
          proc.kill("SIGTERM");
        } catch {
          /* ignore */
        }
        setTimeout(() => {
          if (!closed) {
            try {
              proc.kill("SIGKILL");
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
