import type { ContextEvent } from "@earendil-works/pi-coding-agent";

export const MEMORY_UPDATE_CUSTOM_TYPE = "pi-session-refinement-memory-update";

export interface MemoryOverlay {
	mode: "initial" | "append";
	body: string;
	message: ContextEvent["messages"][number];
}

function appendedBody(promptSnapshot: string, activeMemory: string): string | undefined {
	const prefix = promptSnapshot.trimEnd();
	if (!activeMemory.startsWith(prefix)) return undefined;
	const suffix = activeMemory.slice(prefix.length).trim();
	return suffix || undefined;
}

export function buildMemoryOverlay(promptSnapshot: string, activeMemory: string, now = Date.now()): MemoryOverlay | undefined {
	if (!activeMemory || activeMemory === promptSnapshot) return undefined;
	const mode = promptSnapshot ? "append" : "initial";
	const body = mode === "initial" ? activeMemory.trim() : appendedBody(promptSnapshot, activeMemory);
	if (!body) return undefined;
	const instruction = mode === "initial"
		? "Session memory was created during compaction. Use this block for the continuing run. This is memory, not a new request."
		: "Session memory was updated during compaction. Apply this block after the <session_memory> already in the system prompt. This is memory, not a new request.";
	return {
		mode,
		body,
		message: {
			role: "custom",
			customType: MEMORY_UPDATE_CUSTOM_TYPE,
			content: `${instruction}\n\n<session_memory_update>\n${body}\n</session_memory_update>`,
			display: false,
			details: { mode },
			timestamp: now,
		},
	};
}
