import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendRecordToMemory, atomicWrite, getSessionPaths, LEGACY_MEMORY_HEADER, readAuthoritativeMemory, validateLegacyMemory, renderMemoryForPrompt, writeMemoryGeneration } from "../src/memory-file.ts";
import { createCheckpointRecord } from "../src/rolling-memory.ts";
import { assertValidState, createInitialState, inheritForkMemory, loadState, readParentSessionFromFile, saveState } from "../src/session-store.ts";

const message = (id: string) => ({ type: "message", id, parentId: null, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: id, timestamp: 1 } }) as any;

async function parentFixture(agentDir: string) {
	const paths = getSessionPaths(agentDir, "parent-session");
	const records = [
		createCheckpointRecord({ throughEntryId: "shared", createdAt: "2026-01-01T00:00:00Z", trigger: "time" }),
		createCheckpointRecord({ fromEntryId: "after", throughEntryId: "parent-leaf", createdAt: "2026-01-01T01:00:00Z", trigger: "time" }),
	];
	let memory = appendRecordToMemory("", "shared memory", records[0]);
	memory = appendRecordToMemory(memory, "later parent-only memory", records[1]);
	const state = createInitialState("parent-session");
	state.records = records;
	state.lastProcessedEntryId = "parent-leaf";
	state.memoryGeneration = await writeMemoryGeneration(paths, memory);
	await saveState(paths, state);
	const file = join(agentDir, "parent.jsonl");
	await atomicWrite(file, JSON.stringify({ type: "session", id: "parent-session", cwd: "/tmp", timestamp: "2026-01-01T00:00:00Z" }) + "\n");
	return file;
}

test("v2 state rejects non-finite counters, fake warnings, invalid records, cursor drift, and fork overflow", () => {
	const record = createCheckpointRecord({ throughEntryId: "entry", createdAt: "2026-01-01T00:00:00Z", trigger: "time" });
	const base: any = {
		version: 2, sessionId: "session", toolCallsSinceRun: 0, records: [record], lastProcessedEntryId: "entry",
		memoryGeneration: { file: "generations/memory-00000000-0000-4000-8000-000000000000.md", sha256: "a".repeat(64) }, warnings: [],
	};
	for (const mutate of [
		(state: any) => { state.toolCallsSinceRun = Number.NaN; },
		(state: any) => { state.warnings = [{ code: "invented", message: "x" }]; },
		(state: any) => { state.records[0].generation = 2; },
		(state: any) => { state.records[0] = { ...state.records[0], kind: "consolidation", generation: 0 }; },
		(state: any) => { state.records[0].trigger = "mystery"; },
		(state: any) => { state.lastProcessedEntryId = "other"; },
		(state: any) => { state.fork = { floorEntryId: "floor", inheritedRecordCount: 2 }; },
	]) {
		const candidate = structuredClone(base);
		mutate(candidate);
		assert.throws(() => assertValidState(candidate), /Invalid state/);
	}
});

test("a v2 fork inherits only the active record prefix and records an immutable floor", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-session-refinement-fork-"));
	try {
		const parentSessionFile = await parentFixture(agentDir);
		const inherited = await inheritForkMemory({
			agentDir, newSessionId: "fork-session", previousSessionFile: parentSessionFile,
			branchEntries: [message("shared"), message("fork-point")],
		});
		assert.equal(inherited.mode, "v2");
		assert.equal(inherited.inherited, 1);
		assert.deepEqual(inherited.state.fork, { floorEntryId: "fork-point", inheritedRecordCount: 1 });
		assert.equal(inherited.state.lastProcessedEntryId, "fork-point");
		const childPaths = getSessionPaths(agentDir, "fork-session");
		const promptMemory = renderMemoryForPrompt(await readAuthoritativeMemory(childPaths, inherited.state));
		assert.match(promptMemory, /shared memory/);
		assert.doesNotMatch(promptMemory, /parent-only/);
	} finally { await rm(agentDir, { recursive: true, force: true }); }
});

