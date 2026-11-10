/**
 * Loaded only into the pb_explore and pb_try processes (`pi -e`), which start without pb's own extension and so
 * without its shell hook. It applies command-guard.ts to every shell call there: the explorer runs read-only
 * inspection commands only, a probe never writes to a system outside this machine, every command has a limit
 * that never outlasts the run, and the model's shell runs without production credentials. pb hands it its
 * settings in PI_PB_GUARD, read once when the process starts — which is when the run's clock starts too.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TIMED_OUT, commandCap, explorerRefusal, isLongCommand, remoteWriteRefusal, scrubPrefix, timeoutNote } from "./command-guard.ts";

export interface GuardSettings {
  role: "explorer" | "trier";
  /** the limit for an ordinary command, and its config key */
  shellSec: number;
  shellKey: string;
  /** the limit for the project's own long commands (the trier only; the explorer runs none), and its config key */
  longSec: number;
  longKey: string;
  longCommands: string[];
  /** the whole run's limit (0 = none), and its config key */
  runSec: number;
  runKey: string;
  /** where the limits are set, for the note a timeout gets */
  configPath: string;
}

export const GUARD_ENV = "PI_PB_GUARD";

export default function freshGuard(pi: ExtensionAPI) {
  let settings: GuardSettings | undefined;
  try {
    settings = JSON.parse(process.env[GUARD_ENV] ?? "") as GuardSettings;
  } catch {
    settings = undefined;
  }
  const started = Date.now();
  /** which limit governs each call, so a timeout names the one that fired */
  const keys = new Map<string, string>();
  // Without its settings the guard fails closed: no shell at all, rather than an unguarded one.
  pi.on("tool_call", (e) => {
    const ev = e as { toolName: string; toolCallId?: string; input: { command?: string; timeout?: unknown } };
    if (ev.toolName !== "bash" && ev.toolName !== "powershell") return;
    if (!settings) return { block: true, reason: "pb's guard has no settings, so this run has no shell." };
    const command = String(ev.input.command ?? "");
    const refused = settings.role === "explorer" ? explorerRefusal(command) : remoteWriteRefusal(command);
    if (refused) {
      return {
        block: true,
        reason:
          settings.role === "explorer"
            ? `The explorer only inspects: ${refused}. Read files with read/grep/find/ls; anything that needs running code, a database or the network belongs in pb_try, called by the session that asked.`
            : `A probe never writes to a system outside this machine, and this looks like ${refused}. Probe a local or scratch copy instead, or say what you would run and why, so the human can.`,
      };
    }
    const runLeftSec = settings.runSec > 0 ? settings.runSec - (Date.now() - started) / 1000 : undefined;
    const cap = commandCap({ command, asked: typeof ev.input.timeout === "number" ? ev.input.timeout : undefined, shellSec: settings.shellSec, longSec: settings.longSec, longCommands: settings.longCommands, runLeftSec });
    if (cap !== undefined) ev.input.timeout = cap;
    const own = isLongCommand(command, settings.longCommands) ? settings.longKey : settings.shellKey;
    if (ev.toolCallId) keys.set(ev.toolCallId, runLeftSec !== undefined && cap !== undefined && cap >= Math.floor(runLeftSec) ? settings.runKey : own);
    ev.input.command = `${scrubPrefix(process.env, [GUARD_ENV])}${command}`;
  });
  // A command stopped at its limit says which limit, so the run's answer can name it instead of guessing.
  pi.on("tool_result", (ev) => {
    if (!settings || (ev.toolName !== "bash" && ev.toolName !== "powershell")) return;
    const text = ev.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    const key = keys.get(ev.toolCallId) ?? settings.shellKey;
    keys.delete(ev.toolCallId);
    if (!TIMED_OUT.test(text)) return;
    return { content: [...ev.content, { type: "text" as const, text: `\n${timeoutNote(key, settings.configPath)}` }] };
  });
}
