/**
 * The markdown rules shared by specs and the project map: a heading inside a fenced
 * code block is never structure, and writers and readers use the same section matcher, so a
 * section the reader accepts can't become a second one to the writer.
 *
 * Also the one sanitizer for text pb stores in a markdown container: one builder for a line, one
 * for a block, both removing control characters before comment markers (a control character inside
 * `<!--` defeats a marker match, and stripping the marker first then reassembles a live one) and
 * repeating until stable, because one removal can splice the fragments of another marker together.
 */

const FENCE = /^(\s*)```/;

/** A line that opens or closes a fenced code block. */
export const isFence = (line: string): boolean => FENCE.test(line);

/** Control characters that must never reach a container: C0, C1, and the two line/paragraph separators. */
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g;

/** HTML comment markers: in a container they open or close a section pb (or another tool) reads. */
const MARKERS = /<!--|-->/g;

/** Control characters, then comment markers, until the text stops changing. */
const neutralise = (text: string, flatten: (s: string) => string): string => {
  let out = flatten(text);
  for (;;) {
    const next = flatten(out.replace(CONTROL, "").replace(MARKERS, ""));
    if (next === out) return next;
    out = next;
  }
};

/**
 * Untrusted text as one line: safe to store in a bullet, a table cell or a one-line ledger field.
 * Every whitespace run (tabs, newlines) becomes a single space; no control character or comment
 * marker survives; the words do.
 */
export const safeLine = (text: string): string => neutralise(text, (s) => s.replace(/\s+/g, " ")).trim();

/**
 * Untrusted text kept as a block: lines stay lines — the stripping runs per line so the breaks
 * survive — each tab becomes a single space so no line can turn into an indented code block, and no
 * other control character or comment marker survives.
 */
export const safeBlock = (text: string): string => text.split("\n").map((line) => neutralise(line, (s) => s.replace(/\t/g, " "))).join("\n");

/** Lines of markdown with fenced code blocks blanked for structure detection. */
export function blankFenced(md: string): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const line of md.split("\n")) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      out.push("");
      continue;
    }
    out.push(inFence ? "" : line);
  }
  return out;
}

/** Text before the first ## heading outside fences: the title and header lines live here. */
export function headerBlock(md: string): string {
  const lines = md.split("\n");
  const blanked = blankFenced(md);
  const idx = blanked.findIndex((l) => /^##\s/.test(l));
  return (idx < 0 ? lines : lines.slice(0, idx)).join("\n");
}

export const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * "## <name>", case-insensitive, with an optional trailing colon (planners write both).
 * The single heading matcher for every section reader and writer.
 */
export const sectionHeading = (name: string) => new RegExp(`^##\\s+${escapeRegExp(name)}\\s*:?\\s*$`, "im");

/** A section's body, trimmed ("" when missing). Fence-aware; name is literal. */
export function sectionOf(md: string, name: string): string {
  const lines = md.split("\n");
  const blanked = blankFenced(md);
  const idx = blanked.findIndex((l) => sectionHeading(name).test(l));
  if (idx < 0) return "";
  const rel = blanked.slice(idx + 1).findIndex((l) => /^##\s+(?!#)/.test(l));
  const end = rel < 0 ? lines.length : idx + 1 + rel;
  return lines.slice(idx + 1, end).join("\n").trim();
}

/**
 * Replace (or append to) one "## <section>"; a missing section is added before Tasks, or
 * at the end. Lets a checkpoint change only what moved instead of rewriting the whole spec.
 */
export function setSection(md: string, section: string, body: string, mode: "replace" | "append" = "replace"): string {
  const name = section.replace(/^#+\s*/, "").trim();
  const lines = md.split("\n");
  const blanked = blankFenced(md);
  const idx = blanked.findIndex((l) => sectionHeading(name).test(l));
  const text = body.trim();
  if (idx < 0) {
    const tasksIdx = blanked.findIndex((l) => sectionHeading("Tasks").test(l));
    const block = `## ${name}\n${text}\n\n`;
    if (tasksIdx < 0 || name.toLowerCase() === "tasks") return `${md.trimEnd()}\n\n${block.trimEnd()}\n`;
    const at = lines.slice(0, tasksIdx).join("\n").length + (tasksIdx > 0 ? 1 : 0);
    const head = md.slice(0, at).replace(/\s*$/, "\n\n");
    return `${head}${block}${md.slice(at).replace(/^\s*/, "")}`;
  }
  const startLine = idx + 1;
  const rel = blanked.slice(startLine).findIndex((l) => /^##\s+(?!#)/.test(l));
  const endLine = rel < 0 ? lines.length : startLine + rel;
  const start = lines.slice(0, startLine).join("\n").length + (startLine > 0 ? 1 : 0);
  const end = lines.slice(0, endLine).join("\n").length + (endLine < lines.length ? 1 : 0);
  const current = md.slice(start, end).trim();
  const merged = mode === "append" && current ? `${current}\n${text}` : text;
  return `${md.slice(0, start).replace(/\s*$/, "")}\n${merged}\n${end < md.length ? `\n${md.slice(end).replace(/^\s*/, "")}` : ""}`;
}

/** Lines outside fenced code blocks, where example bullets are not real content. */
export function unfenced(text: string): string[] {
  const lines = text.split("\n");
  const structure = blankFenced(text);
  return lines.filter((_, i) => structure[i].trim() !== "");
}
