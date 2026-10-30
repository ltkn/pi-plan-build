/**
 * The spec: one self-contained markdown document per feature, the single source of
 * truth for its build. The planning agent writes it through pb_write_spec; the
 * harness only needs a few things back from it, so the format is fixed but small:
 *
 *   # <title>
 *   Status: planning | ready                 (optional; ready by default)
 *   Depends on: <spec name> | none (a trailing note in parens is ignored)
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
import { parseRequirementDeltas, requirementSurfaceText } from "./requirements.ts";
import type { AcceptanceCriterion, Finding, Gate } from "./store.ts";

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
  const dependsOn = dep && !/^none(\s*\(|$)/i.test(dep) ? dep : undefined;

  for (const s of REQUIRED_SECTIONS) {
    const found = blanked.filter((l) => sectionHeading(s).test(l));
    if (!found.length) errors.push(`missing the "## ${s}" section`);
    else if (found.length > 1) errors.push(`duplicate "## ${s}" section: keep one`);
  }
  if (status === "ready" && sectionOf(md, "Open questions").trim())
    errors.push('Status: ready can\'t have "## Open questions": settle each into Decisions ("Assumption: <claim> — settles by <how>, because <reason>") or ask with pb_ask');

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
 * The `Test:` commands carried by more than one task that needs red, with their task ids in spec order.
 * A later task's run then shows only that something is missing among them — or, once an earlier one is
 * done and proven, that its own tests are already satisfied (pre-green).
 */
export function sharedTestCommands(spec: ParsedSpec): Array<{ command: string; ids: string[] }> {
  const byCommand = new Map<string, string[]>();
  for (const t of spec.tasks) if (needsRed(spec, t) && t.test) byCommand.set(t.test, [...(byCommand.get(t.test) ?? []), t.id]);
  return [...byCommand].filter(([, ids]) => ids.length > 1).map(([command, ids]) => ({ command, ids }));
}

/**
 * The other tasks that need red and run the very same `Test:` command: one run then shows only that
 * something is missing among them, not each task's own tests. Grouped by command, so it survives a
 * spec being rewritten.
 */
export function redSharing(spec: ParsedSpec): Map<string, string> {
  return new Map(
    sharedTestCommands(spec).flatMap(({ ids }) => ids.map((id) => [id, ids.filter((other) => other !== id).join(", ")] as [string, string])),
  );
}

/** A step of the build by id: a spec task. */
export const buildTask = (spec: ParsedSpec, id: string | undefined) => spec.tasks.find((t) => t.id === id);

/** A task acceptance line, including qualified variants such as `Acceptance (abuse):`. */
const ACCEPTANCE_LINE = /^\s*[-*]\s*Acceptance(\s*\([^)]*\))?:/i;
/** True for a task acceptance line; the task's `Test:` command is the proof, with no per-line marker. */
export const isAcceptanceLine = (line: string): boolean => ACCEPTANCE_LINE.test(line);

/* ------------------- citation grammar and review-risk selection ------------------- */

/**
 * A spec's shape is decided by its parser: required sections, unique task ids, resolvable
 * citations and requirement deltas. Semantic questions — whether evidence is real, a reason is
 * sound, a threat is covered, a contract or migration is complete — belong to the reviewer and
 * the human. The heuristics below only choose when a spec gets that review.
 */

const hasSection = (md: string, name: string): boolean => {
  const blanked = blankFenced(md);
  return blanked.some((l) => sectionHeading(name).test(l));
};

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

/**
 * High-signal product keywords that make a spec worth an independent review.
 * Deliberately narrower than the reviewer's own heuristic: generic words
 * (status, limit, address, email, job, role) stay reviewer-level. Scanned
 * across the spec's substantive sections, because a trust boundary is just as
 * real when it is first named in Findings or Decisions.
 */
