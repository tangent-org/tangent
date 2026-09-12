import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createTypedSpanStarter, NOOP_TELEMETRY_CONTEXT, type TelemetryContext } from "@tangent-ai/tangent-telemetry";
import { describe, expect, expectTypeOf, it } from "vitest";
import { renderAgentTelemetrySchemaMarkdown } from "../../scripts/generate-telemetry-docs.ts";
import { BACKGROUND_CONTEXT, withTelemetryContext } from "../../src/harness/context.ts";
import {
	AGENT_TELEMETRY_SCHEMAS,
	AI_TELEMETRY_SCHEMA,
	type AiSpanEndAttributes,
	type AiSpanStartAttributes,
	HARNESS_TELEMETRY_SCHEMA,
	type HarnessSpanEndAttributes,
	type HarnessSpanStartAttributes,
	startAiSpan,
	startHarnessSpan,
} from "../../src/harness/telemetry.ts";

describe("agent telemetry schemas", () => {
	it("serializes both schemas and generates the checked-in reference", () => {
		expect(() => JSON.stringify(AI_TELEMETRY_SCHEMA)).not.toThrow();
		expect(() => JSON.stringify(HARNESS_TELEMETRY_SCHEMA)).not.toThrow();
		expect(AGENT_TELEMETRY_SCHEMAS).toEqual([AI_TELEMETRY_SCHEMA, HARNESS_TELEMETRY_SCHEMA]);
		expect(Object.keys(HARNESS_TELEMETRY_SCHEMA.spans)).toEqual([
			"tangent.harness.run",
			"tangent.harness.compaction",
			"tangent.harness.navigation",
			"tangent.harness.checkpoint",
			"tangent.harness.turn",
			"tangent.harness.step",
			"tangent.harness.tool",
			"tangent.harness.hook",
			"tangent.harness.sleep",
			"tangent.harness.event_handler",
			"tangent.session.write",
		]);
		const actual = readFileSync(resolve(import.meta.dirname, "../../docs/telemetry-schema.md"), "utf8");
		expect(actual).toBe(renderAgentTelemetrySchemaMarkdown());
	});

	it("starts AI-request and harness spans through one composed typed starter", async () => {
		const startSpan = createTypedSpanStarter(NOOP_TELEMETRY_CONTEXT, AGENT_TELEMETRY_SCHEMAS);
		await startSpan(
			"tangent.harness.step",
			{
				"tangent.lane.name": "main",
				"tangent.operation.id": "operation",
				"tangent.step.kind": "assistant",
				"tangent.step.attempt": 1,
			},
			async (stepSpan, startChildSpan) => {
				stepSpan.setAttributes({ "tangent.step.outcome": "succeeded" });
				await startChildSpan(
					"tangent.ai.request",
					{
						"tangent.ai.operation": "stream",
						"tangent.ai.provider": "provider",
						"tangent.ai.model": "model",
						"tangent.ai.api": "api",
						"tangent.ai.streaming": true,
					},
					(requestSpan) => {
						requestSpan.setAttributes({ "tangent.ai.response.stop_reason": "stop" });
					},
				);
			},
		);
	});

	it("infers exact AI start and optional end attributes", async () => {
		type Start = AiSpanStartAttributes<"tangent.ai.request">;
		type End = AiSpanEndAttributes<"tangent.ai.request">;
		expectTypeOf<Start>().toMatchTypeOf<{
			"tangent.ai.operation": "stream" | "fetch_deferred" | "cancel_deferred" | "generate_images";
			"tangent.ai.provider": string;
			"tangent.ai.model": string;
			"tangent.ai.api": string;
			"tangent.ai.streaming": boolean;
			"tangent.ai.deferred"?: boolean;
		}>();
		expectTypeOf<End["tangent.ai.response.stop_reason"]>().toEqualTypeOf<
			"stop" | "length" | "tool_use" | "error" | "aborted" | "deferred" | undefined
		>();

		const telemetryContext: TelemetryContext = NOOP_TELEMETRY_CONTEXT;
		const context = withTelemetryContext(telemetryContext, BACKGROUND_CONTEXT);
		await startAiSpan(
			"tangent.ai.request",
			{
				"tangent.ai.operation": "stream",
				"tangent.ai.provider": "provider",
				"tangent.ai.model": "model",
				"tangent.ai.api": "api",
				"tangent.ai.streaming": true,
			},
			(span) => {
				span.setAttributes({ "tangent.ai.response.stop_reason": "tool_use" });
				// @ts-expect-error tangent.ai.request declares no span events
				span.addEvent("chunk");
			},
			context,
		);

		const compileTimeFailures = () => {
			const extraAttributes = {
				"tangent.ai.operation": "stream",
				"tangent.ai.provider": "provider",
				"tangent.ai.model": "model",
				"tangent.ai.api": "api",
				"tangent.ai.streaming": true,
				"tangent.ai.unknown": true,
			} as const;
			// @ts-expect-error variables with unknown attributes are rejected
			void startAiSpan("tangent.ai.request", extraAttributes, () => {}, context);
			// @ts-expect-error missing required start attributes
			void startAiSpan("tangent.ai.request", { "tangent.ai.operation": "stream" }, () => {}, context);
		};
		expectTypeOf(compileTimeFailures).toBeFunction();
	});

	it("infers per-span harness literals and optional completion enrichment", async () => {
		type RunStart = HarnessSpanStartAttributes<"tangent.harness.run">;
		type RunEnd = HarnessSpanEndAttributes<"tangent.harness.run">;
		type WriteStart = HarnessSpanStartAttributes<"tangent.session.write">;
		type WriteEnd = HarnessSpanEndAttributes<"tangent.session.write">;
		expectTypeOf<RunStart["tangent.operation.kind"]>().toEqualTypeOf<"run">();
		expectTypeOf<RunEnd["tangent.operation.outcome"]>().toEqualTypeOf<
			"completed" | "aborted" | "failed" | "suspended" | undefined
		>();
		const writeStart = {
			"tangent.session.id": "session",
			"tangent.session.item_count": 2,
			"tangent.session.item_kinds": ["entry", "value", "list"],
		} satisfies WriteStart;
		const writeEnd = {
			"tangent.session.first_seq": 1,
			"tangent.session.last_seq": 2,
		} satisfies WriteEnd;
		expectTypeOf(writeStart["tangent.session.item_count"]).toEqualTypeOf<number>();
		expectTypeOf(writeEnd["tangent.session.last_seq"]).toEqualTypeOf<number>();

		const telemetryContext: TelemetryContext = NOOP_TELEMETRY_CONTEXT;
		const context = withTelemetryContext(telemetryContext, BACKGROUND_CONTEXT);
		await startHarnessSpan(
			"tangent.harness.run",
			{
				"tangent.session.id": "session",
				"tangent.lane.name": "main",
				"tangent.operation.id": "operation",
				"tangent.operation.kind": "run",
				"tangent.operation.recovery": false,
			},
			(span) => {
				span.setAttributes({ "tangent.operation.outcome": "completed" });
				span.setAttributes({});
				// @ts-expect-error the harness schema declares no span events
				span.addEvent("result");
			},
			context,
		);

		const compileTimeFailures = () => {
			const extraRunAttributes = {
				"tangent.session.id": "session",
				"tangent.lane.name": "main",
				"tangent.operation.id": "operation",
				"tangent.operation.kind": "run",
				"tangent.operation.recovery": false,
				"tangent.unknown": true,
			} as const;
			// @ts-expect-error variables with unknown attributes are rejected
			void startHarnessSpan("tangent.harness.run", extraRunAttributes, () => {}, context);
			void startHarnessSpan(
				"tangent.harness.checkpoint",
				{
					"tangent.lane.name": "main",
					"tangent.operation.id": "operation",
					"tangent.checkpoint.kind": "normal",
				},
				(span) => {
					// @ts-expect-error empty end schemas reject every attribute
					span.setAttributes({ "tangent.unknown": true });
				},
				context,
			);
			void startHarnessSpan(
				"tangent.harness.run",
				{
					"tangent.session.id": "session",
					"tangent.lane.name": "main",
					"tangent.operation.id": "operation",
					// @ts-expect-error run spans accept only the run operation kind
					"tangent.operation.kind": "navigation",
					"tangent.operation.recovery": false,
				},
				() => {},
				context,
			);
			// @ts-expect-error missing required run start attributes
			void startHarnessSpan("tangent.harness.run", {}, () => {}, context);
		};
		expectTypeOf(compileTimeFailures).toBeFunction();
	});
});
