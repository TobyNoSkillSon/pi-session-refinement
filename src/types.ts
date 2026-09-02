import type { Usage } from "@earendil-works/pi-ai";

export type RefinementThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelOperationConfig {
	model: string;
	thinking: RefinementThinkingLevel;
}

export interface RefinementConfig extends ModelOperationConfig {
	consolidator: ModelOperationConfig;
	memoryBudgetTokens: number;
	triggers: {
		contextPercent: number;
		elapsedMinutes: number;
		minimumToolCalls: number;
	};
	runOnManualCompaction: boolean;
	maxAttempts: number;
	enabled: boolean;
}

export type TriggerReason = "context" | "time" | "manual-compaction" | "auto-compaction" | "resume" | "fork" | "rebuild" | "consolidation";
export type MemoryRecordKind = "checkpoint" | "consolidation";

export interface MemoryRecord {
	kind: MemoryRecordKind;
	generation: number;
	fromEntryId?: string;
	throughEntryId: string;
	sourceRecordCount: number;
	createdAt: string;
	cutoffAt: string;
	trigger: TriggerReason;
}

/** Kept only so valid v1 sessions can be loaded and injected read-only. */
export interface LegacyCheckpointRecord {
	fromEntryId?: string;
	throughEntryId: string;
	createdAt: string;
	trigger: TriggerReason;
}

export interface LegacyForkState {
	floorEntryId: string;
	inheritedCheckpointCount: number;
}

export interface LegacyPersistentWarning {
	code: WarningCode | "budget-exceeded";
	message: string;
	rootInstruction?: string;
}

export interface SessionRefinementStateV1 {
	version: 1;
	sessionId: string;
	lastProcessedEntryId?: string;
	lastRunAt?: string;
	lastAttemptAt?: string;
	toolCallsSinceRun: number;
	injectedMemoryHash?: string;
	checkpoints: LegacyCheckpointRecord[];
	warnings: LegacyPersistentWarning[];
	fork?: LegacyForkState;
}

export interface MemoryGenerationRef {
	/** Root-relative, host-created path such as generations/memory-<uuid>.md. */
	file: string;
	sha256: string;
}

export interface SessionRefinementState {
	version: 2;
	sessionId: string;
	lastProcessedEntryId?: string;
	lastRunAt?: string;
	lastAttemptAt?: string;
	toolCallsSinceRun: number;
	injectedMemoryHash?: string;
	memoryGeneration?: MemoryGenerationRef;
	records: MemoryRecord[];
	warnings: PersistentWarning[];
	fork?: {
		floorEntryId: string;
		inheritedRecordCount: number;
	};
}

export type LoadedSessionState = SessionRefinementState | SessionRefinementStateV1;
export type WarningCode = "broken-state" | "missing-model" | "missing-consolidator-model" | "rebuild-required" | "consolidation-failed";

export interface PersistentWarning {
	code: WarningCode;
	message: string;
	rootInstruction?: string;
}

export interface SessionPaths {
	root: string;
	/** Legacy v1 location only. v2 never treats this file as authoritative. */
	memory: string;
	generations: string;
	state: string;
}

export interface TranscriptSegment {
	text: string;
	fromEntryId?: string;
	throughEntryId: string;
	cutoffAt: string;
	entryCount: number;
}

export interface ExaminationRequest {
	sessionId: string;
	trigger: TriggerReason;
	contextTokens?: number;
	contextWindow?: number;
	previousMemory: string;
	segment: TranscriptSegment;
	currentTimeUtc: string;
	currentTimeLocal: string;
}

export interface ConsolidationRequest {
	sessionId: string;
	trigger: TriggerReason;
	prefixMemory: string;
	prefixRecords: number;
	firstSourceEntry?: string;
	lastSourceEntry: string;
	cutoffAt: string;
	outputBudgetTokens: number;
}

export type ModelOperation = "refinement" | "consolidation";

export interface ExaminationUsageRecord {
	operation: ModelOperation;
	trigger: TriggerReason;
	configuredModel: string;
	usedModel: string;
	thinking: RefinementThinkingLevel;
	attempts: number;
	fallbackUsed: boolean;
	timestamp: string;
	usage?: Usage;
	error?: string;
}

export interface ModelOperationResult {
	ok: boolean;
	body?: string;
	cancelled?: boolean;
	/** Successful model, or the last model actually attempted on failure. */
	usedModel?: string;
	attempts: number;
	/** True only if at least one fallback attempt actually started. */
	fallbackUsed: boolean;
	usage?: Usage;
	error?: string;
}

export type ExaminationResult = ModelOperationResult;
