/** pb_ask: the one question tool; builds never ask. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { notifyDesktop } from "./notify.ts";
import { type AcceptanceCheck, type Checkpoint, type Finding, type Progress, type ReviewLedgerEntry, type ReviewRun, type ReviewSessionState, type TaskProgress, type VerifyResult, COHERE_TASK_ID, PREFIX, Store, cap, changedSince, diffStat, gitDiff, gitHead, gitRepo, ledgerFindings, now, readEvents, resolvesRevision, reviewLedger, untrackedText } from "./store.ts";
import { ASK_DESCRIPTION, checkpointing, choose, patiently, post, reply, specOfSession, specWriting, stop } from "./kit.ts";

export function registerAsk(pi: ExtensionAPI) {
  pi.registerTool({
    name: "pb_ask",
    label: "Ask",
    description: ASK_DESCRIPTION,
    parameters: Type.Object({
      question: Type.String({ description: "one precise question" }),
      options: Type.Optional(Type.Array(Type.String(), { description: "2 to 4 answers to choose from; the human can always type another" })),
      recommended: Type.Optional(Type.String({ description: "your recommendation: one of the options, or a suggested answer" })),
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
      // The human may have walked away: while /pb:build writes the spec, and while planning.
      const planning = store.planningSessions().includes(session);
      const unattended = specWriting.has(session) || store.pendingBuild(session) || planning;
      if (!ctx.hasUI) {
        // No one to answer: the question stays open. A planning reading would decide for the human.
        post(`**Question for you** — ${params.question}${params.options?.length ? `\n\n${params.options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}${o === params.recommended ? " (recommended)" : ""}`).join("\n")}` : ""}`);
        return stop("No one can answer here: the question stays open. Stop here and tell the human what you need.");
      }
      // Planning and the way into a build may wait for the human: after askTimeoutSec idle the question stays open.
      const timeoutMs = unattended ? store.config().askTimeoutSec * 1000 : 0;
      if (store.config().notify) notifyDesktop("pb: a question for you", params.question);
      // Lettered, so "A and C" is a complete answer whenever it comes: in the dialog, in the
      // chat later, or typed freehand after picking "Something else".
      const letter = (i: number) => String.fromCharCode(65 + i);
      const lettered = (params.options ?? []).map((o, i) => `${letter(i)}. ${o}${o === params.recommended ? " (recommended)" : ""}`);
      let answer: string | undefined;
      let timedOut = false;
      const OTHER = "Something else (type it)";
      if (params.options?.length) {
        const labels = params.options.map((o) => (o === params.recommended ? `${o} (recommended)` : o));
        const sel = await patiently(ctx, timeoutMs, (opts) => ctx.ui.select(params.question, [...labels, OTHER], opts));
        timedOut = sel.timedOut;
        if (sel.result === OTHER) {
          // The options vanish the moment the typing dialog opens, and the choice is often
          // written from them: keep them in the chat, where they stay visible while typing.
          post([`**Answering with your own words:**`, "", params.question, "", ...lettered, "", `Type it here — a letter is enough, or write guidance based on the options above.`].join("\n"));
          const inp = await patiently(ctx, timeoutMs, (opts) => ctx.ui.input(params.question, "A letter is enough, or your own words based on the options above", opts));
          timedOut = timedOut || inp.timedOut;
          answer = inp.result;
        } else answer = sel.result ? params.options[labels.indexOf(sel.result)] : undefined;
      } else {
        const inp = await patiently(ctx, timeoutMs, (opts) => ctx.ui.input(params.question, params.recommended, opts));
        timedOut = inp.timedOut;
        answer = inp.result;
      }
      if (!answer?.trim()) {
        // Silence is not consent before anything is built: an unanswered question stays an open
        // question, and planning stays incomplete. pb never takes a reading for the human.
        // The dialog is gone; the question stays in the chat, to answer whenever the human is back.
        const KEPT = ` The question stays in the chat${lettered.length ? `, its options lettered (${lettered.map((o) => o.replace(/ \(recommended\)$/, "")).join("; ")})` : ""}: if the human answers later, by letter or in words, follow their answer.`;
        post(
          [
            `**Unanswered question** (${timedOut ? `no answer within ${Math.max(1, Math.round(timeoutMs / 60_000))} min` : "the dialog was closed"}; nothing was decided — the question stays open):`,
            "",
            params.question,
            ...(lettered.length ? ["", ...lettered] : []),
            "",
            `To answer, type it here any time${lettered.length ? ` (a letter is enough)` : ""}: if Pi is working, it reads it after its current step.`,
          ].join("\n"),
        );
        return reply(`${timedOut ? "No answer in time" : "The human dismissed the question"}: it stays open — do not take a reading or write it as an Assumption. Record it under Open questions; planning stays incomplete until it is answered.${KEPT}`);
      }
      return reply(`The human answered: ${answer.trim()}`);
    },
  });
}
