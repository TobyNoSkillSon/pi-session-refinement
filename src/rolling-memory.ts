import {
	MEMORY_HEADER,
	appendRecordToMemory,
	estimateTextTokens,
	formatMemoryRecord,
	materializeMemoryFromRecords,
	parseMemoryRecords,
	renderMemoryForPrompt,
	validateRecordBody,
	type ParsedMemoryRecord,
} from "./memory-file.js";
import type { MemoryRecord, TriggerReason } from "./types.js";

export const CONSOLIDATION_THRESHOLD_RATIO = 0.8;
export const CONSOLIDATION_PREFIX_TARGET_RATIO = 0.5;
export const CONSOLIDATION_HEADROOM_RATIO = 0.6;

export function renderedMemoryTokens(memory: string): number {
	return estimateTextTokens(renderMemoryForPrompt(memory));
}

export function consolidationThresholdTokens(budgetTokens: number): number {
	return Math.ceil(budgetTokens * CONSOLIDATION_THRESHOLD_RATIO);
}

export function needsConsolidation(memory: string, budgetTokens: number): boolean {
	return renderedMemoryTokens(memory) >= consolidationThresholdTokens(budgetTokens);
}

export interface PrefixSelection {
	start: number;
	count: number;
	tokens: number;
	targetTokens: number;
	bodyAllowanceTokens: number;
	records: ParsedMemoryRecord[];
	replacementRecord: MemoryRecord;
}

export function createCheckpointRecord(options: {
	fromEntryId?: string;
	throughEntryId: string;
	createdAt: string;
	cutoffAt?: string;
	trigger: TriggerReason;
}): MemoryRecord {
	return {
		kind: "checkpoint",
		generation: 0,
		fromEntryId: options.fromEntryId,
		throughEntryId: options.throughEntryId,
		sourceRecordCount: 1,
		createdAt: options.createdAt,
		cutoffAt: options.cutoffAt ?? options.createdAt,
		trigger: options.trigger,
	};
}

export function createConsolidationRecord(prefix: ParsedMemoryRecord[], createdAt: string, trigger: TriggerReason): MemoryRecord {
	if (prefix.length === 0) throw new Error("Cannot create consolidation metadata for an empty range.");
	const first = prefix[0].record;
	const last = prefix.at(-1)!.record;
	return {
		kind: "consolidation",
		generation: Math.max(...prefix.map((entry) => entry.record.generation)) + 1,
		fromEntryId: first.fromEntryId,
		throughEntryId: last.throughEntryId,
		sourceRecordCount: prefix.reduce((total, entry) => total + entry.record.sourceRecordCount, 0),
		createdAt,
		cutoffAt: last.cutoffAt,
		trigger,
	};
}

function spliceRange(memory: string, all: ParsedMemoryRecord[], start: number, count: number, body: string, record: MemoryRecord): string {
	const prefix = memory.slice(0, all[start].start).trimEnd();
	const after = all[start + count]?.start;
	const suffix = after === undefined ? "" : memory.slice(after);
	return prefix + formatMemoryRecord(body, record) + (suffix ? `\n${suffix}` : "");
}

function bodyAllowance(memory: string, all: ParsedMemoryRecord[], start: number, count: number, record: MemoryRecord, targetTokens: number): number {
	const withOneByte = spliceRange(memory, all, start, count, "x", record);
	const overheadBytes = Buffer.byteLength(renderMemoryForPrompt(withOneByte), "utf8") - 1;
	const availableBytes = targetTokens * 4 - overheadBytes;
	return Math.max(0, Math.floor(availableBytes / 4));
}

function legalRanges(total: number, inherited: number | undefined): Array<{ start: number; count: number }> {
	if (inherited === undefined) return Array.from({ length: total }, (_, index) => ({ start: 0, count: index + 1 }));
	if (!Number.isInteger(inherited) || inherited < 0 || inherited > total) throw new Error("Invalid fork inherited-record boundary.");
	const ranges: Array<{ start: number; count: number }> = [];
	for (let count = 1; count <= inherited; count++) ranges.push({ start: 0, count });
	for (let count = 1; count <= total - inherited; count++) ranges.push({ start: inherited, count });
	return ranges;
}

