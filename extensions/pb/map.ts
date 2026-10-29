/**
 * The project map: a short section of the project's AGENTS.md (marked, apart from the standards and
 * from what you wrote) with what stays true across features: layout, patterns to follow, constraints,
 * test and build quirks. Pi loads AGENTS.md into every session, so every plan, build, review and
 * exploration starts with it instead of rediscovering it. pb proposes updates; you accept them.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { isFence, safeBlock } from "./markdown.ts";
import type { ReviewLedgerEntry } from "./store.ts";

const START = "<!-- pb:map -->";
const END = "<!-- /pb:map -->";
const HEADING = "## Project map";

/** The map's soft ceiling in tokens: it's read in every session, so it stays as short as the project allows. */
export const MAP_TOKENS = 20000;

export const mapFile = (cwd: string) => path.join(cwd, "AGENTS.md");

/** pb's own markers around the map section, so a message can name them without a second copy of them. */
export const MAP_MARKERS = { start: START, end: END } as const;

/** Which of pb's own map markers a line is: only a line of its own is one, prose naming a marker is not. */
const markerOf = (line: string): string | undefined => {
  const t = line.trim();
  return t === START ? START : t === END ? END : undefined;
};

/** The map section's own marker lines: its start and end, as indexes into `lines`. */
interface MapSection {
  start: number;
  end: number;
}

/** Why the map section's markers can't be resolved: which marker, on which line (1-based). */
export interface MapDefect {
  marker: string;
  line: number;
}

/**
 * Locate the map section, or say why it can't be located. Marker lines count only where the file's own
 * fence state says they are prose, and that state is counted from line 0 the way every other markdown
 * reader here counts it: a marker shown inside a properly fenced example stays documentation wherever
 * the example sits, above pb's section as well as inside it. Only a file whose fences never close is read
 * blind to fences, and only when that leaves no marker outside a fence at all — where one survives, the
 * file's own fence state stands, and a section that still won't close is reported, never guessed at.
 */
