import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ConsolidationRequest, ExaminationRequest } from "./types.js";

const EXAMINER_PROMPT_PATH = fileURLToPath(new URL("../prompts/examiner.md", import.meta.url));
const CONSOLIDATOR_PROMPT_PATH = fileURLToPath(new URL("../prompts/consolidator.md", import.meta.url));

export async function loadExaminerPrompt(): Promise<string> {
	return (await readFile(EXAMINER_PROMPT_PATH, "utf8")).trim();
}

export async function loadConsolidatorPrompt(): Promise<string> {
	return (await readFile(CONSOLIDATOR_PROMPT_PATH, "utf8")).trim();
}

export function buildExaminerTask(request: ExaminationRequest): string {
	const context = request.contextTokens !== undefined && request.contextWindow !== undefined
		? `${request.contextTokens.toLocaleString()} / ${request.contextWindow.toLocaleString()} tokens (${((request.contextTokens / request.contextWindow) * 100).toFixed(1)}%)`
		: "unavailable";
	return `Examine the next chronological interval of a persistent Pi session and submit one completed memory checkpoint.

<runtime>
Session ID: ${request.sessionId}
Trigger: ${request.trigger}
Current UTC time: ${request.currentTimeUtc}
Current local time: ${request.currentTimeLocal}
Context usage: ${context}
First source entry: ${request.segment.fromEntryId ?? "beginning of branch"}
Last source entry: ${request.segment.throughEntryId}
Source entries: ${request.segment.entryCount}
</runtime>

<existing_session_memory>
${request.previousMemory || "(No previous session memory.)"}
</existing_session_memory>

<new_chronological_interval>
${request.segment.text}
</new_chronological_interval>

Use append_memory exactly once with the complete new checkpoint body. Do not return the checkpoint as ordinary assistant text.`;
}

export function buildConsolidatorTask(request: ConsolidationRequest): string {
	return `Consolidate the oldest chronological memory-record prefix below.

<runtime>
Session ID: ${request.sessionId}
Trigger: ${request.trigger}
Operation: consolidation
Prefix records: ${request.prefixRecords}
First source entry: ${request.firstSourceEntry ?? "beginning of branch"}
Last source entry: ${request.lastSourceEntry}
Prefix cutoff UTC: ${request.cutoffAt}
Maximum replacement body: ${request.outputBudgetTokens.toLocaleString()} estimated tokens (after exact retained-memory, header, heading, and metadata costs)
</runtime>

<record_prefix>
${request.prefixMemory}
</record_prefix>

Use replace_memory_prefix exactly once with the complete replacement checkpoint body.`;
}
