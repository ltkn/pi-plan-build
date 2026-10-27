/**
 * The markdown rules shared by specs and living requirement files: a heading inside a fenced
 * code block is never structure, and writers and readers use the same section matcher, so a
 * section the reader accepts can't become a second one to the writer.
 */

const FENCE = /^(\s*)```/;

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
