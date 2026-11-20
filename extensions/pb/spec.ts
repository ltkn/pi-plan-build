/**
 * The spec: one self-contained markdown document per feature, the single source of
 * truth for its build. The planning agent writes it through pb_write_spec; the
 * harness only needs a few things back from it, so the format is fixed but small:
 *
 *   # <title>
 *   Status: planning | ready                 (optional; ready by default)
 *   Depends on: <spec name> | none
 *   Also changes: ../<repo>, … | none        (optional)
 *   Verification: tests | build | none — <why, unless tests>
 *   New tests: yes | no — <why, if no>
 *
 * Every header line is `Key: value`, optionally followed by a note after a dash or in parentheses
 * (`headerValue`); the note is a reason where the line needs one, and never part of the value.
 *
 *   ## Goal · ## Findings · ## Decisions · ## Open questions · ## Tasks
 *   (optional: Out of scope, Contracts, Migration and rollback, Threats and abuse;
 *    Findings recommended; Open questions only while planning)
 *
 * A planning spec is the checkpoint of an unfinished discussion: it needs no Verification line and
 * no Tasks yet. A ready spec is what the build runs.
 *   ### T1: <title>
 *   <detail>
 *   - Acceptance: <checkable>
 *   - Test: `<targeted test command>`        (optional)
 */
import { createHash } from "node:crypto";
import { blankFenced, escapeRegExp, headerBlock, removeSection, sectionHeading, sectionOf, setSection, unfenced } from "./markdown.ts";
import { KEBAB_NAME } from "./names.ts";
import { SIBLING_REPO } from "./repos.ts";
import type { AcceptanceCriterion, Gate } from "./store.ts";

export { removeSection, sectionHeading, sectionOf, setSection };

export interface SpecTask {
  id: string;
  title: string;
  /** the whole task section, as written: what the build agent gets for this task */
  text: string;
  test?: string;
}

export interface ParsedSpec {
  title: string;
  status: "planning" | "ready";
  dependsOn?: string;
  /** sibling repositories the change also edits (`Also changes: ../tempo-ui`): undo, review and commit cover them */
  repos: string[];
  gate: Gate;
  gateReason?: string;
  newTests: boolean;
  newTestsReason?: string;
  tasks: SpecTask[];
}

/** The rest is optional: specs stay as short as the change allows. Tasks are required once the spec is ready. */
export const REQUIRED_SECTIONS = ["Goal", "Decisions"];

/** The spec's header lines, in the order they are written; Title is the `# <title>` line. */
export const HEADER_FIELDS = ["Title", "Status", "Depends on", "Also changes", "Verification", "New tests"] as const;
export type HeaderField = (typeof HEADER_FIELDS)[number];

/**
 * What a spec gets wrong, and where: `field` names the header line it is about, absent for anything in the
 * sections. A refusal's advice is built from it, so every error says which tool call fixes it.
 */
export interface SpecError {
  message: string;
  field?: HeaderField;
}

const TITLE_LINE = /^\s{0,3}#\s+(.+)$/m;
const fieldLine = (label: string) => new RegExp(`^\\s{0,3}${escapeRegExp(label)}:[ \\t]*(.*)$`, "im");
const header = (md: string, label: string) => headerBlock(md).match(fieldLine(label))?.[1].trim() || undefined;

/**
 * A header line's value and its note: the note follows an em or en dash, a spaced hyphen, or sits in parentheses.
 * One rule for every header line, so a writer never has to know which lines take a note.
 */
export function headerValue(raw: string): { value: string; note?: string } {
  const m = /^(.*?)(?:\s*[—–]|\s+-\s|\s*\()\s*(.*)$/s.exec(raw);
  if (!m) return { value: raw.trim() };
  const inParentheses = raw.slice(m[1].length).trimStart().startsWith("(");
  const note = (inParentheses ? m[2].replace(/\)\s*$/, "") : m[2]).trim();
  return { value: m[1].trim(), note: note || undefined };
}

/** Whether the text declares itself a draft (`Status: planning`); anything else is meant to be built. */
export const isDraftSpec = (md: string) => headerValue(header(md, "Status") ?? "").value.toLowerCase() === "planning";

