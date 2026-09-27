/**
 * How pb's session entries look in the terminal. The spec view is a custom entry: you read the
 * whole spec before building, and the model isn't sent it again (it wrote it).
 */
import { type ExtensionAPI, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";

export function registerRenderers(pi: ExtensionAPI) {
  pi.registerEntryRenderer<{ name: string; markdown: string }>("pb-spec", (entry, { expanded }, theme) => {
    const data = entry.data;
    if (!data) return undefined;
    const box = new Box(1, 1, (s) => theme.bg("customMessageBg", s));
    box.addChild(new Text(theme.fg("accent", `spec: ${data.name}`) + (expanded ? "" : theme.fg("dim", "  (expand to read it all)")), 0, 0));
    const body = expanded ? data.markdown : data.markdown.split("\n").slice(0, 24).join("\n");
    box.addChild(new Markdown(body, 0, 1, getMarkdownTheme()));
    return box;
  });
}

/* ------------------------------- pb_explore ------------------------------- */

/** What an exploration did: kept in the tool result's details for the display only. */
export interface ExploreDetails {
  /** the last few steps (tool calls) of the explorer */
  steps: string[];
  count: number;
  /** files it read */
  files: string[];
  started: number;
  ms?: number;
  tokens?: number;
}

const short = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
const human = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`);
const secs = (ms: number) => `${Math.round(ms / 1000)}s`;

/** The lines shown for an exploration: live steps while it runs, then one summary line (all of it when expanded). */
export function exploreLines(o: { details?: ExploreDetails; answer: string; partial: boolean; expanded: boolean; error?: boolean; now?: number }): { text: string; kind: "step" | "count" | "done" | "answer" | "file" | "error" }[] {
  const d = o.details;
  if (o.error) return [{ text: short(o.answer.split("\n")[0] || "exploration failed", 120), kind: "error" }];
  if (o.partial) {
    if (!d) return [{ text: "starting…", kind: "count" }];
    return [...d.steps.map((s) => ({ text: `↳ ${short(s, 100)}`, kind: "step" as const })), { text: `${d.count} step${d.count === 1 ? "" : "s"} · ${secs((o.now ?? Date.now()) - d.started)}`, kind: "count" as const }];
  }
  const head = d ? `explored in ${secs(d.ms ?? 0)} · ${d.files.length} file${d.files.length === 1 ? "" : "s"} read${d.tokens ? ` · ${human(d.tokens)} tokens` : ""}` : "explored";
  const first = o.answer.split("\n").find((l) => l.trim()) ?? "";
  if (!o.expanded) return [{ text: head, kind: "done" }, ...(first ? [{ text: short(first.trim(), 120), kind: "answer" as const }] : [])];
  return [
    { text: head, kind: "done" },
    ...o.answer.split("\n").map((l) => ({ text: l, kind: "answer" as const })),
    ...(d?.files.length ? [{ text: "files read:", kind: "file" as const }, ...d.files.map((f) => ({ text: `  ${f}`, kind: "file" as const }))] : []),
  ];
}

type Theme = { fg(color: string, text: string): string; bold(text: string): string };

export function renderExploreCall(args: { question?: string }, theme: Theme) {
  return new Text(theme.fg("toolTitle", theme.bold("explore ")) + theme.fg("accent", short(args.question ?? "", 110)), 0, 0);
}

export function renderExploreResult(result: { content: { type: string; text?: string }[]; details?: ExploreDetails }, opts: { expanded: boolean; isPartial: boolean }, theme: Theme, isError = false) {
  const answer = result.content.map((c) => c.text ?? "").join("");
  const color = { step: "dim", count: "muted", done: "success", answer: "text", file: "dim", error: "error" } as const;
  const lines = exploreLines({ details: result.details, answer, partial: opts.isPartial, expanded: opts.expanded, error: isError });
  return new Text(lines.map((l) => theme.fg(color[l.kind], l.text)).join("\n"), 0, 0);
}
