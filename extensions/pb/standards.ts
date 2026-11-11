/**
 * Engineering standards live in AGENTS.md, which Pi loads into every session (planning,
 * building, your plain sessions, the reviewer's call). pb only offers once to add its
 * default section, marked so it can be found again, and never duplicates Pi's loading.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { dependencyNames, readJsonManifest, readManifest } from "./manifest.ts";

const START = "<!-- pb:standards -->";
const END = "<!-- /pb:standards -->";

/* Bullets every section shares; the others differ because a page has no database and no business rules. */
const QUALITY =
  "- Quality: the best current practice for this stack: clean, maintainable, secure; a proper fix, never a workaround. Use modern idioms and the latest stable language and platform features, even where the surrounding code doesn't. When outdated code stands in the way, refactor it to current practice, planned as a task of its own.";
const SIMPLICITY =
  "- Simplicity: the smallest design that meets the need. No option, layer or abstraction without a second user or a stated reason; no near-copy of an existing helper; no code kept for a case nothing reaches. Less code is the default; every addition earns its place.";
const DEPENDENCIES = "- Dependencies: current, non-deprecated APIs and versions only. Upgrading dependencies is a change of its own, not part of a feature.";
const TESTS =
  "- Tests: test behaviour, written to current best practice for this stack even where existing tests aren't; new test tooling is proposed as a task of its own. Never weaken an existing test. A test proves a fix only if it fails without it.";
const SECURITY =
  "- Security: assume every entry point (API, UI action, command, message, file, webhook) will be abused by someone who controls its input, holds a stolen or another user's session, and replays or automates requests. Each operation checks who the caller is, what they may act on, and what they have proven; logic reused from another flow keeps that flow's preconditions (a write that is safe behind an emailed token is not safe behind a session alone). Security-relevant changes get tests for their abuse cases, written from the attacker's side. When something gains trust or changes hands (verified, accepted, promoted, transferred), whatever was set up before the proof by someone who hadn't proven anything (credentials, sessions, linked identities, settings) is discarded or re-proven, not inherited.";
const REREAD = (extra: string) =>
  `- Before calling a change done, re-read the diff as an attacker and as a race: a stolen session, a replayed or concurrent request, a look-alike or malformed input, an attacker who acted before the victim, a failure halfway${extra}. Search for existing copies of any rule you touched.`;

const section = (lines: string[]) => `${START}\n## Engineering standards\n\n${lines.join("\n")}\n${END}\n`;

/** The rules for any backend or library, whatever its language: the stack and database parts add to them. */
const CORE = [
  QUALITY,
  SIMPLICITY,
  DEPENDENCIES,
  `- Comments: concise, and only where they add what the code can't say (why, intent, constraints). They describe the code as it is, never its history: no dates, "decided", previous values or task ids; decisions stay in the spec.`,
  TESTS,
  SECURITY,
  "- One source of truth: a rule or canonical form that already exists (a shared helper, a type, a constraint) is used, never re-implemented: a second copy of a rule drifts, and the gap between copies is a bypass.",
  "- Robustness: at a boundary, assume input is hostile or broken (sizes, ranges, encodings, duplicates, order, concurrent calls); business rules can't be bypassed by quantity, repetition, reordering or racing; every request's work is bounded; a failure halfway leaves consistent state. Values that will be stored, compared or sent (addresses, identifiers, URLs) are validated strictly: no control characters or whitespace, and nothing that Unicode normalization would change. Inside the boundary, rely on invariants (types, constraints, transactions), not repeated checks.",
];

/** Only for a project with a SQL database: where its rules and its consistency come from. */
const DATABASE = [
  "- Database rules: normalization, uniqueness and constraints live in the database; compare against the database's own form in SQL, never a copy of it in application code.",
  "- Consistency and concurrency come from the database: one request is one transaction on one connection. Use constraints, single atomic statements (`ON CONFLICT`, `UPDATE … RETURNING`) or row locks; not check-then-write in application code, retries, or extra transactions (`REQUIRES_NEW`), unless the reason is stated where it's used. State transitions are guarded by the current state (`WHERE status = …`), so repeating one is a no-op and a fact recorded once (a verification or creation time) is never overwritten.",
];

