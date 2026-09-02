import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildTranscriptSegment, splitBranchAtCompactions } from "./session-history.js";
import type { TranscriptSegment } from "./types.js";

export function buildReconstructionSegments(branchEntries: SessionEntry[], afterEntryId?: string): TranscriptSegment[] {
	let selected = branchEntries;
	if (afterEntryId) {
		const floor = branchEntries.findIndex((entry) => entry.id === afterEntryId);
		if (floor < 0) throw new Error(`Rebuild floor ${afterEntryId} is not on the current branch.`);
		selected = branchEntries.slice(floor + 1);
	}
	return splitBranchAtCompactions(selected)
		.map((chunk) => buildTranscriptSegment({ branchEntries: chunk }))
		.filter((segment): segment is TranscriptSegment => Boolean(segment));
}
