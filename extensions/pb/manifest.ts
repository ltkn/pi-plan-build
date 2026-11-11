/**
 * The one way pb reads a project's manifests (package.json, Cargo.toml, pom.xml, …) to detect its
 * stack and commands. The project's files are untrusted input: a pipe or device planted under a
 * manifest's name must not hang a command, and a huge file must not be read whole.
 */
import { execFileSync } from "node:child_process";
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

/* ------------------------------------- dependencies a change adds ------------------------------------- */

const sectionKeys = (text: string, isSection: (header: string) => boolean) => {
  const names: string[] = [];
  let inside = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const header = line.match(/^\[([^\]]+)\]$/)?.[1];
    if (header !== undefined) {
      inside = isSection(header.trim());
      continue;
    }
    const key = inside ? line.match(/^([A-Za-z0-9_.-]+)\s*=/)?.[1] : undefined;
    if (key) names.push(key.replace(/^["']|["']$/g, ""));
  }
  return names;
};

const pythonName = (spec: string) => spec.trim().match(/^[A-Za-z0-9][A-Za-z0-9._-]*/)?.[0].toLowerCase();

/** The dependency names a manifest declares, by its file name; empty for a file pb doesn't read this way. */
export function dependenciesIn(file: string, text: string): string[] {
  const name = path.basename(file);
  if (name === "package.json") {
    try {
      const json: unknown = JSON.parse(text);
      return json && typeof json === "object" && !Array.isArray(json) ? dependencyNames(json as PackageJson) : [];
    } catch {
      return [];
    }
  }
  if (name === "Cargo.toml") {
    const tables = [...text.matchAll(/^\s*\[(?:workspace\.|target\.[^\]]+\.)?(?:dev-|build-)?dependencies\.([A-Za-z0-9_-]+)\]\s*$/gm)].map((m) => m[1]);
    return [...sectionKeys(text, (h) => /^(?:workspace\.|target\..+\.)?(?:dev-|build-)?dependencies$/.test(h)), ...tables];
  }
  if (name === "go.mod") {
    const direct = (line: string) => !/\/\/\s*indirect/.test(line);
    const block = [...text.matchAll(/^require\s*\(([\s\S]*?)^\)/gm)].flatMap((m) => m[1].split("\n").filter(direct).map((l) => l.trim().split(/\s+/)[0]));
    const single = [...text.matchAll(/^require\s+(\S+)\s+\S+(.*)$/gm)].filter((m) => direct(m[2])).map((m) => m[1]);
    return [...block, ...single].filter((n) => n && n !== "(" && !n.startsWith("//"));
  }
  if (name === "pom.xml") {
    return [...text.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)].flatMap((m) => {
      const group = m[1].match(/<groupId>\s*([^<\s]+)\s*<\/groupId>/)?.[1];
      const artifact = m[1].match(/<artifactId>\s*([^<\s]+)\s*<\/artifactId>/)?.[1];
      return group && artifact ? [`${group}:${artifact}`] : [];
    });
  }
  if (name === "build.gradle" || name === "build.gradle.kts") {
    return [...text.matchAll(/\b(?:implementation|api|compileOnly|runtimeOnly|testImplementation|testRuntimeOnly|annotationProcessor|kapt|ksp)\s*\(?\s*["']([^:"'\s]+:[^:"'\s]+)(?::[^"']*)?["']/g)].map((m) => m[1]);
  }
  if (name === "pyproject.toml") {
    // PEP 621 lists ([project] dependencies, [project.optional-dependencies] any key) and Poetry tables.
    const names: string[] = [];
    let section = "";
    let collecting = false;
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      const header = line.match(/^\[([^\]]+)\]$/)?.[1];
      if (header !== undefined && !collecting) {
        section = header.trim();
        continue;
      }
      const start = line.match(/^([A-Za-z0-9_-]+)\s*=\s*\[(.*)$/);
      if (!collecting && start && ((section === "project" && start[1] === "dependencies") || section === "project.optional-dependencies")) collecting = true;
      if (collecting) {
        const body = line.replace(/^[A-Za-z0-9_-]+\s*=\s*\[/, "");
        for (const q of body.matchAll(/["']([^"']+)["']/g)) names.push(pythonName(q[1]) ?? "");
        if (body.includes("]")) collecting = false;
        continue;
      }
      if (/^tool\.poetry\.(?:group\.[^.]+\.)?(?:dev-)?dependencies$/.test(section)) {
        const key = line.match(/^([A-Za-z0-9_.-]+)\s*=/)?.[1];
        if (key && key !== "python") names.push(key.toLowerCase());
      }
    }
    return names.filter(Boolean);
  }
  if (/^requirements[\w.-]*\.txt$/.test(name)) {
    return text.split("\n").flatMap((l) => (/^\s*(#|-|$)/.test(l) ? [] : [pythonName(l)])).filter((n): n is string => !!n);
  }
  return [];
}

/** At most this many changed manifests are compared: a change touching more is not a dependency question. */
const MANIFEST_LIMIT = 50;

/**
 * The dependencies a change adds, per manifest: each changed manifest's names now, minus its names at `base`
 * (a manifest new since then counts every name it declares). Read through readManifest, and from git with a
 * bounded output and time, so a hostile file can neither hang the review nor fill it.
 */
export function addedDependencies(cwd: string, base: string | undefined, changed: string[]): { file: string; names: string[] }[] {
  const out: { file: string; names: string[] }[] = [];
  for (const file of changed.filter(isDependencyManifest).slice(0, MANIFEST_LIMIT)) {
    let before = "";
    try {
      before = execFileSync("git", ["show", `${base ?? "HEAD"}:${file}`], { cwd, encoding: "utf8", maxBuffer: MANIFEST_BYTES * 2, timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      before = ""; // new since the base
    }
    const had = new Set(dependenciesIn(file, before));
    const names = [...new Set(dependenciesIn(file, readManifest(path.join(cwd, file)) ?? ""))].filter((n) => !had.has(n));
    if (names.length) out.push({ file, names });
  }
  return out;
}

const isDependencyManifest = (file: string) => /^(package\.json|Cargo\.toml|go\.mod|pom\.xml|build\.gradle(\.kts)?|pyproject\.toml|requirements[\w.-]*\.txt)$/.test(path.basename(file));
