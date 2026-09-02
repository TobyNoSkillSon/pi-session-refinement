import assert from "node:assert/strict";
import test from "node:test";
import { resolveConfiguredModel } from "../src/examiner.ts";
import { buildConsolidatorTask } from "../src/prompt.ts";

const models = [
	{ provider: "provider-c", id: "gpt-a" },
	{ provider: "provider-a", id: "shared" },
	{ provider: "provider-b", id: "shared" },
] as any[];
const registry = { getAvailable: () => models } as any;

test("resolves canonical and uniquely bare available models", () => {
	assert.equal(resolveConfiguredModel("provider-c/gpt-a", registry), models[0]);
	assert.equal(resolveConfiguredModel("gpt-a", registry), models[0]);
});

test("rejects missing and ambiguous models", () => {
	assert.equal(resolveConfiguredModel("missing", registry), undefined);
	assert.equal(resolveConfiguredModel("shared", registry), undefined);
});

test("consolidator task contains only the selected prefix supplied by the host", () => {
	const task = buildConsolidatorTask({
		sessionId: "session", trigger: "context", prefixMemory: "SELECTED_PREFIX_ONLY", prefixRecords: 2,
		firstSourceEntry: "a", lastSourceEntry: "b", cutoffAt: "2026-01-01T00:00:00Z", outputBudgetTokens: 100,
	});
	assert.match(task, /SELECTED_PREFIX_ONLY/);
	assert.match(task, /Operation: consolidation/);
	assert.match(task, /after exact retained-memory, header, heading, and metadata costs/);
	assert.doesNotMatch(task, /retained suffix|existing_session_memory|new_chronological_interval/i);
});
