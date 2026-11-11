/**
 * Loaded only into pb's fresh reviewer, verifier and cartographer processes (`pi -e`): the tools they
 * report through, so pb reads their findings, verdicts and maps from tool calls instead of parsing prose.
 * The calls themselves are what pb reads; the tools only acknowledge them.
 */
import { StringEnum, Type } from "./schema.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function reviewTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: "report_findings",
    label: "Report findings",
    description: "Report the review's findings: one call with all of them, an empty list when there are none.",
    parameters: Type.Object({
      findings: Type.Array(
        Type.Object({
          priority: StringEnum(["P0", "P1", "P2", "P3"]),
          file: Type.Optional(Type.String({ description: "path relative to the repository root" })),
          line: Type.Optional(Type.Number()),
          title: Type.String({ description: "the problem, in one sentence" }),
          fix: Type.Optional(Type.String({ description: "a concrete fix" })),
          check: Type.Optional(Type.String({ description: "in a spec review: the name of the check the finding fails (e.g. Claims, Values, Proof), as your instructions list them" })),
          outside: Type.Optional(Type.Boolean({ description: "true when the problem pre-dates this change (outside it): still a finding — give it the priority it deserves, and a serious one (P0/P1) still blocks" })),
          map: Type.Optional(StringEnum(["stated", "wrong"], { description: "in a code review: \"stated\" when the problem breaks a rule the project map in AGENTS.md states; \"wrong\" when the problem is that a map line is wrong (the code contradicts it)" })),
        }),
      ),
    }),
    async execute(_id, params) {
      return { content: [{ type: "text", text: `Recorded ${params.findings.length} finding(s).` }], details: undefined };
    },
  });

  pi.registerTool({
    name: "report_map",
    label: "Report map",
    description: "Report the whole new project map (its body, without a top heading) and what changed, one line each; an empty list when nothing changed.",
    parameters: Type.Object({
      map: Type.String({ description: "the whole map, markdown" }),
      changes: Type.Array(Type.String(), { description: "what changed, one line each" }),
    }),
    async execute(_id, params) {
      return { content: [{ type: "text", text: `Recorded the map (${params.map.split("\n").length} lines).` }], details: undefined };
    },
  });

  pi.registerTool({
    name: "report_verdicts",
    label: "Report verdicts",
    description: "Report whether each finding is confirmed or rejected: one entry per finding, by its number.",
    parameters: Type.Object({
      verdicts: Type.Array(
        Type.Object({
          finding: Type.Number({ description: "the finding's number in the brief" }),
          verdict: StringEnum(["confirmed", "rejected"]),
          evidence: Type.String({ description: "one line, with file:line" }),
        }),
      ),
    }),
    async execute(_id, params) {
      return { content: [{ type: "text", text: `Recorded ${params.verdicts.length} verdict(s).` }], details: undefined };
    },
  });
}
