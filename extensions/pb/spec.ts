/**
 * The spec: one self-contained markdown document per feature, the single source of
 * truth for its build. The planning agent writes it through pb_write_spec; the
 * harness only needs a few things back from it, so the format is fixed but small:
 *
 *   # <title>
 *   Depends on: <spec name> | none
 *   Verification: tests | build | none — <why, unless tests>
 *   New tests: yes | no — <why, if no>
 *
 *   ## Goal · ## Decisions · ## Tasks   (optional: Out of scope, Context, Acceptance criteria)
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
  dependsOn?: string;
  gate: Gate;
  gateReason?: string;
  newTests: boolean;
  newTestsReason?: string;
  tasks: SpecTask[];
}

/** The rest (Out of scope, Context, Acceptance criteria) is optional: specs stay as short as the change allows. */
export const REQUIRED_SECTIONS = ["Goal", "Decisions", "Tasks"];

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

  const verification = header(md, "Verification");
  let gate: Gate = "tests";
  let gateReason: string | undefined;
  if (!verification) errors.push('missing "Verification: tests | build | none"');
  else {
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
  if (!heads.length) errors.push('no tasks: write each as "### T1: <title>" under "## Tasks"');
  const tasks: SpecTask[] = heads.map((h, i) => {
    const text = tasksBody.slice(h.index, heads[i + 1]?.index ?? tasksBody.length).trim();
    const test = text.match(/^\s*-\s*Test:\s*`([^`]+)`/m)?.[1].trim();
    if (!/^\s*-\s*Acceptance:/m.test(text)) errors.push(`${h[1]} has no "- Acceptance:" line`);
    return { id: h[1], title: h[2].trim() || h[1], text, test };
  });
  const ids = tasks.map((t) => t.id);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dup.length) errors.push(`duplicate task ids: ${[...new Set(dup)].join(", ")}`);

  return errors.length ? { errors } : { spec: { title: title!, dependsOn, gate, gateReason, newTests, newTestsReason, tasks }, errors };
}

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
