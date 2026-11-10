/**
 * The spec: one self-contained markdown document per feature, the single source of
 * truth for its build. The planning agent writes it through pb_write_spec; the
 * harness only needs a few things back from it, so the format is fixed but small:
 *
 *   # <title>
 *   Status: planning | ready                 (optional; ready by default)
 *   Depends on: <spec name> | none (an optional note may follow a dash or sit in parentheses)
 *   Verification: tests | build | none — <why, unless tests>
 *   New tests: yes | no — <why, if no>
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
import { blankFenced, escapeRegExp, headerBlock, sectionHeading, sectionOf, setSection, unfenced } from "./markdown.ts";
import { KEBAB_NAME } from "./names.ts";
import type { AcceptanceCriterion, Gate } from "./store.ts";

export { sectionHeading, sectionOf, setSection };

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
  gate: Gate;
  gateReason?: string;
  newTests: boolean;
  newTestsReason?: string;
  tasks: SpecTask[];
}

/** The rest is optional: specs stay as short as the change allows. Tasks are required once the spec is ready. */
export const REQUIRED_SECTIONS = ["Goal", "Decisions"];

const header = (md: string, label: string) => headerBlock(md).match(new RegExp(`^\\s{0,3}${escapeRegExp(label)}:\\s*(.+)$`, "im"))?.[1].trim();
const splitReason = (v: string) => {
  const m = v.match(/^(.*?)\s*[—–]\s*(.+)$/) ?? v.match(/^(.*?)\s+-\s+(.+)$/);
  if (!m) return { value: v.trim().toLowerCase(), reason: undefined as string | undefined };
  return { value: m[1].trim().toLowerCase(), reason: m[2].trim() || undefined };
};

/** Parse a spec; `errors` lists what's missing or malformed (empty = valid). */
export function parseSpec(md: string): { spec?: ParsedSpec; errors: string[] } {
  const errors: string[] = [];
  const blanked = blankFenced(md);
  const title = headerBlock(md).match(/^\s{0,3}#\s+(.+)$/m)?.[1].trim();
  if (!title) errors.push('missing the "# <title>" line');

  const statusLine = header(md, "Status")?.toLowerCase();
  if (statusLine && statusLine !== "planning" && statusLine !== "ready") errors.push(`"Status: ${statusLine}" must be planning or ready`);
  const status = statusLine === "planning" ? "planning" : "ready";

  const verification = header(md, "Verification");
  let gate: Gate = "tests";
  let gateReason: string | undefined;
  if (!verification) {
    if (status === "ready") errors.push('missing "Verification: tests | build | none"');
  } else {
    const v = splitReason(verification);
    if (v.value === "tests" || v.value === "build" || v.value === "none") [gate, gateReason] = [v.value, v.reason];
    else errors.push(`"Verification: ${verification}" must be tests, build or none`);
    if (gate !== "tests" && !gateReason) errors.push(`"Verification: ${gate}" needs a reason ("Verification: ${gate} — why")`);
  }

  const nt = header(md, "New tests");
  let newTests = true;
  let newTestsReason: string | undefined;
  if (nt) {
    const v = splitReason(nt);
    if (v.value !== "yes" && v.value !== "no") errors.push(`"New tests: ${nt}" must be yes or no`);
    newTests = v.value !== "no";
    newTestsReason = v.reason;
    if (!newTests && !newTestsReason) errors.push('"New tests: no" needs a reason ("New tests: no — why")');
  }

  const dep = header(md, "Depends on");
  // A spec name is one kebab-case token; a note may follow it after a dash or in parentheses and is
  // never part of the name — every consumer turns this bare name into the spec directory.
  const depName = dep?.split(/\s+/, 1)[0];
  const depNote = dep && depName ? dep.slice(depName.length).trim() : "";
  if (depName && depName !== "none" && (!KEBAB_NAME.test(depName) || (depNote !== "" && !/^(?:[—–-]|\()/.test(depNote))))
    errors.push(`"Depends on: ${dep}" must name a spec (short kebab-case, e.g. order-cancellation) or none; a note may follow after a dash or in parentheses`);
  const dependsOn = depName && depName !== "none" ? depName : undefined;

  for (const s of REQUIRED_SECTIONS) {
    const found = blanked.filter((l) => sectionHeading(s).test(l));
    if (!found.length) errors.push(`missing the "## ${s}" section`);
    else if (found.length > 1) errors.push(`duplicate "## ${s}" section: keep one`);
  }
  if (status === "ready" && sectionOf(md, "Open questions").trim())
    errors.push('Status: ready can\'t have "## Open questions": settle each into Decisions, tag the claim \`assumed: <what would falsify it>\`, or ask with pb_ask');

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
      else errors.push(`"${l.trim()}" didn't parse as a task: write each as "### T1: <title>" under "## Tasks"`);
    }
  });
  const ready = status === "ready";
  if (ready && tasksIdx < 0) errors.push('no tasks: write each as "### T1: <title>" under "## Tasks"');
  else if (ready && !headAt.length && !errors.some((e) => e.includes("didn't parse as a task"))) errors.push('no tasks: write each as "### T1: <title>" under "## Tasks"');
  const tasks: SpecTask[] = headAt.map((lineIdx, k) => {
    const next = headAt[k + 1] ?? tasksLines.length;
    const text = tasksLines.slice(lineIdx, next).join("\n").trim();
    const idLine = tasksBlanked[lineIdx].match(/^###\s+[Tt](\d+)\s*[:.—–-]?\s*(.*)$/)!;
    const id = `T${idLine[1]}`;
    const title = (idLine[2] ?? "").trim() || id;
    const hasTestLine = /^\s*[-*]\s*Test:/im.test(text);
    const test = text.match(/^\s*[-*]\s*Test:\s*`([^`]+)`/m)?.[1].trim();
    if (hasTestLine && !test) errors.push(`${id} has a Test: line without \`command\`: write it as "- Test: \`<command>\`"`);
    if (ready && !/^\s*[-*]\s*Acceptance(\s*\([^)]*\))?:/im.test(text)) errors.push(`${id} has no "- Acceptance:" line`);
    return { id, title, text, test };
  });
  const ids = tasks.map((t) => t.id);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dup.length) errors.push(`duplicate task ids: ${[...new Set(dup)].join(", ")}`);

  return errors.length ? { errors } : { spec: { title: title!, status, dependsOn, gate, gateReason, newTests, newTestsReason, tasks }, errors };
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

