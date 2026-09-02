import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	appendRecordToMemory,
	atomicWrite,
	getSessionPaths,
	parseMemoryRecords,
	readAuthoritativeMemory,
	readMemory,
	renderMemoryForPrompt,
	validateMemoryDocument,
	writeMemoryGeneration,
} from "../src/memory-file.ts";
import { createCheckpointRecord } from "../src/rolling-memory.ts";

async function temporaryAgentDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "pi-session-refinement-test-"));
}

test("stores a complete v2 record with rolling metadata", async () => {
	const agentDir = await temporaryAgentDir();
	try {
		const paths = getSessionPaths(agentDir, "session-a");
		const record = createCheckpointRecord({ fromEntryId: "entry-1", throughEntryId: "entry-2", createdAt: "2026-01-01T00:00:00Z", trigger: "time" });
		await atomicWrite(paths.memory, appendRecordToMemory("", "### Behavioural refinements\n\n- Prefer the smaller mechanism.", record));
		const stored = await readMemory(paths.memory);
		assert.match(stored, /"version":2/);
		assert.doesNotMatch(renderMemoryForPrompt(stored), /throughEntryId/);
		assert.deepEqual(parseMemoryRecords(stored)[0].record, {
			kind: "checkpoint", generation: 0, fromEntryId: "entry-1", throughEntryId: "entry-2",
			sourceRecordCount: 1, createdAt: "2026-01-01T00:00:00Z", cutoffAt: "2026-01-01T00:00:00Z", trigger: "time",
		});
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("session paths are confined and package sources contain no pending file", () => {
	const paths = getSessionPaths("/tmp/agent", "session");
	assert.deepEqual(Object.keys(paths).sort(), ["generations", "memory", "root", "state"]);
	for (const sessionId of ["../escape", "a/b", "a\\b", ".", "..", " session"]) {
		assert.throws(() => getSessionPaths("/tmp/agent", sessionId), /Invalid session identifier/);
	}
});

test("authoritative generations are confined, hashed, and structurally exact", async () => {
	const agentDir = await temporaryAgentDir();
	try {
		const paths = getSessionPaths(agentDir, "session-a");
		const record = createCheckpointRecord({ throughEntryId: "entry", createdAt: "2026-01-01T00:00:00Z", trigger: "time" });
		const memory = appendRecordToMemory("", "tracked body", record);
		const memoryGeneration = await writeMemoryGeneration(paths, memory);
		assert.equal(await readAuthoritativeMemory(paths, { version: 2, sessionId: "session-a", toolCallsSinceRun: 0, records: [record], warnings: [], lastProcessedEntryId: "entry", memoryGeneration }), memory);
		await assert.rejects(() => readAuthoritativeMemory(paths, { version: 2, sessionId: "session-a", toolCallsSinceRun: 0, records: [record], warnings: [], lastProcessedEntryId: "entry", memoryGeneration: { ...memoryGeneration, file: "../escape.md" } }), /generation reference|escapes/);
		await assert.rejects(() => readAuthoritativeMemory(paths, { version: 2, sessionId: "session-a", toolCallsSinceRun: 0, records: [record], warnings: [], lastProcessedEntryId: "entry", memoryGeneration: { ...memoryGeneration, sha256: "0".repeat(64) } }), /hash/);
		assert.throws(() => validateMemoryDocument(memory.replace("# Session Memory\n", "# Session Memory\nUNTRACKED\n")), /untracked prose/);
	} finally { await rm(agentDir, { recursive: true, force: true }); }
});

test("record body validation rejects reserved metadata and host titles", () => {
	const record = createCheckpointRecord({ throughEntryId: "entry", createdAt: "2026-01-01T00:00:00Z", trigger: "time" });
	assert.throws(() => appendRecordToMemory("", "", record), /empty/);
	assert.throws(() => appendRecordToMemory("", "<!-- pi-session-refinement:{} -->", record), /reserved/);
	assert.throws(() => appendRecordToMemory("", "# Session Memory", record), /host-owned/);
});
