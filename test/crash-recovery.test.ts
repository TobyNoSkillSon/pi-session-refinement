import assert from "node:assert/strict";
import { access, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	appendRecordToMemory,
	atomicWrite,
	cleanupMemoryGenerations,
	getSessionPaths,
	readAuthoritativeMemory,
	writeMemoryGeneration,
} from "../src/memory-file.ts";
import { createCheckpointRecord } from "../src/rolling-memory.ts";
import { createInitialState, loadState, saveState } from "../src/session-store.ts";

function candidate(entry: string, body: string, createdAt: string) {
	const record = createCheckpointRecord({ throughEntryId: entry, createdAt, trigger: "time" });
	return { record, memory: appendRecordToMemory("", body, record) };
}

test("a crash after generation write leaves the old pointer authoritative and the orphan removable", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-session-refinement-crash-before-pointer-"));
	try {
		const paths = getSessionPaths(root, "session");
		const old = candidate("old", "old authoritative memory", "2026-01-01T00:00:00Z");
		const state = createInitialState("session");
		state.records = [old.record]; state.lastProcessedEntryId = "old";
		state.memoryGeneration = await writeMemoryGeneration(paths, old.memory);
		await saveState(paths, state);

		const next = candidate("new", "unpublished generation", "2026-01-02T00:00:00Z");
		const orphan = await writeMemoryGeneration(paths, next.memory);
		const loaded = await loadState(paths, "session");
		assert.equal(loaded.state.version, 2);
		assert.equal(await readAuthoritativeMemory(paths, loaded.state as any), old.memory);
		await cleanupMemoryGenerations(paths, state.memoryGeneration);
		await assert.rejects(access(join(paths.root, orphan.file)), /ENOENT/);
		assert.equal(await readAuthoritativeMemory(paths, state), old.memory);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("a crash after pointer publication loads the new generation and later removes the old one", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-session-refinement-crash-after-pointer-"));
	try {
		const paths = getSessionPaths(root, "session");
		const old = candidate("old", "old memory", "2026-01-01T00:00:00Z");
		const oldRef = await writeMemoryGeneration(paths, old.memory);
		const oldState = createInitialState("session");
		oldState.records = [old.record]; oldState.lastProcessedEntryId = "old"; oldState.memoryGeneration = oldRef;
		await saveState(paths, oldState);

		const nextRecord = createCheckpointRecord({ fromEntryId: "new", throughEntryId: "new", createdAt: "2026-01-02T00:00:00Z", trigger: "time" });
		const nextMemory = appendRecordToMemory(old.memory, "new authoritative memory", nextRecord);
		const nextRef = await writeMemoryGeneration(paths, nextMemory);
		const nextState = structuredClone(oldState);
		nextState.records.push(nextRecord); nextState.lastProcessedEntryId = "new"; nextState.memoryGeneration = nextRef;
		await saveState(paths, nextState);
		// Simulated power loss here: both immutable files exist, but state already points at the new one.
		assert.equal((await readdir(paths.generations)).length, 2);
		const loaded = await loadState(paths, "session");
		assert.equal(await readAuthoritativeMemory(paths, loaded.state as any), nextMemory);
		await cleanupMemoryGenerations(paths, nextRef);
		assert.deepEqual(await readdir(paths.generations), [nextRef.file.split("/").at(-1)]);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("incomplete atomic-write residue is ignored, concurrent writes stay whole, and tampering is detected", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-session-refinement-atomic-write-"));
	try {
		const path = join(root, "value.json");
		const values = Array.from({ length: 50 }, (_, index) => JSON.stringify({ index, payload: String(index).repeat(200) }) + "\n");
		await Promise.all(values.map((value) => atomicWrite(path, value)));
		assert.ok(values.includes(await readFile(path, "utf8")));
		assert.equal((await readdir(root)).filter((name) => name.endsWith(".tmp")).length, 0);

		const paths = getSessionPaths(root, "session");
		const item = candidate("entry", "protected memory", "2026-01-01T00:00:00Z");
		const state = createInitialState("session");
		state.records = [item.record]; state.lastProcessedEntryId = "entry"; state.memoryGeneration = await writeMemoryGeneration(paths, item.memory);
		await saveState(paths, state);
		await writeFile(join(paths.root, ".state.json.interrupted.tmp"), "{broken", "utf8");
		assert.equal((await loadState(paths, "session")).existed, true);
		await writeFile(join(paths.root, state.memoryGeneration.file), item.memory + "tampered", "utf8");
		await assert.rejects(readAuthoritativeMemory(paths, state), /hash does not match/);
	} finally { await rm(root, { recursive: true, force: true }); }
});
