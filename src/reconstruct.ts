import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildTranscriptSegment, splitBranchAtCompactions } from "./session-history.js";
import type { TranscriptSegment } from "./types.js";

export function buildReconstructionSegments(branchEntries: SessionEntry[]): TranscriptSegment[] {
	return splitBranchAtCompactions(branchEntries)
		.map((chunk) => buildTranscriptSegment({ branchEntries: chunk }))
		.filter((segment): segment is TranscriptSegment => Boolean(segment));
}
