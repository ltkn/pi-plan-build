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
 *   (optional: Out of scope, Acceptance criteria, Contracts, Migration and rollback, Threats and abuse;
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
import { parseRequirementDeltas, requirementCriteria, requirementSurfaceText } from "./requirements.ts";
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
 * top-level "## Acceptance criteria" bullets become A1, A2, ...; requirement deltas contribute each
 * touched scenario as R1.1, R1.2, ...; each task's "- Acceptance:" line becomes T1.1, T1.2, ... in
 * reading order. Proof markers stay in the text so the reviewer can judge them.
 */
export function acceptanceCriteria(md: string, parsed?: ParsedSpec): AcceptanceCriterion[] {
  const spec = parsed ?? parseSpec(md).spec;
  const out: AcceptanceCriterion[] = [];
  let lineNo = 0;
  for (const line of unfenced(sectionOf(md, "Acceptance criteria"))) {
    const m = /^\s*[-*]\s+(.+)$/.exec(line);
    if (!m) continue;
    const text = m[1].trim();
    if (!text || noCriteria(text)) continue;
    out.push({ id: `A${++lineNo}`, text });
  }
  for (const criterion of requirementCriteria(md)) {
    out.push({ id: criterion.id, text: criterion.text, capability: criterion.capability, requirement: criterion.requirement });
  }
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

export interface ProofMarker {
  kind: "tests" | "non-testable";
  body: string;
}

const ACCEPTANCE_LINE = /^\s*[-*]\s*Acceptance(\s*\([^)]*\))?:/i;
const PROOF_MARKER = /\((tests|non-testable):\s*([^)]+)\)/gi;
/** What may follow a real marker: whitespace and sentence punctuation, or the close of a wrapping parenthesis. */
const MARKER_TRAILER = /^[\s.;,)]*$/;

/** True for a task acceptance line, including qualified variants such as `Acceptance (abuse):`. */
export const isAcceptanceLine = (line: string): boolean => ACCEPTANCE_LINE.test(line);

/**
 * The proof markers that end an acceptance line, in order. A marker earlier in the line is prose:
 * a criterion may explain what a `(tests: Tn)` marker means, and that example must not become the
 * line's own claim. Only markers in the trailing run are claims.
 */
export function proofMarkersOf(line: string): ProofMarker[] {
  const found = [...line.matchAll(PROOF_MARKER)];
  const markers: ProofMarker[] = [];
  let nextStart = line.length;
  for (let i = found.length - 1; i >= 0; i--) {
    const match = found[i];
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (!MARKER_TRAILER.test(line.slice(end, nextStart))) break;
    markers.unshift({ kind: match[1].toLowerCase() as ProofMarker["kind"], body: match[2].trim() });
    nextStart = start;
  }
  return markers;
}

/**
 * `(tests: ...)` proof references named on one task's acceptance lines. A `Tn`-style entry names a
 * task whose red `Test:` run proves the line — its own id or another task's, only where that task
 * needs red; a path-like entry names a file; anything else must occur verbatim in the test files
 * (a test or file name) — a named test that proves nothing is a faked mapping.
 */
export function testRefsOf(taskText: string): string[] {
  const refs: string[] = [];
  for (const line of taskText.split("\n")) {
    if (!isAcceptanceLine(line)) continue;
    for (const marker of proofMarkersOf(line)) {
      if (marker.kind !== "tests") continue;
      for (const e of marker.body.split(/[,;]/).map((s) => s.trim()).filter(Boolean)) refs.push(e);
    }
  }
  return refs;
}

/** A `Tn`-shaped entry: it names a task rather than a file; `taskIdProofGap` decides whether that task's red run backs it. */
export const ownTestRef = (entry: string) => /^T\d+$/i.test(entry.trim());
/** A path-like entry: must exist in the repo. */
export const pathTestRef = (entry: string) => /[/\\]/.test(entry) || /\.[A-Za-z0-9]+$/.test(entry.trim());

