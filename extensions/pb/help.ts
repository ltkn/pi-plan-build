/**
 * Situational help. guide.md is the single source: tagged regions
 * (`<!-- pb:tip key -->` … `<!-- /pb -->`, same for `pb:topic`) are shown after
 * phase results and by /pb:help, so the doc and the in-session text can't drift.
 */
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

export const HELP_PATH = fileURLToPath(new URL("./guide.md", import.meta.url));

interface Regions {
  tip: Map<string, string>;
  topic: Map<string, string>;
}

let cache: Regions | undefined;
let cacheMtime = 0;

function regions(): Regions {
  try {
    const mtime = fs.statSync(HELP_PATH).mtimeMs;
    if (!cache || mtime !== cacheMtime) {
      cache = { tip: new Map(), topic: new Map() };
      cacheMtime = mtime;
      const md = fs.readFileSync(HELP_PATH, "utf8");
      for (const m of md.matchAll(/<!--\s*pb:(tip|topic)\s+([\w.-]+)\s*-->\s*([\s\S]*?)\s*<!--\s*\/pb\s*-->/g)) {
        const map = cache[m[1] as keyof Regions];
        if (!map.has(m[2])) map.set(m[2], m[3].trim());
      }
    }
    return cache;
  } catch {
    return cache ?? { tip: new Map(), topic: new Map() }; // help is best-effort; never break a phase over it
  }
}

/** Short "What now" block for a phase result; `{name}` placeholders are filled from vars. */
export function tip(key: string, vars: Record<string, string | number> = {}): string {
  return (regions().tip.get(key) ?? "").replace(/\{(\w+)\}/g, (all, k) => (k in vars ? String(vars[k]) : all));
}

/** A full help section, or undefined if there is no such topic. */
export function topic(name: string): string | undefined {
  return regions().topic.get(name);
}

/** Topic names with their headings, in document order. */
export function topics(): { name: string; title: string }[] {
  return [...regions().topic].map(([name, body]) => ({ name, title: body.match(/^#+\s*(.+)$/m)?.[1] ?? name }));
}
