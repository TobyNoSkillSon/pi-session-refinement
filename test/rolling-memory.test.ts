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
	return bodies.reduce((memory, body, index) => appendRecordToMemory(memory, body, checkpoint(`entry-${index}`, `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00Z`)), "");
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

test("selector chooses the closest range that still leaves a practical consolidation body allowance", () => {
	const memory = memoryWithBodies(["a".repeat(220), "b".repeat(20), "c".repeat(180)]);
	const records = parseMemoryRecords(memory);
	const materialized = records.map((_, index) => renderedMemoryTokens(materializeMemoryFromRecords(records.slice(0, index + 1))));
	const budget = 220;
	const selection = selectConsolidationPrefix(memory, budget);
	assert.equal(selection.count, 3, "the mathematically closest one-record range leaves no useful output allowance");
	assert.equal(selection.tokens, materialized[selection.count - 1]);
	assert.ok(selection.bodyAllowanceTokens >= Math.floor(Math.floor(budget * 0.6) * 0.25));
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

test("randomized rolling selections preserve chronology, exact tails, and mandatory headroom", () => {
	let seed = 0x5eedc0de;
	const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x1_0000_0000; };
	for (let iteration = 0; iteration < 750; iteration++) {
		const count = 1 + Math.floor(random() * 12);
		const bodies = Array.from({ length: count }, (_, index) => {
			const size = 180 + Math.floor(random() * 1_000);
			return `${index % 3 === 0 ? "current ✅ " : "current "}${String.fromCharCode(97 + index % 26).repeat(size)}`;
		});
		const memory = memoryWithBodies(bodies);
		const before = renderedMemoryTokens(memory);
		const budget = Math.max(64, Math.floor(before / 0.8));
		assert.equal(needsConsolidation(memory, budget), true);
		const selection = selectConsolidationPrefix(memory, budget, { createdAt: "2026-02-01T00:00:00Z", trigger: "consolidation" });
		const all = parseMemoryRecords(memory);
		const originalSuffix = selection.start + selection.count < all.length
			? memory.slice(all[selection.start + selection.count].start)
			: "";
		const replacement = replaceMemoryPrefix({ candidateMemory: memory, selection, body: "current truth", budgetTokens: budget });
		assert.ok(replacement.tokens <= Math.floor(budget * 0.6));
		assert.ok(replacement.tokens < before);
		const after = parseMemoryRecords(replacement.memory);
		assert.equal(after.length, all.length - selection.count + 1);
		assert.equal(after[selection.start].record.sourceRecordCount, selection.count);
		assert.equal(after[selection.start].record.throughEntryId, all[selection.start + selection.count - 1].record.throughEntryId);
		if (originalSuffix) assert.equal(replacement.memory.slice(after[selection.start + 1].start), originalSuffix);

		const inherited = Math.floor(random() * (count + 1));
		try {
			const forkSelection = selectConsolidationPrefix(memory, budget, { inheritedRecordCount: inherited, createdAt: "2026-02-01T00:00:00Z", trigger: "consolidation" });
			assert.ok(forkSelection.start + forkSelection.count <= inherited || forkSelection.start >= inherited);
		} catch (error) {
			assert.match(error instanceof Error ? error.message : String(error), /No legal consolidation range/);
		}
	}
});

test("one thousand checkpoints survive repeated root rolling without losing source coverage", () => {
	let memory = "";
	let rolls = 0;
	const budget = 2_000;
	for (let index = 0; index < 1_000; index++) {
		const at = new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
		memory = appendRecordToMemory(memory, `### Current state\n\n- Checkpoint ${index}: ${"fact ".repeat(30 + index % 40)}`, checkpoint(`long-${index}`, at));
		if (needsConsolidation(memory, budget)) {
			const selection = selectConsolidationPrefix(memory, budget, { createdAt: at, trigger: "consolidation" });
			memory = replaceMemoryPrefix({
				candidateMemory: memory,
				selection,
				body: `### Current continuity\n\n- Rolling base ${rolls + 1} preserves verified state through checkpoint ${index}.`,
				budgetTokens: budget,
			}).memory;
			rolls++;
			assert.ok(renderedMemoryTokens(memory) <= Math.floor(budget * 0.6));
		}
		const records = parseMemoryRecords(memory);
		assert.equal(records.reduce((sum, entry) => sum + entry.record.sourceRecordCount, 0), index + 1);
		assert.equal(records.at(-1)?.record.throughEntryId, `long-${index}`);
		assert.ok(records.filter((entry) => entry.record.kind === "consolidation").length <= 1);
	}
	assert.ok(rolls > 50);
});

test("long fork rolling never crosses its inherited-local boundary and preserves all coverage", () => {
	let memory = memoryWithBodies(["inherited one ".repeat(40), "inherited two ".repeat(40), "inherited three ".repeat(40)]);
	let inherited = 3;
	const budget = 2_000;
	for (let index = 0; index < 600; index++) {
		const at = new Date(Date.UTC(2026, 2, 1, 0, index)).toISOString();
		memory = appendRecordToMemory(memory, `### Local state\n\n- Fork-local checkpoint ${index}: ${"detail ".repeat(35 + index % 25)}`, checkpoint(`fork-long-${index}`, at));
		if (!needsConsolidation(memory, budget)) continue;
		const selection = selectConsolidationPrefix(memory, budget, { inheritedRecordCount: inherited, createdAt: at, trigger: "consolidation" });
		assert.ok(selection.start + selection.count <= inherited || selection.start >= inherited);
		memory = replaceMemoryPrefix({
			candidateMemory: memory,
			selection,
			body: `### Fork continuity\n\n- Legal rolling range through local checkpoint ${index}.`,
			budgetTokens: budget,
		}).memory;
		if (selection.start === 0 && inherited > 0) inherited = inherited - selection.count + 1;
		const records = parseMemoryRecords(memory);
		assert.ok(inherited >= 0 && inherited <= records.length);
		assert.ok(renderedMemoryTokens(memory) <= Math.floor(budget * 0.6));
		assert.equal(records.reduce((sum, entry) => sum + entry.record.sourceRecordCount, 0), index + 4);
	}
	const final = parseMemoryRecords(memory);
	assert.equal(final.at(-1)?.record.throughEntryId, "fork-long-599");
	assert.ok(final.filter((entry) => entry.record.kind === "consolidation").length <= 2);
});
