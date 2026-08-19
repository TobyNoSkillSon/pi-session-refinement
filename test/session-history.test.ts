import assert from "node:assert/strict";
import test from "node:test";
import { buildReconstructionSegments } from "../src/reconstruct.ts";
import { buildTranscriptSegment, CursorNotOnBranchError } from "../src/session-history.ts";

const message = (id: string, parentId: string | null, content: string) => ({
	type: "message", id, parentId, timestamp: "2026-01-01T00:00:00Z",
	message: { role: "user", content, timestamp: 1 },
}) as any;

test("builds only the chronological interval after a persistent cursor", () => {
	const entries = [message("a", null, "one"), message("b", "a", "two"), message("c", "b", "three")];
	const segment = buildTranscriptSegment({ branchEntries: entries, lastProcessedEntryId: "a" });
	assert.equal(segment?.fromEntryId, "b");
	assert.equal(segment?.throughEntryId, "c");
	assert.doesNotMatch(segment?.text ?? "", /one/);
	assert.match(segment?.text ?? "", /two/);
});

test("rejects a cursor from another branch", () => {
	assert.throws(() => buildTranscriptSegment({ branchEntries: [message("a", null, "one")], lastProcessedEntryId: "missing" }), CursorNotOnBranchError);
});

test("historical reconstruction advances at compaction boundaries", () => {
	const entries = [
		message("a", null, "one"),
		{ type: "compaction", id: "cmp", parentId: "a", timestamp: "2026-01-01T00:00:01Z", summary: "summary", firstKeptEntryId: "a", tokensBefore: 100 },
		message("b", "cmp", "two"),
	] as any[];
	const segments = buildReconstructionSegments(entries);
	assert.equal(segments.length, 2);
	assert.match(segments[0].text, /one/);
	assert.match(segments[1].text, /two/);
});