/** The stack-specific line added for a Java project (Maven or Gradle). */
export const JAVA_STANDARDS = "- Java: the current LTS release, with records, sealed types, pattern matching, virtual threads and scoped values; no Lombok.";

/** The stack-specific lines added for a Rust project (Cargo). */
export const RUST_STANDARDS = [
  "- Rust: the stable toolchain and the current edition. Errors are typed (`thiserror` enums in libraries; `anyhow` with context only at a binary's edge) and propagated with `?`. No `unwrap`, `expect` or `panic!` outside tests, unless an invariant makes failure impossible and the `expect` message states it. No `unsafe` without a `// SAFETY:` comment proving the invariants it relies on. A validated value is a newtype built only by a fallible constructor (parse, don't validate); borrow rather than clone to satisfy the borrow checker.",
  "- Rust async and tooling: never block inside async code (`spawn_blocking` for blocking work) and never hold a lock across `.await`; `cargo clippy --all-targets -- -D warnings` and `cargo fmt --check` stay clean.",
];

/**
 * A backend section: the core, the database part when the project has one, the re-read, then the
 * stack's lines — last, so a shared core section stays a prefix of every stack's own.
 */
const backend = (database: boolean, stack: string[] = []) => section([...CORE, ...(database ? DATABASE : []), REREAD(""), ...stack]);

/** The section for a project with no stack detected and no database: the core alone. */
export const DEFAULT_STANDARDS = backend(false);

/** For a Vue project: the page renders what the backend decides. */
export const FRONTEND_STANDARDS = section([
  QUALITY,
  DEPENDENCIES,
  `- Comments: explain why, never history (no dates, "decided", previous values or task ids). Every platform-integration step (sessions, CSRF, redirects, problem types, where-to-go-next) says why it works that way.`,
  TESTS,
  SECURITY,
  `- One source of truth: every rule lives in the backend. The page never re-implements one (no length checks, no "same as current", no email checks, no trimming or normalizing): input is sent as typed, and a client copy would drift from the real rule.`,
  '- Frontend role: the page renders what the backend decides. No business rules on the page (validation, permissions, eligibility, where to go next): the backend checks every input and words every message, and a client-side copy of a rule is a second rule that drifts. State is minimal and justified: form inputs and presentation state; backend data lives in the query cache, never copied into stores. "No rules" is not "no UI quality": loading and disabled states, focus after errors, accessible messages (`aria-describedby`, `role="status"`), autocomplete hints, and clearing secrets from memory once sent are the page\'s job.',
  "- Backend refusals: RFC 9457 problem details. The page branches only on the stable `type`, and shows `detail` and `errors` as sent. It never infers meaning from the wording, the status code alone, or the body's shape (an empty `errors` is not a kind). An unknown or missing `type` falls back to `detail`, else a generic message. The page words only what the backend doesn't send: no answer at all (offline), rate limiting, and success texts for empty responses.",
  "- Browser security: sign-in is an HttpOnly session cookie. No tokens or secrets in JavaScript-readable storage. Writes carry the CSRF token fetched from the backend. Navigation goes only to backend-given `https` URLs or fixed route names, never to a URL taken from the query string (open redirect). Pages whose URL carries a token send no Referer. No `v-html` on backend or user data.",
  "- Vue: Vue 3 Composition API with `<script setup lang=\"ts\">`; TypeScript; Vite; Vue Router; TanStack Vue Query for all backend reads and writes; Bootstrap 5 through Sass (tokens, `data-bs-theme` dark mode); Vitest with @vue/test-utils and jsdom, MSW for the dev fake backend; ESLint and Prettier; pnpm with a committed lockfile. Pinia only for client-only state that must outlive a route (such as a file the user picked), never as a cache of backend data.",
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

/** Where pb's standards section is, and its text; undefined if none of the context files has it. Broken markers are skipped. */
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
    if (j < 0) continue;
    return { file, text: md.slice(i + START.length, j).trim() };
  }
  return undefined;
}

/** A stack's name: "java", "vue" and "rust" are built in; a template in templatesDir() can add any other. */
export type Stack = string;

/** Your own sections: <name>.md, optionally starting with "detect: go.mod, package.json:react". */
export const templatesDir = () => path.join(agentDir(), "pb", "standards");

