/**
 * What a fresh run shows while it works: the step it is on, how long and how many tokens so far, its last few
 * actions in words, and the file its whole transcript is going to. One display for every fresh role (the map,
 * the spec review and claim check, the review's passes and verifier), so a long run reads as moving or stuck
 * at a glance, and nothing of it reaches the conversation: the transcript stays in its own session.
 */
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { duration, human } from "./format.ts";
import type { RunOptions } from "./runner.ts";

/** How many recent actions the display keeps. */
const RECENT = 5;

type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number };

export interface FreshProgress {
  /** spread into runFresh's options: the run reports through these */
  hooks: Pick<RunOptions, "onActivity" | "onUsage" | "onSession">;
  /** the step the work is on, e.g. "checking 42 new lines against the code" (numbered as it advances) */
  step(label: string): void;
  /** clear the display; call it in a finally */
  stop(): void;
}

/**
 * A live display under `key` (one setWidget slot), titled e.g. "pb map". `esc` adds the hint that Esc stops it;
 * `sessionsRoot` is the folder the run's file is shown relative to (the project root).
 */
export function freshProgress(ctx: ExtensionContext, key: string, title: string, o: { esc?: boolean; sessionsRoot?: string } = {}): FreshProgress {
  const started = Date.now();
  const recent: string[] = [];
  let steps = 0;
  let label = "";
  let tokens = 0;
  let file: string | undefined;
  let live = true;
  const paint = () => {
    if (!live) return;
    try {
      const facts = [label ? `${steps > 1 ? `step ${steps}: ` : ""}${label}` : "", duration(Date.now() - started), tokens ? `${human(tokens)} tokens` : ""].filter(Boolean).join(" · ");
      ctx.ui.setWidget(key, [
        `${title} — ${facts}${o.esc ? "   (Esc to stop)" : ""}`,
        ...recent.map((a, i) => `  ${i === recent.length - 1 ? "↳" : "·"} ${a}`),
        ...(file ? [`  the whole run: ${o.sessionsRoot ? path.relative(o.sessionsRoot, file) : file}`] : []),
      ]);
    } catch {
      live = false; // a replaced or closed context: nothing left to draw on
    }
  };
  let beat: ReturnType<typeof setInterval> | undefined;
  try {
    if (ctx.hasUI) beat = setInterval(paint, 1000);
  } catch {
    beat = undefined;
  }
  paint();
  return {
    hooks: {
      onActivity: (line) => {
        recent.push(line);
        if (recent.length > RECENT) recent.shift();
        paint();
      },
      onUsage: (t: Tokens) => {
        tokens = t.input + t.output + t.cacheRead + t.cacheWrite;
        paint();
      },
      onSession: (f) => {
        file = f;
        paint();
      },
    },
    step(next) {
      steps += 1;
      label = next;
      recent.length = 0;
      paint();
    },
    stop() {
      if (beat !== undefined) clearInterval(beat);
      try {
        ctx.ui.setWidget(key, undefined);
      } catch {
        /* the context is gone: its widget went with it */
      }
      live = false;
    },
  };
}
