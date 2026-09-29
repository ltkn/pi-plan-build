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

/* Bullets both sections share; the others differ because a page has no database and no business rules. */
const QUALITY =
  "- Quality: the best current practice for this stack: clean, maintainable, secure; a proper fix, never a workaround. Use modern idioms and the latest stable language and platform features, even where the surrounding code doesn't. When outdated code stands in the way, refactor it to current practice, planned as a task of its own.";
const DEPENDENCIES = "- Dependencies: current, non-deprecated APIs and versions only. Upgrading dependencies is a change of its own, not part of a feature.";
const TESTS =
  "- Tests: test behaviour, written to current best practice for this stack even where existing tests aren't; new test tooling is proposed as a task of its own. Never weaken an existing test. A test proves a fix only if it fails without it.";
const SECURITY =
  "- Security: assume every entry point (API, UI action, command, message, file, webhook) will be abused by someone who controls its input, holds a stolen or another user's session, and replays or automates requests. Each operation checks who the caller is, what they may act on, and what they have proven; logic reused from another flow keeps that flow's preconditions (a write that is safe behind an emailed token is not safe behind a session alone). Security-relevant changes get tests for their abuse cases, written from the attacker's side. When something gains trust or changes hands (verified, accepted, promoted, transferred), whatever was set up before the proof by someone who hadn't proven anything (credentials, sessions, linked identities, settings) is discarded or re-proven, not inherited.";
const REREAD = (extra: string) =>
  `- Before calling a change done, re-read the diff as an attacker and as a race: a stolen session, a replayed or concurrent request, a look-alike or malformed input, an attacker who acted before the victim, a failure halfway${extra}. Search for existing copies of any rule you touched.`;

const section = (lines: string[]) => `${START}\n## Engineering standards\n\n${lines.join("\n")}\n${END}\n`;

export const DEFAULT_STANDARDS = section([
  QUALITY,
  DEPENDENCIES,
  `- Comments: concise, and only where they add what the code can't say (why, intent, constraints). They describe the code as it is, never its history: no dates, "decided", previous values or task ids; decisions stay in the spec.`,
  TESTS,
  SECURITY,
  "- One source of truth: a rule or canonical form that already exists (in the database: normalization, uniqueness, constraints; or in a shared helper) is used, never re-implemented. Compare against the database's own form in SQL; a second copy of a rule drifts, and the gap between copies is a bypass.",
  "- Robustness: at a boundary, assume input is hostile or broken (sizes, ranges, encodings, duplicates, order, concurrent calls); business rules can't be bypassed by quantity, repetition, reordering or racing; every request's work is bounded; a failure halfway leaves consistent state. Values that will be stored, compared or sent (addresses, identifiers, URLs) are validated strictly: no control characters or whitespace, and nothing that Unicode normalization would change. Inside the boundary, rely on invariants (types, constraints, transactions), not repeated checks.",
  "- Consistency and concurrency come from the database: one request is one transaction on one connection. Use constraints, single atomic statements (`ON CONFLICT`, `UPDATE … RETURNING`) or row locks; not check-then-write in application code, retries, or extra transactions (`REQUIRES_NEW`), unless the reason is stated where it's used. State transitions are guarded by the current state (`WHERE status = …`), so repeating one is a no-op and a fact recorded once (a verification or creation time) is never overwritten.",
  REREAD(""),
]);

/** For a Vue project: the page renders what the backend decides. */
export const FRONTEND_STANDARDS = section([
  QUALITY,
  DEPENDENCIES,
  `- Comments: explain why, never history (no dates, "decided", previous values or task ids). In these apps, maintained by backend (Java) developers, comments are deliberately dense: every platform-integration step (sessions, CSRF, redirects, problem types, where-to-go-next) says why it works that way.`,
  TESTS,
  SECURITY,
  `- One source of truth: every rule lives in the backend. The page never re-implements one (no length checks, no "same as current", no email checks, no trimming or normalizing): input is sent as typed, and a client copy would drift from the real rule.`,
  '- Frontend role: the page renders what the backend decides. No business rules on the page (validation, permissions, eligibility, where to go next): the backend checks every input and words every message, and a client-side copy of a rule is a second rule that drifts. State is minimal and justified: form inputs and presentation state; backend data lives in the query cache, never copied into stores. "No rules" is not "no UI quality": loading and disabled states, focus after errors, accessible messages (`aria-describedby`, `role="status"`), autocomplete hints, and clearing secrets from memory once sent are the page\'s job.',
  "- Backend refusals: RFC 9457 problem details. The page branches only on the stable `type`, and shows `detail` and `errors` as sent. It never infers meaning from the wording, the status code alone, or the body's shape (an empty `errors` is not a kind). An unknown or missing `type` falls back to `detail`, else a generic message. The page words only what the backend doesn't send: no answer at all (offline), rate limiting, and success texts for empty responses.",
  "- Browser security: sign-in is an HttpOnly session cookie. No tokens or secrets in JavaScript-readable storage. Writes carry the CSRF token fetched from the backend. Navigation goes only to backend-given `https` URLs or fixed route names, never to a URL taken from the query string (open redirect). Pages whose URL carries a token send no Referer. No `v-html` on backend or user data.",
  "- Vue: Vue 3.5 Composition API with `<script setup lang=\"ts\">`; TypeScript 6 (vue-tsc doesn't support 7); Vite; Vue Router; TanStack Vue Query for all backend reads and writes; Bootstrap 5.3 through Sass (tokens, `data-bs-theme` dark mode); Vitest with @vue/test-utils and jsdom, MSW for the dev fake backend; ESLint and Prettier; pnpm with a committed lockfile. Pinia only for client-only state that must outlive a route (such as a file the user picked), never as a cache of backend data.",
  "- Frontend tests: each page is tested through the real router against a scripted backend. They check what it sends (body, CSRF header) and how it renders each response `type` it handles, plus one unknown `type`.",
  REREAD(", a double click, a session that expires mid-edit, a URL from the query string"),
]);

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

export type Stack = "java" | "vue";

/** Java (Maven or Gradle) wins over Vue: a backend that also builds its pages keeps the backend's rules. */
export function projectStack(cwd: string): Stack | undefined {
  if (["pom.xml", "build.gradle", "build.gradle.kts"].some((f) => fs.existsSync(path.join(cwd, f)))) return "java";
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
    if (pkg.dependencies?.vue || pkg.devDependencies?.vue) return "vue";
  } catch {
    // no package.json, or not JSON: not a Vue project
  }
  return undefined;
}

/** Append the section for the stack to a context file (created if missing). */
export function addStandards(file: string, o: { stack?: Stack } = {}): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const prev = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const section = o.stack === "vue" ? FRONTEND_STANDARDS : o.stack === "java" ? DEFAULT_STANDARDS.replace(END, `${JAVA_STANDARDS}\n${END}`) : DEFAULT_STANDARDS;
  fs.writeFileSync(file, `${prev}${prev && !prev.endsWith("\n\n") ? (prev.endsWith("\n") ? "\n" : "\n\n") : ""}${section}`);
}

/** True when the session's loaded context files already contain the standards (so prompts needn't repeat them). */
export function standardsLoaded(contextFiles: { content: string }[] | undefined): boolean {
  return !!contextFiles?.some((f) => f.content.includes(START));
}
