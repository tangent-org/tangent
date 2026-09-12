import type { ExtensionAPI } from "@tangent-ai/tangent-coding-agent";

export default function widgetPlacementExtension(tangent: ExtensionAPI) {
	tangent.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setWidget("widget-above", ["Above editor widget"]);
		ctx.ui.setWidget("widget-below", ["Below editor widget"], { placement: "belowEditor" });
	});
}
