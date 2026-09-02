import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { commitRebuiltMemory } from "../src/rebuild-commit.ts";
import { appendRecordToMemory, atomicWrite, getSessionPaths, readAuthoritativeMemory } from "../src/memory-file.ts";
import { createCheckpointRecord } from "../src/rolling-memory.ts";
import { createInitialState, loadState, saveState } from "../src/session-store.ts";
import type { MemoryGenerationRef } from "../src/types.ts";

const paths = { root: "/tmp/session", memory: "/tmp/session/memory.md", generations: "/tmp/session/generations", state: "/tmp/session/state.json" };
const generation: MemoryGenerationRef = { file: "generations/memory-00000000-0000-4000-8000-000000000000.md", sha256: "a".repeat(64) };
const state = { version: 2 as const, sessionId: "session", toolCallsSinceRun: 0, records: [], warnings: [] };

function dependencies(events: string[], failState = false) {
	return {
		writeGeneration: async () => { events.push("generation"); return generation; },
		save: async () => { events.push("state"); if (failState) throw new Error("state failed"); },
		remove: async (path: string) => { events.push(`remove:${path}`); },
		cleanup: async () => { events.push("cleanup"); },
	};
}

test("rebuild writes a generation before publishing its pointer, then cleans legacy material", async () => {
	const events: string[] = [];
	const published = await commitRebuiltMemory({ paths, memory: "new", state, dependencies: dependencies(events) });
	assert.deepEqual(events, ["generation", "state", "cleanup", `remove:${paths.memory}`, `remove:${paths.root}/pending.md`]);
	assert.deepEqual(published.memoryGeneration, generation);
});

test("failed rebuild pointer publication deletes only the orphan generation", async () => {
	const events: string[] = [];
	await assert.rejects(commitRebuiltMemory({ paths, memory: "new", state, dependencies: dependencies(events, true) }), /state failed/);
	assert.deepEqual(events, ["generation", "state", `remove:${paths.root}/${generation.file}`]);
});

test("a successful manual rebuild replaces v1 authority with one verified v2 generation", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-session-refinement-rebuild-v2-"));
	try {
		const live = getSessionPaths(root, "session");
		await atomicWrite(live.memory, "legacy memory");
		await saveState(live, { version: 1, sessionId: "session", toolCallsSinceRun: 0, checkpoints: [], warnings: [] });
		const record = createCheckpointRecord({ throughEntryId: "entry", createdAt: "2026-01-01T00:00:00Z", trigger: "rebuild" });
		const memory = appendRecordToMemory("", "rebuilt truth", record);
		const replacement = createInitialState("session");
		replacement.records = [record];
		replacement.lastProcessedEntryId = "entry";
		const published = await commitRebuiltMemory({ paths: live, memory, state: replacement });
		assert.equal((await loadState(live, "session")).state.version, 2);
		assert.equal(await readAuthoritativeMemory(live, published), memory);
		await assert.rejects(readFile(live.memory, "utf8"), /ENOENT/);
	} finally { await rm(root, { recursive: true, force: true }); }
});
