import assert from "node:assert/strict";
import test from "node:test";
import {
	appendRecordToMemory,
	estimateTextTokens,
	materializeMemoryFromRecords,
	parseMemoryRecords,
	renderMemoryForPrompt,
} from "../src/memory-file.ts";
import {
	consolidationThresholdTokens,
	createCheckpointRecord,
	createConsolidationRecord,
	needsConsolidation,
	renderedMemoryTokens,
	replaceMemoryPrefix,
	selectConsolidationPrefix,
	stageCheckpoint,
} from "../src/rolling-memory.ts";

function checkpoint(id: string, at: string) {
	return createCheckpointRecord({ fromEntryId: `${id}-from`, throughEntryId: id, createdAt: at, trigger: "time" });
}

function memoryWithBodies(bodies: string[]): string {
	return bodies.reduce((memory, body, index) => appendRecordToMemory(memory, body, checkpoint(`entry-${index}`, `2026-01-0${index + 1}T00:00:00Z`)), "");
}

test("consolidation starts at the exact 80 percent threshold", () => {
	const memory = memoryWithBodies(["x".repeat(240)]);
	const tokens = renderedMemoryTokens(memory);
	const budget = Array.from({ length: tokens * 2 }, (_, index) => index + 1).find((value) => consolidationThresholdTokens(value) === tokens);
	assert.ok(budget);
	assert.equal(needsConsolidation(memory, budget!), true);
	let above = budget! + 1;
	while (consolidationThresholdTokens(above) <= tokens) above++;
	assert.equal(needsConsolidation(memory, above), false);
});

test("selector minimizes rendered token distance to half the configured budget", () => {
	const memory = memoryWithBodies(["a".repeat(220), "b".repeat(20), "c".repeat(180)]);
	const records = parseMemoryRecords(memory);
	const materialized = records.map((_, index) => renderedMemoryTokens(materializeMemoryFromRecords(records.slice(0, index + 1))));
	const budget = 220;
	const selection = selectConsolidationPrefix(memory, budget);
	const closest = materialized.map((tokens, index) => ({ count: index + 1, distance: Math.abs(tokens - budget * 0.5) }))
		.sort((left, right) => left.distance - right.distance || left.count - right.count)[0];
	assert.equal(selection.count, closest.count);
	assert.equal(selection.tokens, materialized[selection.count - 1]);
	assert.ok(selection.bodyAllowanceTokens > 0);
	assert.notEqual(materialized[0], estimateTextTokens(renderMemoryForPrompt(records[0].block)), "materialized selection must include its real header cost");
});

test("fork selection never crosses the immutable inherited/local boundary", () => {
	const memory = memoryWithBodies(["i1 ".repeat(180), "i2 ".repeat(180), "l1 ".repeat(180), "l2 ".repeat(180)]);
	const selection = selectConsolidationPrefix(memory, 1_100, { inheritedRecordCount: 2, createdAt: "2026-01-05T00:00:00Z", trigger: "manual-compaction" });
	assert.ok(selection.start + selection.count <= 2 || selection.start >= 2);
	assert.equal(selection.replacementRecord.cutoffAt, selection.records.at(-1)?.record.cutoffAt);
	assert.equal(selection.replacementRecord.trigger, "manual-compaction");
});

test("fork selection fails rather than crossing the boundary when neither side can reach 60 percent", () => {
	const memory = memoryWithBodies(["inherited ".repeat(160), "inherited ".repeat(160), "local ".repeat(220), "local ".repeat(220)]);
	assert.throws(() => selectConsolidationPrefix(memory, 700, { inheritedRecordCount: 2, createdAt: "2026-01-05T00:00:00Z", trigger: "context" }), /No legal consolidation range/);
});

