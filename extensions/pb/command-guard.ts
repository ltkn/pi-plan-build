/**
 * The rules pb applies to a shell command before Pi runs it, in one place: pb's own sessions (hooks.ts) and the
 * pb_explore / pb_try processes (fresh-guard.ts) read the same functions. Pure: no Pi, no I/O.
 *
 * - How long a command may run: the project's own long commands (its suite, compile, lint, extra checks and the
 *   specs' Test: lines) get the longest limit, everything else the shell limit, and nothing inside a run gets
 *   more than the run has left — a genuine long command is never cut shorter than pb would run it itself.
 * - What the explorer may run: read-only inspection commands only (an allowlist, enforced).
 * - What a probe may not run: commands that write to a system outside this machine (a heuristic: a script can
 *   still do anything, which is why the probe's shell also runs without production credentials).
 */

/** The longest a command may run, in seconds, or undefined for no limit (every limit set to 0). */
export function commandCap(o: {
  command: string;
  /** the timeout the model asked for, if any: a shorter one is kept */
  asked?: number;
  /** the shell limit (commandTimeoutSec), 0 = none */
  shellSec: number;
  /** the limit for the project's own long commands (max of commandTimeoutSec and verifyTimeoutSec), 0 = none */
  longSec: number;
  longCommands: string[];
  /** seconds left in the run this command belongs to, if the run has a limit */
  runLeftSec?: number;
}): number | undefined {
  const base = isLongCommand(o.command, o.longCommands) ? o.longSec : o.shellSec;
  const limits = [base > 0 ? base : undefined, o.runLeftSec !== undefined ? Math.max(1, Math.floor(o.runLeftSec)) : undefined].filter((x): x is number => x !== undefined);
  const cap = limits.length ? Math.min(...limits) : undefined;
  const asked = typeof o.asked === "number" && Number.isFinite(o.asked) && o.asked > 0 ? o.asked : undefined;
  if (cap === undefined) return asked;
  return asked !== undefined && asked < cap ? asked : cap;
}

const squash = (s: string) => s.trim().replace(/\s+/g, " ");

/**
 * A command the project defines as long-running: one of them exactly, or with arguments after it, or behind a
 * `cd <dir> &&` or `timeout <n>` prefix. Anything else is an ordinary command.
 */
export function isLongCommand(command: string, longCommands: string[]): boolean {
  let c = squash(command);
  for (;;) {
    const stripped = c.replace(/^cd\s+\S+\s*&&\s*/, "").replace(/^timeout\s+(?:-\S+\s+)*\d+[smhd]?\s+/, "");
    if (stripped === c) break;
    c = stripped;
  }
  return longCommands.map(squash).filter(Boolean).some((l) => c === l || c.startsWith(`${l} `));
}

/** What Pi's bash says when its timeout fires, and pb's note naming the limit that did it and how to raise it. */
export const TIMED_OUT = /Command timed out after (\d+) seconds/;
export const timeoutNote = (key: string, where: string) =>
  `pb stopped this command at its limit (${key}). If it legitimately needs longer, don't retry it with a bigger timeout: say so, and the human raises ${key} in ${where} (0 = no limit).`;

/* ------------------------------------------------ the explorer's allowlist ------------------------------------------------ */

const READ_ONLY = new Set(["ls", "find", "cat", "head", "tail", "wc", "rg", "grep", "tree", "file", "stat", "pwd", "sort", "uniq", "cut", "basename", "dirname", "realpath", "du"]);
const GIT_READ_ONLY = new Set(["status", "log", "diff", "show", "blame", "ls-files", "ls-tree", "rev-parse", "grep", "describe", "shortlog", "cat-file"]);

/**
 * Why the explorer may not run this command, or undefined when it may: every piped segment starts with a
 * read-only inspection command, and nothing redirects, chains, substitutes or backgrounds. An allowlist, so
 * a database client, a network call or a script is refused by not being on it.
 */
export function explorerRefusal(command: string): string | undefined {
  if (/[;&`\n<>]|\$\(/.test(command)) return "redirects, chained commands, substitutions and background jobs are not inspection";
  for (const segment of command.split("|")) {
    const words = segment.trim().split(/\s+/);
    const [head, sub] = words;
    if (!head) return "an empty command";
    if (head === "git") {
      if (!sub || !GIT_READ_ONLY.has(sub)) return `\`git ${sub ?? ""}\` is not read-only inspection`;
      continue;
    }
    if (!READ_ONLY.has(head)) return `\`${head}\` is not on the explorer's read-only list (${[...READ_ONLY].join(", ")}, git ${[...GIT_READ_ONLY].join("/")})`;
    if (head === "find" && words.some((w) => /^-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)$/.test(w))) return "`find` that deletes, writes or runs commands is not inspection";
  }
  return undefined;
}

/* ------------------------------------------------ a probe's remote writes ------------------------------------------------ */

/**
 * The simple commands a shell line runs, split at `&&`, `||`, `;`, `|`, `&`, new lines, parentheses and backticks
 * outside quotes: so one command's flags are never read as another's (`curl … && unzip -d dir`).
 */
