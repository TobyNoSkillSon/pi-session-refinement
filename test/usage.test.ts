import assert from "node:assert/strict";
import test from "node:test";
import { recordOperationUsage } from "../src/usage.ts";

test("failed usage records preserve the last model actually attempted and actual fallback attempt", () => {
	let stored: any;
	recordOperationUsage({
		pi: { appendEntry(_type: string, value: unknown) { stored = value; } } as any,
		operation: "consolidation",
		trigger: "context",
		config: { model: "configured/model", thinking: "high" },
		result: { ok: false, usedModel: "fallback/current", attempts: 4, fallbackUsed: true, error: "failed" },
	});
	assert.equal(stored.usedModel, "fallback/current");
	assert.equal(stored.fallbackUsed, true);
	assert.equal(stored.attempts, 4);
});

test("usage accounting stays fail-open when the session hook rejects it", () => {
	assert.doesNotThrow(() => recordOperationUsage({
		pi: { appendEntry() { throw new Error("session unavailable"); } } as any,
		operation: "consolidation",
		trigger: "time",
		config: { model: "current", thinking: "high" },
		result: { ok: false, usedModel: "provider/last-attempt", attempts: 3, fallbackUsed: false, error: "failed" },
	}));
});