/** Parse a spec; `errors` lists what's missing or malformed, each with where it is (empty = valid). */
export function parseSpec(md: string): { spec?: ParsedSpec; errors: SpecError[] } {
  const errors: SpecError[] = [];
  const fail = (message: string, field?: HeaderField) => errors.push(field ? { message, field } : { message });
  const blanked = blankFenced(md);
  const title = headerBlock(md).match(TITLE_LINE)?.[1].trim();
  if (!title) fail('missing the "# <title>" line', "Title");

  const statusLine = header(md, "Status");
  const statusValue = statusLine ? headerValue(statusLine).value.toLowerCase() : undefined;
  if (statusValue !== undefined && statusValue !== "planning" && statusValue !== "ready") fail(`"Status: ${statusLine}" must be planning or ready`, "Status");
  const status = statusValue === "planning" ? "planning" : "ready";

  const verification = header(md, "Verification");
  let gate: Gate = "tests";
  let gateReason: string | undefined;
  if (!verification) {
    if (status === "ready") fail('missing "Verification: tests | build | none"', "Verification");
  } else {
    const v = headerValue(verification);
    const value = v.value.toLowerCase();
    if (value === "tests" || value === "build" || value === "none") [gate, gateReason] = [value, v.note];
    else fail(`"Verification: ${verification}" must be tests, build or none`, "Verification");
    if (gate !== "tests" && !gateReason) fail(`"Verification: ${gate}" needs a reason ("Verification: ${gate} — why")`, "Verification");
  }

  const nt = header(md, "New tests");
  let newTests = true;
  let newTestsReason: string | undefined;
  if (nt) {
    const v = headerValue(nt);
    const value = v.value.toLowerCase();
    if (value !== "yes" && value !== "no") fail(`"New tests: ${nt}" must be yes or no`, "New tests");
    newTests = value !== "no";
    newTestsReason = v.note;
    if (!newTests && !newTestsReason) fail('"New tests: no" needs a reason ("New tests: no — why")', "New tests");
  }

  // A spec name is one kebab-case token: every consumer turns it into the spec directory.
  const dep = header(md, "Depends on");
  const depName = dep ? headerValue(dep).value : undefined;
  if (dep && depName !== "none" && !KEBAB_NAME.test(depName ?? ""))
    fail(`"Depends on: ${dep}" must name a spec (short kebab-case, e.g. order-cancellation) or none; a note may follow after a dash or in parentheses`, "Depends on");
  const dependsOn = depName && depName !== "none" ? depName : undefined;

  // Sibling repositories the change also edits: `../<name>` each, comma- or space-separated, or none.
  const also = header(md, "Also changes");
  const alsoValue = also ? headerValue(also).value : "";
  const repos = alsoValue && !/^none$/i.test(alsoValue) ? [...new Set(alsoValue.split(/[,\s]+/).filter(Boolean))] : [];
  const notRepos = repos.filter((r) => !SIBLING_REPO.test(r));
  if (notRepos.length)
    fail(
      `"Also changes: ${also}" must name sibling repositories as ../<name> (one folder beside the project), or none: ${notRepos.map((r) => `"${r}"`).join(", ")} ${notRepos.length === 1 ? "is" : "are"} not; a note goes after a dash or in parentheses`,
      "Also changes",
    );

  for (const s of REQUIRED_SECTIONS) {
    const found = blanked.filter((l) => sectionHeading(s).test(l));
    if (!found.length) fail(`missing the "## ${s}" section`);
    else if (found.length > 1) fail(`duplicate "## ${s}" section: keep one`);
  }
  if (status === "ready" && sectionOf(md, "Open questions").trim())
    fail('Status: ready can\'t have "## Open questions": settle each into Decisions, tag the claim \`assumed: <what would falsify it>\`, or ask with pb_ask; if nothing is open, remove the section (pb_update_spec, mode remove)');

  // Tasks: fence-aware, line-based. ## Tasks allows a trailing colon; ### T1 is case-insensitive
  // and normalized to T1; a ### line that looks like a task but doesn't parse is an error, not silence.
  const lines = md.split("\n");
  const tasksIdx = blanked.findIndex((l) => sectionHeading("Tasks").test(l));
  const tasksEndRel = tasksIdx < 0 ? -1 : blanked.slice(tasksIdx + 1).findIndex((l) => /^##\s+(?!#)/.test(l));
  const tasksEnd = tasksIdx < 0 ? -1 : tasksEndRel < 0 ? lines.length : tasksIdx + 1 + tasksEndRel;
  const tasksLines = tasksIdx < 0 ? [] : lines.slice(tasksIdx + 1, tasksEnd);
  const tasksBlanked = tasksIdx < 0 ? [] : blanked.slice(tasksIdx + 1, tasksEnd);
  const headAt: number[] = [];
  tasksBlanked.forEach((l, i) => {
    if (/^###\s/.test(l)) {
      const m = l.match(/^###\s+[Tt](\d+)\s*[:.—–-]?\s*(.*)$/);
      if (m) headAt.push(i);
      else fail(`"${l.trim()}" didn't parse as a task: write each as "### T1: <title>" under "## Tasks"`);
    }
  });
  const ready = status === "ready";
  if (ready && tasksIdx < 0) fail('no tasks: write each as "### T1: <title>" under "## Tasks"');
  else if (ready && !headAt.length && !errors.some((e) => e.message.includes("didn't parse as a task"))) fail('no tasks: write each as "### T1: <title>" under "## Tasks"');
  const tasks: SpecTask[] = headAt.map((lineIdx, k) => {
    const next = headAt[k + 1] ?? tasksLines.length;
    const text = tasksLines.slice(lineIdx, next).join("\n").trim();
    const idLine = tasksBlanked[lineIdx].match(/^###\s+[Tt](\d+)\s*[:.—–-]?\s*(.*)$/)!;
    const id = `T${idLine[1]}`;
    const title = (idLine[2] ?? "").trim() || id;
    const hasTestLine = /^\s*[-*]\s*Test:/im.test(text);
    const test = text.match(/^\s*[-*]\s*Test:\s*`([^`]+)`/m)?.[1].trim();
    if (hasTestLine && !test) fail(`${id} has a Test: line without \`command\`: write it as "- Test: \`<command>\`"`);
    if (ready && !/^\s*[-*]\s*Acceptance(\s*\([^)]*\))?:/im.test(text)) fail(`${id} has no "- Acceptance:" line`);
    return { id, title, text, test };
  });
  const ids = tasks.map((t) => t.id);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dup.length) fail(`duplicate task ids: ${[...new Set(dup)].join(", ")}`);

  return errors.length ? { errors } : { spec: { title: title!, status, dependsOn, repos, gate, gateReason, newTests, newTestsReason, tasks }, errors };
}

