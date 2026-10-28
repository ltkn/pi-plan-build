/**
 * The living requirement base: one markdown file per capability under specs/ in the project.
 * It is durable project knowledge, kept outside .pi/ so it can be committed and reviewed.
 * It changes only when a spec is archived. The spec carries a delta, one section per capability:
 *
 *   ## Requirements: order-cancellation
 *   Overview: Orders can be cancelled by their owner while pending.
 *   ### ADDED
 *   ### Requirement: Cancel a pending order
 *   Invariant: Only the order's owner can cancel it, and only while it is pending.
 *   #### Scenario: Owner cancels
 *   - **GIVEN** an order in PENDING owned by the caller
 *   - **WHEN** the owner cancels it
 *   - **THEN** it becomes CANCELLED
 *
 * ADDED must not exist, MODIFIED and REMOVED must exist; MODIFIED replaces the requirement whole
 * (a rename is REMOVED + ADDED). A delta that does not apply exactly is refused, so the base never
 * half-merges. The invariant is the first review criterion (R1.1) and each scenario follows (R1.2,
 * R2.1, …), so the reviewer checks the rule, not only its examples.
 */
import * as fs from "node:fs";
import { blankFenced, sectionHeading } from "./markdown.ts";
import { KEBAB_NAME } from "./names.ts";
import type { Store } from "./store.ts";

export type ScenarioKeyword = "GIVEN" | "WHEN" | "THEN" | "AND";

export interface ScenarioCriterion {
  keyword: ScenarioKeyword;
  text: string;
}

export interface RequirementScenario {
  name: string;
  criteria: ScenarioCriterion[];
}

export interface Requirement {
  name: string;
  /** the checkable rule from an "Invariant:" line; empty when the requirement only states its rule as prose */
  invariant: string;
  /** what the requirement states beyond its invariant, before its scenarios */
  statement: string;
  scenarios: RequirementScenario[];
}

export interface RequirementDocument {
  capability: string;
  title: string;
  /** the human entry point: what the capability is and what it refuses to do; never a criterion */
  overview: string;
  /** text kept between "## Requirements" and the first requirement */
  intro: string;
  requirements: Requirement[];
  /** the file this was parsed from; a canonical skeleton for a new capability */
  source: string;
}

export type RequirementGroup = "ADDED" | "MODIFIED" | "REMOVED";

export interface RequirementDelta {
  capability: string;
  /** the capability's human entry point; required when the living file has none, replaces the old one when given */
  overview?: string;
  groups: Array<{ kind: RequirementGroup; requirements: Requirement[] }>;
}

export interface RequirementPlan {
  capability: string;
  before: RequirementDocument;
  after: RequirementDocument;
  /** the living file after the merge */
  markdown: string;
  added: string[];
  modified: string[];
  removed: string[];
}

const KEYWORD = /^\s*[-*]\s+\*\*(GIVEN|WHEN|THEN|AND)\*\*\s+(.+?)\s*$/i;
const INVARIANT = /^Invariant\s*:\s*(.*)$/i;
const GROUP = /^###\s+(ADDED|MODIFIED|REMOVED)\s*:?\s*$/i;
const ANY_H2 = /^##\s+(?!#)/;

const normalize = (text: string) => text.replace(/\r\n?/g, "\n");
const key = (name: string) => name.trim().toLowerCase();
const emptyDocument = (capability: string): RequirementDocument => ({
  capability,
  title: `${capability} requirements`,
  overview: "",
  intro: "",
  requirements: [],
  source: `# ${capability} requirements\n\n## Requirements\n`,
});

/** A display name: not empty, not absurdly long, no control characters. */
const displayNameError = (kind: string, name: string): string | undefined => {
  if (!name) return `${kind} needs a name`;
  if (name.length > 160) return `${kind} name is longer than 160 characters`;
  if (/[\u0000-\u001f\u007f]/.test(name)) return `${kind} name contains a control character`;
  return undefined;
};

interface RequirementDraft {
  name: string;
  line: number;
  invariant: string[];
  statement: string[];
  scenarios: ScenarioDraft[];
}

interface ScenarioDraft {
  name: string;
  line: number;
  body: Array<{ line: number; text: string }>;
}

const trimBlank = (lines: string[]): string => {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start].trim()) start++;
  while (end > start && !lines[end - 1].trim()) end--;
  return lines.slice(start, end).join("\n").trim();
};

