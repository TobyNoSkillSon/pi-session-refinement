import type { Usage } from "@earendil-works/pi-ai";

export type RefinementThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface RefinementConfig {
	enabled: boolean;
	model: string;
	thinking: RefinementThinkingLevel;
	memoryBudgetTokens: number;
	triggers: {
		contextPercent: number;
		elapsedMinutes: number;
		minimumToolCalls: number;
	};
	runOnManualCompaction: boolean;
	maxAttempts: number;
}

export type TriggerReason = "context" | "time" | "manual-compaction" | "auto-compaction" | "resume" | "fork" | "rebuild";

export interface CheckpointRecord {
	fromEntryId?: string;
	throughEntryId: string;
	createdAt: string;
	trigger: TriggerReason;
}

export interface SessionRefinementState {
	version: 1;
	sessionId: string;
	lastProcessedEntryId?: string;
	lastRunAt?: string;
	lastAttemptAt?: string;
	toolCallsSinceRun: number;
	injectedMemoryHash?: string;
	checkpoints: CheckpointRecord[];
	warnings: PersistentWarning[];
}

export type WarningCode = "budget-exceeded" | "broken-state" | "missing-model" | "rebuild-required";

export interface PersistentWarning {
	code: WarningCode;
	message: string;
	rootInstruction?: string;
}

export interface SessionPaths {
	root: string;
	memory: string;
	pending: string;
	state: string;
}

export interface TranscriptSegment {
	text: string;
	fromEntryId?: string;
	throughEntryId: string;
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

export interface ExaminationUsageRecord {
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

export interface ExaminationResult {
	ok: boolean;
	appended: boolean;
	budgetExceeded?: boolean;
	usedModel?: string;
	attempts: number;
	fallbackUsed: boolean;
	usage?: Usage;
	error?: string;
}
