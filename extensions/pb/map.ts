/**
 * The project map: a short section of the project's AGENTS.md (marked, apart from the standards and
 * from what you wrote) with what stays true across features: layout, patterns to follow, constraints,
 * test and build quirks. Pi loads AGENTS.md into every session, so every plan, build, review and
 * exploration starts with it instead of rediscovering it. pb proposes updates; you accept them.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const START = "<!-- pb:map -->";
const END = "<!-- /pb:map -->";
const HEADING = "## Project map";

/** The map's soft ceiling in tokens: it's read in every session, so it stays as short as the project allows. */
export const MAP_TOKENS = 20000;

export const mapFile = (cwd: string) => path.join(cwd, "AGENTS.md");

/** The map's body (without markers and heading), or "" when there is none yet. */
export function readMap(cwd: string): string {
  let md: string;
  try {
    md = fs.readFileSync(mapFile(cwd), "utf8");
  } catch {
    return "";
  }
  const i = md.indexOf(START);
  if (i < 0) return "";
  const j = md.indexOf(END, i);
  return md
    .slice(i + START.length, j < 0 ? undefined : j)
    .trim()
    .replace(new RegExp(`^${HEADING}\\s*\\n`), "")
    .trim();
}

/** Write the map's body into AGENTS.md: its section replaced, or appended (the file created if missing). */
export function writeMap(cwd: string, body: string): void {
  const file = mapFile(cwd);
  const section = `${START}\n${HEADING}\n\n${body.trim()}\n${END}\n`;
  const prev = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const i = prev.indexOf(START);
  const j = i < 0 ? -1 : prev.indexOf(END, i);
  const next =
    i >= 0 && j >= 0
      ? `${prev.slice(0, i)}${section.trimEnd()}${prev.slice(j + END.length)}`
      : `${prev}${prev && !prev.endsWith("\n\n") ? (prev.endsWith("\n") ? "\n" : "\n\n") : ""}${section}`;
  fs.writeFileSync(file, next.endsWith("\n") ? next : `${next}\n`);
}

/**
 * Paths the map names: backticked tokens with a slash or a file extension, without spaces, wildcards,
 * placeholders or calls. `module/Class` and package-relative paths count: they're resolved leniently.
 */
