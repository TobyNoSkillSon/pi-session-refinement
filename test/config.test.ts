import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG, parseConfig } from "../src/config.ts";

test("uses portable defaults", () => {
	const { config, issues } = parseConfig(undefined);
	assert.deepEqual(config, DEFAULT_CONFIG);
	assert.deepEqual(issues, []);
	assert.equal(config.model, "current");
	assert.equal(config.memoryBudgetTokens, 32_000);
	assert.deepEqual(config.consolidator, { model: "current", thinking: "high" });
});

test("accepts configurable model, trigger, budget, and retry settings", () => {
	const { config, issues } = parseConfig({
		model: "provider/model",
		thinking: "medium",
		consolidator: { model: "provider/consolidator", thinking: "low" },
		memoryBudgetTokens: 12_345,
		triggers: { contextPercent: 85, elapsedMinutes: 60, minimumToolCalls: 10 },
		maxAttempts: 5,
	});
	assert.deepEqual(issues, []);
	assert.equal(config.model, "provider/model");
	assert.equal(config.triggers.contextPercent, 85);
	assert.equal(config.consolidator.model, "provider/consolidator");
	assert.equal(config.maxAttempts, 5);
});

test("invalid values fall back with diagnostics", () => {
	const { config, issues } = parseConfig({ memoryBudgetTokens: -1, triggers: { contextPercent: 100 } });
	assert.equal(config.memoryBudgetTokens, DEFAULT_CONFIG.memoryBudgetTokens);
	assert.equal(config.triggers.contextPercent, DEFAULT_CONFIG.triggers.contextPercent);
	assert.equal(issues.length, 2);
});
