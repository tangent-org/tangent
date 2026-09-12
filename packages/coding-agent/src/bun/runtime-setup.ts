import { bedrockProviderModule } from "@tangent-ai/tangent-ai/bedrock-provider";
import { registerBunOAuthFlows } from "@tangent-ai/tangent-ai/bun-oauth";
import { setBedrockProviderModule } from "@tangent-ai/tangent-ai/compat";
import { APP_NAME } from "../config.ts";

process.title = APP_NAME;
process.emitWarning = (() => {}) as typeof process.emitWarning;
registerBunOAuthFlows();
setBedrockProviderModule(bedrockProviderModule);
