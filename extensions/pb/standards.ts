/**
 * Engineering standards live in AGENTS.md, which Pi loads into every session (planning,
 * building, your plain sessions, the reviewer's call). pb only offers once to add its
 * default section, marked so it can be found again, and never duplicates Pi's loading.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const START = "<!-- pb:standards -->";
const END = "<!-- /pb:standards -->";

export const DEFAULT_STANDARDS = `${START}
## Engineering standards

- Quality: the best current practice for this stack; clean, maintainable and secure; a proper fix, never a workaround. Prefer modern idioms, unless that would make the code inconsistent with its surroundings; then stay consistent and say so.
- Dependencies: use current, non-deprecated APIs; never add a deprecated API or an outdated version. Upgrading dependencies is a change of its own, not part of a feature.
- Comments: explain the code as it is (why, intent, constraints), never its history: no dates, "decided", previous values or task ids. Decisions stay in the spec. Match the surrounding comment density.
- Tests: test behaviour, in the project's existing style; never weaken an existing test.
${END}
`;

const CONTEXT_FILES = ["AGENTS.md", "CLAUDE.md"];

/** Pi's agent directory (global AGENTS.md lives there). */
export const agentDir = () => {
  const env = process.env.PI_CODING_AGENT_DIR;
  return env ? env.replace(/^~(?=$|\/)/, os.homedir()) : path.join(os.homedir(), ".pi", "agent");
};

/** The context files Pi would load for this directory: its own and its parents', then the agent directory's. */
function candidates(cwd: string): string[] {
  const out: string[] = [];
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    for (const f of CONTEXT_FILES) out.push(path.join(dir, f));
    if (path.dirname(dir) === dir) break;
  }
  for (const f of CONTEXT_FILES) out.push(path.join(agentDir(), f));
  return out;
}

/** Where pb's standards section is, and its text; undefined if none of the context files has it. */
export function findStandards(cwd: string): { file: string; text: string } | undefined {
  for (const file of candidates(cwd)) {
    let md: string;
    try {
      md = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const i = md.indexOf(START);
    if (i < 0) continue;
    const j = md.indexOf(END, i);
    return { file, text: md.slice(i + START.length, j < 0 ? undefined : j).trim() };
  }
  return undefined;
}

/** Append the default section to a context file (created if missing). */
export function addStandards(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const prev = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  fs.writeFileSync(file, `${prev}${prev && !prev.endsWith("\n\n") ? (prev.endsWith("\n") ? "\n" : "\n\n") : ""}${DEFAULT_STANDARDS}`);
}

/** True when the session's loaded context files already contain the standards (so prompts needn't repeat them). */
export function standardsLoaded(contextFiles: { content: string }[] | undefined): boolean {
  return !!contextFiles?.some((f) => f.content.includes(START));
}
