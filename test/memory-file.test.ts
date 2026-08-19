import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	BudgetExceededError,
	appendCheckpoint,
	getSessionPaths,
	parseCheckpoints,
	readMemory,
	renderMemoryForPrompt,
} from "../src/memory-file.ts";

async function temporaryAgentDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "pi-session-refinement-test-"));
}

test("atomically appends a complete chronological checkpoint", async () => {
	const agentDir = await temporaryAgentDir();
	try {
		const paths = getSessionPaths(agentDir, "session-a");
		await appendCheckpoint({
			paths,
			body: "### Behavioural refinements\n\n- Prefer the smaller mechanism.",
			record: { throughEntryId: "entry-2", fromEntryId: "entry-1", createdAt: "2026-01-01T00:00:00Z", trigger: "time" },
			budgetTokens: 32_000,
		});
		const stored = await readMemory(paths.memory);
		assert.match(stored, /Memory checkpoint/);
		assert.match(stored, /throughEntryId/);
		assert.doesNotMatch(renderMemoryForPrompt(stored), /throughEntryId/);
		assert.equal(parseCheckpoints(stored).length, 1);
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("preserves an over-budget checkpoint as pending without changing active memory", async () => {
	const agentDir = await temporaryAgentDir();
	try {
		const paths = getSessionPaths(agentDir, "session-b");
		await assert.rejects(() => appendCheckpoint({
			paths,
			body: "x".repeat(400),
			record: { throughEntryId: "entry-1", createdAt: "2026-01-01T00:00:00Z", trigger: "time" },
			budgetTokens: 10,
		}), BudgetExceededError);
		assert.equal(await readMemory(paths.memory), "");
		assert.match(await readFile(paths.pending, "utf8"), /x{20}/);
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});
