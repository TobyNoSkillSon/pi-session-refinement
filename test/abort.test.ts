import assert from "node:assert/strict";
import test from "node:test";
import { linkAbortSignals, waitForPromiseOrAbort } from "../src/abort.ts";

test("linked signal aborts when either source aborts", () => {
	const first = new AbortController();
	const second = new AbortController();
	const linked = linkAbortSignals([first.signal, second.signal]);
	assert.equal(linked.signal.aborted, false);
	second.abort();
	assert.equal(linked.signal.aborted, true);
	linked.dispose();
});

test("linked signal starts aborted and disposal detaches listeners", () => {
	const already = new AbortController();
	already.abort();
	const linked = linkAbortSignals([already.signal]);
	assert.equal(linked.signal.aborted, true);
	linked.dispose();

	const later = new AbortController();
	const detached = linkAbortSignals([later.signal]);
	detached.dispose();
	later.abort();
	assert.equal(detached.signal.aborted, false);
});


test("waiting can stop on cancellation without cancelling the underlying work", async () => {
	const controller = new AbortController();
	let complete!: () => void;
	const work = new Promise<void>((resolve) => { complete = resolve; });
	const waiting = waitForPromiseOrAbort(work, controller.signal);
	controller.abort();
	assert.equal(await waiting, false);
	complete();
	await work;
});

test("waiting reports normal settlement", async () => {
	const controller = new AbortController();
	assert.equal(await waitForPromiseOrAbort(Promise.resolve(), controller.signal), true);
});