/** Select a legal range that can actually leave the full materialized memory at or below 60% of budget. */
export function selectConsolidationPrefix(memory: string, budgetTokens: number, options: {
	inheritedRecordCount?: number;
	createdAt?: string;
	trigger?: TriggerReason;
} = {}): PrefixSelection {
	const all = parseMemoryRecords(memory);
	if (all.length === 0) throw new Error("Candidate memory has no valid v2 records to consolidate.");
	const targetTokens = budgetTokens * CONSOLIDATION_PREFIX_TARGET_RATIO;
	const headroomTokens = Math.floor(budgetTokens * CONSOLIDATION_HEADROOM_RATIO);
	const candidates = legalRanges(all.length, options.inheritedRecordCount).flatMap(({ start, count }) => {
		const records = all.slice(start, start + count);
		const createdAt = options.createdAt ?? records.at(-1)!.record.createdAt;
		const replacementRecord = createConsolidationRecord(records, createdAt, options.trigger ?? records.at(-1)!.record.trigger);
		const allowance = bodyAllowance(memory, all, start, count, replacementRecord, headroomTokens);
		if (allowance < 1) return [];
		const minimum = spliceRange(memory, all, start, count, "x", replacementRecord);
		if (renderedMemoryTokens(minimum) > headroomTokens || renderedMemoryTokens(minimum) >= renderedMemoryTokens(memory)) return [];
		const tokens = renderedMemoryTokens(materializeMemoryFromRecords(records));
		return [{ start, count, tokens, targetTokens, bodyAllowanceTokens: allowance, records, replacementRecord }];
	});
	if (candidates.length === 0) {
		throw new Error(`No legal consolidation range can reach the mandatory ${headroomTokens.toLocaleString()}-token headroom target.`);
	}
	return candidates.sort((left, right) => Math.abs(left.tokens - targetTokens) - Math.abs(right.tokens - targetTokens)
		|| left.start - right.start || left.count - right.count)[0];
}

export function replaceMemoryPrefix(options: {
	candidateMemory: string;
	selection: PrefixSelection;
	body: string;
	record?: MemoryRecord;
	budgetTokens: number;
}): { memory: string; tokens: number } {
	const normalized = validateRecordBody(options.body);
	const allRecords = parseMemoryRecords(options.candidateMemory);
	if (options.selection.start < 0 || options.selection.count < 1
		|| options.selection.start + options.selection.count > allRecords.length) {
		throw new Error("Consolidation range selection is outside candidate memory.");
	}
	const record = options.record ?? options.selection.replacementRecord;
	const replacement = spliceRange(options.candidateMemory, allRecords, options.selection.start, options.selection.count, normalized, record);
	const beforeTokens = renderedMemoryTokens(options.candidateMemory);
	const afterTokens = renderedMemoryTokens(replacement);
	const replacementTokens = renderedMemoryTokens(appendRecordToMemory("", normalized, record));
	if (replacementTokens >= options.selection.tokens) throw new Error("Consolidation did not compress the selected materialized range.");
	if (afterTokens >= beforeTokens) throw new Error("Consolidation did not create memory headroom.");
	const headroomTarget = Math.floor(options.budgetTokens * CONSOLIDATION_HEADROOM_RATIO);
	if (afterTokens > options.budgetTokens) throw new Error("Consolidated memory remains over budget.");
	if (afterTokens > headroomTarget) {
		throw new Error(`Consolidated memory is ${afterTokens.toLocaleString()} tokens; target is at most ${headroomTarget.toLocaleString()}.`);
	}
	if (estimateTextTokens(normalized) > options.selection.bodyAllowanceTokens) {
		throw new Error("Consolidation body exceeds the exact allowance after retained memory and host metadata costs.");
	}
	return { memory: replacement, tokens: afterTokens };
}

export function stageCheckpoint(memory: string, body: string, record: MemoryRecord): string {
	return appendRecordToMemory(memory || MEMORY_HEADER, body, record);
}
