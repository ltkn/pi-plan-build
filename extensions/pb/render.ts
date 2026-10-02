/**
 * How pb's session entries look in the terminal. The spec view is a custom entry: you read the
 * whole spec before building, and the model isn't sent it again (it wrote it).
 */
import { type ExtensionAPI, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";
import { MAP_TOKENS } from "./map.ts";

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

  // A change to the project map: shown to you, not sent to the model. Collapsed, what changed; expanded, the map itself.
  pi.registerEntryRenderer<MapView>("pb-map", (entry, { expanded }, theme) => {
    const d = entry.data;
    if (!Array.isArray(d?.diff) || !Array.isArray(d.warnings)) return undefined; // entries from earlier versions: not shown
    const v = mapView(d, expanded);
    const box = new Box(1, 1, (s) => theme.bg("customMessageBg", s));
    box.addChild(new Text(theme.fg("accent", "project map (AGENTS.md)") + theme.fg(v.over ? "warning" : "dim", `  ${v.head}`), 0, 0));
    const color = { change: "text", warning: "warning", removed: "toolDiffRemoved", hint: "dim" } as const;
    if (v.lines.length) box.addChild(new Text(v.lines.map((l) => theme.fg(color[l.kind], l.text)).join("\n"), 0, 0));
    if (v.markdown) box.addChild(new Markdown(v.markdown, 0, 1, getMarkdownTheme()));
    if (v.removed.length) box.addChild(new Text([theme.fg("dim", "removed:"), ...v.removed.map((l) => theme.fg("toolDiffRemoved", `- ${l}`))].join("\n"), 0, 0));
    return box;
  });
}

/* ------------------------------- project map ------------------------------- */

export interface MapView {
  diff: string[];
  warnings: string[];
  tokens: number;
  /** the new map */
  map?: string;
  /** what changed, as the cartographer put it */
  changes?: string[];
}

/** What the map's entry shows: collapsed, what changed; expanded, the new map as markdown and what was removed. */
export function mapView(d: MapView, expanded: boolean) {
  const added = d.diff.filter((l) => l.startsWith("+ ")).length;
  const removedLines = d.diff.filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
  const over = d.tokens > MAP_TOKENS;
  const head = `~${d.tokens.toLocaleString("en-US")} tokens${over ? `, over the ~${MAP_TOKENS.toLocaleString("en-US")} budget` : ""} · ${added} line${added === 1 ? "" : "s"} added, ${removedLines.length} removed`;
  const lines: { text: string; kind: "change" | "warning" | "hint" }[] = [
    ...(d.changes ?? []).map((c) => ({ text: `• ${c}`, kind: "change" as const })),
    ...d.warnings.map((w) => ({ text: `⚠ ${w}`, kind: "warning" as const })),
  ];
  if (!expanded) return { head, over, lines: [...lines, { text: "(expand to read the map)", kind: "hint" as const }], markdown: undefined, removed: [] as string[] };
  return { head, over, lines, markdown: d.map, removed: removedLines };
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
  /** Split of tokens for the head line: in = input + cache, out = completions. The rate uses out/ms. */
  tokensIn?: number;
  tokensOut?: number;
  /** the last lines it's writing (or thinking), while it runs */
  writing?: string[];
  /** its saved session, to open with `pi --session <file>` */
  session?: string;
}

