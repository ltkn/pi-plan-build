/** pb_ask: the one question tool; builds and unattended laps never ask. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "./schema.ts";
import { notifyDesktop } from "./notify.ts";
import { ASK_DESCRIPTION, checkpointing, patiently, post, reply, specOfSession, specWriting, stop } from "./kit.ts";

interface Question {
  question: string;
  options?: string[];
  recommended?: string;
  multiple?: boolean;
}

/** The most questions one call may show: a batch, not a questionnaire. */
const MAX_QUESTIONS = 8;

const letter = (i: number) => String.fromCharCode(65 + i);

/**
 * Which option the recommendation names, however the model wrote it: the option itself, its letter ("B", "b."),
 * or the one option it is part of (or that is part of it). -1 when none, or when it could be several.
 */
export function recommendedIndex(rec: string | undefined, options: string[]): number {
  const r = rec?.trim();
  if (!r || !options.length) return -1;
  const exact = options.indexOf(r);
  if (exact >= 0) return exact;
  const byLetter = r.match(/^([A-Za-z])\.?$/)?.[1];
  if (byLetter) {
    const i = byLetter.toUpperCase().charCodeAt(0) - 65;
    return i < options.length ? i : -1;
  }
  const low = r.toLowerCase();
  const near = options.map((o, i) => [o.toLowerCase(), i] as const).filter(([o]) => o === low || o.includes(low) || low.includes(o));
  return near.length === 1 ? near[0][1] : -1;
}

/**
 * The answer as the model should read it: letters typed for the options ("B", "a and c", "A, C") become the
 * letters with the options they name; anything else is the human's own words, unchanged.
 */
export function resolveAnswer(answer: string, options: string[]): string {
  const t = answer.trim();
  if (!options.length || !/^[A-Za-z](\s*(?:,|&|\+|and|\s)\s*[A-Za-z])*\.?$/i.test(t)) return t;
  const letters = [...new Set((t.replace(/\band\b/gi, " ").match(/[A-Za-z]/g) ?? []).map((l) => l.toUpperCase()))];
  const picked = letters.map((l) => l.charCodeAt(0) - 65);
  if (picked.some((i) => i < 0 || i >= options.length)) return t;
  return `${letters.join(" and ")} — ${picked.map((i) => options[i]).join("; ")}`;
}

/** One question's outcome: the answer, or why there is none (no answer in time, or the dialog was closed). */
interface Outcome {
  q: Question;
  answer?: string;
  timedOut: boolean;
  skipped?: boolean;
}