test("consolidation records roll forward source coverage and generation", () => {
	const memory = memoryWithBodies(["first".repeat(20), "second".repeat(20)]);
	const firstPrefix = parseMemoryRecords(memory);
	const firstRoll = createConsolidationRecord(firstPrefix, "2026-01-03T00:00:00Z", "time");
	assert.deepEqual({ kind: firstRoll.kind, generation: firstRoll.generation, count: firstRoll.sourceRecordCount, through: firstRoll.throughEntryId, cutoff: firstRoll.cutoffAt }, {
		kind: "consolidation", generation: 1, count: 2, through: "entry-1", cutoff: "2026-01-02T00:00:00Z",
	});
	const rolledMemory = appendRecordToMemory("", "rolled truth", firstRoll);
	const withNewer = appendRecordToMemory(rolledMemory, "new truth", checkpoint("entry-2", "2026-01-04T00:00:00Z"));
	const secondRoll = createConsolidationRecord(parseMemoryRecords(withNewer), "2026-01-05T00:00:00Z", "time");
	assert.equal(secondRoll.generation, 2);
	assert.equal(secondRoll.sourceRecordCount, 3);
	assert.equal(secondRoll.throughEntryId, "entry-2");
});

test("prefix replacement keeps every retained suffix byte exact", () => {
	const memory = memoryWithBodies(["old-one ".repeat(80), "old-two ".repeat(80), "newer-byte-exact\n\n- tail"]);
	const budget = 650;
	const selection = selectConsolidationPrefix(memory, budget);
	assert.ok(selection.count < parseMemoryRecords(memory).length);
	const all = parseMemoryRecords(memory);
	const originalSuffix = memory.slice(all[selection.count].start);
	const record = createConsolidationRecord(selection.records, "2026-01-04T00:00:00Z", "time");
	const replaced = replaceMemoryPrefix({ candidateMemory: memory, selection, body: "### Learned information and decisions\n\n- Current truth.", record, budgetTokens: budget }).memory;
	const replacementRecords = parseMemoryRecords(replaced);
	const replacementSuffix = replaced.slice(replacementRecords[1].start);
	assert.equal(replacementSuffix, originalSuffix);
});

test("host rejects empty, non-compressing, and no-headroom replacements", () => {
	const memory = memoryWithBodies(["material ".repeat(100), "retained ".repeat(25)]);
	const budget = 500;
	const selection = selectConsolidationPrefix(memory, budget);
	const record = createConsolidationRecord(selection.records, "2026-01-03T00:00:00Z", "time");
	assert.throws(() => replaceMemoryPrefix({ candidateMemory: memory, selection, body: "", record, budgetTokens: budget }), /empty/);
	assert.throws(() => replaceMemoryPrefix({ candidateMemory: memory, selection, body: "z".repeat(2000), record, budgetTokens: budget }), /did not compress|target|headroom/);
	assert.throws(() => replaceMemoryPrefix({ candidateMemory: memory, selection, body: "short", record, budgetTokens: 20 }), /target|over budget/);
});

test("staged candidates consolidate before publication and failures leave the active value untouched", async () => {
	const active = memoryWithBodies(["old ".repeat(120)]);
	const record = checkpoint("next", "2026-01-02T00:00:00Z");
	const candidate = stageCheckpoint(active, "new ".repeat(120), record);
	assert.equal(needsConsolidation(candidate, 370), true);
	const selection = selectConsolidationPrefix(candidate, 370);
	const consolidation = createConsolidationRecord(selection.records, "2026-01-03T00:00:00Z", "time");
	const staged = replaceMemoryPrefix({ candidateMemory: candidate, selection, body: "### Learned information and decisions\n\n- Consolidated truth.", record: consolidation, budgetTokens: 370 }).memory;
	assert.match(staged, /Consolidated memory/);
	assert.equal(active.includes("Consolidated memory"), false);

	await assert.rejects(async () => { throw new Error("all models failed"); }, /all models failed/);
	assert.equal(active, materializeMemoryFromRecords(parseMemoryRecords(active)));
});
