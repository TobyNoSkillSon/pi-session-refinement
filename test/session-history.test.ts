import assert from "node:assert/strict";
import test from "node:test";
import { buildReconstructionSegments } from "../src/reconstruct.ts";
import { buildTranscriptSegment, CompactionBoundaryNotOnBranchError, countToolResults, CursorNotOnBranchError, initialSessionBaseline } from "../src/session-history.ts";

const message = (id: string, parentId: string | null, content: string) => ({
	type: "message", id, parentId, timestamp: "2026-01-01T00:00:00Z",
	message: { role: "user", content, timestamp: 1 },
}) as any;

test("builds only the chronological interval after a persistent cursor", () => {
	const entries = [message("a", null, "one"), message("b", "a", "two"), message("c", "b", "three")];
	const segment = buildTranscriptSegment({ branchEntries: entries, lastProcessedEntryId: "a" });
	assert.equal(segment?.fromEntryId, "b");
	assert.equal(segment?.throughEntryId, "c");
	assert.equal(segment?.cutoffAt, "2026-01-01T00:00:00Z");
	assert.doesNotMatch(segment?.text ?? "", /one/);
	assert.match(segment?.text ?? "", /two/);
});

test("rejects a cursor from another branch", () => {
	assert.throws(() => buildTranscriptSegment({ branchEntries: [message("a", null, "one")], lastProcessedEntryId: "missing" }), CursorNotOnBranchError);
});

test("rejects an off-branch pre-compaction boundary instead of retaining unintended history", () => {
	assert.throws(() => buildTranscriptSegment({ branchEntries: [message("a", null, "one"), message("b", "a", "two")], throughBeforeEntryId: "other-branch" }), CompactionBoundaryNotOnBranchError);
});

test("root reconstruction begins at branch start and fork rebuilds only the tail after its floor", () => {
	const entries = [
		message("a", null, "one"),
		{ type: "compaction", id: "cmp", parentId: "a", timestamp: "2026-01-01T00:00:01Z", summary: "summary", firstKeptEntryId: "a", tokensBefore: 100 },
		message("floor", "cmp", "fork point"),
		message("local", "floor", "fork local"),
	] as any[];
	const rootSegments = buildReconstructionSegments(entries);
	assert.equal(rootSegments.length, 2);
	assert.match(rootSegments[0].text, /one/);
	assert.match(rootSegments[1].text, /fork point/);
	const forkSegments = buildReconstructionSegments(entries, "floor");
	assert.equal(forkSegments.length, 1);
	assert.match(forkSegments[0].text, /fork local/);
	assert.doesNotMatch(forkSegments[0].text, /fork point|one/);
});


test("new-session baseline stops before the first user message", () => {
	const metadataOnly = [{ type: "session", id: "session" }, { type: "model_change", id: "model" }] as any[];
	assert.equal(initialSessionBaseline(metadataOnly), "model");
	assert.equal(initialSessionBaseline([...metadataOnly, message("first", "model", "Initial governing request")]), undefined);
});

test("counts only tool-result messages", () => {
	const toolResult = (id: string) => ({
		type: "message", id, parentId: null, timestamp: "2026-01-01T00:00:00Z",
		message: { role: "toolResult", toolCallId: id, toolName: "probe", content: [], isError: false, timestamp: 1 },
	}) as any;
	const entries = [
		message("user", null, "request"),
		toolResult("result-1"),
		{ type: "compaction", id: "compact" },
		toolResult("result-2"),
	] as any[];
	assert.equal(countToolResults(entries), 2);
});
