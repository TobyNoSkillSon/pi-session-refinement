import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { RefinementController } from "../src/lifecycle.ts";
import sessionRefinement from "../src/index.ts";
import { buildMemoryOverlay, MEMORY_UPDATE_CUSTOM_TYPE } from "../src/memory-overlay.ts";
import { appendRecordToMemory, formatMemoryRecord, getSessionPaths, parseMemoryRecords, renderMemoryForPrompt, writeMemoryGeneration } from "../src/memory-file.ts";
import { createCheckpointRecord } from "../src/rolling-memory.ts";

const BASE_RECORD = createCheckpointRecord({ throughEntryId: "base", createdAt: "2026-01-01T00:00:00Z", trigger: "time" });
const NEW_RECORD = createCheckpointRecord({ fromEntryId: "next", throughEntryId: "next", createdAt: "2026-01-01T01:00:00Z", trigger: "context" });
const REPLACEMENT_RECORD = createCheckpointRecord({ throughEntryId: "replacement", createdAt: "2026-01-01T02:00:00Z", trigger: "rebuild" });
const BASE = appendRecordToMemory("", "BASE_MEMORY", BASE_RECORD);
const APPENDED = appendRecordToMemory(BASE, "NEW_CHECKPOINT", NEW_RECORD);
const REPLACEMENT = appendRecordToMemory("", "REPLACEMENT_MEMORY", REPLACEMENT_RECORD);

const ctx = {
	mode: "tui",
	hasUI: true,
	ui: { notify() {}, setWidget() {} },
} as any;

async function syntheticController(memory = BASE) {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-session-refinement-postcompact-"));
	const paths = getSessionPaths(agentDir, "session");
	const controller: any = new RefinementController({} as any);
	controller.active = true;
	controller.firstPrompt = false;
	controller.injectedMemory = memory;
	controller.state = { version: 2, sessionId: "session", toolCallsSinceRun: 0, records: [], warnings: [] };
	if (memory) {
		controller.state.records = parseMemoryRecords(memory).map((entry) => entry.record);
		controller.state.lastProcessedEntryId = controller.state.records.at(-1).throughEntryId;
		controller.state.memoryGeneration = await writeMemoryGeneration(paths, memory);
	}
	controller.paths = paths;
	controller.loadedConfig = {
		config: { enabled: true, model: "current", thinking: "high", consolidator: { model: "current", thinking: "high" }, memoryBudgetTokens: 32_000, triggers: { contextPercent: 80, elapsedMinutes: 40, minimumToolCalls: 25 }, runOnManualCompaction: true, maxAttempts: 3 },
		issues: [],
	};
	return { controller, paths, agentDir };
}

async function publish(controller: any, paths: ReturnType<typeof getSessionPaths>, memory: string): Promise<void> {
	const records = parseMemoryRecords(memory).map((entry) => entry.record);
	controller.state.records = records;
	controller.state.lastProcessedEntryId = records.at(-1)?.throughEntryId;
	controller.state.memoryGeneration = memory ? await writeMemoryGeneration(paths, memory) : undefined;
}

function userMessage(text = "continue") {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 } as any;
}

test("memory overlay emits only an appended checkpoint delta", () => {
	const overlay = buildMemoryOverlay(BASE, APPENDED, 10);
	assert.equal(overlay?.mode, "append");
	assert.match(overlay?.body ?? "", /NEW_CHECKPOINT/);
	assert.doesNotMatch(overlay?.body ?? "", /BASE_MEMORY/);
	assert.equal((overlay?.message as any).customType, MEMORY_UPDATE_CUSTOM_TYPE);
	assert.equal((overlay?.message as any).display, false);
});

test("first checkpoint creates an initial continuation overlay", () => {
	const overlay = buildMemoryOverlay("", BASE, 10);
	assert.equal(overlay?.mode, "initial");
	assert.match(overlay?.body ?? "", /BASE_MEMORY/);
	assert.match(String((overlay?.message as any).content), /Session memory was created during compaction/);
});

test("non-append replacement waits for a fresh system prompt", () => {
	assert.equal(buildMemoryOverlay(BASE, REPLACEMENT, 10), undefined);
});

test("unchanged or empty active memory creates no overlay", () => {
	assert.equal(buildMemoryOverlay(BASE, BASE), undefined);
	assert.equal(buildMemoryOverlay(BASE, ""), undefined);
});

