/**
 * Sibling repositories: a change that spans a backend and its frontend lives in two git repositories side by
 * side, the project and `../<repo>`. A spec names the ones it also changes (`Also changes: ../tempo-ui`), and the
 * build's undo points, the review's diff and /pb:commit cover each of them as they cover the project. Planning
 * protects them all, named or not: planning changes nothing.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** `../<name>`: one folder beside the project, never further up, never dot-named. */
export const SIBLING_REPO = /^\.\.\/[A-Za-z0-9_][A-Za-z0-9._-]*$/;

const real = (p: string) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/** The nearest existing ancestor's real path: a file about to be created resolves through the folder that holds it. */
const realExisting = (p: string): string => {
  let at = path.resolve(p);
  const rest: string[] = [];
  while (!fs.existsSync(at) && path.dirname(at) !== at) {
    rest.unshift(path.basename(at));
    at = path.dirname(at);
  }
  return path.join(real(at), ...rest);
};

/**
 * The root of the git repository beside the project that `target` is in, or undefined: the folder that holds
 * the project is the workspace, and each of its other folders with a `.git` is a sibling repository.
 */
export function siblingRepoOf(cwd: string, target: string): string | undefined {
  const project = real(cwd);
  const workspace = path.dirname(project);
  if (workspace === path.parse(workspace).root) return undefined;
  const t = realExisting(path.resolve(cwd, target));
  const rel = path.relative(workspace, t);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  const root = path.join(workspace, rel.split(path.sep)[0]);
  if (root === project) return undefined;
  return fs.existsSync(path.join(root, ".git")) ? root : undefined;
}

/** A spec's declared sibling repositories, resolved: each must be a git repository beside the project. */
export function resolveRepos(cwd: string, names: string[]): { name: string; root?: string; error?: string }[] {
  const workspace = path.dirname(real(cwd));
  return names.map((name) => {
    if (!SIBLING_REPO.test(name)) return { name, error: "not a folder beside the project (`../<name>`)" };
    const root = path.join(workspace, name.slice(3));
    if (root === real(cwd)) return { name, error: "that is the project itself" };
    if (!fs.existsSync(path.join(root, ".git"))) return { name, error: "no git repository there" };
    return { name, root };
  });
}

/** Paths in a sibling repository, as pb shows them: from the project root, `../<repo>/<path>`. */
export const inRepo = (name: string, file: string) => `${name}/${file}`;
