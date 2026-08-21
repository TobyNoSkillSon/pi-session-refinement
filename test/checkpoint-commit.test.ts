import assert from "node:assert/strict";
import test from "node:test";
import { commitCheckpoint } from "../src/checkpoint-commit.ts";
import type { SessionRefinementState } from "../src/types.ts";

const paths = { root: "/tmp/session", memory: "/tmp/session/memory.md", pending: "/tmp/session/pending.md", state: "/tmp/session/state.json" };
const record = { throughEntryId: "through", createdAt: "2026-01-01T00:00:00.000Z", trigger: "time" as const };

function state(): SessionRefinementState {
	return { version: 1 as const, sessionId: "session", toolCallsSinceRun: 2, checkpoints: [], warnings: [] };
}

test("checkpoint commit publishes matching memory and cursor state", async () => {
	const current = state();
	const events: string[] = [];
	await commitCheckpoint({
		paths, state: current, body: "checkpoint", record, budgetTokens: 100,
		applyState(value) { value.lastProcessedEntryId = record.throughEntryId; value.checkpoints.push(record); },
		dependencies: {
			readMemory: async () => "old",
			append: async () => { events.push("append"); },
			write: async () => { events.push("rollback"); },
			save: async () => { events.push("save"); },
		},
	});
	assert.deepEqual(events, ["append", "save"]);
	assert.equal(current.lastProcessedEntryId, "through");
});

test("checkpoint commit restores memory and in-memory state after state failure", async () => {
	const current = state();
	const writes: string[] = [];
	await assert.rejects(commitCheckpoint({
		paths, state: current, body: "checkpoint", record, budgetTokens: 100,
		applyState(value) { value.lastProcessedEntryId = record.throughEntryId; value.checkpoints.push(record); },
		dependencies: {
			readMemory: async () => "old",
			append: async () => {},
			write: async (_path, content) => { writes.push(content); },
			save: async () => { throw new Error("state failed"); },
		},
	}), /state failed/);
	assert.deepEqual(writes, ["old"]);
	assert.equal(current.lastProcessedEntryId, undefined);
	assert.deepEqual(current.checkpoints, []);
	assert.equal(current.toolCallsSinceRun, 2);
});

test("checkpoint append failure does not attempt rollback", async () => {
	const current = state();
	let writes = 0;
	await assert.rejects(commitCheckpoint({
		paths, state: current, body: "checkpoint", record, budgetTokens: 100,
		applyState() {},
		dependencies: {
			readMemory: async () => "old",
			append: async () => { throw new Error("append failed"); },
			write: async () => { writes++; },
			save: async () => {},
		},
	}), /append failed/);
	assert.equal(writes, 0);
});
