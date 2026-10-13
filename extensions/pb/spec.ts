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
 *   (optional: Out of scope, Acceptance criteria; Findings recommended; Open questions only while planning)
 *
 * A planning spec is the checkpoint of an unfinished discussion: it needs no Verification line and
 * no Tasks yet. A ready spec is what the build runs.
 *   ### T1: <title>
 *   <detail>
 *   - Acceptance: <checkable>
 *   - Test: `<targeted test command>`        (optional)
 */
import type { Gate } from "./store.ts";

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

/** Lines of markdown with fenced code blocks blanked for structure detection (headings inside fences aren't structure). */
const FENCE = /^(\s*)```/;
const blankFenced = (md: string): string[] => {
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
};

/** Text before the first ## heading outside fences: title + Status/Verification/New tests/Depends on live here. */
const headerBlock = (md: string): string => {
  const lines = md.split("\n");
  const blanked = blankFenced(md);
  const idx = blanked.findIndex((l) => /^##\s/.test(l));
  return (idx < 0 ? lines : lines.slice(0, idx)).join("\n");
};

const escapeReg = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const header = (md: string, label: string) => headerBlock(md).match(new RegExp(`^\\s{0,3}${escapeReg(label)}:\\s*(.+)$`, "im"))?.[1].trim();
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
    const found = blanked.filter((l) => new RegExp(`^##\\s+${escapeReg(s)}\\s*:?\\s*$`, "i").test(l));
    if (!found.length) errors.push(`missing the "## ${s}" section`);
    else if (found.length > 1) errors.push(`duplicate "## ${s}" section: keep one`);
  }
  if (status === "ready" && blanked.some((l) => /^##\s+Open questions\s*:?\s*$/i.test(l)) && sectionOf(md, "Open questions").trim())
    errors.push('Status: ready can\'t have "## Open questions": settle each into Decisions ("Assumption: <claim> — settles by <how>, because <reason>") or ask with pb_ask');

  // Tasks: fence-aware, line-based. ## Tasks allows a trailing colon; ### T1 is case-insensitive
  // and normalized to T1; a ### line that looks like a task but doesn't parse is an error, not silence.
  const lines = md.split("\n");
  const tasksIdx = blanked.findIndex((l) => /^##\s+Tasks\s*:?\s*$/i.test(l));
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

/**
 * Replace (or append to) one "## <section>" of a spec; a missing section is added before Tasks, or
 * at the end. Lets a checkpoint change only what moved instead of rewriting the whole spec.
 * Fence-aware: headings inside code fences aren't sections.
 */
export function setSection(md: string, section: string, body: string, mode: "replace" | "append" = "replace"): string {
  const name = section.replace(/^#+\s*/, "").trim();
  const lines = md.split("\n");
  const blanked = blankFenced(md);
  const idx = blanked.findIndex((l) => new RegExp(`^##\\s+${escapeReg(name)}\\s*:?\\s*$`, "i").test(l));
  const text = body.trim();
  if (idx < 0) {
    const tasksIdx = blanked.findIndex((l) => /^##\s+Tasks\s*:?\s*$/i.test(l));
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
  const m = md.match(/^##\s+Decisions\s*$/im);
  if (!m || m.index === undefined) return `${md.trimEnd()}\n\n## Decisions\n\n${line}\n`;
  const start = m.index + m[0].length;
  const next = md.slice(start).search(/^##\s+/m);
  const end = next < 0 ? md.length : start + next;
  return `${md.slice(0, end).trimEnd()}\n${line}\n\n${md.slice(end).trimStart()}`;
}

export const SPEC_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

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

/** A section's body, trimmed ("" when missing). Fence-aware; name is literal. */
export const sectionOf = (md: string, name: string): string => {
  const lines = md.split("\n");
  const blanked = blankFenced(md);
  const idx = blanked.findIndex((l) => new RegExp(`^##\\s+${escapeReg(name)}\\s*:?\\s*$`, "i").test(l));
  if (idx < 0) return "";
  const rel = blanked.slice(idx + 1).findIndex((l) => /^##\s+(?!#)/.test(l));
  const end = rel < 0 ? lines.length : idx + 1 + rel;
  return lines.slice(idx + 1, end).join("\n").trim();
};

/* ------------------------- senior-enforcement gates ------------------------- */

/**
 * Senior-enforcement semantic gates: mechanically checkable shape rules that turn
 * senior prompt asks into write-time rejections. Readers stay lenient: only the
 * write tools call these, so in-flight and grandfathered specs keep working.
 * Planning specs are exempt: gates bite only on transition to ready.
 */

const hasSection = (md: string, name: string): boolean => {
  const blanked = blankFenced(md);
  return blanked.some((l) => new RegExp(`^##\\s+${escapeReg(name)}\\s*:?\\s*$`, "i").test(l));
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
 * High-signal product keywords for the write-time Threats gate. Deliberately
 * narrower than the reviewer's auto-mode heuristic: generic words (status,
 * limit, address, email, job, role) stay reviewer-level, not write-time blocks.
 * Scanned in Goal plus Tasks only, so meta-discussion in Findings/Decisions
 * about the gate itself never triggers it.
 */
const SENSITIVE_WRITE = /\b(auth\w*|login|logout|sign-?in|password|passwd|credential|secret|api[_-]?key|token|jwt|oauth|saml|sso|permission|privilege|admin|payment|billing|invoice|refund|webhook|upload|download|session|cookie|csrf|cors|endpoint|route)\b/i;

/** A ready spec whose Goal or Tasks look sensitive must carry Threats plus abuse-case acceptance. */
export function threatsErrors(md: string, spec: ParsedSpec): string[] {
  if (spec.status !== "ready") return [];
  if (hasSection(md, "Threats") || hasSection(md, "Threats and abuse")) return [];
  const scope = [sectionOf(md, "Goal"), spec.tasks.map((t) => t.text).join("\n")].join("\n");
  const hit = scope.split("\n").find((l) => SENSITIVE_WRITE.test(l.replace(/`[^`]*`/g, "")));
  if (!hit) return [];
  const word = hit.replace(/`[^`]*`/g, "").match(SENSITIVE_WRITE)![0];
  return [`ready spec mentions "${word}" in Goal/Tasks but has no "## Threats and abuse": add who can reach it, what they must prove, how it could be abused, what prevents each abuse, and cover the abuse cases in Acceptance`];
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

export function quantitativeErrors(md: string, spec: ParsedSpec): string[] {
  if (spec.status !== "ready") return [];
  const out: string[] = [];
  for (const section of ["Decisions", "Contracts"] as const) {
    for (const line of sectionBullets(md, section)) {
      if (!QUANTITY.test(line) && !SUBSECOND.test(line)) continue;
      if (/assumption:/i.test(line) && /settles?\s+by/i.test(line)) continue;
      if (/`[^`]+`/.test(line)) continue;
      out.push(`${section} quantitative claim without measurement or Assumption: "${line}" — add a measurement (command plus result) or write it as "Assumption: <claim> — settles by <how>, because <reason>"`);
    }
  }
  for (const t of spec.tasks) {
    for (const line of t.text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || /^###\s/.test(trimmed)) continue;
      if (!QUANTITY.test(trimmed) && !SUBSECOND.test(trimmed)) continue;
      if (/assumption:/i.test(trimmed) && /settles?\s+by/i.test(trimmed)) continue;
      if (/`[^`]+`/.test(trimmed)) continue;
      out.push(`${t.id} quantitative claim without measurement or Assumption: "${trimmed}" — add a measurement (command plus result) or write it as "Assumption: <claim> — settles by <how>, because <reason>"`);
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
 * A multi-task behavioural spec whose tasks share a seam must pin it in
 * Contracts. Disjoint tasks (no shared command, no shared file) need no
 * Contracts section: the existing advisory warning covers them.
 */
export function contractsErrors(md: string, spec: ParsedSpec): string[] {
  if (spec.status !== "ready") return [];
  if (spec.tasks.length < 2) return [];
  if (hasSection(md, "Contracts")) return [];
  const behavioural = spec.tasks.some((t) => t.test || (/acceptance:/i.test(t.text) && !/^\(refactor\)/i.test(t.title)));
  if (!behavioural) return [];
  if (spec.gate === "none" && spec.tasks.every((t) => !t.test)) return [];
  if (!sharesSeam(spec)) return [];
  return [`${spec.tasks.length} tasks share a seam but have no ## Contracts: pin every seam they share (signatures, API and errors, data, events, and which task owns each side)`];
}

/**
 * Findings bullets (when the section exists) must cite checkable evidence: a
 * path (file:line), a pathed file (with a slash and an extension, so and/or
 * never counts), or a backtick probe (command plus conclusion). Bare words
 * alone ("baseline", "measured") never count: evidence must point somewhere.
 * Catches unevidenced senior prose without judging its truth, which stays the
 * reviewer's job.
 */
const EVIDENCE = /(`[^`]+`|[A-Za-z0-9_./-]+\.[a-z]{1,5}:\d+|[\w.-]+\/[\w./-]*\.[\w]{1,5})/;

export function findingsEvidenceErrors(md: string, spec: ParsedSpec): string[] {
  if (spec.status !== "ready") return [];
  if (!hasSection(md, "Findings")) return [];
  return sectionBullets(md, "Findings")
    .filter((l) => !EVIDENCE.test(l))
    .map((l) => `Findings line without evidence: "${l}" — cite a path (file:line), a probe (command plus conclusion), or a constraint`);
}

/**
 * Decisions bullets (when the section exists) must carry a reason: because, an
 * em/en dash or arrow reasoning marker, "so that", an explicit Rationale, or a
 * settled guess in Assumption form. A bare colon never counts ("Use X: yes"
 * states no reason). Rejected ideas ("Not doing X") need the same.
 */
const REASON = /(because|—|–|→|so that|rationale|assumption:)/i;

export function decisionsEvidenceErrors(md: string, spec: ParsedSpec): string[] {
  if (spec.status !== "ready") return [];
  if (!hasSection(md, "Decisions")) return [];
  return sectionBullets(md, "Decisions")
    .filter((l) => !REASON.test(l))
    .map((l) => `Decisions line without a reason: "${l}" — add its reason (because …), or write guesses as "Assumption: <claim> — settles by <how>, because <reason>"`);
}

/** All senior-enforcement gates for a ready spec; empty when planning or clean. */
export function semanticErrors(md: string, spec: ParsedSpec): string[] {
  return [...threatsErrors(md, spec), ...quantitativeErrors(md, spec), ...contractsErrors(md, spec), ...findingsEvidenceErrors(md, spec), ...decisionsEvidenceErrors(md, spec)];
}

/** The Threats/numbers/Contracts subset: what a Tasks-section update re-checks. */
export function taskScopeSemanticErrors(md: string, spec: ParsedSpec): string[] {
  return [...threatsErrors(md, spec), ...quantitativeErrors(md, spec), ...contractsErrors(md, spec)];
}