/**
 * Why a `Tn` proof entry names no red proof, or undefined when it names one: the id must name a task
 * of this spec and that task must need red, because the red gate forcing its `Test:` run to fail
 * before the change is all such a marker claims — which is why an own id is as good as another task's,
 * and why a `Tn` on a red-exempt task or in a red-exempt spec names nothing. The writer's alternatives
 * are `(non-testable: <why>)` or a test file or test name that exists today.
 */
export function taskIdProofGap(spec: ParsedSpec, entry: string): string | undefined {
  if (!ownTestRef(entry)) return undefined; // not a task id: the repo decides whether it resolves
  const named = buildTask(spec, entry.trim().toUpperCase());
  if (!named) return "names no task of this spec";
  const exempt = redExemption(spec, named);
  return exempt ? `names ${named.id}, which needs no red proof (${exempt})` : undefined;
}

/* ------------------------- senior-enforcement gates ------------------------- */

/**
 * Senior-enforcement semantic gates: mechanically checkable shape rules that turn
 * senior prompt asks into write-time rejections. Readers stay lenient: only the
 * write tools call these, so in-flight and grandfathered specs keep working.
 * Planning specs are exempt: gates bite only on transition to ready.
 */

const hasSection = (md: string, name: string): boolean => {
  const blanked = blankFenced(md);
  return blanked.some((l) => sectionHeading(name).test(l));
};

