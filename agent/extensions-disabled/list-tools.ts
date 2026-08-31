import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";

function describeSource(tool: ToolInfo): string {
	const source = tool.sourceInfo?.source ?? "unknown";
	if (source === "builtin") return "builtin";
	if (source === "sdk") return "sdk";
	return `extension: ${source}`;
}

function formatTool(tool: ToolInfo): string {
	const description = tool.description ? ` - ${tool.description}` : "";
	return `${tool.name} (${describeSource(tool)})${description}`;
}

export default function listToolsExtension(pi: ExtensionAPI) {
	pi.registerCommand("list-tools", {
		description: "List currently active tools",
		handler: async (_args, ctx) => {
			const activeNames = pi.getActiveTools();
			const allTools = pi.getAllTools();
			const byName = new Map(allTools.map((tool) => [tool.name, tool]));

			if (activeNames.length === 0) {
				ctx.ui.notify("No tools are currently active.", "info");
				return;
			}

			const items = activeNames
				.map((name) => byName.get(name) ?? ({ name, description: "", sourceInfo: { source: "unknown" } } as ToolInfo))
				.sort((a, b) => a.name.localeCompare(b.name))
				.map(formatTool);

			const selected = await ctx.ui.select(`Active Tools (${items.length})`, items);
			if (!selected) return;

			const name = selected.split(" ", 1)[0];
			const tool = byName.get(name);
			if (tool?.sourceInfo?.path) {
				ctx.ui.notify(`${name}: ${tool.sourceInfo.path}`, "info");
			}
		},
	});
}
