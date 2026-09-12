import type { InlineExtension } from "../core/extensions/types.ts";
import llamaExtension from "./llama/index.ts";
import wtangentServerExtension from "./wtangent/server.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, hidden: true },
	{ name: "wtangent-server", factory: wtangentServerExtension, hidden: true },
];