const SENSITIVE_WRITE = /\b(auth\w*|login|logout|sign-?in|password|passwd|credential|secret|api[_-]?key|token|jwt|oauth|saml|sso|permission|privilege|admin|payment|billing|invoice|refund|webhook|upload|download|session|cookie|csrf|cors|endpoint|route|tenant|ownership|quota|replay|balance|credit|debit)\b/i;

/**
 * Language-agnostic words for a surface other code, clients or stored data can
 * observe: an API, event, schema, config, public signature, file format.
 */
const EXTERNAL_SURFACE =
  /\b(?:api|endpoint|route|http|https|rest|graphql|grpc|rpc|webhook|event|message|queue|topic|schema|migration|database|table|column|constraint|json|dto|payload|config|configuration|environment|cli|file\s+format|serializ\w*|deserializ\w*|contract|client|consumer|producer)\b|\bpublic\s+(?:api|interface|signature|contract)\b/i;

/**
 * Words for data that outlives one run: a database, a schema, a stored format, a backfill. A hit
 * makes the spec review ask for a migration/rollback answer (or an explicit "none — why").
 */
const PERSISTED_DATA =
  /\b(?:database|db|schema|migration|persist\w*|storage|stored?\s+(?:data|state|record|file)|file\s+format|serializ\w*|deserializ\w*|backfill|table|column)\b/i;

/** The sections whose prose describes the change, never the headings themselves. */
const SURFACE_SECTIONS = ["Goal", "Findings", "Context", "Decisions", "Contracts"] as const;

const surfaceText = (md: string, spec: ParsedSpec): string =>
  [...SURFACE_SECTIONS.map((name) => sectionOf(md, name)), ...spec.tasks.map((t) => t.text), requirementSurfaceText(md)].filter(Boolean).join("\n");

/** A section body that says why it does not apply: "none — no external surface". */
const negativeWithReason = (body: string): boolean => {
  const text = body.trim();
  const first = text.split("\n")[0].trim();
  if (!/^(?:none|n\/a|not applicable|nothing)\b/i.test(first)) return false;
  return /(?:—|–|\bbecause\b|\bsince\b|:)\s*\S/i.test(text);
};

const threatSection = (md: string): string | undefined =>
  hasSection(md, "Threats and abuse") ? "Threats and abuse" : hasSection(md, "Threats") ? "Threats" : undefined;

/**
 * Whether a spec changes behaviour it must test: a task with a Test: command, or a non-refactor
 * task with acceptance lines. The living-requirement check and the review risk share this reading.
 */
export function behaviouralChange(spec: ParsedSpec): boolean {
  return spec.tasks.some((t) => t.test || (/acceptance:/i.test(t.text) && !/^\(refactor\)/i.test(t.title)));
}

/** A spec at or above this many tasks has too wide a blast radius to build unreviewed in auto mode. */
export const LARGE_SPEC_TASKS = 4;

export interface SpecReviewRisk {
  review: boolean;
  reason?: string;
}

/**
 * Whether a spec carries enough risk to deserve an independent reviewer under "auto": a
 * security-sensitive surface, threats, a migration, persisted data, an external contract, a named
 * living capability with no delta, or a large blast radius. Small reversible specs rely on the
 * decidable write checks and the human's read.
 */
