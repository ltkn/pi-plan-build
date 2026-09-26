/**
 * Loaded only into the fresh reviewer and verifier processes (`pi -e`): the tools they report
 * through, so pb reads their findings and verdicts from tool calls instead of parsing prose.
 * The calls themselves are what pb reads; the tools only acknowledge them.
 */
import { StringEnum, Type } from "@earendil-works/pi-ai";
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
        }),
      ),
    }),
    async execute(_id, params) {
      return { content: [{ type: "text", text: `Recorded ${params.findings.length} finding(s).` }], details: undefined };
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
