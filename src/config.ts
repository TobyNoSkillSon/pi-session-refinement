import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RefinementConfig, RefinementThinkingLevel } from "./types.js";

export const DEFAULT_CONFIG: RefinementConfig = {
	enabled: true,
	model: "current",
	thinking: "high",
	memoryBudgetTokens: 32_000,
	triggers: {
		contextPercent: 80,
		elapsedMinutes: 40,
		minimumToolCalls: 25,
	},
	runOnManualCompaction: true,
	maxAttempts: 3,
};

const THINKING_LEVELS = new Set<RefinementThinkingLevel>([
	"off", "minimal", "low", "medium", "high", "xhigh", "max",
]);

export interface LoadedConfig {
	config: RefinementConfig;
	path: string;
	issues: string[];
}

export function getConfigPath(agentDir: string): string {
	return join(agentDir, "pi-session-refinement", "config.json");
}

function positiveInteger(value: unknown, fallback: number, label: string, issues: string[]): number {
	if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
	if (value !== undefined) issues.push(`${label} must be a positive integer; using ${fallback}.`);
	return fallback;
}

function percent(value: unknown, fallback: number, issues: string[]): number {
	if (typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= 99) return value;
	if (value !== undefined) issues.push(`triggers.contextPercent must be between 1 and 99; using ${fallback}.`);
	return fallback;
}

export function parseConfig(input: unknown): { config: RefinementConfig; issues: string[] } {
	const issues: string[] = [];
	const raw = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
	if (input !== undefined && raw !== input) issues.push("Configuration root must be an object; using defaults.");
	const triggerRaw = raw.triggers && typeof raw.triggers === "object" && !Array.isArray(raw.triggers)
		? raw.triggers as Record<string, unknown>
		: {};
	if (raw.triggers !== undefined && triggerRaw !== raw.triggers) issues.push("triggers must be an object; using defaults.");

	const model = typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : DEFAULT_CONFIG.model;
	if (raw.model !== undefined && model === DEFAULT_CONFIG.model && raw.model !== DEFAULT_CONFIG.model) {
		issues.push(`model must be a non-empty string; using "${DEFAULT_CONFIG.model}".`);
	}
	const thinking = THINKING_LEVELS.has(raw.thinking as RefinementThinkingLevel)
		? raw.thinking as RefinementThinkingLevel
		: DEFAULT_CONFIG.thinking;
	if (raw.thinking !== undefined && thinking !== raw.thinking) issues.push(`thinking is invalid; using "${thinking}".`);

	return {
		config: {
			enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_CONFIG.enabled,
			model,
			thinking,
			memoryBudgetTokens: positiveInteger(raw.memoryBudgetTokens, DEFAULT_CONFIG.memoryBudgetTokens, "memoryBudgetTokens", issues),
			triggers: {
				contextPercent: percent(triggerRaw.contextPercent, DEFAULT_CONFIG.triggers.contextPercent, issues),
				elapsedMinutes: positiveInteger(triggerRaw.elapsedMinutes, DEFAULT_CONFIG.triggers.elapsedMinutes, "triggers.elapsedMinutes", issues),
				minimumToolCalls: positiveInteger(triggerRaw.minimumToolCalls, DEFAULT_CONFIG.triggers.minimumToolCalls, "triggers.minimumToolCalls", issues),
			},
			runOnManualCompaction: typeof raw.runOnManualCompaction === "boolean"
				? raw.runOnManualCompaction
				: DEFAULT_CONFIG.runOnManualCompaction,
			maxAttempts: positiveInteger(raw.maxAttempts, DEFAULT_CONFIG.maxAttempts, "maxAttempts", issues),
		},
		issues,
	};
}

export async function loadConfig(agentDir: string): Promise<LoadedConfig> {
	const path = getConfigPath(agentDir);
	try {
		const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
		return { ...parseConfig(parsed), path };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { config: structuredClone(DEFAULT_CONFIG), path, issues: [] };
		const message = error instanceof Error ? error.message : String(error);
		return { config: structuredClone(DEFAULT_CONFIG), path, issues: [`Could not load ${path}: ${message}`] };
	}
}