/** Bullets of a section (fence-aware, "-" or "*" markers). */
const sectionBullets = (md: string, name: string): string[] => {
  const body = sectionOf(md, name);
  if (!body) return [];
  let inFence = false;
  const out: string[] = [];
  for (const line of body.split("\n")) {
    if (/^(\s*)```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^\s*[-*]\s+\S/.test(line)) out.push(line.trim());
  }
  return out;
};

/**
 * Root files a spec may cite by name without an extension (README:12). Part of the citation grammar
 * below: `specPathErrors` resolves the refs it finds against the project, `boundOwnerErrors` asks
 * only whether a bullet carries one, so both read the same text.
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
 * High-signal product keywords for the write-time Threats gate. Deliberately
 * narrower than the reviewer's auto-mode heuristic: generic words (status,
 * limit, address, email, job, role) stay reviewer-level, not write-time blocks.
 * Scanned across the spec's substantive sections, because a trust boundary is
 * just as real when it is first named in Findings or Decisions.
 */
const SENSITIVE_WRITE = /\b(auth\w*|login|logout|sign-?in|password|passwd|credential|secret|api[_-]?key|token|jwt|oauth|saml|sso|permission|privilege|admin|payment|billing|invoice|refund|webhook|upload|download|session|cookie|csrf|cors|endpoint|route|tenant|ownership|quota|replay|balance|credit|debit)\b/i;

/**
 * Language-agnostic words for a surface other code, clients or stored data can
 * observe: an API, event, schema, config, public signature, file format. A hit
 * requires Contracts (or an explicit "none — why").
 */
const EXTERNAL_SURFACE =
  /\b(?:api|endpoint|route|http|https|rest|graphql|grpc|rpc|webhook|event|message|queue|topic|schema|migration|database|table|column|constraint|json|dto|payload|config|configuration|environment|cli|file\s+format|serializ\w*|deserializ\w*|contract|client|consumer|producer)\b|\bpublic\s+(?:api|interface|signature|contract)\b/i;

/**
 * Words for data that outlives one run and needs a migration/rollback answer:
 * a database, a schema, a stored format, a backfill. A hit requires Migration
 * and rollback (or an explicit "none — why").
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

/** Whether a section has a real body, not an empty heading, TBD, or a bare "none". */
const sectionUsable = (md: string, name: string): boolean => {
  if (!hasSection(md, name)) return false;
  const body = sectionOf(md, name);
  if (!body) return false;
  const first = body.trim().split("\n")[0].trim();
  if (!/^(?:tbd|tba|todo|n\/a|none|nothing)\b/i.test(first)) return true;
  return negativeWithReason(body);
};

const threatSection = (md: string): string | undefined =>
  hasSection(md, "Threats and abuse") ? "Threats and abuse" : hasSection(md, "Threats") ? "Threats" : undefined;

/**
 * A ready spec whose substantive sections look sensitive must carry Threats plus
 * abuse-case acceptance, or an explicit "none — why" that the reviewer can judge.
 */
export function threatsErrors(md: string, spec: ParsedSpec): string[] {
  if (spec.status !== "ready") return [];
  const section = threatSection(md);
  if (section) {
    if (sectionUsable(md, section)) return [];
    return [`"## ${section}" is empty or a placeholder: name who can reach it, what they must prove, how it could be abused, and what prevents each abuse — or write "none — <why>"`];
  }
  const scope = surfaceText(md, spec);
  const hit = scope.split("\n").find((l) => SENSITIVE_WRITE.test(l.replace(/`[^`]*`/g, "")));
  if (!hit) return [];
  const word = hit.replace(/`[^`]*`/g, "").match(SENSITIVE_WRITE)![0];
  return [`ready spec mentions "${word}" but has no "## Threats and abuse": add who can reach it, what they must prove, how it could be abused, what prevents each abuse, and cover the abuse cases in Acceptance (or write "none — <why>")`];
}

/**
 * Quantitative claims with units or bounded counts (latencies, counts, windows,
 * limits, retries) must carry a measurement (a backtick command on the line) or
 * be an Assumption with a settler. Bare task ids (T1), file names, and line
 * ranges carry no units and never trigger. Scanned in Decisions, Contracts, and
 * Tasks.
 */
const QUANTITY = /\b\d+(\.\d+)?\s*(ms|s\b|sec|secs|seconds?|minutes?|mins?|hours?|days?|rows?|reqs?|rps|qps|%|percent|mb|gb|kb)\b|\bp(50|90|95|99)\b|\b\d+\s*(attempts|retries|times|connections|threads|workers|requests)\b|\b(at least|at most|max|maximum|min|minimum|up to|over|under|fewer than|more than|within)\s+\d+\b/i;
const SUBSECOND = /\bsub-?seconds?\b/i;

/**
 * Whether a line is an Assumption that names how it settles. Both halves must be present; their
 * order is free, because the two claims are one sentence in either order. One answer, shared by the
 * measurement gate and the bound gate.
 */
export const ASSUMPTION_WITH_SETTLER = /(?=[\s\S]*assumption:)(?=[\s\S]*settles?\s+by)/i;

/**
 * How often something runs, said in words: the trigger for a bound that must name its owner. It
 * never matches a bare count or a unit (`at most 200`, `200ms`) — `QUANTITY` owns those, and their
 * answer is a measurement, which no `path:line` can give.
 */
export const CADENCE = /\b(?:at most once|no more than once|once per|twice per|per (?:calls?|runs?|rounds?|invocations?|requests?|passes)|every (?:calls?|runs?|rounds?|invocations?|requests?|passes)|each (?:calls?|runs?|rounds?|invocations?|requests?|passes)|one (?:calls?|runs?|rounds?|invocations?|requests?|queries) per|at most one [^.;\n]{0,40}?\b(?:calls?|invocations?|runs?|rounds?|passes|queries|lookups?|scans?|fetches|requests?|executions?|walks?|reads?|processes|sends?|writes?))\b/i;

/** A bound whose owner is code that does not exist yet: `new: src/scan.ts`. Angle brackets are prose, never literal. */
export const NEW_BOUND_OWNER = /\bnew:\s*`?[\w./-]+\.[\w]{1,12}`?/i;

export function quantitativeErrors(md: string, spec: ParsedSpec): string[] {
  if (spec.status !== "ready") return [];
  const out: string[] = [];
  for (const section of ["Decisions", "Contracts"] as const) {
    for (const line of sectionBullets(md, section)) {
      if (!QUANTITY.test(line) && !SUBSECOND.test(line)) continue;
      if (ASSUMPTION_WITH_SETTLER.test(line)) continue;
      if (/`[^`]+`/.test(line)) continue;
      out.push(`${section} quantitative claim without measurement or Assumption: "${line}" — add a measurement (command plus result) or write it as "Assumption: <claim> — settles by <how>, because <reason>"`);
    }
  }
  for (const t of spec.tasks) {
    for (const line of t.text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || /^###\s/.test(trimmed)) continue;
      if (!QUANTITY.test(trimmed) && !SUBSECOND.test(trimmed)) continue;
      if (ASSUMPTION_WITH_SETTLER.test(trimmed)) continue;
      if (/`[^`]+`/.test(trimmed)) continue;
      out.push(`${t.id} quantitative claim without measurement or Assumption: "${trimmed}" — add a measurement (command plus result) or write it as "Assumption: <claim> — settles by <how>, because <reason>"`);
    }
  }
  for (const delta of parseRequirementDeltas(md).deltas) {
    for (const group of delta.groups) {
      if (group.kind === "REMOVED") continue;
      for (const requirement of group.requirements) {
        const lines = [requirement.statement, ...requirement.scenarios.flatMap((s) => s.criteria.map((c) => `${c.keyword} ${c.text}`))];
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || (!QUANTITY.test(trimmed) && !SUBSECOND.test(trimmed))) continue;
          if (ASSUMPTION_WITH_SETTLER.test(trimmed)) continue;
          if (/`[^`]+`/.test(trimmed)) continue;
          out.push(`${delta.capability} requirement "${requirement.name}" has a quantitative claim without measurement or Assumption: "${trimmed}" — add a measurement (command plus result) or write it as "Assumption: <claim> — settles by <how>, because <reason>"`);
        }
      }
    }
  }
  return out;
}

