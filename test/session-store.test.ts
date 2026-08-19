import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendCheckpoint, atomicWrite, getSessionPaths, readMemory, renderMemoryForPrompt } from "../src/memory-file.ts";
import { inheritForkMemory } from "../src/session-store.ts";

test("a fork inherits only checkpoints whose source is on its branch", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-session-refinement-fork-"));
	try {
		const parent = getSessionPaths(agentDir, "parent-session");
		await appendCheckpoint({ paths: parent, body: "shared memory", record: { throughEntryId: "shared", createdAt: "2026-01-01T00:00:00Z", trigger: "time" }, budgetTokens: 32_000 });
		await appendCheckpoint({ paths: parent, body: "later parent-only memory", record: { fromEntryId: "after", throughEntryId: "parent-leaf", createdAt: "2026-01-01T01:00:00Z", trigger: "time" }, budgetTokens: 32_000 });
		const parentSessionFile = join(agentDir, "parent.jsonl");
		await atomicWrite(parentSessionFile, JSON.stringify({ type: "session", id: "parent-session", cwd: "/tmp", timestamp: "2026-01-01T00:00:00Z" }) + "\n");
		const inherited = await inheritForkMemory({
			agentDir,
			newSessionId: "fork-session",
			previousSessionFile: parentSessionFile,
			branchEntries: [{ type: "message", id: "shared", parentId: null, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "shared", timestamp: 1 } }] as any,
		});
		assert.equal(inherited.inherited, 1);
		const promptMemory = renderMemoryForPrompt(await readMemory(getSessionPaths(agentDir, "fork-session").memory));
		assert.match(promptMemory, /shared memory/);
		assert.doesNotMatch(promptMemory, /parent-only/);
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});
