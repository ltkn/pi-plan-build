/**
 * A desktop notification when pb asks you something, so a question doesn't wait unseen while you're in
 * another window: where the terminal supports it, it hands the notification to the system's notification center.
 * The protocols follow Pi's own notify example: OSC 777 (Ghostty, iTerm2, WezTerm, rxvt-unicode), OSC 99
 * (Kitty), a toast on Windows Terminal. Any other macOS terminal (Terminal.app among them) gets the bell: its
 * Dock icon bounces and takes a badge. Not osascript: that notification belongs to Script Editor, so clicking it
 * opens Script Editor instead of the terminal.
 */
import { execFile } from "node:child_process";

/** One line, no control characters (they would end the escape sequence early), and short. Surrogate-safe. */
const clean = (s: string, max: number) =>
  Array.from(
    s
      .replace(/[\x00-\x1f\x7f;]+/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  )
    .slice(0, max)
    .join("");

/** Terminals with native OSC notification support; any other macOS terminal gets the bell. */
const OSC_TERMS = new Set(["Ghostty", "iTerm.app", "WezTerm"]);

/** How this terminal is told: a Windows toast, Kitty's OSC 99, the bell, or OSC 777. */
export function channelFor(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): "windows" | "kitty" | "bell" | "osc777" {
  if (env.WT_SESSION || platform === "win32") return "windows";
  if (env.KITTY_WINDOW_ID) return "kitty";
  if (platform === "darwin" && !OSC_TERMS.has(env.TERM_PROGRAM ?? "")) return "bell";
  return "osc777";
}

function send(title: string, body: string): void {
  const channel = channelFor(process.env, process.platform);
  if (channel === "windows") {
    const q = (s: string) => s.replace(/'/g, "''");
    const type = "Windows.UI.Notifications";
    const script = [
      `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime] > $null`,
      `$xml = [${type}.ToastNotificationManager]::GetTemplateContent([${type}.ToastTemplateType]::ToastText01)`,
      `$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('${q(body)}')) > $null`,
      `[${type}.ToastNotificationManager]::CreateToastNotifier('${q(title)}').Show([${type}.ToastNotification]::new($xml))`,
    ].join("; ");
    execFile("powershell.exe", ["-NoProfile", "-Command", script], () => {});
  } else if (channel === "kitty") {
    process.stdout.write(`\x1b]99;i=1:d=0;${title}\x1b\\\x1b]99;i=1:p=body;${body}\x1b\\`);
  } else if (channel === "bell") {
    process.stdout.write("\x07");
  } else {
    process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
  }
}

let sink = send;

/** Tests capture notifications instead of sending them. */
export function setNotifySink(f: ((title: string, body: string) => void) | undefined): void {
  sink = f ?? send;
}

/** Best-effort: a notification that can't be shown never gets in the way of the question. */
export function notifyDesktop(title: string, body: string): void {
  try {
    sink(clean(title, 60), clean(body, 200));
  } catch {
    // no notification, the dialog is still there
  }
}