/**
 * Parse the Requirement/Scenario blocks in lines [from, to). `mode` decides whether an empty
 * requirement is an error and whether scenarios are allowed. Structural violations are errors;
 * the returned requirements are the ones that could be read, for a partial report.
 */
function parseBlocks(lines: string[], blanked: string[], from: number, to: number, mode: RequirementGroup | "document", errors: string[]): { requirements: Requirement[]; intro: string } {
  const drafts: RequirementDraft[] = [];
  let current: RequirementDraft | undefined;
  let scenario: ScenarioDraft | undefined;
  const intro: string[] = [];

  const finishScenario = () => {
    if (!scenario) return;
    current?.scenarios.push(scenario);
    scenario = undefined;
  };
  const finishRequirement = () => {
    finishScenario();
    if (current) drafts.push(current);
    current = undefined;
  };

  for (let i = from; i < to; i++) {
    const raw = lines[i] ?? "";
    const text = blanked[i] ?? "";
    if (raw.trim() === "") {
      if (scenario) scenario.body.push({ line: i + 1, text: "" });
      else if (current) current.statement.push("");
      else intro.push("");
      continue;
    }
    // `blanked` is empty only inside a fence: structure is not code, and a requirement never is.
    if (text.trim() === "") {
      errors.push(`line ${i + 1}: fenced code isn't allowed inside the Requirements section; write statements and scenario criteria as plain lines`);
      continue;
    }
    if (ANY_H2.test(text)) break;
    if (/^#####\s+/.test(text)) {
      errors.push(`line ${i + 1}: use "### Requirement: <name>" and "#### Scenario: <name>"; deeper headings have no meaning here`);
      continue;
    }
    const scenarioHeading = text.match(/^####\s+(.+?)\s*$/);
    if (scenarioHeading) {
      finishScenario();
      if (!current) {
        errors.push(`line ${i + 1}: a Scenario must be inside a Requirement`);
        continue;
      }
      const parsed = scenarioHeading[1].match(/^Scenario\s*:\s*(.+)$/i);
      if (!parsed) {
        errors.push(`line ${i + 1}: "${text.trim()}" didn't parse as a scenario: write "#### Scenario: <name>"`);
        continue;
      }
      const name = parsed[1].trim();
      const bad = displayNameError("Scenario", name);
      if (bad) errors.push(`line ${i + 1}: ${bad}`);
      scenario = { name, line: i + 1, body: [] };
      continue;
    }
    const requirementHeading = text.match(/^###\s+(.+?)\s*$/);
    if (requirementHeading) {
      finishRequirement();
      const group = requirementHeading[1].match(/^(ADDED|MODIFIED|REMOVED)\s*:?\s*$/i);
      if (group) {
        errors.push(`line ${i + 1}: "${group[1].toUpperCase()}" belongs only in a spec's "## Requirements: <capability>" section, not in a living requirements file`);
        continue;
      }
      const parsed = requirementHeading[1].match(/^Requirement\s*:\s*(.+)$/i);
      if (!parsed) {
        errors.push(`line ${i + 1}: "${text.trim()}" didn't parse as a requirement: write "### Requirement: <name>"`);
        continue;
      }
      const name = parsed[1].trim();
      const bad = displayNameError("Requirement", name);
      if (bad) errors.push(`line ${i + 1}: ${bad}`);
      current = { name, line: i + 1, invariant: [], statement: [], scenarios: [] };
      continue;
    }
    const invariant = !scenario ? text.match(INVARIANT) : undefined;
    if (invariant) {
      if (!current) {
        errors.push(`line ${i + 1}: an "Invariant:" line must be inside a Requirement`);
        continue;
      }
      const rule = invariant[1].trim();
      if (!rule) errors.push(`line ${i + 1}: "Invariant:" needs the rule it states`);
      else if (current.invariant.length) errors.push(`line ${i + 1}: requirement "${current.name}" already has an Invariant line; keep one`);
      else current.invariant.push(rule);
      continue;
    }
    if (scenario) scenario.body.push({ line: i + 1, text: raw.trim() });
    else if (current) current.statement.push(raw.trim());
    else intro.push(raw.trim());
  }
  finishRequirement();

  const requirements: Requirement[] = [];
  const seen = new Map<string, number>();
  for (const draft of drafts) {
    const bad = displayNameError("Requirement", draft.name);
    if (bad) errors.push(`line ${draft.line}: ${bad}`);
    const duplicate = seen.get(key(draft.name));
    if (duplicate !== undefined) errors.push(`line ${draft.line}: requirement "${draft.name}" also appears at line ${duplicate}; requirement names must be unique`);
    else seen.set(key(draft.name), draft.line);

    const invariant = trimBlank(draft.invariant);
    const statement = trimBlank(draft.statement);
    if (mode !== "REMOVED" && !invariant && !statement) errors.push(`line ${draft.line}: requirement "${draft.name}" needs an "Invariant:" line (the rule to check) or a statement before its first Scenario`);

    const scenarioNames = new Map<string, number>();
    const scenarios: RequirementScenario[] = [];
    for (const s of draft.scenarios) {
      const scenarioBad = displayNameError("Scenario", s.name);
      if (scenarioBad) errors.push(`line ${s.line}: ${scenarioBad}`);
      const duplicateScenario = scenarioNames.get(key(s.name));
      if (duplicateScenario !== undefined) errors.push(`line ${s.line}: scenario "${s.name}" appears twice in "${draft.name}" (also line ${duplicateScenario})`);
      else scenarioNames.set(key(s.name), s.line);

      const criteria: ScenarioCriterion[] = [];
      for (const line of s.body) {
        if (!line.text.trim()) continue;
        const m = line.text.match(KEYWORD);
        if (!m) {
          errors.push(`line ${line.line}: "${line.text}" isn't a scenario criterion: write "- **WHEN** …" / "- **THEN** …" (GIVEN and AND allowed)`);
          continue;
        }
        criteria.push({ keyword: m[1].toUpperCase() as ScenarioKeyword, text: m[2].trim() });
      }
      if (mode !== "REMOVED") {
        if (!criteria.some((c) => c.keyword === "WHEN")) errors.push(`line ${s.line}: scenario "${s.name}" needs at least one **WHEN** line`);
        if (!criteria.some((c) => c.keyword === "THEN")) errors.push(`line ${s.line}: scenario "${s.name}" needs at least one **THEN** line`);
      }
      scenarios.push({ name: s.name, criteria });
    }

    if (mode === "REMOVED") {
      if (draft.scenarios.length) errors.push(`line ${draft.line}: REMOVED names the requirement only; remove its scenarios from the delta (they leave with the requirement)`);
      requirements.push({ name: draft.name, invariant, statement, scenarios: [] });
    } else {
      if (!draft.scenarios.length) errors.push(`line ${draft.line}: requirement "${draft.name}" needs at least one "#### Scenario:" so it can be checked`);
      requirements.push({ name: draft.name, invariant, statement, scenarios });
    }
  }
  return { requirements, intro: trimBlank(intro) };
}

/** Parse one living requirements document. Errors leave a partial document for reports. */
export function parseRequirementDocument(markdown: string, capability: string): { document: RequirementDocument; errors: string[] } {
  const md = normalize(markdown);
  const lines = md.split("\n");
  const blanked = blankFenced(md);
  const errors: string[] = [];
  const capError = KEBAB_NAME.test(capability) ? undefined : `"${capability}" is not a valid capability name: use short kebab-case, e.g. order-cancellation`;
  if (capError) errors.push(capError);

  const title = lines.find((_, i) => /^#\s+/.test(blanked[i]))?.replace(/^#\s+/, "").trim() || `${capability} requirements`;
  const overviewStarts = blanked.flatMap((l, i) => (sectionHeading("Overview").test(l) ? [i] : []));
  if (overviewStarts.length > 1) errors.push(`duplicate "## Overview" section: keep one`);
  const overviewAt = overviewStarts[0] ?? -1;
  let overview = "";
  if (overviewAt >= 0) {
    const rel = blanked.slice(overviewAt + 1).findIndex((l) => ANY_H2.test(l));
    const end = rel < 0 ? lines.length : overviewAt + 1 + rel;
    overview = trimBlank(lines.slice(overviewAt + 1, end));
  }
  const starts = blanked.flatMap((l, i) => (sectionHeading("Requirements").test(l) ? [i] : []));
  if (!starts.length) {
    errors.push(`missing the "## Requirements" section`);
    return { document: { capability, title, overview, intro: "", requirements: [], source: md }, errors };
  }
  if (starts.length > 1) errors.push(`duplicate "## Requirements" section: keep one`);
  const start = starts[0];
  const rel = blanked.slice(start + 1).findIndex((l) => ANY_H2.test(l));
  const end = rel < 0 ? lines.length : start + 1 + rel;
  const parsed = parseBlocks(lines, blanked, start + 1, end, "document", errors);
  return { document: { capability, title, overview, intro: parsed.intro, requirements: parsed.requirements, source: md }, errors };
}

/** Parse every "## Requirements: <capability>" delta section in a spec. */
export function parseRequirementDeltas(markdown: string): { deltas: RequirementDelta[]; errors: string[] } {
  const md = normalize(markdown);
  const lines = md.split("\n");
  const blanked = blankFenced(md);
  const errors: string[] = [];
  const deltas: RequirementDelta[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const text = blanked[i] ?? "";
    if (!ANY_H2.test(text)) continue;
    const heading = text.match(/^##\s+(.+?)\s*$/);
    if (!heading) continue;
    // OpenSpec-shaped headings are close enough to be worth naming, not silently ignoring.
    if (/^(?:ADDED|MODIFIED|REMOVED)\s+Requirements\b/i.test(heading[1])) {
      errors.push(`line ${i + 1}: "${text.trim()}" isn't a pb delta: write "## Requirements: <capability>" and put "### ${heading[1].split(/\s+/)[0].toUpperCase()}" inside it`);
      continue;
    }
    if (!/^Requirements\b/i.test(heading[1])) continue;
    const rel = blanked.slice(i + 1).findIndex((l) => ANY_H2.test(l));
    const end = rel < 0 ? lines.length : i + 1 + rel;

    const rest = heading[1].replace(/^Requirements\b/i, "").trim();
    if (!rest.startsWith(":")) {
      errors.push(`line ${i + 1}: "## Requirements" needs a capability: write "## Requirements: <capability>"`);
      continue;
    }
    const capability = rest.slice(1).trim();
    const capError = KEBAB_NAME.test(capability) ? undefined : `line ${i + 1}: ${displayNameError("capability", capability) ?? `"${capability}" is not a valid capability name: use short kebab-case, e.g. order-cancellation`}`;
    if (capError) {
      errors.push(capError);
      continue;
    }
    if (seen.has(capability)) {
      errors.push(`line ${i + 1}: capability "${capability}" has more than one "## Requirements:" section; keep one`);
      continue;
    }
    seen.add(capability);

    const parsed = parseGroups(lines, blanked, i + 1, end, capability, errors);
    deltas.push({ capability, overview: parsed.overview, groups: parsed.groups });
  }
  return { deltas, errors };
}

function parseGroups(lines: string[], blanked: string[], from: number, to: number, capability: string, errors: string[]): { groups: Array<{ kind: RequirementGroup; requirements: Requirement[] }>; overview?: string } {
  const markers: Array<{ at: number; kind: RequirementGroup }> = [];
  for (let i = from; i < to; i++) {
    const m = (blanked[i] ?? "").match(GROUP);
    if (m) markers.push({ at: i, kind: m[1].toUpperCase() as RequirementGroup });
  }

  let overview: string | undefined;
  for (let i = from; i < (markers[0]?.at ?? to); i++) {
    const text = (blanked[i] ?? "").trim();
    if (!text) continue;
    const m = text.match(/^Overview\s*:\s*(.*)$/i);
    if (m) {
      if (overview !== undefined) errors.push(`"## Requirements: ${capability}" has more than one Overview line; keep one`);
      else if (!m[1].trim()) errors.push(`"## Requirements: ${capability}" has an empty Overview; say what the capability is and what it refuses to do`);
      else if (/^\s*(#|```)/.test(m[1])) errors.push(`"## Requirements: ${capability}" Overview must be plain text, not a heading or a fence`);
      else overview = m[1].trim();
      continue;
    }
    errors.push(`"## Requirements: ${capability}" has text before its first group ("${text}"); write "Overview: <what the capability is>" or move it into a requirement`);
  }

  if (!markers.length) {
    errors.push(`"## Requirements: ${capability}" has no "### ADDED", "### MODIFIED" or "### REMOVED" group`);
    return { groups: [], overview };
  }

  const byKind = new Map<RequirementGroup, Requirement[]>();
  for (const [n, marker] of markers.entries()) {
    const next = markers[n + 1]?.at ?? to;
    const parsed = parseBlocks(lines, blanked, marker.at + 1, next, marker.kind, errors);
    if (parsed.intro.trim()) errors.push(`"${capability}" ${marker.kind} has text before its first Requirement ("${parsed.intro.split("\n")[0]}"); move it into a requirement`);
    if (!parsed.requirements.length) errors.push(`"${capability}" ${marker.kind} has no requirements`);
    byKind.set(marker.kind, [...(byKind.get(marker.kind) ?? []), ...parsed.requirements]);
  }
  return { groups: [...byKind].map(([kind, requirements]) => ({ kind, requirements })), overview };
}

/**
 * Plan every delta against the living files. `read` returns the living markdown or undefined when
 * the capability has no file yet. Any conflict is an error: nothing should be written.
 */
export function planRequirementDeltas(deltas: RequirementDelta[], read: (capability: string) => string | undefined): { plans: RequirementPlan[]; errors: string[] } {
  const plans: RequirementPlan[] = [];
  const errors: string[] = [];
  for (const delta of deltas) {
    const raw = read(delta.capability);
    const parsed = raw === undefined ? { document: emptyDocument(delta.capability), errors: [] } : parseRequirementDocument(raw, delta.capability);
    if (parsed.errors.length) {
      errors.push(...parsed.errors.map((e) => `${delta.capability}: ${e}`));
      continue;
    }
    const before = parsed.document;
    const existing = new Map(before.requirements.map((r) => [key(r.name), r]));
    const seen = new Map<string, RequirementGroup>();
    const added: Requirement[] = [];
    const modified: Requirement[] = [];
    const removed: Requirement[] = [];
    for (const group of delta.groups) {
      for (const requirement of group.requirements) {
        const name = key(requirement.name);
        const prior = seen.get(name);
        if (prior !== undefined) {
          errors.push(`${delta.capability}: requirement "${requirement.name}" appears in both ${prior} and ${group.kind}; one requirement, one group`);
          continue;
        }
        seen.set(name, group.kind);
        if (group.kind === "ADDED") {
          if (existing.has(name)) errors.push(`${delta.capability}: ADDED "${requirement.name}" already exists; use MODIFIED`);
          else added.push(requirement);
        } else if (group.kind === "MODIFIED") {
          if (!existing.has(name)) errors.push(`${delta.capability}: MODIFIED "${requirement.name}" does not exist; use ADDED`);
          else modified.push(requirement);
        } else if (!existing.has(name)) {
          errors.push(`${delta.capability}: REMOVED "${requirement.name}" does not exist; nothing to remove`);
        } else {
          removed.push(requirement);
        }
      }
    }

    const removedKeys = new Set(removed.map((r) => key(r.name)));
    const modifiedBy = new Map(modified.map((r) => [key(r.name), r]));
    const requirements = before.requirements.filter((r) => !removedKeys.has(key(r.name))).map((r) => modifiedBy.get(key(r.name)) ?? r);
    requirements.push(...added);

    const names = new Map<string, string>();
    for (const requirement of requirements) {
      const duplicate = names.get(key(requirement.name));
      if (duplicate !== undefined) errors.push(`${delta.capability}: the merged base would hold "${duplicate}" and "${requirement.name}" at once; requirement names must be unique`);
      else names.set(key(requirement.name), requirement.name);
    }
    if (!before.overview && !delta.overview) errors.push(`${delta.capability}: the living file has no Overview; write "Overview: <what the capability is and what it refuses to do>" in the delta`);
    if (errors.length) continue;

    const after: RequirementDocument = { ...before, overview: delta.overview ?? before.overview, requirements };
    plans.push({
      capability: delta.capability,
      before,
      after,
      markdown: renderRequirementDocument(after),
      added: added.map((r) => r.name),
      modified: modified.map((r) => r.name),
      removed: removed.map((r) => r.name),
    });
  }
  return { plans, errors };
}

/** Plan an archive's requirement merge from the spec's deltas and the store's living files. */
export function planArchiveRequirements(store: Store, markdown: string): { plans: RequirementPlan[]; errors: string[] } {
  const parsed = parseRequirementDeltas(markdown);
  if (parsed.errors.length) return { plans: [], errors: parsed.errors };
  if (!parsed.deltas.length) return { plans: [], errors: [] };
  return planRequirementDeltas(parsed.deltas, (capability) => store.readRequirementFile(capability));
}

/** Write-time check: the same rules the archive will apply, so a delta is never written already broken. */
export function requirementWriteErrors(store: Store, markdown: string): string[] {
  return planArchiveRequirements(store, markdown).errors;
}

/** The spec review checklist: the invariant first (R1.1), then one criterion per scenario (R1.2, R2.1, …). */
export interface RequirementCriterion {
  id: string;
  text: string;
  capability: string;
  requirement: string;
}

export function requirementCriteria(markdown: string): RequirementCriterion[] {
  const { deltas } = parseRequirementDeltas(markdown);
  const out: RequirementCriterion[] = [];
  let requirementIndex = 0;
  for (const delta of deltas) {
    for (const group of delta.groups) {
      if (group.kind === "REMOVED") continue;
      for (const requirement of group.requirements) {
        requirementIndex++;
        let criterionIndex = 0;
        // The rule is checked before its examples: an explicit Invariant line, or the statement it
        // was written as before invariants existed. Scenarios are evidence for the rule, not the rule.
        const invariant = (requirement.invariant || requirement.statement).replace(/\s+/g, " ").trim();
        if (invariant) {
          criterionIndex++;
          out.push({
            id: `R${requirementIndex}.${criterionIndex}`,
            text: `${requirement.name}: invariant — ${invariant}`,
            capability: delta.capability,
            requirement: requirement.name,
          });
        }
        for (const scenario of requirement.scenarios) {
          criterionIndex++;
          const criteria = scenario.criteria.map((c) => `${c.keyword} ${c.text}`).join("; ");
          out.push({
            id: `R${requirementIndex}.${criterionIndex}`,
            text: `${requirement.name}: ${scenario.name}${criteria ? ` — ${criteria}` : ""}`,
            capability: delta.capability,
            requirement: requirement.name,
          });
        }
      }
    }
  }
  return out;
}

/** The text a delta adds or changes, for the spec's semantic gates. */
export function requirementSurfaceText(markdown: string): string {
  const { deltas } = parseRequirementDeltas(markdown);
  return deltas
    .flatMap((delta) =>
      delta.groups
        .filter((group) => group.kind !== "REMOVED")
        .flatMap((group) =>
          group.requirements.flatMap((requirement) => [
            requirement.name,
            requirement.invariant,
            requirement.statement,
            ...requirement.scenarios.flatMap((scenario) => [scenario.name, ...scenario.criteria.map((c) => `${c.keyword} ${c.text}`)]),
          ]),
        ),
    )
    .join("\n");
}

/** A one-line delta summary for the write reply, or undefined when the spec has none. */
export function requirementDeltaSummary(markdown: string): string | undefined {
  const { deltas } = parseRequirementDeltas(markdown);
  if (!deltas.length) return undefined;
  return deltas
    .map((delta) => {
      const count = (kind: RequirementGroup) => delta.groups.find((g) => g.kind === kind)?.requirements.length ?? 0;
      return `${delta.capability} +${count("ADDED")} ~${count("MODIFIED")} -${count("REMOVED")}`;
    })
    .join(", ");
}

/** Render a requirement block in the canonical form the parser reads. */
function renderRequirement(requirement: Requirement): string {
  const parts = [`### Requirement: ${requirement.name}`];
  if (requirement.invariant.trim()) parts.push(`Invariant: ${requirement.invariant.trim()}`);
  if (requirement.statement.trim()) parts.push(requirement.statement.trim());
  for (const scenario of requirement.scenarios) {
    parts.push([`#### Scenario: ${scenario.name}`, ...scenario.criteria.map((c) => `- **${c.keyword}** ${c.text}`)].join("\n"));
  }
  return parts.join("\n\n");
}

/** Replace just the managed "## Requirements" section, preserving the title, intro and trailing sections. */
function replaceRequirementsSection(markdown: string, body: string): string {
  const md = normalize(markdown);
  const lines = md.split("\n");
  const blanked = blankFenced(md);
  const idx = blanked.findIndex((l) => sectionHeading("Requirements").test(l));
  const trimmed = body.trim();
  if (idx < 0) {
    const first = blanked.findIndex((l) => ANY_H2.test(l));
    const block = `## Requirements${trimmed ? `\n\n${trimmed}` : ""}`;
    if (first < 0) return `${md.trimEnd()}${md.trim() ? "\n\n" : ""}${block}\n`;
    const head = lines.slice(0, first).join("\n").replace(/\s*$/, "");
    const tail = lines.slice(first).join("\n").replace(/^\s*/, "");
    return `${head}${head ? "\n\n" : ""}${block.trimEnd()}\n\n${tail}`;
  }
  const rel = blanked.slice(idx + 1).findIndex((l) => ANY_H2.test(l));
  const end = rel < 0 ? lines.length : idx + 1 + rel;
  const head = lines.slice(0, idx + 1).join("\n").replace(/\s*$/, "");
  const tail = end < lines.length ? lines.slice(end).join("\n").replace(/^\s*/, "") : "";
  return `${head}${trimmed ? `\n\n${trimmed}` : ""}${tail ? `\n\n${tail}` : ""}\n`;
}

/** Replace (or add) the human entry point: a living file opens with its "## Overview". */
function replaceOverviewSection(markdown: string, overview: string): string {
  const md = normalize(markdown);
  const body = `## Overview\n\n${overview.trim()}`;
  const withoutOverview = (() => {
    const lines = md.split("\n");
    const blanked = blankFenced(md);
    const idx = blanked.findIndex((l) => sectionHeading("Overview").test(l));
    if (idx < 0) return md;
    const rel = blanked.slice(idx + 1).findIndex((l) => ANY_H2.test(l));
    const end = rel < 0 ? lines.length : idx + 1 + rel;
    return [...lines.slice(0, idx), ...lines.slice(end)].join("\n");
  })();
  const cleaned = normalize(withoutOverview);
  const lines = cleaned.split("\n");
  const blanked = blankFenced(cleaned);
  const requirementsAt = blanked.findIndex((l) => sectionHeading("Requirements").test(l));
  if (requirementsAt < 0) return `${cleaned.trimEnd()}${cleaned.trim() ? "\n\n" : ""}${body}\n`;
  const head = lines.slice(0, requirementsAt).join("\n").trimEnd();
  const tail = lines.slice(requirementsAt).join("\n").trimStart();
  return `${head ? `${head}\n\n` : ""}${body}\n\n${tail}\n`;
}

/** The whole living document after a merge, with its non-managed text untouched. */
export function renderRequirementDocument(document: RequirementDocument): string {
  const body = [document.intro.trim(), ...document.requirements.map(renderRequirement)].filter(Boolean).join("\n\n");
  const source = document.source.trim() ? document.source : emptyDocument(document.capability).source;
  const withRequirements = replaceRequirementsSection(source, body);
  const rendered = document.overview.trim() ? replaceOverviewSection(withRequirements, document.overview) : withRequirements;
  return `${rendered.trimEnd()}\n`;
}

/** A capability's living file, for reports: counts plus parse errors, never a throw. */
export interface RequirementInventoryEntry {
  capability: string;
  path: string;
  requirements: number;
  scenarios: number;
  errors: string[];
}

export function requirementInventory(store: Store): RequirementInventoryEntry[] {
  return store.requirementNames().map((capability) => {
    const parsed = parseRequirementDocument(store.readRequirementFile(capability) ?? "", capability);
    return {
      capability,
      path: store.requirementsRel(capability),
      requirements: parsed.document.requirements.length,
      scenarios: parsed.document.requirements.reduce((n, r) => n + r.scenarios.length, 0),
      errors: parsed.errors,
    };
  });
}

/**
 * Write every plan, remembering each file's exact earlier text. On a failure partway, already
 * written files are put back before the error escapes; the caller can roll back later too (for
 * the archive move, which happens after the writes).
 */
export function writeRequirementPlans(store: Store, plans: RequirementPlan[]): { rollback: () => string[] } {
  const written: Array<{ capability: string; file: string; before: string | undefined }> = [];
  const rollback = (): string[] => {
    const failures: string[] = [];
    for (const w of [...written].reverse()) {
      try {
        if (w.before === undefined) fs.rmSync(w.file, { force: true });
        else store.writeRequirementFile(w.capability, w.before);
      } catch (e) {
        failures.push(`${w.capability}: ${(e as Error).message}`);
      }
    }
    written.length = 0;
    return failures;
  };
  try {
    for (const plan of plans) {
      const file = store.requirementPath(plan.capability);
      const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
      store.writeRequirementFile(plan.capability, plan.markdown);
      written.push({ capability: plan.capability, file, before });
    }
  } catch (e) {
    const failures = rollback();
    throw new Error(`${(e as Error).message}${failures.length ? `; restoring the requirement base also failed: ${failures.join("; ")}` : "; every living requirements file was restored"}`);
  }
  return { rollback };
}