/** File-like tokens in a task (backtick paths and dotted filenames), for seam-overlap detection. */
const taskFiles = (text: string): Set<string> => {
  const out = new Set<string>();
  for (const m of text.matchAll(/`([^`]+)`/g)) {
    const inner = m[1].trim();
    if (/[./]/.test(inner)) out.add(inner.toLowerCase());
  }
  for (const m of text.matchAll(/(?<![\w./-])([\w.-]+\.[\w]{1,5})(?![\w])/g)) out.add(m[1].toLowerCase());
  return out;
};

/**
 * Whether the tasks share a seam: the same Test: command, or a file-like token
 * named by more than one task. Disjoint tasks (different commands, different
 * files) carry no shared seam; missing Contracts there stays advisory.
 */
export function sharesSeam(spec: ParsedSpec): boolean {
  if (sharedTestCommands(spec).length) return true;
  const seen = new Map<string, string>();
  for (const t of spec.tasks) {
    for (const f of taskFiles(t.text)) {
      const owner = seen.get(f);
      if (owner !== undefined && owner !== t.id) return true;
      if (owner === undefined) seen.set(f, t.id);
    }
  }
  return false;
}

/**
 * Whether a spec changes behaviour it must test: a task with a Test: command, or a non-refactor
 * task with acceptance lines. Contracts and the living-requirement check share this one reading.
 */
export function behaviouralChange(spec: ParsedSpec): boolean {
  return spec.tasks.some((t) => t.test || (/acceptance:/i.test(t.text) && !/^\(refactor\)/i.test(t.title)));
}

/**
 * A ready spec needs Contracts when it changes an external surface, even with
 * one task, or when a multi-task behavioural spec's tasks share a seam. Disjoint
 * internal tasks need no Contracts section: the existing advisory warning covers
 * them. `none — why` is accepted for the external-surface trigger alone, so a
 * keyword false positive costs one line instead of a fake contract.
 */
export function contractsErrors(md: string, spec: ParsedSpec): string[] {
  if (spec.status !== "ready") return [];
  const external = EXTERNAL_SURFACE.test(surfaceText(md, spec));
  const behavioural = behaviouralChange(spec);
  const shared = spec.tasks.length > 1 && sharesSeam(spec);
  if (!external && !(shared && behavioural)) return [];
  if (!external && spec.gate === "none" && spec.tasks.every((t) => !t.test)) return [];
  if (hasSection(md, "Contracts")) {
    if (!sectionUsable(md, "Contracts")) {
      return [`"## Contracts" is empty or a placeholder: pin every seam (signatures, API and errors, data, events, and which task owns each side) or write "none — <why>"`];
    }
    if (shared && negativeWithReason(sectionOf(md, "Contracts"))) {
      return [`${spec.tasks.length} tasks share a seam, but ## Contracts says none: pin every seam they share, or make the tasks truly independent`];
    }
    return [];
  }
  if (external) {
    return [`ready spec changes an external surface (API, event, schema, config, public signature or stored shape) but has no ## Contracts: pin every seam other code, clients or stored data depend on, with its errors and which task owns each side (or write "none — <why>")`];
  }
  return [`${spec.tasks.length} tasks share a seam but have no ## Contracts: pin every seam they share (signatures, API and errors, data, events, and which task owns each side)`];
}