export function specReviewRisk(md: string, spec: ParsedSpec, touchesLiving = false): SpecReviewRisk {
  const scope = surfaceText(md, spec);
  const sensitive = scope.split("\n").find((line) => SENSITIVE_WRITE.test(line.replace(/`[^`]*`/g, "")));
  if (sensitive) return { review: true, reason: `security-sensitive (${sensitive.replace(/`[^`]*`/g, "").match(SENSITIVE_WRITE)?.[0] ?? "surface"})` };
  if (parseRequirementDeltas(md).deltas.length) return { review: true, reason: "changes the requirement base" };
  if (touchesLiving) return { review: true, reason: "touches a living capability without a delta" };
  if (threatSection(md)) return { review: true, reason: "threats and abuse" };
  const migration = sectionOf(md, "Migration and rollback");
  if (migration && !negativeWithReason(migration)) return { review: true, reason: "a migration" };
  if (PERSISTED_DATA.test(scope)) return { review: true, reason: "persisted data" };
  if (EXTERNAL_SURFACE.test(scope)) return { review: true, reason: "an external surface" };
  if (spec.tasks.length >= LARGE_SPEC_TASKS) return { review: true, reason: `${spec.tasks.length} tasks` };
  return { review: false };
}

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

/** The prior state a changed spec's review needs: open blockers, carried advisories, and the text they came from. */
export interface SpecReviewCarry {
  /** earlier blocking findings, with stable ids: in-scope P0/P1 and outside P0 */
  prior: Finding[];
  /** earlier P2/P3 findings, carried as context and never re-listed as new */
  advisory: Finding[];
  /** the exact text the earlier review saw, when the event has it */
  markdown?: string;
  nextId: number;
  round: number;
  /** blocking rounds since the last pass or forced acceptance; an unreadable block counts too */
  blockingRounds: number;
}

export type SpecReviewGate =
  | { action: "skip" }
  | { action: "repost"; findings: Finding[]; advisory: Finding[] }
  | ({ action: "manual"; reason: "cap" | "unparsed"; prose?: string } & SpecReviewCarry)
  | ({ action: "review" } & SpecReviewCarry);

const SPEC_FINDING_ID = /^F(\d+)$/;

/** Whether a finding holds the build: an in-scope P0/P1, or an outside P0 (pre-existing, but unsafe to build on). */
export const specReviewBlocks = (f: Finding) => f.priority === "P0" || (f.priority === "P1" && !f.outside);

/** How many carried advisories a follow-up brief lists, so the revision stays the bulk of what it reads. */
export const CARRIED_ADVISORY_LIMIT = 8;

/**
 * The carried advisories to show a follow-up reviewer: at most `limit`, dropping the least blocking
 * first (P3 before P2) and only as many as needed, so a P1 advisory — a real pre-existing weakness
 * whose only written-out appearance is this brief — survives any flood of polish. Input order
 * survives within a priority. This narrows what the reviewer reads, never the record: the review
 * event and the human's counts keep the full list.
 */
export function capCarriedAdvisories(items: Finding[], limit = CARRIED_ADVISORY_LIMIT): Finding[] {
  const kept = [...items];
  const weight = (f: Finding) => (f.priority === "P1" ? 2 : f.priority === "P2" ? 1 : 0);
  while (kept.length > limit) {
    let weakest = -1;
    for (let i = 0; i < kept.length; i++) if (weight(kept[i]) < 2 && (weakest < 0 || weight(kept[i]) <= weight(kept[weakest]))) weakest = i;
    if (weakest < 0) break; // more P1 advisories than the limit: a P1 is never dropped
    kept.splice(weakest, 1);
  }
  return kept;
}

/** Give every legacy or newly parsed finding a stable F id, continuing after the highest one already issued. */
export function ensureSpecIds(findings: Finding[]): { findings: Finding[]; next: number } {
  let next = findings.reduce((highest, f) => Math.max(highest, Number(SPEC_FINDING_ID.exec(f.id ?? "")?.[1] ?? 0)), 0) + 1;
  return { findings: findings.map((f) => (f.id ? f : { ...f, id: `F${next++}` })), next };
}

const findingKey = (f: Finding) => f.id ?? f.title.trim().toLowerCase().replace(/\s+/g, " ");

/** The distinct text blocks a spec is reviewed in: its header, its ## sections and each task. */
interface SpecTextBlock {
  key: string;
  label: string;
  text: string;
}

const blockName = (heading: string) => heading.trim().toLowerCase().replace(/\s+/g, " ").replace(/:$/, "");

const specTextBlocks = (md: string): SpecTextBlock[] => {
  const lines = md.split("\n");
  const blanked = blankFenced(md);
  const blocks: SpecTextBlock[] = [];
  const firstHeading = blanked.findIndex((l) => /^##\s+(?!#)/.test(l));
  const header = lines.slice(0, firstHeading < 0 ? lines.length : firstHeading).join("\n").trim();
  if (header) blocks.push({ key: "header", label: "Header", text: header });
  const headings: number[] = [];
  blanked.forEach((line, i) => {
    if (/^##\s+(?!#)/.test(line)) headings.push(i);
  });
  for (const [k, at] of headings.entries()) {
    const end = headings[k + 1] ?? lines.length;
    const heading = blanked[at].replace(/^##\s+/, "").replace(/\s*:?\s*$/, "").trim();
    blocks.push({ key: `section:${blockName(heading)}`, label: `## ${heading}`, text: lines.slice(at, end).join("\n").trim() });
  }
  return blocks;
};

/** Each task under ## Tasks is its own block: changing one does not resend the whole task list. */
const withTaskBlocks = (md: string, blocks: SpecTextBlock[]): SpecTextBlock[] => {
  const spec = parseSpec(md).spec;
  if (!spec) return blocks;
  return blocks.flatMap((b) => (b.key === "section:tasks" ? spec.tasks.map((t) => ({ key: `task:${t.id}`, label: `### ${t.id}: ${t.title}`, text: t.text })) : [b]));
};

export interface SpecReviewDelta {
  /** current text of the sections and tasks that changed */
  changed: string;
  /** their earlier text, plus sections removed since */
  earlier: string;
  /** labels of sections/tasks that disappeared */
  removed: string[];
  /**
   * unchanged sections and header that bind the delta: Goal, Out of scope, Decisions, Contracts,
   * Migration and rollback, Threats (either spelling), plus any requirement sections.
   * Design is the one binding section left out: a delta round is told to check the full spec too,
   * so resending the largest section with every unchanged delta buys nothing.
   */
  context: string;
}

/**
 * The sections that bind a step, in the order a handout shows them: what the change must serve,
 * what it may not walk on, and the promises it keeps. One list for the whole tool — prompts.ts
 * renders it into every handout, spec review derives its delta context from it below — so the
 * builder and the reviewer can never disagree about what binds. `Threats` is the alias of
 * `Threats and abuse`; a spec carries one spelling.
 */
export const BINDING_SECTIONS: readonly string[] = ["Goal", "Out of scope", "Decisions", "Design", "Contracts", "Migration and rollback", "Threats and abuse", "Threats"];

/**
 * Blocks a spec-review delta always carries: the list above and the header — minus Design, stated
 * here as a subtraction rather than kept as a second list. A delta round reads the whole spec anyway
 * (prompts.ts reviewPrompt), so Design is the one section it does not need resent with every
 * unchanged delta. Requirement sections are added by `bindingBlock` below.
 */
const BINDING_BLOCKS = new Set<string>([
  "header",
  ...BINDING_SECTIONS.filter((section) => section !== "Design").map((section) => `section:${blockName(section)}`),
]);

/** Requirement deltas bind every review: a task change must still fit the requirement it serves. */
const bindingBlock = (key: string) => BINDING_BLOCKS.has(key) || key.startsWith("section:requirements");

/**
 * What changed between two reviewed spec texts, compared by section and task so a delta round
 * sends only the parts that moved. A text whose blocks all match returns an empty delta: the
 * caller then falls back to a full review, because a hash change alone is not worth re-reading.
 */
export function specReviewDelta(previous: string, current: string): SpecReviewDelta {
  const before = withTaskBlocks(previous, specTextBlocks(previous));
  const after = withTaskBlocks(current, specTextBlocks(current));
  const beforeBy = new Map(before.map((b) => [b.key, b]));
  const changed = after.filter((b) => beforeBy.get(b.key)?.text.trim() !== b.text.trim());
  const afterKeys = new Set(after.map((b) => b.key));
  const removed = before.filter((b) => !afterKeys.has(b.key) && b.key !== "header");
  const changedKeys = new Set(changed.map((b) => b.key));
  const earlierParts = [
    ...changed.map((b) => beforeBy.get(b.key)?.text).filter((text): text is string => !!text),
    ...removed.map((b) => b.text),
  ];
  return {
    changed: changed.map((b) => b.text).join("\n\n").trim(),
    earlier: earlierParts.join("\n\n").trim(),
    removed: removed.map((b) => b.label),
    context: after
      .filter((b) => bindingBlock(b.key) && !changedKeys.has(b.key))
      .map((b) => b.text)
      .join("\n\n")
      .trim(),
  };
}

/**
 * What a build start owes the spec review, from its {type:"spec-review"} events and the current
 * text's hash: a pass on this text skips it, a block on this text with open P0/P1 findings is
 * re-posted (a re-run would re-find the same), and anything else runs with the earlier blockers
 * and advisory findings first. Only an in-scope P0/P1 or an outside P0 blocks; anything else is
 * carried as advisory. A block with no open blocker is re-run because there is nothing to re-post.
 * After `maxRounds` blocking rounds since the last pass, a human decides instead: the automatic
 * loop stops and the standing findings stay visible. An unreadable block counts too, since it
 * cannot be shown harmless. Legacy events without ids get them here, once.
 */
export function specReviewGate(events: Array<Record<string, unknown>>, hash: string, maxRounds = 2): SpecReviewGate {
  const last = events.filter((e) => e.type === "spec-review" && (e.verdict === "pass" || e.verdict === "block")).at(-1);
  if (!last) return { action: "review", prior: [], advisory: [], nextId: 1, round: 1, blockingRounds: 0 };
  const reported = Array.isArray(last.reported) ? (last.reported as Finding[]) : [];
  const carried = Array.isArray(last.advisory) ? (last.advisory as Finding[]) : [];
  const seen = new Set<string>();
  const combined = [...reported, ...carried].filter((f) => {
    const key = findingKey(f);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const ids = ensureSpecIds(combined);
  const prior = ids.findings.filter(specReviewBlocks);
  const advisory = ids.findings.filter((f) => !specReviewBlocks(f));
  const nextId = Math.max(ids.next, typeof last.nextId === "number" ? last.nextId : 1);
  const round = (typeof last.round === "number" ? last.round : 1) + 1;
  const markdown = typeof last.markdown === "string" ? last.markdown : undefined;
  // A pass or a forced acceptance closes the cycle: only blocks after it can reach the cap.
  const reset = events.reduce((at, e, i) => (e.type === "spec-review" && (e.verdict === "pass" || e.verdict === "forced") ? i : at), -1);
  const blockingRounds = events.slice(reset + 1).filter((e) => {
    if (e.type !== "spec-review" || e.verdict !== "block") return false;
    const findings = Array.isArray(e.reported) ? (e.reported as Finding[]) : [];
    const open = Array.isArray(e.resolutions) ? (e.resolutions as Array<{ status?: string }>).some((r) => r.status === "open") : false;
    return findings.some(specReviewBlocks) || open || e.unparsed === true || (!Array.isArray(e.reported) && typeof e.findings === "number" && e.findings > 0);
  }).length;
  const carry = { prior, advisory, ...(markdown !== undefined ? { markdown } : {}), nextId, round, blockingRounds };
  const prose = typeof last.prose === "string" ? last.prose : undefined;
  const cap = Math.max(1, Math.floor(maxRounds));
  if (last.hash !== hash) {
    if (blockingRounds >= cap) return { action: "manual", reason: "cap", ...(prose !== undefined ? { prose } : {}), ...carry };
    return { action: "review", ...carry };
  }
  if (last.verdict === "pass") return { action: "skip" };
  if (prior.length) return { action: "repost", findings: prior, advisory };
  if (last.unparsed) return { action: "manual", reason: "unparsed", ...(prose !== undefined ? { prose } : {}), ...carry, prior: [] };
  return { action: "review", ...carry, prior: [] };
}
