/**
 * How pb's session entries look in the terminal. The spec view is a custom entry: you read the
 * whole spec before building, and the model isn't sent it again (it wrote it).
 */
import { type ExtensionAPI, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";

export function registerRenderers(pi: ExtensionAPI) {
  pi.registerEntryRenderer<{ name: string; markdown: string }>("pb-spec", (entry, { expanded }, theme) => {
    const data = entry.data;
    if (!data) return undefined;
    const box = new Box(1, 1, (s) => theme.bg("customMessageBg", s));
    box.addChild(new Text(theme.fg("accent", `spec: ${data.name}`) + (expanded ? "" : theme.fg("dim", "  (expand to read it all)")), 0, 0));
    const body = expanded ? data.markdown : data.markdown.split("\n").slice(0, 24).join("\n");
    box.addChild(new Markdown(body, 0, 1, getMarkdownTheme()));
    return box;
  });
}
