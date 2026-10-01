import type { InlineExtension } from "../core/extensions/types.ts";
import llamaExtension from "./llama/index.ts";
import tangentServerExtension from "./tangent/server.ts";
import gitSyncExtension from "./tangent/git-sync.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, hidden: true },
	{ name: "tangent-server", factory: tangentServerExtension, hidden: true },
	{ name: "tangent-git-sync", factory: gitSyncExtension, hidden: true },
];
