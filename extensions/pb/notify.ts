/**
 * A desktop notification when pb asks you something, so a question doesn't wait unseen while you're in
 * another window. Quieter than a sound: the terminal hands it to the system's notification center.
 * The protocols follow Pi's own notify example: OSC 777 (Ghostty, iTerm2, WezTerm, rxvt-unicode), OSC 99
 * (Kitty), a toast on Windows Terminal; macOS Terminal understands none of them, so it goes through osascript.
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

/** Terminals with native OSC notification support; anything else on macOS falls back to osascript. */
const OSC_TERMS = new Set(["Ghostty", "iTerm.app", "WezTerm"]);

function send(title: string, body: string): void {
  if (process.env.WT_SESSION || process.platform === "win32") {
    const q = (s: string) => s.replace(/'/g, "''");
    const type = "Windows.UI.Notifications";
    const script = [
      `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime] > $null`,
      `$xml = [${type}.ToastNotificationManager]::GetTemplateContent([${type}.ToastTemplateType]::ToastText01)`,
      `$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('${q(body)}')) > $null`,
      `[${type}.ToastNotificationManager]::CreateToastNotifier('${q(title)}').Show([${type}.ToastNotification]::new($xml))`,
    ].join("; ");
    execFile("powershell.exe", ["-NoProfile", "-Command", script], () => {});
  } else if (process.env.KITTY_WINDOW_ID) {
    process.stdout.write(`\x1b]99;i=1:d=0;${title}\x1b\\\x1b]99;i=1:p=body;${body}\x1b\\`);
  } else if (process.platform === "darwin" && (process.env.TERM_PROGRAM === "Apple_Terminal" || !OSC_TERMS.has(process.env.TERM_PROGRAM ?? ""))) {
    execFile("osascript", ["-e", `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`], () => {});
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
