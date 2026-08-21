import assert from "node:assert/strict";
import test from "node:test";
import { commitRebuiltMemory } from "../src/rebuild-commit.ts";

const paths = { root: "/tmp/session", memory: "/tmp/session/memory.md", pending: "/tmp/session/pending.md", state: "/tmp/session/state.json" };
const state = { version: 1 as const, sessionId: "session", toolCallsSinceRun: 0, checkpoints: [], warnings: [] };

test("rebuild commit writes memory before publishing matching state", async () => {
	const events: string[] = [];
	await commitRebuiltMemory({
		paths,
		memory: "new",
		state,
		dependencies: {
			readMemory: async () => "old",
			write: async (_path, content) => { events.push(`write:${content}`); },
			save: async () => { events.push("save"); },
		},
	});
	assert.deepEqual(events, ["write:new", "save"]);
});

test("rebuild commit restores old memory when state publication fails", async () => {
	const writes: string[] = [];
	await assert.rejects(commitRebuiltMemory({
		paths,
		memory: "new",
		state,
		dependencies: {
			readMemory: async () => "old",
			write: async (_path, content) => { writes.push(content); },
			save: async () => { throw new Error("state failed"); },
		},
	}), /state failed/);
	assert.deepEqual(writes, ["new", "old"]);
});

test("rebuild commit reports state and rollback failures together", async () => {
	let writes = 0;
	await assert.rejects(commitRebuiltMemory({
		paths,
		memory: "new",
		state,
		dependencies: {
			readMemory: async () => "old",
			write: async () => { if (++writes === 2) throw new Error("rollback failed"); },
			save: async () => { throw new Error("state failed"); },
		},
	}), AggregateError);
});