test("post-compaction continuation receives newly refined memory on every provider call", async () => {
	const { controller, paths, agentDir } = await syntheticController();
	try {
		const originalPrompt = await controller.beforeAgentStart(ctx, "SYSTEM");
		assert.match(originalPrompt, /BASE_MEMORY/);
		await publish(controller, paths, APPENDED);
		await controller.afterCompact();

		const source = [userMessage()];
		const first = controller.contextMessages(source);
		const second = controller.contextMessages(source);
		assert.equal(source.length, 1, "context transformation must not mutate Pi messages");
		for (const result of [first, second]) {
			assert.equal(result?.messages?.length, 2);
			const update = result?.messages?.[1] as any;
			assert.equal(update.customType, MEMORY_UPDATE_CUSTOM_TYPE);
			assert.match(String(update.content), /NEW_CHECKPOINT/);
			assert.doesNotMatch(String(update.content), /BASE_MEMORY/);
			assert.doesNotMatch(String(update.content), /pi-session-refinement:/);
			const providerMessages = convertToLlm(result!.messages!);
			const providerText = JSON.stringify(providerMessages.at(-1));
			assert.match(providerText, /NEW_CHECKPOINT/);
			assert.match(providerText, /session_memory_update/);
		}
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("fresh prompt after compaction carries full memory and clears the temporary overlay", async () => {
	const { controller, paths, agentDir } = await syntheticController();
	try {
		await controller.beforeAgentStart(ctx, "SYSTEM");
		await publish(controller, paths, APPENDED);
		await controller.afterCompact();
		assert.ok(controller.contextMessages([userMessage()]));

		const freshPrompt = await controller.beforeAgentStart(ctx, "SYSTEM");
		assert.match(freshPrompt, /BASE_MEMORY/);
		assert.match(freshPrompt, /NEW_CHECKPOINT/);
		assert.equal((freshPrompt.match(/NEW_CHECKPOINT/g) ?? []).length, 1);
		assert.equal(controller.contextMessages([userMessage("queued prompt")]), undefined);
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("background disk checkpoint stays inactive until an activation boundary", async () => {
	const { controller, paths, agentDir } = await syntheticController();
	try {
		await controller.beforeAgentStart(ctx, "SYSTEM");
		await publish(controller, paths, APPENDED);
		assert.equal(controller.contextMessages([userMessage()]), undefined);
		const beforeActivation = await controller.beforeAgentStart(ctx, "SYSTEM");
		assert.doesNotMatch(beforeActivation, /NEW_CHECKPOINT/);

		await controller.afterCompact();
		assert.ok(controller.contextMessages([userMessage()]));
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("compaction without a memory change creates no continuation overlay", async () => {
	const { controller, agentDir } = await syntheticController();
	try {
		await controller.beforeAgentStart(ctx, "SYSTEM");
		await controller.afterCompact();
		assert.equal(controller.contextMessages([userMessage()]), undefined);
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("non-append replacement waits for a fresh prompt and then becomes canonical", async () => {
	const { controller, paths, agentDir } = await syntheticController();
	try {
		await controller.beforeAgentStart(ctx, "SYSTEM");
		await publish(controller, paths, REPLACEMENT);
		await controller.afterCompact();
		assert.equal(controller.contextMessages([userMessage()]), undefined);

		const freshPrompt = await controller.beforeAgentStart(ctx, "SYSTEM");
		assert.match(freshPrompt, /REPLACEMENT_MEMORY/);
		assert.doesNotMatch(freshPrompt, /BASE_MEMORY/);
		assert.equal(controller.contextMessages([userMessage()]), undefined);
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});


test("a consolidation replacement activates only the exact additive checkpoint during immediate continuation", async () => {
	const { controller, paths, agentDir } = await syntheticController();
	try {
		await controller.beforeAgentStart(ctx, "SYSTEM");
		controller.deferredCheckpointUpdates = [renderMemoryForPrompt(formatMemoryRecord("NEW_CHECKPOINT", NEW_RECORD))];
		await publish(controller, paths, REPLACEMENT);
		await controller.afterCompact();
		for (const result of [controller.contextMessages([userMessage()]), controller.contextMessages([userMessage()])]) {
			const sent = JSON.stringify(result?.messages);
			assert.match(sent, /NEW_CHECKPOINT/);
			assert.doesNotMatch(sent, /REPLACEMENT_MEMORY/);
		}
		const fresh = await controller.beforeAgentStart(ctx, "SYSTEM");
		assert.match(fresh, /REPLACEMENT_MEMORY/);
		assert.equal(controller.contextMessages([userMessage()]), undefined);
	} finally { await rm(agentDir, { recursive: true, force: true }); }
});

test("extension registers the post-compaction provider-context bridge", () => {
	const handlers = new Map<string, Function>();
	const fakePi = {
		on(name: string, handler: Function) { handlers.set(name, handler); },
		registerCommand() {},
	} as any;
	sessionRefinement(fakePi);
	assert.equal(typeof handlers.get("context"), "function");
	assert.equal(typeof handlers.get("before_agent_start"), "function");
	assert.equal(typeof handlers.get("session_compact"), "function");
});


test("provider-context bridge remains fail-open if overlay preparation throws", async () => {
	const handlers = new Map<string, Function>();
	const original = RefinementController.prototype.contextMessages;
	RefinementController.prototype.contextMessages = function () { throw new Error("synthetic overlay failure"); };
	try {
		sessionRefinement({
			on(name: string, handler: Function) { handlers.set(name, handler); },
			registerCommand() {},
		} as any);
		const handler = handlers.get("context");
		assert.ok(handler);
		assert.equal(await handler({ messages: [{ role: "user", content: "unchanged" }] }), undefined);
	} finally {
		RefinementController.prototype.contextMessages = original;
	}
});

const FAKE_MODEL: Model<any> = {
	id: "synthetic",
	name: "Synthetic",
	api: "openai-completions",
	provider: "synthetic",
	baseUrl: "http://localhost.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 1_000,
};

const ZERO_USAGE = {
	input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(content: AssistantMessage["content"], stopReason: "stop" | "toolUse"): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: FAKE_MODEL.api,
		provider: FAKE_MODEL.provider,
		model: FAKE_MODEL.id,
		usage: ZERO_USAGE,
		stopReason,
		timestamp: Date.now(),
	};
}

function completedStream(message: AssistantMessage) {
	const stream = createAssistantMessageEventStream();
	stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
	return stream;
}

test("synthetic provider sees the first checkpoint when compaction creates session memory", async () => {
	const { controller, paths, agentDir } = await syntheticController("");
	try {
		const staleSystemPrompt = await controller.beforeAgentStart(ctx, "SYSTEM");
		assert.doesNotMatch(staleSystemPrompt, /session_memory/);
		await publish(controller, paths, BASE);
		await controller.afterCompact();

		const captures: Array<{ systemPrompt?: string; messages: Context["messages"] }> = [];
		const agent = new Agent({
			initialState: {
				systemPrompt: staleSystemPrompt,
				model: FAKE_MODEL,
				thinkingLevel: "off",
				tools: [],
				messages: [userMessage("continue first compacted run")],
			},
			convertToLlm,
			transformContext: async (messages) => controller.contextMessages(messages)?.messages ?? messages,
			streamFn: async (_model, providerContext) => {
				captures.push({ systemPrompt: providerContext.systemPrompt, messages: structuredClone(providerContext.messages) });
				return completedStream(assistant([{ type: "text", text: "done" }], "stop"));
			},
		});
		await agent.continue();
		assert.equal(captures.length, 1);
		assert.doesNotMatch(captures[0].systemPrompt ?? "", /BASE_MEMORY/);
		assert.match(JSON.stringify(captures[0].messages), /BASE_MEMORY/);
		assert.match(JSON.stringify(captures[0].messages), /session_memory_update/);

		const freshSystemPrompt = await controller.beforeAgentStart(ctx, "SYSTEM");
		agent.state.systemPrompt = freshSystemPrompt;
		await agent.prompt(userMessage("fresh prompt"));
		assert.match(captures[1].systemPrompt ?? "", /BASE_MEMORY/);
		assert.doesNotMatch(JSON.stringify(captures[1].messages), /session_memory_update/);
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("synthetic provider sees compaction delta throughout continuation, then full fresh snapshot", async () => {
	const { controller, paths, agentDir } = await syntheticController();
	try {
		const staleSystemPrompt = await controller.beforeAgentStart(ctx, "SYSTEM");
		await publish(controller, paths, APPENDED);
		await controller.afterCompact();

		const captures: Array<{ systemPrompt?: string; messages: Context["messages"] }> = [];
		let providerCall = 0;
		const probeTool = {
			name: "probe",
			label: "Probe",
			description: "Synthetic tool",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text" as const, text: "probe result" }], details: {} }),
		};
		const agent = new Agent({
			initialState: {
				systemPrompt: staleSystemPrompt,
				model: FAKE_MODEL,
				thinkingLevel: "off",
				tools: [probeTool],
				messages: [userMessage("continue interrupted work")],
			},
			convertToLlm,
			transformContext: async (messages) => controller.contextMessages(messages)?.messages ?? messages,
			streamFn: async (_model, providerContext) => {
				captures.push({ systemPrompt: providerContext.systemPrompt, messages: structuredClone(providerContext.messages) });
				providerCall++;
				if (providerCall === 1) {
					return completedStream(assistant([{ type: "toolCall", id: "probe-1", name: "probe", arguments: {} }], "toolUse"));
				}
				return completedStream(assistant([{ type: "text", text: "done" }], "stop"));
			},
		});

		await agent.continue();
		assert.equal(captures.length, 2, agent.state.errorMessage ?? "tool continuation should make two provider calls");
		for (const providerContext of captures) {
			assert.match(providerContext.systemPrompt ?? "", /BASE_MEMORY/);
			assert.doesNotMatch(providerContext.systemPrompt ?? "", /NEW_CHECKPOINT/);
			const sentMessages = JSON.stringify(providerContext.messages);
			assert.match(sentMessages, /NEW_CHECKPOINT/);
			assert.equal((sentMessages.match(/NEW_CHECKPOINT/g) ?? []).length, 1);
			assert.doesNotMatch(sentMessages, /pi-session-refinement:/);
		}
		assert.equal(agent.state.messages.some((message: any) => message.customType === MEMORY_UPDATE_CUSTOM_TYPE), false, "overlay must not persist in agent state");

		const freshSystemPrompt = await controller.beforeAgentStart(ctx, "SYSTEM");
		agent.state.systemPrompt = freshSystemPrompt;
		await agent.prompt(userMessage("fresh prompt"));
		assert.equal(captures.length, 3);
		assert.match(captures[2].systemPrompt ?? "", /NEW_CHECKPOINT/);
		assert.doesNotMatch(JSON.stringify(captures[2].messages), /session_memory_update/);
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});
