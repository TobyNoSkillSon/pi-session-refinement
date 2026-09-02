import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { commitCandidatePublication } from "../src/checkpoint-commit.ts";
import { appendRecordToMemory, getSessionPaths, readAuthoritativeMemory } from "../src/memory-file.ts";
import { createCheckpointRecord } from "../src/rolling-memory.ts";
import { createInitialState } from "../src/session-store.ts";
import type { MemoryGenerationRef, SessionRefinementState } from "../src/types.ts";

const paths = { root: "/tmp/session", memory: "/tmp/session/memory.md", generations: "/tmp/session/generations", state: "/tmp/session/state.json" };
const generation: MemoryGenerationRef = { file: "generations/memory-00000000-0000-4000-8000-000000000000.md", sha256: "a".repeat(64) };

function state(): SessionRefinementState {
	return { version: 2, sessionId: "session", toolCallsSinceRun: 2, records: [], warnings: [] };
}

function dependencies(events: string[], save: () => Promise<void> = async () => {}) {
	return {
		writeGeneration: async (_paths: typeof paths, content: string) => { events.push(`generation:${content}`); return generation; },
		save: async () => { events.push("state"); await save(); },
		remove: async (path: string) => { events.push(`remove:${path}`); },
		cleanup: async () => { events.push("cleanup"); },
	};
}

test("candidate publication writes immutable generation before the atomic state pointer", async () => {
	const current = state();
	const events: string[] = [];
	await commitCandidatePublication({
		paths, state: current, memory: "new",
		applyState(value) { value.lastProcessedEntryId = "through"; },
		dependencies: dependencies(events),
	});
	assert.deepEqual(events, ["generation:new", "state", "cleanup"]);
	assert.equal(current.lastProcessedEntryId, "through");
	assert.deepEqual(current.memoryGeneration, generation);
});

test("failed pointer publication leaves old in-memory state authoritative and deletes the orphan generation", async () => {
	const current = state();
	const old = { file: "generations/memory-11111111-1111-4111-8111-111111111111.md", sha256: "b".repeat(64) };
	current.memoryGeneration = old;
	const events: string[] = [];
	await assert.rejects(commitCandidatePublication({
		paths, state: current, memory: "new",
		applyState(value) { value.lastProcessedEntryId = "through"; },
		dependencies: dependencies(events, async () => { throw new Error("state failed"); }),
	}), /state failed/);
	assert.deepEqual(current.memoryGeneration, old);
	assert.equal(current.lastProcessedEntryId, undefined);
	assert.deepEqual(events, ["generation:new", "state", `remove:${paths.root}/${generation.file}`]);
});

test("successful publications retain only the active generation", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-session-refinement-generations-"));
	try {
		const live = getSessionPaths(root, "session");
		const current = createInitialState("session");
		for (let index = 0; index < 2; index++) {
			const record = createCheckpointRecord({ throughEntryId: `entry-${index}`, createdAt: `2026-01-0${index + 1}T00:00:00Z`, trigger: "time" });
			const memory = appendRecordToMemory("", `body-${index}`, record);
			await commitCandidatePublication({ paths: live, state: current, memory, applyState(next) {
				next.records = [record];
				next.lastProcessedEntryId = record.throughEntryId;
			} });
		}
		assert.equal((await readdir(live.generations)).filter((name) => name.startsWith("memory-")).length, 1);
		assert.match(await readAuthoritativeMemory(live, current), /body-1/);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("generation write failure never attempts pointer publication or cleanup", async () => {
	const current = state();
	const events: string[] = [];
	await assert.rejects(commitCandidatePublication({
		paths, state: current, memory: "new", applyState() {},
		dependencies: {
			...dependencies(events),
			writeGeneration: async () => { events.push("generation"); throw new Error("write failed"); },
		},
	}), /write failed/);
	assert.deepEqual(events, ["generation"]);
});