/**
 * A ready spec that changes persisted data or a stored format must say how the
 * old data moves and how the change is rolled back, or state explicitly why no
 * data outlives the change. The section is optional for every other spec.
 */
export function migrationErrors(md: string, spec: ParsedSpec): string[] {
  if (spec.status !== "ready") return [];
  if (!PERSISTED_DATA.test(surfaceText(md, spec))) return [];
  if (!hasSection(md, "Migration and rollback")) {
    return [`ready spec changes persisted data or a stored format but has no "## Migration and rollback": say how existing data moves to the new shape, how it is rolled back, and what old and new code do while both run (or write "none — <why>")`];
  }
  if (!sectionUsable(md, "Migration and rollback")) {
    return [`"## Migration and rollback" is empty or a placeholder: say how existing data moves, how the change is rolled back, and what old and new code do while both run — or write "none — <why>"`];
  }
  return [];
}

/**
 * Findings bullets (when the section exists) must cite checkable evidence: a
 * path (file:line), a pathed file (with a slash and an extension, so and/or
 * never counts), a backtick probe (command plus conclusion), an explicit
 * `probe: …; conclusion: …` pair, or an explicit `constraint: …`. Bare words
 * alone ("baseline", "measured") never count: evidence must point somewhere.
 * Catches unevidenced senior prose without judging its truth, which stays the
 * reviewer's job.
 */
export const FINDINGS_EVIDENCE_RULE =
  'a path (file:line), a probe ("probe: <what you ran>; conclusion: <what it showed>" or a backticked command with its conclusion), or a constraint ("constraint: <what limits the change>")';
