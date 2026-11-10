/**
 * The one way pb reads a project's manifests (package.json, Cargo.toml, pom.xml, …) to detect its
 * stack and commands. The project's files are untrusted input: a pipe or device planted under a
 * manifest's name must not hang a command, and a huge file must not be read whole.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** A manifest is read only up to this size: enough for any real one, bounded for a hostile one. */
const MANIFEST_BYTES = 1_000_000;

/** A regular file's first MANIFEST_BYTES; undefined when it is missing, unreadable or not a regular file. */
export function readManifest(file: string): string | undefined {
  try {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
    try {
      if (!fs.fstatSync(fd).isFile()) return undefined;
      const buffer = Buffer.alloc(MANIFEST_BYTES);
      return buffer.toString("utf8", 0, fs.readSync(fd, buffer, 0, MANIFEST_BYTES, 0));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined; // no evidence either way
  }
}

/** The fields of a package.json pb reads. */
export interface PackageJson {
  scripts?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  peerDependencies?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
}

/** A JSON manifest in the project (package.json by default), parsed; undefined when unreadable or not a JSON object. */
export function readJsonManifest(cwd: string, file = "package.json"): PackageJson | undefined {
  const text = readManifest(path.join(cwd, file));
  if (text === undefined) return undefined;
  try {
    const json: unknown = JSON.parse(text);
    return json && typeof json === "object" && !Array.isArray(json) ? (json as PackageJson) : undefined;
  } catch {
    return undefined;
  }
}

/** Every package a package.json names, in any dependency section. */
export const dependencyNames = (pkg: PackageJson | undefined): string[] =>
  [pkg?.dependencies, pkg?.devDependencies, pkg?.peerDependencies, pkg?.optionalDependencies].flatMap((section) => (section && typeof section === "object" ? Object.keys(section) : []));

/** A package.json script's command, when it is a real one (npm's "no test specified" placeholder is not). */
export function packageScript(cwd: string, name: string): string | undefined {
  const script = readJsonManifest(cwd)?.scripts?.[name];
  return typeof script === "string" && script.trim() && !/no (test|lint) specified/.test(script) ? script : undefined;
}