test("a historical fork before the rolling base inherits nothing and never scans siblings", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-session-refinement-old-fork-"));
	try {
		const parentSessionFile = await parentFixture(agentDir);
		const sibling = getSessionPaths(agentDir, "unrelated-session");
		await atomicWrite(sibling.memory, "SIBLING_SECRET");
		const inherited = await inheritForkMemory({ agentDir, newSessionId: "fork-session", previousSessionFile: parentSessionFile, branchEntries: [message("old-point")] });
		assert.equal(inherited.inherited, 0);
		assert.equal(inherited.memory, "");
		if (inherited.state.version !== 2) assert.fail("expected v2 fork state");
		assert.deepEqual(inherited.state.fork, { floorEntryId: "old-point", inheritedRecordCount: 0 });
		assert.doesNotMatch(JSON.stringify(inherited), /SIBLING_SECRET/);
	} finally { await rm(agentDir, { recursive: true, force: true }); }
});

test("valid v1 state remains loadable and a v1 fork stays legacy", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-session-refinement-v1-fork-"));
	try {
		const parent = getSessionPaths(agentDir, "legacy-parent");
		const metadata = JSON.stringify({ throughEntryId: "shared", createdAt: "2025-01-01T00:00:00Z", trigger: "time" });
		await atomicWrite(parent.memory, `${LEGACY_MEMORY_HEADER.trimEnd()}\n\n<!-- pi-session-refinement:${metadata} -->\n\n---\n\n## Memory checkpoint — 2025-01-01T00:00:00Z\n\nlegacy memory\n`);
		await saveState(parent, { version: 1, sessionId: "legacy-parent", lastProcessedEntryId: "shared", toolCallsSinceRun: 0, checkpoints: [{ throughEntryId: "shared", createdAt: "2025-01-01T00:00:00Z", trigger: "time" }], warnings: [] });
		const loaded = await loadState(parent, "legacy-parent");
		assert.equal(loaded.state.version, 1);
		const parentFile = join(agentDir, "legacy.jsonl");
		await atomicWrite(parentFile, JSON.stringify({ type: "session", id: "legacy-parent" }) + "\n");
		const inherited = await inheritForkMemory({ agentDir, newSessionId: "legacy-child", previousSessionFile: parentFile, branchEntries: [message("shared"), message("floor")] });
		assert.equal(inherited.mode, "legacy");
		assert.match(inherited.memory, /legacy memory/);
		assert.equal(inherited.state.version, 1);
		if (inherited.state.version === 1) assert.deepEqual(inherited.state.fork, { floorEntryId: "floor", inheritedCheckpointCount: 1 });
	} finally { await rm(agentDir, { recursive: true, force: true }); }
});

test("legacy budget warnings and baseline-only state remain readable for explicit v2 rebuild", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-session-refinement-legacy-budget-"));
	try {
		const paths = getSessionPaths(root, "legacy");
		await saveState(paths, {
			version: 1,
			sessionId: "legacy",
			lastProcessedEntryId: "baseline",
			toolCallsSinceRun: 0,
			checkpoints: [],
			warnings: [{ code: "budget-exceeded", message: "legacy overflow" }],
		});
		const loaded = await loadState(paths, "legacy");
		assert.equal(loaded.state.version, 1);
		assert.deepEqual(validateLegacyMemory("", loaded.state as any), []);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("startup fork detection reads only the session header parent path", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-session-refinement-parent-header-"));
	try {
		const file = join(root, "child.jsonl");
		await atomicWrite(file, `${JSON.stringify({ type: "session", version: 3, id: "child", parentSession: "/tmp/parent.jsonl" })}\n${JSON.stringify({ type: "message", content: "ignored" })}\n`);
		assert.equal(await readParentSessionFromFile(file), "/tmp/parent.jsonl");
	} finally { await rm(root, { recursive: true, force: true }); }
});