const short = (t: string, n: number) => {
  const chars = Array.from(t);
  return chars.length > n ? `${chars.slice(0, n - 1).join("")}…` : t;
};
/** Live view budget: a wider window than the blur of one step, still bounded so fast runs can't flood the transcript. */
export const LIVE_STEPS = 8;
export const LIVE_WRITING_LINES = 4;
/** Minimum ms between live repaints: calmer screen, same data. Terminal states always flush immediately. */
export const LIVE_FLUSH_MS = 250;
const human = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`);
const secs = (ms: number) => `${Math.round(ms / 1000)}s`;
/** Blended throughput over the run's wall time (which includes the tools the explorer ran), not pure generation speed. */
export const outRate = (out: number, ms: number) => {
  const r = (out / ms) * 1000;
  return r < 1000 ? r.toFixed(1) : human(r);
};
const MAX_ANSWER_LINES = 200;
const MAX_FILES = 50;

/** The lines shown for an exploration: live steps while it runs, then one summary line (all of it when expanded). */
export function exploreLines(o: { details?: ExploreDetails; answer: string; partial: boolean; expanded: boolean; error?: boolean; now?: number }): { text: string; kind: "step" | "count" | "done" | "answer" | "file" | "error" | "writing" }[] {
  const d = o.details;
  if (o.error) return [{ text: o.answer.trim() || "exploration failed", kind: "error" }];
  if (o.partial) {
    if (!d) return [{ text: "starting…", kind: "count" }];
    return [
      ...d.steps.slice(-LIVE_STEPS).map((s) => ({ text: `↳ ${s}`, kind: "step" as const })),
      ...(d.writing ?? []).slice(-LIVE_WRITING_LINES).map((l) => ({ text: `│ ${l}`, kind: "writing" as const })),
      { text: `${d.count} step${d.count === 1 ? "" : "s"} · ${secs((o.now ?? Date.now()) - d.started)}`, kind: "count" as const },
    ];
  }
  const usage =
    d && (d.tokensIn !== undefined || d.tokensOut !== undefined)
      ? `${human(d.tokensIn ?? 0)} in · ${human(d.tokensOut ?? 0)} out${d.ms ? ` @ ${outRate(d.tokensOut ?? 0, d.ms)} tok/s` : ""}`
      : d?.tokens
        ? `${human(d.tokens)} tokens`
        : "";
  const head = d ? `explored in ${secs(d.ms ?? 0)} · ${d.files.length} file${d.files.length === 1 ? "" : "s"} read${usage ? ` · ${usage}` : ""}` : "explored";
  const first = o.answer.split("\n").find((l) => l.trim()) ?? "";
  if (!o.expanded) return [{ text: head, kind: "done" }, ...(first ? [{ text: short(first.trim(), 120), kind: "answer" as const }] : [])];
  const answerLines = o.answer.split("\n");
  const shownAnswer = answerLines.length > MAX_ANSWER_LINES ? [...answerLines.slice(0, MAX_ANSWER_LINES), `… (+${answerLines.length - MAX_ANSWER_LINES} more lines)`] : answerLines;
  const files = d?.files ?? [];
  const shownFiles = files.length > MAX_FILES ? files.slice(0, MAX_FILES) : files;
  return [
    { text: head, kind: "done" },
    ...shownAnswer.map((l) => ({ text: l, kind: "answer" as const })),
    ...(files.length ? [{ text: "files read:", kind: "file" as const }, ...shownFiles.map((f) => ({ text: `  ${f}`, kind: "file" as const }))] : []),
    ...(files.length > MAX_FILES ? [{ text: `  … (+${files.length - MAX_FILES} more)`, kind: "file" as const }] : []),
    ...(d?.session ? [{ text: `the whole run: pi --session ${d.session}`, kind: "file" as const }] : []),
  ];
}

type Theme = { fg(color: string, text: string): string; bold(text: string): string };

export function renderExploreCall(args: { question?: string }, theme: Theme) {
  return new Text(theme.fg("toolTitle", theme.bold("explore ")) + theme.fg("accent", args.question ?? ""), 0, 0);
}

export function renderExploreResult(result: { content: { type: string; text?: string }[]; details?: ExploreDetails }, opts: { expanded: boolean; isPartial: boolean }, theme: Theme, isError = false) {
  const answer = result.content.map((c) => c.text ?? "").join("");
  const color = { step: "dim", count: "muted", done: "success", answer: "text", file: "dim", error: "error", writing: "muted" } as const;
  const lines = exploreLines({ details: result.details, answer, partial: opts.isPartial, expanded: opts.expanded, error: isError });
  return new Text(lines.map((l) => theme.fg(color[l.kind], l.text)).join("\n"), 0, 0);
}