interface Template {
  /** files at the project root, or "package.json:<dependency>"; none = never detected, only named */
  detect: string[];
  /** a built-in preset's opinions, named before anyone accepts it */
  assumes?: string;
  /** the section to write, given whether the project uses a SQL database (your templates ignore it) */
  section: (database: boolean) => string;
}

const BUILT_IN: Record<string, Template> = {
  java: { detect: ["pom.xml", "build.gradle", "build.gradle.kts"], section: (database) => backend(database, [JAVA_STANDARDS]), assumes: "Java's current LTS with records, sealed types and virtual threads, no Lombok" },
  vue: {
    detect: ["package.json:vue"],
    section: () => FRONTEND_STANDARDS,
    assumes: "the backend decides every rule; an HttpOnly session cookie with CSRF tokens; RFC 9457 problem details; TanStack Vue Query, Bootstrap through Sass, Vitest with MSW, pnpm",
  },
  rust: { detect: ["Cargo.toml"], section: (database) => backend(database, RUST_STANDARDS), assumes: "thiserror in libraries and anyhow at a binary's edge, no unwrap outside tests, clippy and fmt clean" },
  plain: { detect: [], section: (database) => backend(database) },
};

/** Your templates: a file's section is wrapped in pb's markers (and given a heading) unless it has them. */
function userTemplates(): Record<string, Template> {
  const out: Record<string, Template> = {};
  let files: string[] = [];
  try {
    files = fs.readdirSync(templatesDir()).filter((f) => /^[a-z0-9][a-z0-9-]*\.md$/.test(f));
  } catch {
    return out;
  }
  for (const f of files.sort()) {
    const name = f.slice(0, -3);
    let text = fs.readFileSync(path.join(templatesDir(), f), "utf8");
    const detect = text.match(/^detect:\s*(.*?)(?:\n|$)/i);
    if (detect) text = text.slice(detect[0].length);
    const body = text.trim();
    const section = body.includes(START) ? `${body}\n` : `${START}\n${/^## /.test(body) ? "" : "## Engineering standards\n\n"}${body}\n${END}\n`;
    out[name] = { detect: detect ? detect[1].split(",").map((d) => d.trim()).filter(Boolean) : (BUILT_IN[name]?.detect ?? []), section: () => section };
  }
  return out;
}

/** Every stack, yours first: yours replace a built-in of the same name. */
function templates(): [string, Template][] {
  const mine = userTemplates();
  return [...Object.entries(mine), ...Object.entries(BUILT_IN).filter(([n]) => !(n in mine))];
}

export const stackNames = () => templates().map(([n]) => n);

/**
 * pb's presets are opinionated on purpose — a concrete rule steers a model, a bland one doesn't — so what one
 * assumes is said before it is accepted, with where your own goes instead. Empty for your templates and the plain section.
 */
export const presetNote = (stack?: Stack): string => {
  if (!stack || isUserTemplate(stack)) return "";
  const assumes = BUILT_IN[stack]?.assumes;
  return assumes ? `pb's ${stack} preset is opinionated: ${assumes}. To use your own instead, put it in ${path.join(templatesDir(), `${stack}.md`)}.` : "";
};

/** True when it's your template rather than pb's. */
export const isUserTemplate = (stack: string) => stack in userTemplates();

const detects = (cwd: string, d: string) => {
  const [file, dep] = d.split(":");
  if (!dep) return fs.existsSync(path.join(cwd, file));
  return dependencyNames(readJsonManifest(cwd, file)).includes(dep);
};

/** The first stack whose detection matches, yours before pb's; Java before Vue: a backend that also builds its pages keeps the backend's rules. */
export function projectStack(cwd: string): Stack | undefined {
  return templates().find(([n, t]) => n !== "plain" && t.detect.some((d) => detects(cwd, d)))?.[0];
}

/** npm packages that mean a SQL database. */
const SQL_PACKAGES = new Set(["pg", "postgres", "mysql", "mysql2", "sqlite3", "better-sqlite3", "@prisma/client", "prisma", "typeorm", "sequelize", "knex", "drizzle-orm", "kysely", "mssql", "oracledb", "@neondatabase/serverless"]);