const EVIDENCE = /(`[^`]+`|[A-Za-z0-9_./-]+\.[a-z]{1,5}:\d+|[\w.-]+\/[\w./-]*\.[\w]{1,5}|\bconstraint\s*:\s*\S|\bprobe\s*:[\s\S]*?\bconclusion\s*:\s*\S)/i;

export function findingsEvidenceErrors(md: string, spec: ParsedSpec): string[] {
  if (spec.status !== "ready") return [];
  if (!hasSection(md, "Findings")) return [];
  return sectionBullets(md, "Findings")
    .filter((l) => !EVIDENCE.test(l))
    .map((l) => `Findings line without evidence: "${l}" — cite ${FINDINGS_EVIDENCE_RULE}`);
}

/**
 * Decisions bullets (when the section exists) must carry a reason with an
 * explicit marker: because, since, so, so that, therefore, to avoid, an em/en
 * dash or arrow, "Rationale:"/"Reason:", or an Assumption. A bare colon never
 * counts ("Use X: yes" states no reason). Rejected ideas ("Not doing X") need
 * the same. The accepted forms are shared with the spec prompt so the rule
 * taught and the rule enforced cannot drift.
 */
export const DECISION_REASON_RULE =
  'because, since, so, so that, therefore, to avoid, an em dash (—), "Rationale:", "Reason:", or "Assumption: <claim> — settles by <how>, because <reason>"';
const REASON = /(because|since|\bso\b|so that|therefore|to avoid|rationale|reason(?:s|ing)?:|assumption:|—|–|→)/i;

export function decisionsEvidenceErrors(md: string, spec: ParsedSpec): string[] {
  if (spec.status !== "ready") return [];
  if (!hasSection(md, "Decisions")) return [];
  return sectionBullets(md, "Decisions")
    .filter((l) => !REASON.test(l))
    .map((l) => `Decisions line without a reason: "${l}" — add its reason with an explicit marker: ${DECISION_REASON_RULE}`);
}

/**
 * The owner a bound must name, in the writer's words: one sentence shared by this gate's refusal and
 * SPEC_FORMAT, so the rule taught and the rule enforced cannot drift. A backticked command is
 * deliberately absent — that is the measurement gate's answer, and the case this gate exists for is a
 * command quoted with no code named.
 */
export const BOUND_OWNER_RULE =
  'name the code whose call this bounds as path:line, write "new: <path>" if nothing performs it yet, or make it an Assumption with a settler when nothing in the project enforces the cadence — a backticked command measures, it does not own a cadence';

/**
 * A ready spec's Contracts bullets that bound how often something runs must name the code whose call
 * they bound: a resolvable `path:line` (resolved for real by `specPathErrors`), a path presented as
 * new, or an Assumption with a settler for a cadence nothing here enforces. Contracts only — a
 * cadence in Decisions is rationale, and widening the section doubles the false-refusal surface for
 * no bound the build would implement.
 */
export function boundOwnerErrors(md: string, spec: ParsedSpec): string[] {
  if (spec.status !== "ready") return [];
  const out: string[] = [];
  for (const line of sectionBullets(md, "Contracts")) {
    if (!CADENCE.test(line)) continue;
    if (specPathRefs(line).length || NEW_BOUND_OWNER.test(line) || ASSUMPTION_WITH_SETTLER.test(line)) continue;
    out.push(`Contracts bound without an owner: "${line}" — ${BOUND_OWNER_RULE}`);
  }
  return out;
}

/** All senior-enforcement gates for a ready spec; empty when planning or clean. */
export function semanticErrors(md: string, spec: ParsedSpec): string[] {
  return [...threatsErrors(md, spec), ...quantitativeErrors(md, spec), ...contractsErrors(md, spec), ...migrationErrors(md, spec), ...findingsEvidenceErrors(md, spec), ...decisionsEvidenceErrors(md, spec), ...boundOwnerErrors(md, spec)];
}

/** The Threats/numbers/Contracts/migration/bound subset: what a Tasks-section update re-checks. */
export function taskScopeSemanticErrors(md: string, spec: ParsedSpec): string[] {
  return [...threatsErrors(md, spec), ...quantitativeErrors(md, spec), ...contractsErrors(md, spec), ...migrationErrors(md, spec), ...boundOwnerErrors(md, spec)];
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
 * write-time checks and the human's read.
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
   * Migration and rollback, Threats (either spelling) and the top-level Acceptance criteria.
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
 * Blocks a spec-review delta always carries: the list above, the header and the top-level acceptance
 * criteria — minus Design, stated here as a subtraction rather than kept as a second list. A delta
 * round reads the whole spec anyway (prompts.ts reviewPrompt), so Design is the one section it does
 * not need resent with every unchanged delta.
 */
const BINDING_BLOCKS = new Set<string>([
  "header",
  "section:acceptance criteria",
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