export function registerAsk(pi: ExtensionAPI) {
  const OTHER = "Something else (type it)";

  /** Ask one question in a dialog: one choice, several (a checklist), or the human's own words. */
  const askOne = async (ctx: ExtensionContext, q: Question, title: string, timeoutMs: number): Promise<Outcome> => {
    const options = q.options ?? [];
    const rec = recommendedIndex(q.recommended, options);
    const lettered = options.map((o, i) => `${letter(i)}. ${o}${i === rec ? " (recommended)" : ""}`);
    const typed = async (): Promise<{ text?: string; timedOut: boolean }> => {
      // The options vanish the moment the typing dialog opens, and the choice is often
      // written from them: keep them in the chat, where they stay visible while typing.
      if (options.length) post([`**Answering with your own words:**`, "", q.question, "", ...lettered, "", `Type it here — a letter is enough, or write guidance based on the options above.`].join("\n"));
      const inp = await patiently(ctx, timeoutMs, (opts) => ctx.ui.input(title, options.length ? "A letter is enough, or your own words based on the options above" : (q.recommended ?? ""), opts));
      return { text: inp.result?.trim() ? resolveAnswer(inp.result, options) : undefined, timedOut: inp.timedOut };
    };
    if (!options.length) {
      const r = await typed();
      return { q, answer: r.text, timedOut: r.timedOut };
    }
    if (!q.multiple) {
      const labels = options.map((o, i) => (i === rec ? `${o} (recommended)` : o));
      const sel = await patiently(ctx, timeoutMs, (opts) => ctx.ui.select(title, [...labels, OTHER], opts));
      if (sel.result === OTHER) {
        const r = await typed();
        return { q, answer: r.text, timedOut: sel.timedOut || r.timedOut };
      }
      const i = sel.result ? labels.indexOf(sel.result) : -1;
      return { q, answer: i >= 0 ? options[i] : undefined, timedOut: sel.timedOut };
    }
    // Several may apply: a checklist — each pick toggles one, Done answers with all that are ticked.
    const picked = new Set<number>();
    for (;;) {
      const labels = options.map((o, i) => `${picked.has(i) ? "[x]" : "[ ]"} ${letter(i)}. ${o}${i === rec ? " (recommended)" : ""}`);
      const done = picked.size ? `Done — ${[...picked].sort((a, b) => a - b).map(letter).join(", ")}` : "Done — none of these";
      const sel = await patiently(ctx, timeoutMs, (opts) => ctx.ui.select(`${title} (pick all that apply)`, [...labels, done, OTHER], opts));
      if (sel.result === undefined) return { q, timedOut: sel.timedOut }; // nothing half-ticked is ever read as an answer
      if (sel.result === OTHER) {
        const r = await typed();
        return { q, answer: r.text, timedOut: r.timedOut };
      }
      if (sel.result === done) {
        const chosen = [...picked].sort((a, b) => a - b);
        return { q, answer: chosen.length ? `${chosen.map(letter).join(" and ")} — ${chosen.map((i) => options[i]).join("; ")}` : "none of these", timedOut: false };
      }
      const i = labels.indexOf(sel.result);
      if (i >= 0) {
        if (picked.has(i)) picked.delete(i);
        else picked.add(i);
      }
    }
  };

  pi.registerTool({
    name: "pb_ask",
    label: "Ask",
    description: ASK_DESCRIPTION,
    parameters: Type.Object({
      question: Type.Optional(Type.String({ description: "one precise question (or use questions for several)" })),
      options: Type.Optional(Type.Array(Type.String(), { description: "2 to 4 answers to choose from; the human can always type another" })),
      recommended: Type.Optional(Type.String({ description: "your recommendation: one of the options (or its letter), or a suggested answer" })),
      multiple: Type.Optional(Type.Boolean({ description: "true when several options may apply together: the human ticks all that do" })),
      questions: Type.Optional(
        Type.Array(
          Type.Object({
            question: Type.String(),
            options: Type.Optional(Type.Array(Type.String())),
            recommended: Type.Optional(Type.String()),
            multiple: Type.Optional(Type.Boolean()),
          }),
          { description: `several independent questions in one call (at most ${MAX_QUESTIONS}): shown one after another, answered together` },
        ),
      ),
    }),
    // One dialog at a time: Pi shows a single dialog, and a second one opened in parallel dismisses the first.
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const { store, name, progress: p } = specOfSession(ctx);
      const building = !!name && !!p && p.phase === "building";
      const session = ctx.sessionManager.getSessionFile() ?? "";
      if (checkpointing.has(session)) return reply("Not now: this is a checkpoint. Write the question under Open questions in the spec instead.");
      if (building) {
        // A build never asks: a question would stop it for a decision the spec's approval did not cover.
        return reply(
          'This build is autonomous: don\'t ask. Take the sensible reading and record it with pb_record_decision (assumption: true) as claim + settler + cost. Only if the Goal or a Contract cannot be built as written, stop with pb_task_done status "blocked" and the evidence.',
        );
      }
      // Laps run in sessions of their own, often with nobody watching: they raise a question in their report.
      if (store.fixSession(session))
        return reply("A fix lap doesn't ask: a finding that needs a decision is reported as skipped (it needs a spec revision); for anything else, take the sensible reading and say so in your report.");
      const repair = store.fixOfSession(session);
      if (repair?.p.fix?.driver)
        return reply("A hardening lap doesn't ask: park the question in your pb_spec_fix_done report, with your recommendation — pb asks the human after the lap, and runs the recommendation if nobody answers.");
      const list: Question[] = [...(params.question?.trim() ? [{ question: params.question, options: params.options, recommended: params.recommended, multiple: params.multiple }] : []), ...(params.questions ?? [])]
        .filter((q) => q.question?.trim())
        .slice(0, MAX_QUESTIONS);
      if (!list.length) throw new Error("Nothing to ask: give question (and options), or questions for several.");
      // The human may have walked away: while /pb:build writes the spec, while planning, and in a manual repair lap.
      const planning = store.planningSessions().includes(session);
      const unattended = specWriting.has(session) || store.pendingBuild(session) || planning || !!repair;
      const show = (q: Question) => {
        const rec = recommendedIndex(q.recommended, q.options ?? []);
        return `${q.question}${q.options?.length ? `\n\n${q.options.map((o, i) => `${letter(i)}. ${o}${i === rec ? " (recommended)" : ""}`).join("\n")}` : ""}`;
      };
      if (!ctx.hasUI) {
        // No one to answer: the questions stay open. A planning reading would decide for the human.
        post(list.map((q) => `**Question for you** — ${show(q)}`).join("\n\n"));
        return stop(`No one can answer here: the question${list.length === 1 ? " stays" : "s stay"} open. Stop here and tell the human what you need.`);
      }
      // Planning and the way into a build may wait for the human: after askTimeoutSec idle the question stays open.
      const timeoutMs = unattended ? store.config().askTimeoutSec * 1000 : 0;
      if (store.config().notify) notifyDesktop(list.length === 1 ? "pb: a question for you" : `pb: ${list.length} questions for you`, list[0].question);
      const outcomes: Outcome[] = [];
      for (const [i, q] of list.entries()) {
        // A question nobody answered in time means nobody is there: the rest wait in the chat, not in dialogs.
        if (outcomes.some((o) => o.timedOut && !o.answer)) {
          outcomes.push({ q, timedOut: false, skipped: true });
          continue;
        }
        outcomes.push(await askOne(ctx, q, list.length === 1 ? q.question : `Question ${i + 1} of ${list.length}: ${q.question}`, timeoutMs));
      }
      // What was answered outlives the conversation: the spec transcribes it from the planning record.
      if (planning) for (const o of outcomes) if (o.answer) store.recordPlanningAnswer(session, { question: o.q.question, answer: o.answer });
      const open = outcomes.filter((o) => !o.answer);
      if (open.length) {
        // Silence is not consent before anything is built: an unanswered question stays an open question,
        // and planning stays incomplete. The dialog is gone; the question stays in the chat.
        const why = (o: Outcome) => (o.skipped ? "not asked: the question before it got no answer in time" : o.timedOut ? `no answer within ${Math.max(1, Math.round(timeoutMs / 60_000))} min` : "the dialog was closed");
        post(
          [
            open.length === 1 && list.length === 1
              ? `**Unanswered question** (${why(open[0])}; nothing was decided — the question stays open):`
              : `**Unanswered questions** (nothing was decided — they stay open):`,
            ...open.flatMap((o) => ["", open.length === 1 && list.length === 1 ? show(o.q) : `${show(o.q)}\n(${why(o)})`]),
            "",
            `To answer, type it here any time${open.some((o) => o.q.options?.length) ? ` (a letter is enough)` : ""}: if Pi is working, it reads it after its current step.`,
          ].join("\n"),
        );
      }
      const kept = (o: Outcome) => {
        const options = o.q.options ?? [];
        return options.length ? `, its options lettered (${options.map((x, i) => `${letter(i)}. ${x}`).join("; ")})` : "";
      };
      if (list.length === 1) {
        const o = outcomes[0];
        if (o.answer) return reply(`The human answered: ${o.answer}`);
        return reply(
          `${o.timedOut ? "No answer in time" : "The human dismissed the question"}: it stays open — do not take a reading or tag it assumed. Record it under Open questions; planning stays incomplete until it is answered. The question stays in the chat${kept(o)}: if the human answers later, by letter or in words, follow their answer.`,
        );
      }
      return reply(
        [
          "The human's answers:",
          ...outcomes.map((o, i) => `${i + 1}. ${o.q.question} — ${o.answer ?? "OPEN: no answer; do not take a reading or tag it assumed. Record it under Open questions"}`),
          ...(open.length ? ["", `The open ones stay in the chat: if the human answers later, by letter or in words, follow their answer.`] : []),
        ].join("\n"),
      );
    },
  });
}