/** Per manifest, the libraries that mean a SQL database (matched as whole names in the file's text). */
const SQL_MANIFESTS: Array<[string, RegExp]> = [
  ["Cargo.toml", /^\s*(?:sqlx|diesel|sea-orm|tokio-postgres|postgres|rusqlite|mysql_async|deadpool-postgres|bb8-postgres)\s*=/m],
  ["pom.xml", /<artifactId>[^<]*(?:jdbc|jpa|hibernate|jooq|r2dbc|mybatis|flyway|liquibase|postgresql|mysql-connector|mariadb|sqlite-jdbc)[^<]*<\/artifactId>/i],
  ["build.gradle", /(?:jdbc|jpa|hibernate|jooq|r2dbc|mybatis|flyway|liquibase|postgresql|mysql-connector|mariadb|sqlite-jdbc)/i],
  ["build.gradle.kts", /(?:jdbc|jpa|hibernate|jooq|r2dbc|mybatis|flyway|liquibase|postgresql|mysql-connector|mariadb|sqlite-jdbc|exposed)/i],
  ["go.mod", /(?:github\.com\/(?:lib\/pq|jackc\/pgx|go-sql-driver\/mysql|mattn\/go-sqlite3|jmoiron\/sqlx)|gorm\.io\/|entgo\.io\/|modernc\.org\/sqlite)/],
  ["pyproject.toml", /\b(?:sqlalchemy|psycopg2?|asyncpg|django|sqlmodel|peewee|pymysql|aiosqlite|tortoise-orm)\b/i],
  ["requirements.txt", /^(?:sqlalchemy|psycopg2?(?:-binary)?|asyncpg|django|sqlmodel|peewee|pymysql|aiosqlite|tortoise-orm)\b/im],
];

/** Directories that hold schema migrations, in the usual layouts. */
const MIGRATION_DIRS = ["migrations", "db/migrate", "db/migrations", "src/main/resources/db/migration", "src/main/resources/db/changelog", "prisma/migrations"];

/** True when the project uses a SQL database: a driver or ORM in a manifest, or a migrations directory. */
export function usesDatabase(cwd: string): boolean {
  if (dependencyNames(readJsonManifest(cwd)).some((n) => SQL_PACKAGES.has(n))) return true;
  if (SQL_MANIFESTS.some(([file, pattern]) => pattern.test(readManifest(path.join(cwd, file)) ?? ""))) return true;
  return MIGRATION_DIRS.some((dir) => {
    try {
      return fs.statSync(path.join(cwd, dir)).isDirectory();
    } catch {
      return false;
    }
  });
}

/** The section written for a stack (none = plain), with the database part when the project uses one. */
export const sectionFor = (stack?: Stack, database = false) => {
  const all = Object.fromEntries(templates());
  return (all[stack ?? "plain"] ?? all.plain).section(database);
};

/**
 * Put the stack's section in a context file: created if missing, pb's section replaced if it has one,
 * else appended. Nothing else in the file changes. "broken": a start marker without its end, left alone.
 */
export function writeStandards(file: string, stack?: Stack, database = false): "created" | "added" | "replaced" | "unchanged" | "broken" {
  const section = sectionFor(stack, database);
  const prev = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
  const i = prev?.indexOf(START) ?? -1;
  if (prev !== undefined && i >= 0) {
    const j = prev.indexOf(END, i);
    if (j < 0) return "broken";
    const head = prev.slice(0, i).replace(/\s*$/, "");
    const tail = prev.slice(j + END.length).replace(/^\s*/, "");
    const next = `${head ? `${head}\n\n` : ""}${section.trimEnd()}${tail ? `\n\n${tail}` : "\n"}`;
    if (next === prev) return "unchanged";
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, next, "utf8");
    fs.renameSync(tmp, file);
    return "replaced";
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const before = prev ?? "";
  const out = `${before}${before && !before.endsWith("\n\n") ? (before.endsWith("\n") ? "\n" : "\n\n") : ""}${section}`;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, out, "utf8");
  fs.renameSync(tmp, file);
  return prev === undefined ? "created" : "added";
}

/** True when the session's loaded context files already contain the standards (so prompts needn't repeat them). */
export function standardsLoaded(contextFiles: { content: string }[] | undefined): boolean {
  return !!contextFiles?.some((f) => f.content.includes(START));
}
