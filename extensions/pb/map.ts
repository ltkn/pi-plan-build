/**
 * The project map: a short section of the project's AGENTS.md (marked, apart from the standards and
 * from what you wrote) with what stays true across features: layout, patterns to follow, constraints,
 * test and build quirks. Pi loads AGENTS.md into every session, so every plan, build, review and
 * exploration starts with it instead of rediscovering it. pb proposes updates; you accept them.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const START = "<!-- pb:map -->";
const END = "<!-- /pb:map -->";
const HEADING = "## Project map";

/** Above this many lines the map is flagged as long (never rejected): it's read in every session. */
export const MAP_LINES = 60;

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

/** Paths the map names (in backticks, with a slash or a file extension), for a cheap existence check. */
export function mapPaths(body: string): string[] {
  const found = [...body.matchAll(/`([^`\s]+)`/g)]
    .map((m) => m[1].replace(/[:#].*$/, "").replace(/\/+$/, ""))
    .filter((p) => !p.startsWith("-") && !/^https?:/.test(p) && (p.includes("/") || /\.[a-z0-9]{1,6}$/i.test(p)) && !/[*?{}<>$]/.test(p));
  return [...new Set(found)];
}

/** The paths the map names that don't exist in the project. */
export const missingPaths = (cwd: string, body: string) => mapPaths(body).filter((p) => !fs.existsSync(path.resolve(cwd, p)));

/** Drop the lines that name a path that doesn't exist; returns the kept text and the dropped lines. */
export function dropMissing(cwd: string, body: string): { body: string; dropped: string[] } {
  const dropped: string[] = [];
  const kept = body.split("\n").filter((line) => {
    const bad = missingPaths(cwd, line).length > 0;
    if (bad) dropped.push(line.trim());
    return !bad;
  });
  return { body: kept.join("\n"), dropped };
}

/** A line diff: what's removed and added, in order. */
export function mapDiff(before: string, after: string): string[] {
  const a = before.split("\n").map((l) => l.trimEnd());
  const b = after.split("\n").map((l) => l.trimEnd());
  const inA = new Set(a);
  const inB = new Set(b);
  return [...a.filter((l) => l.trim() && !inB.has(l)).map((l) => `- ${l}`), ...b.filter((l) => l.trim() && !inA.has(l)).map((l) => `+ ${l}`)];
}

export const CARTOGRAPHER_SYSTEM = `You are a CARTOGRAPHER in a fresh context: you maintain the project map, a short section of AGENTS.md that every session of every coding agent reads before working in this project. It saves them from rediscovering the project.

Do not modify any file. Use read/grep/find/ls and bash only for inspection.

What belongs in the map: what stays true across features and saves exploration:
- Layout: the main modules and packages, one line each on their role; the entry points.
- Patterns to follow, by path (e.g. "a new endpoint: follow \`OrderController\` and \`OrderService\`").
- Constraints the code doesn't make obvious (e.g. "services own transactions; controllers never call repositories").
- Test and build quirks (e.g. "integration tests need Docker").
What doesn't: a feature's decisions or tasks, versions, history, anything one \`ls\` answers.

Revisit the whole map, not only the area just worked on: check every path and claim against the code as it is now, correct what changed, remove what is no longer true. Paths in backticks, relative to the project root. Terse lines grouped under a few "### " areas; about 60 lines at most: it is read in every session.

Report with the report_map tool: the whole new map (its body, without a top heading) and the list of changes, one line each.`;

export function cartographerBrief(o: { current: string; spec?: { name: string; findings: string }; changed?: string[]; focus?: string }): string {
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