/** A section that does not apply: "none — why", "N/A", and nothing checkable. */
const noCriteria = (text: string) => /^(?:none|n\/a|not applicable)\s*(?:[—–:.,;-]|$)/i.test(text);

/**
 * The review's acceptance checklist, derived from the spec's current text without changing its format:
 * each task's "- Acceptance:" line becomes T1.1, T1.2, ... in reading order. A task is the build's unit
 * and its Test: command is the proof, so tasks are the only acceptance form.
 */
export function acceptanceCriteria(md: string, parsed?: ParsedSpec): AcceptanceCriterion[] {
  const spec = parsed ?? parseSpec(md).spec;
  const out: AcceptanceCriterion[] = [];
  for (const task of spec?.tasks ?? []) {
    let taskLine = 0;
    for (const line of unfenced(task.text)) {
      const m = /^\s*[-*]\s*Acceptance(\s*\([^)]*\))?:\s*(.+)$/i.exec(line);
      if (!m) continue;
      const text = m[2].trim();
      if (!text || noCriteria(text)) continue;
      out.push({ id: `${task.id}.${++taskLine}`, text, task: task.id });
    }
  }
  return out;
}

/** Set the "Status:" header line. */
export const setStatus = (md: string, status: "planning" | "ready") => setHeaderField(md, "Status", status);

/**
 * Set one header line, or remove it (`null`), touching only the header block so an example in a section is never
 * changed. An absent line is added after the header lines that come before it in `HEADER_FIELDS`. The value must
 * be one line: the caller checks that, since a line break would write a heading of its own.
 */