function simpleCommands(command: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === "\\" && quote === '"' && i + 1 < command.length) {
        current += c + command[++i];
        continue;
      }
      if (c === quote) quote = undefined;
      current += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      current += c;
    } else if (c === "\\" && i + 1 < command.length) {
      current += c + command[++i];
    } else if (";|&\n()`".includes(c)) {
      if (current.trim()) out.push(current.trim());
      current = "";
    } else current += c;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/**
 * An HTTP client run with a method or a body that changes something. Judged per simple command, with the client as a
 * word of its own: a URL's `https:` is not a client, and another command's `-d` (`unzip -d`, `cut -d,`) is not a body.
 */
const HTTP_WRITE = /(?:^|[\s(`"'=])(?:[^\s(`"'=]*\/)?(?:curl|wget|xh|http|https)(?=\s|$)[\s\S]*?(?:\s-[A-Za-z]*X\s*(?:POST|PUT|PATCH|DELETE)\b|\s--request[=\s]+(?:POST|PUT|PATCH|DELETE)\b|\s(?:-[A-Za-z]*[dFT]|--data\S*|--json|--form\S*|--upload-file|--post-data|--post-file)(?=[\s=,'"@]|$)|\s--method[=\s]+(?:POST|PUT|PATCH|DELETE)\b|\s(?:POST|PUT|PATCH|DELETE)(?=\s|$))/i;

const RULES: { name: string; test: RegExp | ((command: string) => boolean) }[] = [
  { name: "a write through a database client", test: /\b(psql|mysql|mariadb|mongo|mongosh|redis-cli|cqlsh|clickhouse-client|sqlcmd)\b[\s\S]*\b(insert|update|delete|drop|truncate|alter|grant|revoke|create|merge|upsert|replace|copy|flushall|flushdb|del|set)\b/i },
  { name: "a script fed to a database client", test: /\b(psql|mysql|mariadb|mongosh|sqlcmd)\b[\s\S]*(\s-f\s|\s--file[=\s]|<)/i },
  { name: "a change to a Kubernetes cluster", test: /\bkubectl\s+(?:\S+\s+)*?(delete|apply|create|replace|patch|edit|scale|rollout|exec|cp|drain|cordon|uncordon|taint|label|annotate|set|run|expose|autoscale)\b/ },
  { name: "a Helm release change", test: /\bhelm\s+(install|upgrade|uninstall|delete|rollback)\b/ },
  { name: "an infrastructure change", test: /\b(terraform|tofu|pulumi)\s+(apply|destroy|import|taint|up|state\s+(rm|mv|push))\b/ },
  { name: "a cloud write", test: /\b(aws|gcloud|az)\b[\s\S]*\b(delete|remove|rm|put|create|update|modify|terminate|deploy|invoke|run-instances|cp|mv|sync|set)\b/ },
  { name: "an HTTP request that changes something", test: (command) => simpleCommands(command).some((c) => HTTP_WRITE.test(c)) },
  { name: "a remote shell or copy", test: /(^|[\s;&|(])(ssh|scp|sftp|rsync)\s/ },
  { name: "a push", test: /\bgit\s+push\b|\bdocker\s+push\b|\bnpm\s+publish\b|\bgh\s+(pr\s+merge|release\s+create|repo\s+delete)\b/ },
];

/** Why a probe may not run this command (it would write to a system outside this machine), or undefined. */
export function remoteWriteRefusal(command: string): string | undefined {
  return RULES.find((r) => (typeof r.test === "function" ? r.test(command) : r.test.test(command)))?.name;
}

/* ------------------------------------------------ a probe's environment ------------------------------------------------ */

/** Credentials a probe's shell never sees: databases, clouds, clusters, registries, agents. */
export const DEFAULT_DROPPED_ENV = [
  "DATABASE_URL", "*_DATABASE_URL", "DB_URL", "PGHOST", "PGHOSTADDR", "PGUSER", "PGPASSWORD", "PGDATABASE", "PGSERVICE", "PGSSLKEY",
  "MYSQL_HOST", "MYSQL_PWD", "MONGO_URL", "MONGODB_URI", "REDIS_URL",
  "AWS_*", "AZURE_*", "GOOGLE_APPLICATION_CREDENTIALS", "CLOUDSDK_*", "KUBECONFIG", "SSH_AUTH_SOCK", "VAULT_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "NPM_TOKEN",
];

/** Credential files the common tools read by default, pointed at nothing so an unset variable doesn't fall back to them. */
const NO_FILE = "/dev/null";
const NEUTRALIZED_FILES = ["KUBECONFIG", "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE", "PGPASSFILE", "PGSERVICEFILE", "CLOUDSDK_CONFIG"];

/** `NAME`, `PREFIX_*` or `*_SUFFIX`. */
const matches = (name: string, pattern: string) =>
  pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : pattern.startsWith("*") ? name.endsWith(pattern.slice(1)) : name === pattern;

/**
 * The shell prefix that runs a probe's command without the credentials above: Pi's own process keeps its model
 * provider keys (a Bedrock or Vertex setup needs AWS_* or Google credentials to reach the model), only the
 * model's shell loses them. `also` adds names to drop (the guard's own settings variable).
 */
export function scrubPrefix(env: Record<string, string | undefined>, also: string[] = []): string {
  const patterns = [...DEFAULT_DROPPED_ENV, ...also];
  const unset = Object.keys(env).filter((n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n) && patterns.some((p) => matches(n, p)));
  return `${unset.length ? `unset ${unset.sort().join(" ")}; ` : ""}export ${NEUTRALIZED_FILES.map((n) => `${n}=${NO_FILE}`).join(" ")}; `;
}