/** Set the "Status:" header line (header block only, so examples in Findings are untouched). */
export function setStatus(md: string, status: "planning" | "ready"): string {
  const block = headerBlock(md);
  const m = block.match(/^\s{0,3}Status:.*$/im);
  if (m && m.index !== undefined) {
    const start = m.index;
    const end = start + m[0].length;
    // Only replace when the match is in the header block (it is, by construction).
    void end;
    return md.slice(0, start) + `Status: ${status}` + md.slice(start + m[0].length);
  }
  const title = block.match(/^\s{0,3}#\s+.+$/m);
  if (!title || title.index === undefined) return md;
  const at = title.index + title[0].length;
  return `${md.slice(0, at)}\nStatus: ${status}${md.slice(at)}`;
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
 * writer and a repair lap are taught), plus the Decisions lines that start "Assumption" (the form specs used
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
 * bare; a line range (`:40-80`) names its first line. New files without a line
 * are allowed: only a line claim must point at a real file and line.
 */
export const specPathRefs = (md: string): Array<{ path: string; line: number; text: string }> => {
  const refs = new Map<string, { path: string; line: number; text: string }>();
  const re = /`([^`\s]+):(\d+)(?:-\d+)?`|(?<![\w/`])([A-Za-z0-9_./-]+):(\d+)(?:-\d+)?/g;
  let inFence = false;
  for (const raw of md.split("\n")) {
    if (/^(\s*)```/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    for (const m of raw.matchAll(re)) {
      const p = (m[1] ?? m[3]).replace(/^\.\//, "").replace(/[/.,;:]+$/, "");
      const line = Number(m[2] ?? m[4]);
      if (!p || !Number.isFinite(line) || line < 1) continue;
      const before = raw.slice(Math.max(0, (m.index ?? 0) - 12), m.index ?? 0);
      if (before.includes("://") || p.startsWith("/") || p.startsWith("~") || p.includes("://") || p.includes("...")) continue;
      if (/[<>{}*$@=,;()[\]\s]/.test(p)) continue;
      if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(p) || /^v?\d+(?:\.\d+){1,3}$/i.test(p)) continue;
      if (!p.includes("/") && !/\.[A-Za-z0-9]{1,12}$/.test(p) && !ROOT_FILE_REF.test(p)) continue;
      const key = `${p}:${line}`;
      if (!refs.has(key)) refs.set(key, { path: p, line, text: raw.trim() });
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