function resolveMap(md: string): { section?: MapSection; defect?: MapDefect } {
  const lines = md.split("\n");
  const scan = (fenceAware: boolean) => {
    const marks: number[] = [];
    let inFence = false;
    for (let i = 0; i < lines.length; i++) {
      if (isFence(lines[i])) {
        if (fenceAware) inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      if (markerOf(lines[i])) marks.push(i);
    }
    return { marks, fenceOpenAtEnd: inFence };
  };
  const endOf = (marks: number[]) => marks.slice(1).find((i) => markerOf(lines[i]) === END);
  const aware = scan(true);
  // A ``` the author left open is trusted only where it leaves pb nothing to read: fences unbalanced at
  // the last line and no marker outside a fence at all — the fence swallowed pb's whole section, and
  // reading such a file blind to fences beats a refusal that blames pb's check for a fence pb never wrote.
  // Where the fence-aware pass did find a marker, the file's own fence state is the one pb uses: falling
  // back then would land on markers a documented example shows, and pb would rewrite the example instead
  // of its section. Markers sitting only inside properly closed examples are documentation: the file has
  // no map section yet.
  const marks = aware.fenceOpenAtEnd && aware.marks.length === 0 ? scan(false).marks : aware.marks;
  if (!marks.length) return {}; // no map section yet: nothing to resolve, and nothing to refuse
  if (markerOf(lines[marks[0]]) !== START) return { defect: { marker: END, line: marks[0] + 1 } }; // an end with no start: nobody's section
  const end = endOf(marks);
  if (end === undefined) return { defect: { marker: END, line: marks[0] + 1 } }; // a start whose end never turns up
  const stray = marks.find((i) => i > end);
  if (stray !== undefined) return { defect: { marker: markerOf(lines[stray])!, line: stray + 1 } }; // a second one: prose or map text, pb can't tell
  return { section: { start: marks[0], end } };
}

/** AGENTS.md as it stands, or "" when the project has none yet. */
const mapText = (cwd: string): string => {
  try {
    return fs.readFileSync(mapFile(cwd), "utf8");
  } catch {
    return "";
  }
};

/**
 * Why this project's map section can't be read: the marker pb would have to trust is missing or
 * stands twice. pb writes nothing into a section it can't resolve — once a marker sits inside its own
 * section, the author's prose and pb's map text are indistinguishable. Undefined when the markers
 * resolve, or the project has no map section yet.
 */
export function mapDefect(cwd: string): MapDefect | undefined {
  return resolveMap(mapText(cwd)).defect;
}

/** The map's body (without markers and heading), or "" when there is none yet or its markers can't be resolved. */
export function readMap(cwd: string): string {
  const md = mapText(cwd);
  const { section } = resolveMap(md);
  if (!section) return "";
  return md
    .split("\n")
    .slice(section.start + 1, section.end)
    .join("\n")
    .trim()
    .replace(new RegExp(`^${HEADING}\\s*\\n`), "")
    .trim();
}

/**
 * Write the map's body into AGENTS.md: its section replaced, or appended (the file created if missing).
 * Returns whether it wrote: a section whose markers can't be resolved is left exactly as it is, because
 * replacing what pb can't read would delete the author's own text with no way back.
 */
export function writeMap(cwd: string, body: string): boolean {
  const file = mapFile(cwd);
  const prev = mapText(cwd);
  const { section, defect } = resolveMap(prev);
  if (defect) return false;
  const lines = prev.split("\n");
  const block = `${START}\n${HEADING}\n\n${normalizeMap(body)}\n${END}\n`;
  const next = section
    ? [...lines.slice(0, section.start), block.trimEnd(), ...lines.slice(section.end + 1)].join("\n")
    : `${prev}${prev && !prev.endsWith("\n\n") ? (prev.endsWith("\n") ? "\n" : "\n\n") : ""}${block}`;
  const out = next.endsWith("\n") ? next : `${next}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, out, "utf8");
  fs.renameSync(tmp, file);
  return true;
}

/** Root-level files without an extension that are still files, not routes. */
const ROOT_FILES = /^(Makefile|Dockerfile|LICENSE|README|CHANGELOG|CONTRIBUTING|Gemfile|Rakefile|Procfile|go\.mod|go\.sum|package\.json|tsconfig\.json|pom\.xml|build\.gradle(?:\.kts)?)$/i;

/**
 * Paths the map names: backticked tokens with a slash, a file extension, or a known root file;
 * without spaces, wildcards, placeholders or calls. `module/Class` and package-relative paths count.
 */
export function mapPaths(body: string): string[] {
  const found = [...body.matchAll(/`([^`\s]+)`/g)]
    .map((m) => m[1].replace(/^\/+/, "").replace(/[:#].*$/, "").replace(/\/+$/, ""))
    .filter(
      (p) =>
        p &&
        !p.startsWith("-") &&
        !/^[a-z]+:\/\//i.test(p) &&
        !p.includes("...") &&
        !/[*?{}<>$()=,;@]/.test(p) &&
        (p.includes("/") || /\.[a-z][a-z0-9]{0,10}$/i.test(p) || ROOT_FILES.test(p)),
    );
  return [...new Set(found)];
}

/** The project's tracked (and untracked, not ignored) files, for resolving the map's paths. */
export function projectFiles(cwd: string): string[] {
  try {
    return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] })
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * The absolute path a project-relative path names: from the project root, or as the end of a
 * tracked/untracked path (with or without an extension: `auth/Login` finds `…/auth/Login.java`).
 * Undefined when nothing matches. Unlike `resolves`, this answers with the file so callers can
 * inspect it (for example, count its lines).
 */
export function resolveProjectPath(cwd: string, p: string, files = projectFiles(cwd)): string | undefined {
  const direct = path.resolve(cwd, p);
  if (fs.existsSync(direct)) return direct;
  const tail = `/${p.toLowerCase()}`;
  const esc = tail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = files.find((f) => {
    const g = `/${f.toLowerCase()}`;
    return g.endsWith(tail) || g.includes(`${tail}/`) || new RegExp(`${esc}\\..+$`, "").test(g);
  });
  return match ? path.resolve(cwd, match) : undefined;
}

/**
 * Whether a path the map names exists: from the project root, under the path the section's heading names,
 * or as the end of a real path.
 */
function resolves(cwd: string, p: string, base: string | undefined, files: string[]): boolean {
  if (fs.existsSync(path.resolve(cwd, p)) || (base && fs.existsSync(path.resolve(cwd, base, p)))) return true;
  return resolveProjectPath(cwd, p, files) !== undefined;
}

/** The paths in the map that don't resolve, with the line naming each. Code fences aren't paths. */
export function unresolvedPaths(cwd: string, body: string, files = projectFiles(cwd)): { path: string; line: string }[] {
  const out: { path: string; line: string }[] = [];
  let base: string | undefined;
  let inFence = false;
  for (const line of body.split("\n")) {
    if (isFence(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^#{1,6}\s/.test(line)) base = line.match(/\(([^()\s]+\/)\)/)?.[1];
    for (const p of mapPaths(line)) if (!resolves(cwd, p, base, files)) out.push({ path: p, line: line.trim() });
  }
  return out;
}

/** The paths the map names that don't exist (a cheap staleness check, no model call). */
export const missingPaths = (cwd: string, body: string) => [...new Set(unresolvedPaths(cwd, body).map((u) => u.path))];

/**
 * The guarantee for every body pb writes into the map: no control character, no tab (each one a single
 * space, so no line becomes an indented code block) and no comment marker, with the words left alone.
 * The neutraliser runs again on the result, so the guarantee is this function's own, not one it inherits
 * from its input. Headings sit one level below the map's own, no empty headings, no runs of blank lines.
 */
export function normalizeMap(body: string): string {
  const lines = safeBlock(body)
    .split("\n")
    .map((l) => l.replace(/^#{1,3}\s+/, "### ").trimEnd());
  const kept = lines.filter((l, i) => {
    if (!l.startsWith("### ")) return true;
    const next = lines.slice(i + 1).find((x) => x.trim());
    return !!next && !next.startsWith("### ");
  });
  return safeBlock(kept.join("\n")).replace(/\n{3,}/g, "\n\n").trim();
}

/** Rough token count (4 characters a token). */
export const mapTokens = (body: string) => Math.round(body.length / 4);

/** A line diff: what's removed and added, in order. */
export function mapDiff(before: string, after: string): string[] {
  const a = before.split("\n").map((l) => l.trimEnd());
  const b = after.split("\n").map((l) => l.trimEnd());
  const inA = new Set(a);
  const inB = new Set(b);
  return [...a.filter((l) => l.trim() && !inB.has(l)).map((l) => `- ${l}`), ...b.filter((l) => l.trim() && !inA.has(l)).map((l) => `+ ${l}`)];
}

/** Widget phase for the cartographer's repair pass: what it's fixing, so a long run doesn't look stuck. */
export function mapRepairPhase(unresolved: number, overBy: number): string {
  const paths = unresolved > 0 ? `checking ${unresolved} path${unresolved === 1 ? "" : "s"}` : "";
  const budget = overBy > 0 ? `trimming ${overBy.toLocaleString("en-US")} tokens` : "";
  return [paths, budget].filter(Boolean).join(" and ");
}

export const CARTOGRAPHER_SYSTEM = `You are a CARTOGRAPHER in a fresh context: you maintain the project map, a short section of AGENTS.md that every session of every coding agent reads before working in this project. It saves them from rediscovering the project — above all, from breaking an invariant the code doesn't make obvious at the call site.

Do not modify any file. Use read/grep/find/ls and bash only for inspection.

Its readers are capable models that explore fast: what a directory listing, a file name, a manifest or one grep shows, they find in seconds, so it has no place here. The map holds what they would still miss or get wrong after exploring: what stays true across features and isn't visible where they are working.

What belongs in the map:
- Security and data invariants, in a "### Security invariants" section: for each, what must be true, and where it is actually enforced — the middleware, filter, helper, SQL, constraint, lock or transaction boundary that makes it true. Name the enforcement point, not the intent. Tag the security-critical ones "(security)", so they aren't read as mere conventions. Say what must stay in one transaction, and where a rule's single source of truth lives (don't reimplement it locally). Where a test proves the invariant, name the test (e.g. "Every request is tenant-scoped by \`TenantScopeFilter\` on \`/api/*\`; controllers must not query repositories directly — the filter, not the service, owns the check.").
- Where new code goes: for each kind of change the project keeps making (an endpoint, a page, a migration, a test), the files to touch and the existing one to copy (e.g. "a new endpoint: follow \`OrderController\` and \`OrderService\`").
- Only code that meets the project's engineering standards (its AGENTS.md, when it has them) is named as a pattern: agents copy what the map points to. Code that departs from them goes under "### Known gaps", one line each with its path; a gap stays listed until the code is fixed.
- Test and build: the exact commands as the project defines them (its manifest's scripts, its wrapper), the package manager its lockfile shows, and the quirks (e.g. "integration tests need Docker").
- A project doc the code contradicts: which one is right.
- Layout, only where exploring misleads: a module whose name doesn't say what it is for, and entry points a search won't find (wiring by convention, generated code, routes or jobs declared in configuration). No module-by-module tour.

What doesn't: a feature's decisions or tasks, versions, history, anything one \`ls\` or grep answers.

Say where to look and what isn't obvious, not how things work in detail: the code and the project's own docs hold the detail. Start with the security invariants.

Every claim comes from reading the code, never from a name, a comment or a doc — and for security or data claims, follow the call far enough to see the mechanism: the callers, shared helpers, filters, SQL and constraints the invariant actually depends on. Review findings in a brief are leads, not evidence: check each against the code as it is now, and leave out one that no longer holds or that a later review resolved. Never write a verdict ("secure", "tenant-safe", "atomic", "non-enumerating") without naming the code that makes it true; if it's enforced indirectly, name the indirect point. Otherwise leave the claim out.

Revisit the whole map, not only the area just worked on: check every path, command and claim against the code as it is now, correct what changed, remove what is no longer true. Paths in backticks, relative to the project root. Short bullet lines, one idea each (no paragraphs), under a few "### " headings. Every area heading carries its path prefix, e.g. "### Levels (src/main/java/ark/ai/regime/levels/)", so a later session reads only the headings covering the paths it touches; "### Security invariants" carries none, it is read in full every time. It is read in every session: keep each line only if it saves a later feature a search or a mistake, and cut what the code, a file name or one \`ls\` already says. As long as the project needs (a small project may need a few lines), as short as it allows; about ${MAP_TOKENS.toLocaleString("en-US")} tokens at most.

Report with the report_map tool: the whole new map (its body, without a top heading) and the list of changes, one line each.`;

export function cartographerBrief(o: {
  current: string;
  spec?: { name: string; findings: string };
  /** P0–P2 findings from completed reviews: leads to verify, never evidence to copy. */
  reviewFindings?: ReviewLedgerEntry[];
  changed?: string[];
  focus?: string;
  unresolved?: { path: string; line: string }[];
  /** tokens over MAP_TOKENS */
  overBy?: number;
  proposed?: string;
}): string {
  if (o.proposed)
    return [
      "# Your proposed map",
      "",
      o.proposed,
      ...(o.unresolved?.length
        ? [
            "",
            "# Paths in it that don't resolve",
            "",
            "Each of these names nothing in the project (tried from the root, under the section's path, and as the end of a real path). Correct each one to a path that exists (from the project root), or remove it.",
            "",
            ...o.unresolved.map((u) => `- \`${u.path}\` in: ${u.line.slice(0, 200)}`),
          ]
        : []),
      ...(o.overBy
        ? [
            "",
            "# Over the budget",
            "",
            `It is about ${o.overBy.toLocaleString("en-US")} tokens over the ${MAP_TOKENS.toLocaleString("en-US")} budget. Cut the lines that save a later feature the least (what a file name or one \`ls\` says, detail the code holds); keep every security invariant with its enforcement point, and every known gap.`,
          ]
        : []),
      "",
      "Change only what the above asks; keep everything else as it is. Report the whole map again with report_map.",
    ].join("\n");
  return [
    "# The current map",
    "",
    o.current || "(none yet: write the first one)",
    ...(o.spec ? ["", `# The feature just finished: ${o.spec.name}`, "", "What its planning established (its Findings; the code may have changed since):", "", o.spec.findings || "(no Findings section)"] : []),
    ...(o.reviewFindings?.length
      ? [
          "",
          `# Review findings for ${o.spec?.name ?? "this feature"} (leads, not evidence)`,
          "",
          "An independent review of this change reported these. Each is a lead: verify it against the code as it is now before using it; leave out one that no longer holds or that a later review resolved. The map needs what stays true, not the finding itself.",
          "",
          ...o.reviewFindings.map(
            (f) => `- [${f.priority}${f.outside ? " · outside the change" : ""}] ${f.file ? `${f.file}${f.line ? `:${f.line}` : ""} — ` : ""}${f.title}${f.count > 1 ? ` (reported ${f.count} times)` : ""}${f.fix ? `\n  Fix: ${f.fix}` : ""}`,
          ),
        ]
      : []),
    ...(o.changed?.length ? ["", "# Files that feature changed", "", ...o.changed] : []),
    ...(o.focus ? ["", `# Focus: ${o.focus}`] : []),
  ].join("\n");
}

/** A spec's Findings section, the part of it that's about the project rather than the feature. Fence-aware. */
export function findingsOf(markdown: string): string {
  const lines = markdown.split("\n");
  const blanked: string[] = [];
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (isFence(line)) {
      inFence = !inFence;
      blanked.push("");
      continue;
    }
    blanked.push(inFence ? "" : line);
  }
  const idx = blanked.findIndex((l) => /^##\s+Findings\s*:?\s*$/i.test(l));
  if (idx < 0) return "";
  const rel = blanked.slice(idx + 1).findIndex((l) => /^##\s+(?!#)/.test(l));
  const end = rel < 0 ? lines.length : idx + 1 + rel;
  return lines.slice(idx + 1, end).join("\n").trim();
}
