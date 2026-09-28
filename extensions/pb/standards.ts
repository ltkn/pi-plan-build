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

- Quality: the best current practice for this stack: clean, maintainable, secure; a proper fix, never a workaround. Use modern idioms and the latest stable language and platform features, even where the surrounding code doesn't. When outdated code stands in the way, refactor it to current practice, planned as a task of its own.
- Dependencies: current, non-deprecated APIs and versions only. Upgrading dependencies is a change of its own, not part of a feature.
- Comments: concise, and only where they add what the code can't say (why, intent, constraints). They describe the code as it is, never its history: no dates, "decided", previous values or task ids; decisions stay in the spec.
- Tests: test behaviour, written to current best practice for this stack even where existing tests aren't; new test tooling is proposed as a task of its own. Never weaken an existing test. A test proves a fix only if it fails without it.
- Security: assume every entry point (API, UI action, command, message, file, webhook) will be abused by someone who controls its input, holds a stolen or another user's session, and replays or automates requests. Each operation checks who the caller is, what they may act on, and what they have proven; logic reused from another flow keeps that flow's preconditions (a write that is safe behind an emailed token is not safe behind a session alone). Security-relevant changes get tests for their abuse cases, written from the attacker's side.
- One source of truth: a rule or canonical form that already exists (in the database: normalization, uniqueness, constraints; or in a shared helper) is used, never re-implemented. Compare against the database's own form in SQL; a second copy of a rule drifts, and the gap between copies is a bypass.
- Robustness: at a boundary, assume input is hostile or broken (sizes, ranges, encodings, duplicates, order, concurrent calls); business rules can't be bypassed by quantity, repetition, reordering or racing; every request's work is bounded; a failure halfway leaves consistent state. Values that will be stored, compared or sent (addresses, identifiers, URLs) are validated strictly: no control characters or whitespace, and nothing that Unicode normalization would change. Inside the boundary, rely on invariants (types, constraints, transactions), not repeated checks.
- Consistency and concurrency come from the database: one request is one transaction on one connection. Use constraints, single atomic statements (\`ON CONFLICT\`, \`UPDATE … RETURNING\`) or row locks; not check-then-write in application code, retries, or extra transactions (\`REQUIRES_NEW\`), unless the reason is stated where it's used.
- Before calling a change done, re-read the diff as an attacker and as a race: a stolen session, a replayed or concurrent request, a look-alike or malformed input, a failure halfway. Search for existing copies of any rule you touched.
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

/** The stack-specific line added for a Java project (Maven or Gradle). */
export const JAVA_STANDARDS = "- Java 25: records, sealed types, pattern matching, virtual threads and scoped values; no Lombok.";

export const isJavaProject = (cwd: string) => ["pom.xml", "build.gradle", "build.gradle.kts"].some((f) => fs.existsSync(path.join(cwd, f)));

/** Append the default section to a context file (created if missing), with the Java line when `java`. */
export function addStandards(file: string, o: { java?: boolean } = {}): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const prev = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const section = o.java ? DEFAULT_STANDARDS.replace(END, `${JAVA_STANDARDS}\n${END}`) : DEFAULT_STANDARDS;
  fs.writeFileSync(file, `${prev}${prev && !prev.endsWith("\n\n") ? (prev.endsWith("\n") ? "\n" : "\n\n") : ""}${section}`);
}

/** True when the session's loaded context files already contain the standards (so prompts needn't repeat them). */
export function standardsLoaded(contextFiles: { content: string }[] | undefined): boolean {
  return !!contextFiles?.some((f) => f.content.includes(START));
}