export function mapPaths(body: string): string[] {
  const found = [...body.matchAll(/`([^`\s]+)`/g)]
    .map((m) => m[1].replace(/[:#].*$/, "").replace(/\/+$/, ""))
    .filter(
      (p) =>
        p &&
        !p.startsWith("-") &&
        !/^[a-z]+:\/\//i.test(p) &&
        !p.includes("...") &&
        !/[*?{}<>$()=,;@]/.test(p) &&
        (p.includes("/") || /\.[a-z][a-z0-9]{0,5}$/i.test(p)) &&
        !/^\//.test(p), // "/signin/**" style routes aren't files
    );
  return [...new Set(found)];
}

/** The project's tracked (and untracked, not ignored) files, for resolving the map's paths. */
function projectFiles(cwd: string): string[] {
  try {
    return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] })
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Whether a path the map names exists: from the project root, under the path the section's heading names,
 * or as the end of a real path (with or without an extension: `auth/Login` finds `…/auth/Login.java`).
 */
function resolves(cwd: string, p: string, base: string | undefined, files: string[]): boolean {
  if (fs.existsSync(path.resolve(cwd, p)) || (base && fs.existsSync(path.resolve(cwd, base, p)))) return true;
  const tail = `/${p}`;
  return files.some((f) => {
    const g = `/${f}`;
    return g.endsWith(tail) || g.includes(`${tail}/`) || new RegExp(`${tail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.[a-z0-9]+$`, "i").test(g);
  });
}

/** The paths in the map that don't resolve, with the line naming each. */
export function unresolvedPaths(cwd: string, body: string, files = projectFiles(cwd)): { path: string; line: string }[] {
  const out: { path: string; line: string }[] = [];
  let base: string | undefined;
  for (const line of body.split("\n")) {
    if (/^#{1,6}\s/.test(line)) base = line.match(/\(([^()\s]+\/)\)/)?.[1];
    for (const p of mapPaths(line)) if (!resolves(cwd, p, base, files)) out.push({ path: p, line: line.trim() });
  }
  return out;
}

/** The paths the map names that don't exist (a cheap staleness check, no model call). */
export const missingPaths = (cwd: string, body: string) => [...new Set(unresolvedPaths(cwd, body).map((u) => u.path))];

/** Headings one level below the map's own, no empty headings, no runs of blank lines. */
export function normalizeMap(body: string): string {
  const lines = body
    .trim()
    .split("\n")
    .map((l) => l.replace(/^#{1,3}\s+/, "### ").trimEnd());
  const kept = lines.filter((l, i) => {
    if (!l.startsWith("### ")) return true;
    const next = lines.slice(i + 1).find((x) => x.trim());
    return !!next && !next.startsWith("### ");
  });
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
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

export const CARTOGRAPHER_SYSTEM = `You are a CARTOGRAPHER in a fresh context: you maintain the project map, a short section of AGENTS.md that every session of every coding agent reads before working in this project. It saves them from rediscovering the project — above all, from breaking an invariant the code doesn't make obvious at the call site.

Do not modify any file. Use read/grep/find/ls and bash only for inspection.

What belongs in the map: what stays true across features and saves exploration or prevents a mistake:
- Layout: the main modules and packages, one line each on their role; the entry points.
- Security and data invariants, in a "### Security invariants" section: for each, what must be true, and where it is actually enforced — the middleware, filter, helper, SQL, constraint, lock or transaction boundary that makes it true. Name the enforcement point, not the intent. Tag the security-critical ones "(security)", so they aren't read as mere conventions. Say what must stay in one transaction, and where a rule's single source of truth lives (don't reimplement it locally). Where a test proves the invariant, name the test (e.g. "Every request is tenant-scoped by \`TenantScopeFilter\` on \`/api/*\`; controllers must not query repositories directly — the filter, not the service, owns the check.").
- Where new code goes: for each kind of change the project keeps making (an endpoint, a page, a migration, a test), the files to touch and the existing one to copy (e.g. "a new endpoint: follow \`OrderController\` and \`OrderService\`").
- Only code that meets the project's engineering standards (its AGENTS.md, when it has them) is named as a pattern: agents copy what the map points to. Code that departs from them goes under "### Known gaps", one line each with its path; a gap stays listed until the code is fixed.
- Test and build: the exact commands as the project defines them (its manifest's scripts, its wrapper), the package manager its lockfile shows, and the quirks (e.g. "integration tests need Docker").
- A project doc the code contradicts: which one is right.

What doesn't: a feature's decisions or tasks, versions, history, anything one \`ls\` answers.

Say where to look and what isn't obvious, not how things work in detail: the code and the project's own docs hold the detail. Start with the overview.

Every claim comes from reading the code, never from a name, a comment or a doc — and for security or data claims, follow the call far enough to see the mechanism: the callers, shared helpers, filters, SQL and constraints the invariant actually depends on. Never write a verdict ("secure", "tenant-safe", "atomic", "non-enumerating") without naming the code that makes it true; if it's enforced indirectly, name the indirect point. Otherwise leave the claim out.

Revisit the whole map, not only the area just worked on: check every path, command and claim against the code as it is now, correct what changed, remove what is no longer true. Paths in backticks, relative to the project root. Short bullet lines, one idea each (no paragraphs), under a few "### " headings. It is read in every session: keep each line only if it saves a later feature a search or a mistake, and cut what the code, a file name or one \`ls\` already says. As long as the project needs, as short as it allows; about ${MAP_TOKENS.toLocaleString("en-US")} tokens at most.

Report with the report_map tool: the whole new map (its body, without a top heading) and the list of changes, one line each.`;

export function cartographerBrief(o: {
  current: string;
  spec?: { name: string; findings: string };
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
    ...(o.changed?.length ? ["", "# Files that feature changed", "", ...o.changed] : []),
    ...(o.focus ? ["", `# Focus: ${o.focus}`] : []),
  ].join("\n");
}

/** A spec's Findings section, the part of it that's about the project rather than the feature. */
export function findingsOf(markdown: string): string {
  return markdown.split(/^##\s+Findings\s*$/im)[1]?.split(/^##\s+(?!#)/m)[0]?.trim() ?? "";
}