export function setHeaderField(md: string, field: HeaderField, value: string | null): string {
  const block = headerBlock(md);
  const pattern = field === "Title" ? TITLE_LINE : fieldLine(field);
  const line = field === "Title" ? `# ${value}` : `${field}: ${value}`;
  const found = pattern.exec(block);
  if (found) {
    const end = found.index + found[0].length;
    if (value !== null) return md.slice(0, found.index) + line + md.slice(end);
    return md.slice(0, found.index) + md.slice(md[end] === "\n" ? end + 1 : end);
  }
  if (value === null) return md;
  const before = HEADER_FIELDS.slice(0, HEADER_FIELDS.indexOf(field))
    .map((f) => (f === "Title" ? TITLE_LINE : fieldLine(f)).exec(block))
    .filter((m): m is RegExpExecArray => !!m);
  if (!before.length) return `${line}\n${md}`;
  const at = Math.max(...before.map((m) => m.index + m[0].length));
  return `${md.slice(0, at)}\n${line}${md.slice(at)}`;
}

/** Rough token count (4 characters a token): enough to tell a spec's size. */
export const tokensOf = (text: string) => Math.round(text.length / 4);

/** Add a decision under "## Decisions" (created if missing), so it survives compaction and reaches the reviewer. */
export function addDecision(md: string, decision: string): string {
  const line = `- ${decision.trim().replace(/\n+/g, " ")}`;
  const m = md.match(sectionHeading("Decisions"));
  if (!m || m.index === undefined) return `${md.trimEnd()}\n\n## Decisions\n\n${line}\n`;
  const start = m.index + m[0].length;
  const next = md.slice(start).search(/^##\s+/m);
  const end = next < 0 ? md.length : start + next;
  return `${md.slice(0, end).trimEnd()}\n${line}\n\n${md.slice(end).trimStart()}`;
}

/**
 * Every assumption the spec states, in order: each line carrying the `assumed:` tag (the one notation the
 * writer is taught), plus the Decisions lines that start "Assumption" (the form specs used
 * before the tag, kept readable). The build's own entries ("Assumption (build, T1): …") are left out: the
 * build lists those itself. Fenced code is not prose and is skipped.
 */
export function specAssumptions(md: string): string[] {
  const lines = blankFenced(md);
  const decisions = new Set(sectionOf(md, "Decisions").split("\n").map((l) => l.trim()));
  const found = lines.flatMap((line) => {
    const text = line.trim().replace(/^[-*]\s+/, "");
    if (/(^|[\s(`])assumed:/i.test(line)) return [text];
    if (/^-\s*Assumption(?! \(build)/.test(line.trim()) && decisions.has(line.trim())) return [text];
    return [];
  });
  return [...new Set(found)];
}

/** A commit message for the feature, from its spec: the title as subject, the goal, and what the tasks did. */
export function commitMessage(md: string): string | undefined {
  const spec = parseSpec(md).spec;
  if (!spec) return undefined;
  const goal = sectionOf(md, "Goal");
  return [spec.title, ...(goal ? ["", goal] : []), ...(spec.tasks.length ? ["", ...spec.tasks.map((t) => `- ${t.title}`)] : [])].join("\n");
}

/**
 * Why a task's new tests don't need to be seen failing, or undefined when they do: no `Test:` command to
 * run, a refactor that keeps behaviour, a spec that asks for no new tests, or a gate that runs no tests.
 * The single definition behind needsRed, and what the reviewer is told for each unproven task.
 */
export function redExemption(spec: ParsedSpec, task: SpecTask | undefined): string | undefined {
  if (!task) return undefined;
  if (!task.test) return "no Test: command, so nothing proves its new tests fail without the change";
  if (/^\(refactor\)/i.test(task.title)) return "a refactor keeps behaviour, so there is nothing new to see failing";
  if (!spec.newTests) return `the spec asks for no new tests${spec.newTestsReason ? ` (${spec.newTestsReason})` : ""}`;
  if (spec.gate !== "tests") return `verification is "${spec.gate}", so no test runs`;
  return undefined;
}

/** A task whose new tests must be seen failing before the change: one with no exemption above. */
export const needsRed = (spec: ParsedSpec, task: SpecTask | undefined) => !!task && !redExemption(spec, task);

/**
 * The done task before `task` whose run proved the same Test: command, if any: once that change is in
 * place the command cannot fail again, so the exemption is derived from the task list, never stored.
 */
export function earlierProof<T extends { id: string; status: string; redCommand?: string }>(spec: ParsedSpec, tasks: readonly T[], task: SpecTask | undefined): T | undefined {
  if (!task?.test) return undefined;
  const at = spec.tasks.findIndex((t) => t.id === task.id);
  if (at < 0) return undefined;
  return spec.tasks
    .slice(0, at)
    .filter((t) => t.test === task.test)
    .map((t) => tasks.find((x) => x.id === t.id))
    .find((x) => x?.status === "done" && x.redCommand !== undefined);
}

/**
 * The `Test:` commands carried by more than one task that needs red, with their task ids in spec order.
 * One run then shows only that something is missing among them, not each task's own new tests.
 */
export function sharedTestCommands(spec: ParsedSpec): Array<{ command: string; ids: string[] }> {
  const byCommand = new Map<string, string[]>();
  for (const t of spec.tasks) if (needsRed(spec, t) && t.test) byCommand.set(t.test, [...(byCommand.get(t.test) ?? []), t.id]);
  return [...byCommand].filter(([, ids]) => ids.length > 1).map(([command, ids]) => ({ command, ids }));
}

/** A step of the build by id: a spec task. */
export const buildTask = (spec: ParsedSpec, id: string | undefined) => spec.tasks.find((t) => t.id === id);

/** A task acceptance line, including qualified variants such as `Acceptance (abuse):`. */
const ACCEPTANCE_LINE = /^\s*[-*]\s*Acceptance(\s*\([^)]*\))?:/i;
/** True for a task acceptance line; the task's `Test:` command is the proof, with no per-line marker. */
export const isAcceptanceLine = (line: string): boolean => ACCEPTANCE_LINE.test(line);

/**
 * What a rewrite took away from the previous text: whole sections, Acceptance lines and Decisions
 * entries no longer there word for word. A rewrite regenerates the whole spec, so content a review
 * lap added can vanish without anyone saying so; this is the fact, not the writer's account of it.
 */
export function specLosses(before: string, after: string): string[] {
  const norm = (line: string) => line.replace(/^\s*[-*]\s*/, "").replace(/\s+/g, " ").trim();
  const headings = (md: string) => blankFenced(md).flatMap((l) => l.match(/^##\s+(?!#)(.+?)\s*:?\s*$/)?.[1] ?? []);
  const gone = (lines: string[], kept: string[]) => {
    const keep = new Set(kept.map(norm));
    return [...new Set(lines.map(norm))].filter((l) => l && !keep.has(l));
  };
  const quote = (lines: string[]) => {
    const shown = lines.slice(0, 3).map((l) => `"${l.length > 80 ? `${l.slice(0, 77)}...` : l}"`);
    return `${shown.join(", ")}${lines.length > 3 ? ` and ${lines.length - 3} more` : ""}`;
  };
  const kept = new Set(headings(after).map((h) => h.toLowerCase()));
  const sections = headings(before).filter((h) => !kept.has(h.toLowerCase()));
  const acceptance = (md: string) => blankFenced(md).filter(isAcceptanceLine);
  const decisions = (md: string) => sectionOf(md, "Decisions").split("\n").filter((l) => /^\s*[-*]\s/.test(l));
  const lostAcceptance = gone(acceptance(before), acceptance(after));
  const lostDecisions = gone(decisions(before), decisions(after));
  return [
    ...sections.map((h) => `the "## ${h}" section`),
    ...(lostAcceptance.length ? [`${lostAcceptance.length} Acceptance line${lostAcceptance.length === 1 ? "" : "s"} (${quote(lostAcceptance)})`] : []),
    ...(lostDecisions.length ? [`${lostDecisions.length} Decisions entr${lostDecisions.length === 1 ? "y" : "ies"} (${quote(lostDecisions)})`] : []),
  ];
}

/* -------------------------------- citation grammar -------------------------------- */

/**
 * A spec's shape is decided by its parser: required sections, unique task ids and resolvable
 * citations. Semantic questions — whether evidence is real, a reason is sound, a threat is
 * covered, a contract or migration is complete — belong to the reviewer and the human.
 */

/**
 * Root files a spec may cite by name without an extension (README:12). Part of the citation grammar
 * below: `specPathErrors` resolves the refs it finds against the project.
 */
export const ROOT_FILE_REF = /^(?:Makefile|Dockerfile|LICENSE|README|CHANGELOG|CONTRIBUTING|Gemfile|Rakefile|Procfile|go\.mod|go\.sum|package\.json|tsconfig\.json|pom\.xml|build\.gradle(?:\.kts)?)$/i;

/**
 * `path:line` references in a spec, outside fences. A path may be backticked or
 * bare; a line range (`:40-80`) names its first line, and a list (`:47-57,65`) names
 * each item's first line. A bare path never starts inside a name (after a letter, a
 * hyphen, a dot or a slash), so `build-start.ts` is never read as `start.ts`. New files
 * without a line are allowed: only a line claim must point at a real file and line.
 */
export const specPathRefs = (md: string): Array<{ path: string; line: number; text: string }> => {
  const refs = new Map<string, { path: string; line: number; text: string }>();
  const re = /`([^`\s]+):(\d+(?:-\d+)?(?:,\s?\d+(?:-\d+)?)*)`|(?<![\w/.`-])([A-Za-z0-9_./-]+):(\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)/g;
  let inFence = false;
  for (const raw of md.split("\n")) {
    if (/^(\s*)```/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    for (const m of raw.matchAll(re)) {
      const p = (m[1] ?? m[3]).replace(/^\.\//, "").replace(/[/.,;:]+$/, "");
      const lines = (m[2] ?? m[4]).split(",").map((item) => Number(item.trim().split("-")[0]));
      if (!p) continue;
      const before = raw.slice(Math.max(0, (m.index ?? 0) - 12), m.index ?? 0);
      if (before.includes("://") || p.startsWith("/") || p.startsWith("~") || p.includes("://") || p.includes("...")) continue;
      if (/[<>{}*$@=,;()[\]\s]/.test(p)) continue;
      if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(p) || /^v?\d+(?:\.\d+){1,3}$/i.test(p)) continue;
      if (!p.includes("/") && !/\.[A-Za-z0-9]{1,12}$/.test(p) && !ROOT_FILE_REF.test(p)) continue;
      for (const line of lines) {
        if (!Number.isFinite(line) || line < 1) continue;
        const key = `${p}:${line}`;
        if (!refs.has(key)) refs.set(key, { path: p, line, text: raw.trim() });
      }
    }
  }
  return [...refs.values()];
};

/** The sections that bind a step, in the order a handout shows them. */
export const BINDING_SECTIONS: readonly string[] = ["Goal", "Out of scope", "Decisions", "Design", "Contracts", "Migration and rollback", "Threats and abuse", "Threats"];

/** A spec's distinct text blocks: its header and each `##` section, keyed by heading. */
export interface SpecTextBlock {
  key: string;
  text: string;
}

const blockName = (heading: string) => heading.trim().toLowerCase().replace(/\s+/g, " ").replace(/:$/, "");

export const specTextBlocks = (md: string): SpecTextBlock[] => {
  const lines = md.split("\n");
  const blanked = blankFenced(md);
  const blocks: SpecTextBlock[] = [];
  const firstHeading = blanked.findIndex((l) => /^##\s+(?!#)/.test(l));
  const headerText = lines.slice(0, firstHeading < 0 ? lines.length : firstHeading).join("\n").trim();
  if (headerText) blocks.push({ key: "header", text: headerText });
  const headings: number[] = [];
  blanked.forEach((line, i) => {
    if (/^##\s+(?!#)/.test(line)) headings.push(i);
  });
  for (const [k, at] of headings.entries()) {
    const end = headings[k + 1] ?? lines.length;
    const heading = blanked[at].replace(/^##\s+/, "").replace(/\s*:?\s*$/, "").trim();
    blocks.push({ key: `section:${blockName(heading)}`, text: lines.slice(at, end).join("\n").trim() });
  }
  return blocks;
};

/** The key a "## <section>" block is filed under in specTextBlocks. */
export const sectionKey = (section: string) => `section:${blockName(section.replace(/^#+\s*/, "").replace(/\s*:?\s*$/, ""))}`;

/**
 * The `##` section a 1-based line of the spec sits in, keyed as specTextBlocks keys it: what a review finding filed
 * against the spec points at. Undefined for the header, a line inside no section, or a line the text doesn't have.
 */
export const sectionKeyAtLine = (md: string, line: number): string | undefined => {
  const blanked = blankFenced(md);
  if (!Number.isInteger(line) || line < 1 || line > blanked.length) return undefined;
  for (let i = line - 1; i >= 0; i--) if (/^##\s+(?!#)/.test(blanked[i])) return sectionKey(blanked[i]);
  return undefined;
};

/** How a block is named to a reader: its own heading line as written, or "the header". */
export const blockLabel = (block: SpecTextBlock) => (block.key === "header" ? "the header" : block.text.split("\n")[0].trim());

/** Each block of a spec and its fingerprint: what a session has seen of it, block by block. */
export const blockFingerprints = (md: string): Record<string, string> =>
  Object.fromEntries(specTextBlocks(md).map((b) => [b.key, createHash("sha256").update(b.text).digest("hex")]));

/** The blocks of `md` that differ from `seen` (changed, added, or gone from `md` are all "changed"), in spec order. */
export const unseenBlocks = (md: string, seen: Record<string, string>): SpecTextBlock[] => {
  const now = blockFingerprints(md);
  const blocks = specTextBlocks(md).filter((b) => seen[b.key] !== now[b.key]);
  const gone = Object.keys(seen).filter((k) => !(k in now)).map((k) => ({ key: k, text: `## ${k.replace(/^section:/, "")}\n(removed)` }));
  return [...blocks, ...gone];
};

/** The non-blank lines of `before` that `after` no longer has, each occurrence counted once, in `before`'s order. */
export function removedLines(before: string, after: string): string[] {
  const left = new Map<string, number>();
  for (const l of after.split("\n").map((x) => x.trim()).filter(Boolean)) left.set(l, (left.get(l) ?? 0) + 1);
  const out: string[] = [];
  for (const l of before.split("\n").map((x) => x.trim()).filter(Boolean)) {
    const n = left.get(l) ?? 0;
    if (n > 0) left.set(l, n - 1);
    else out.push(l);
  }
  return out;
}

/**
 * What re-approving a revised contract accepts, as changed lines: per contract block, the lines it lost and then the
 * lines it gained, whole (a cut could hide the change itself); then any approved decision that is gone. Posted to the
 * chat, where it scrolls and stays; the dialog only asks.
 */
export const contractChanges = (approved: string | undefined, md: string, droppedDecisions: string[]): { diff: string; summary: string; keys: string[] } => {
  const was = new Map(specTextBlocks(approved ?? "").map((b) => [b.key, b]));
  const contract = (key: string) => key !== "section:design" && key !== "section:decisions";
  const now = specTextBlocks(md).filter((b) => contract(b.key));
  const keys = [...new Set([...[...was.keys()].filter(contract), ...now.map((b) => b.key)])];
  const parts: string[] = [];
  const summary: string[] = [];
  const changed: string[] = [];
  const count = (removed: number, added: number) => [removed ? `−${removed}` : "", added ? `+${added}` : ""].filter(Boolean).join(" ");
  for (const key of keys) {
    const before = was.get(key)?.text ?? "";
    const after = now.find((b) => b.key === key)?.text ?? "";
    if (before === after) continue;
    changed.push(key);
    const removed = removedLines(before, after);
    const added = removedLines(after, before);
    const label = blockLabel(was.get(key) ?? now.find((b) => b.key === key)!);
    summary.push(`${label} (${count(removed.length, added.length) || "reordered"})`);
    parts.push(`**${label}** (${count(removed.length, added.length) || "lines reordered"})\n\`\`\`diff\n${[...removed.map((l) => `- ${l}`), ...added.map((l) => `+ ${l}`)].join("\n")}\n\`\`\``);
  }
  if (droppedDecisions.length) {
    changed.push("section:decisions");
    summary.push(`## Decisions (${count(droppedDecisions.length, 0)})`);
    parts.push(`## Decisions — approved lines removed\n\`\`\`diff\n${droppedDecisions.map((l) => `- ${l}`).join("\n")}\n\`\`\``);
  }
  return { diff: parts.join("\n\n"), summary: summary.join(", "), keys: changed };
};

/** A review answers for the exact markdown it saw: a pass stops covering the spec the moment the text changes. */
export const specHash = (markdown: string) => createHash("sha256").update(markdown).digest("hex");

/**
 * A spec's contract: every block that binds the build except Design and Decisions, the two
 * sections the build itself may change. A build is approved against this text; a change to it
 * outside the build pauses the build until the human re-approves the revised spec.
 */
export function contractText(markdown: string): string {
  return specTextBlocks(markdown)
    .filter((block) => block.key !== "section:design" && block.key !== "section:decisions")
    .map((block) => block.text)
    .join("\n\n")
    .trim();
}

/** The contract's fingerprint: what an approval binds, independent of the build's own Design and Decisions. */
export const contractHash = (markdown: string) => createHash("sha256").update(contractText(markdown)).digest("hex");
