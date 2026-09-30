/**
 * The spec: one self-contained markdown document per feature, the single source of
 * truth for its build. The planning agent writes it through pb_write_spec; the
 * harness only needs a few things back from it, so the format is fixed but small:
 *
 *   # <title>
 *   Status: planning | ready                 (optional; ready by default)
 *   Depends on: <spec name> | none
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

const header = (md: string, label: string) => md.match(new RegExp(`^${label}:\\s*(.+)$`, "mi"))?.[1].trim();
const splitReason = (v: string) => {
  const [head, ...rest] = v.split(/\s+[—–-]\s+/);
  return { value: head.trim().toLowerCase(), reason: rest.join(" — ").trim() || undefined };
};

/** Parse a spec; `errors` lists what's missing or malformed (empty = valid). */
export function parseSpec(md: string): { spec?: ParsedSpec; errors: string[] } {
  const errors: string[] = [];
  const title = md.match(/^#\s+(.+)$/m)?.[1].trim();
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
  const dependsOn = dep && !/^none$/i.test(dep) ? dep : undefined;

  for (const s of REQUIRED_SECTIONS) if (!new RegExp(`^##\\s+${s}\\s*$`, "mi").test(md)) errors.push(`missing the "## ${s}" section`);

  const tasksBody = md.split(/^##\s+Tasks\s*$/im)[1]?.split(/^##\s+(?!#)/m)[0] ?? "";
  const heads = [...tasksBody.matchAll(/^###\s+(T\d+)\s*[:.—–-]?\s*(.*)$/gm)];
  const ready = status === "ready";
  if (ready && !heads.length) errors.push('no tasks: write each as "### T1: <title>" under "## Tasks"');
  const tasks: SpecTask[] = heads.map((h, i) => {
    const text = tasksBody.slice(h.index, heads[i + 1]?.index ?? tasksBody.length).trim();
    const test = text.match(/^\s*-\s*Test:\s*`([^`]+)`/m)?.[1].trim();
    if (ready && !/^\s*-\s*Acceptance:/m.test(text)) errors.push(`${h[1]} has no "- Acceptance:" line`);
    return { id: h[1], title: h[2].trim() || h[1], text, test };
  });
  const ids = tasks.map((t) => t.id);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dup.length) errors.push(`duplicate task ids: ${[...new Set(dup)].join(", ")}`);

  return errors.length ? { errors } : { spec: { title: title!, status, dependsOn, gate, gateReason, newTests, newTestsReason, tasks }, errors };
}

/**
 * Replace (or append to) one "## <section>" of a spec; a missing section is added before Tasks, or
 * at the end. Lets a checkpoint change only what moved instead of rewriting the whole spec.
 */
export function setSection(md: string, section: string, body: string, mode: "replace" | "append" = "replace"): string {
  const name = section.replace(/^#+\s*/, "").trim();
  const m = md.match(new RegExp(`^##\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "im"));
  const text = body.trim();
  if (!m || m.index === undefined) {
    const tasks = md.search(/^##\s+Tasks\s*$/im);
    const block = `## ${name}\n${text}\n\n`;
    return tasks < 0 || name.toLowerCase() === "tasks" ? `${md.trimEnd()}\n\n${block.trimEnd()}\n` : `${md.slice(0, tasks)}${block}${md.slice(tasks)}`;
  }
  const start = m.index + m[0].length;
  const next = md.slice(start).search(/^##\s+(?!#)/m);
  const end = next < 0 ? md.length : start + next;
  const current = md.slice(start, end).trim();
  const merged = mode === "append" && current ? `${current}\n${text}` : text;
  return `${md.slice(0, start)}\n${merged}\n${end < md.length ? "\n" : ""}${md.slice(end)}`;
}

/** Set the "Status:" header line, added under the title when missing. */
export function setStatus(md: string, status: "planning" | "ready"): string {
  if (/^Status:.*$/im.test(md)) return md.replace(/^Status:.*$/im, `Status: ${status}`);
  return md.replace(/^(#\s+.+)$/m, `$1\nStatus: ${status}`);
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
  const goal = md.split(/^##\s+Goal\s*$/im)[1]?.split(/^##\s+(?!#)/m)[0]?.trim() ?? "";
  return [spec.title, ...(goal ? ["", goal] : []), ...(spec.tasks.length ? ["", ...spec.tasks.map((t) => `- ${t.title}`)] : [])].join("\n");
}
