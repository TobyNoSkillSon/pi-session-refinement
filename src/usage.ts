import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ExaminationResult, ExaminationUsageRecord, RefinementConfig, TriggerReason } from "./types.js";

export function recordExaminerUsage(options: {
	pi: ExtensionAPI;
	trigger: TriggerReason;
	config: RefinementConfig;
	result: ExaminationResult;
}): void {
	const record: ExaminationUsageRecord = {
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
	options.pi.appendEntry("pi-session-refinement-usage", record);
}
