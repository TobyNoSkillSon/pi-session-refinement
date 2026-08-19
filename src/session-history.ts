import { convertToLlm, serializeConversation, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { TranscriptSegment } from "./types.js";

export class CursorNotOnBranchError extends Error {
	constructor(cursor: string) {
		super(`Last processed entry ${cursor} is not on the current session branch.`);
		this.name = "CursorNotOnBranchError";
	}
}

function entryMessages(entries: SessionEntry[]): Parameters<typeof convertToLlm>[0] {
	const messages: Parameters<typeof convertToLlm>[0] = [];
	for (const entry of entries) {
		if (entry.type === "message") messages.push(entry.message);
		if (entry.type === "compaction") {
			messages.push({
				role: "user",
				content: `[Pi compaction summary recorded at ${entry.timestamp}]\n${entry.summary}`,
				timestamp: Date.parse(entry.timestamp) || Date.now(),
			});
		}
		if (entry.type === "branch_summary") {
			messages.push({
				role: "user",
				content: `[Pi branch summary recorded at ${entry.timestamp}]\n${entry.summary}`,
				timestamp: Date.parse(entry.timestamp) || Date.now(),
			});
		}
	}
	return messages;
}

export function buildTranscriptSegment(options: {
	branchEntries: SessionEntry[];
	lastProcessedEntryId?: string;
	throughBeforeEntryId?: string;
}): TranscriptSegment | undefined {
	const { branchEntries } = options;
	let start = 0;
	if (options.lastProcessedEntryId) {
		const cursor = branchEntries.findIndex((entry) => entry.id === options.lastProcessedEntryId);
		if (cursor < 0) throw new CursorNotOnBranchError(options.lastProcessedEntryId);
		start = cursor + 1;
	}
	let end = branchEntries.length;
	if (options.throughBeforeEntryId) {
		const boundary = branchEntries.findIndex((entry) => entry.id === options.throughBeforeEntryId);
		if (boundary >= 0) end = boundary;
	}
	if (end <= start) return undefined;
	const selected = branchEntries.slice(start, end);
	const messages = entryMessages(selected);
	if (messages.length === 0) return undefined;
	const text = serializeConversation(convertToLlm(messages)).trim();
	if (!text) return undefined;
	return {
		text,
		fromEntryId: selected[0]?.id,
		throughEntryId: selected[selected.length - 1].id,
		entryCount: selected.length,
	};
}

export function splitBranchAtCompactions(branchEntries: SessionEntry[]): SessionEntry[][] {
	const chunks: SessionEntry[][] = [];
	let current: SessionEntry[] = [];
	for (const entry of branchEntries) {
		current.push(entry);
		if (entry.type === "compaction") {
			chunks.push(current);
			current = [];
		}
	}
	if (current.length > 0) chunks.push(current);
	return chunks.filter((chunk) => entryMessages(chunk).length > 0);
}
