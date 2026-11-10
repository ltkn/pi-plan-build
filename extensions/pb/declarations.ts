/**
 * The names a diff declares: functions, types and constants other code can now reuse. A build resets
 * between tasks, so a later task knows the earlier ones only from the handoff; naming what they added
 * lets it extend a helper instead of writing a near-copy. A heuristic per language, read from added
 * lines only: a miss costs a pointer, never correctness.
 */

/** One name a diff added, and the file that declares it. */
export interface Declaration {
  file: string;
  name: string;
}

/** Longer lines are skipped: no declaration needs them, and they bound each pattern's work. */
const MAX_LINE = 300;
/** Per diff: a handoff is a pointer, not an index. */
const MAX_DECLARATIONS = 40;

const MODIFIERS = "(?:(?:public|protected|private|internal|static|final|abstract|sealed|open|override|data|inner|partial|virtual|async|suspend|synchronized)\\s+)";

/** Per language: which files, and the patterns whose first group is the declared name. */
const LANGUAGES: Array<{ files: RegExp; patterns: RegExp[] }> = [
  {
    files: /\.[cm]?[jt]sx?$/,
    patterns: [/^(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|const|let)\s+([A-Za-z_$][\w$]*)/],
  },
  {
    files: /\.rs$/,
    patterns: [
      /^ {0,4}(?:pub(?:\([\w:\s]*\))?\s+)?(?:(?:const|async|unsafe)\s+)*(?:fn|struct|enum|trait|type|mod|static|const|union)\s+([A-Za-z_]\w*)/,
      /^macro_rules!\s*([A-Za-z_]\w*)/,
    ],
  },
  {
    files: /\.go$/,
    patterns: [/^func\s+(?:\([^()]*\)\s*)?([A-Za-z_]\w*)/, /^(?:type|var|const)\s+([A-Za-z_]\w*)/],
  },
  {
    files: /\.py$/,
    patterns: [/^(?: {4})?(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/],
  },
  {
    files: /\.(?:java|kt|kts|cs|scala)$/,
    patterns: [
      new RegExp(`^\\s*${MODIFIERS}*(?:enum\\s+)?(?:class|interface|enum|record|object|trait|struct)\\s+([A-Za-z_]\\w*)`),
      new RegExp(`^\\s{0,8}${MODIFIERS}*fun\\s+(?:<[^<>]*>\\s*)?(?:[\\w.]+(?:<[^<>()]*>)?\\??\\.)?([A-Za-z_]\\w*)\\s*\\(`),
      new RegExp(`^\\s{0,8}${MODIFIERS}+(?:<[^<>]*>\\s+)?[\\w.]+(?:<[^()]*>)?(?:\\[\\])*\\s+([A-Za-z_]\\w*)\\s*\\(`),
    ],
  },
];

/** The declarations the added lines of a `git diff` declare, in diff order, without duplicates. */
export function declarationsIn(diff: string, skipFile: (file: string) => boolean = () => false): Declaration[] {
  const found: Declaration[] = [];
  const seen = new Set<string>();
  let patterns: RegExp[] = [];
  let file = "";
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const target = line.slice(4);
      file = target.startsWith("b/") ? target.slice(2) : "";
      patterns = file && !skipFile(file) ? (LANGUAGES.find((l) => l.files.test(file))?.patterns ?? []) : [];
      continue;
    }
    if (!patterns.length || !line.startsWith("+") || line.length > MAX_LINE) continue;
    const code = line.slice(1);
    for (const pattern of patterns) {
      const name = pattern.exec(code)?.[1];
      if (!name) continue;
      const key = `${file}\0${name}`;
      if (!seen.has(key)) {
        seen.add(key);
        found.push({ file, name });
      }
      break;
    }
    if (found.length >= MAX_DECLARATIONS) break;
  }
  return found;
}
