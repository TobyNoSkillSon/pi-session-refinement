import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
	ExaminationUsageRecord,
	ModelOperation,
	ModelOperationConfig,
	ModelOperationResult,
	TriggerReason,
} from "./types.js";

export function recordOperationUsage(options: {
	pi: ExtensionAPI;
	operation: ModelOperation;
	trigger: TriggerReason;
	config: ModelOperationConfig;
	result: ModelOperationResult;
}): void {
	const record: ExaminationUsageRecord = {
		operation: options.operation,
		trigger: options.trigger,
		configuredModel: options.config.model,
		usedModel: options.result.usedModel ?? "none",
		thinking: options.config.thinking,
		attempts: options.result.attempts,
		fallbackUsed: options.result.fallbackUsed,
		timestamp: new Date().toISOString(),
		usage: options.result.usage,
		error: options.result.error,
	};
	try { options.pi.appendEntry("pi-session-refinement-usage", record); } catch { /* accounting must not block memory or Pi */ }
}
