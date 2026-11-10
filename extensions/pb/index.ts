/**
 * pi-plan-build (pb): plan a feature with Pi, turn it into a spec, build it task by task
 * behind checks the harness runs, and have it reviewed with fresh eyes.
 *
 *   /pb:plan <what you want> plan together; the project's files stay untouched (/pb:plan <spec>: continue one)
 *   /pb:approach [idea]    in planning: hear how Pi would approach it (chat only: no writes, no dialogs)
 *   /pb:compact            planning: write the plan to its spec and reset to it; build: compact to the build's state
 *   /pb:spec [which]       write or revise the spec(s) from the discussion
 *   /pb:build [name]       build a spec here (--fresh: in a new session); resumes after a pause
 *   /pb:spec-review [name] the pre-build review on its own: fresh eyes on a ready spec, nothing built
 *   /pb:spec-fix [name] [ids] one repair lap over the review's findings: probes, decides, argues, asks
 *   /pb:spec-harden [name]  auto-pilot: repair laps, a claim check after each, one confirming review, one last lap
 *   /pb:review [focus]     fresh, independent review against the spec, or of any uncommitted change
 *   /pb:deps [scope]       check dependencies and propose upgrades, as a change of their own
 *   /pb:undo [id]          restore the files, and rewind the conversation, to before a task
 *   /pb:stats [all]        tasks, attempts, checks, tokens and cache per spec
 *   /pb:archive [name]     move a finished spec out of the way
 *   /pb:standards [stack]  write the current standards into this project's AGENTS.md (java | vue | rust | plain | yours)
 *   /pb:status             every spec and where it stands
 *   /pb:help [topic]       what to do next
 *
 * Inspired by GVS5H (Gao et al., arXiv:2608.26480): small tasks, a verifier that
 * outranks the model's own "done", and fresh eyes against anchoring. pb has since
 * deviated far from it; see the README's credits.
 *
 * The implementation is split by role; kit.ts holds the shared machinery, so the trust
 * boundaries (the build's approval gate, the read-only review, the fix numbering) stay
 * legible one module at a time:
 *   plan.ts       /pb:plan, /pb:approach, /pb:deps — the baseline and the planning guard
 *   flow.ts       pb_write_spec … pb_spec_fix_done, the spec review and its repair laps,
 *                 /pb:build, /pb:spec, /pb:spec-review, /pb:spec-fix, /pb:spec-harden
 *   review-flow.ts pb_report_findings, the review passes and /pb:review
 *   fix.ts        pb_fix_done, the fix-lap loop and /pb:fix
 *   hooks.ts      pi's event hooks (compaction, checkpoints, planning protections) and /pb:compact
 *   ask.ts        pb_ask (the one question tool); fresh-tools.ts pb_explore and pb_try
 *   undo.ts       /pb:undo; archive.ts /pb:archive; map-flow.ts the project map
 *   misc.ts       /pb:stats, /pb:standards, /pb:status, /pb:help
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { bindKit } from "./kit.ts";
import { registerRenderers } from "./render.ts";
import { registerAsk } from "./ask.ts";
import { registerArchive } from "./archive.ts";
import { registerFix } from "./fix.ts";
import { registerFlow } from "./flow.ts";
import { registerFreshTools } from "./fresh-tools.ts";
import { registerHooks } from "./hooks.ts";
import { registerMapFlow } from "./map-flow.ts";
import { registerMisc } from "./misc.ts";
import { registerPlan } from "./plan.ts";
import { registerReviewFlow } from "./review-flow.ts";
import { registerUndo } from "./undo.ts";

export { sessionGone, ASK_DESCRIPTION } from "./kit.ts";

export default function pb(pi: ExtensionAPI) {
  bindKit(pi);
  registerRenderers(pi);
  registerHooks(pi);
  registerAsk(pi);
  registerFreshTools(pi);
  registerPlan(pi);
  registerFlow(pi);
  registerReviewFlow(pi);
  registerFix(pi);
  registerMapFlow(pi);
  registerArchive(pi);
  registerUndo(pi);
  registerMisc(pi);
}
