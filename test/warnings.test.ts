import assert from "node:assert/strict";
import test from "node:test";
import { notifyPersistentWarnings } from "../src/warnings.ts";

test("persistent warnings notify without occupying the footer", () => {
	const notifications: Array<{ message: string; type?: string }> = [];
	let statusCalls = 0;
	const ctx = {
		ui: {
			notify(message: string, type?: string) { notifications.push({ message, type }); },
			setStatus() { statusCalls++; },
		},
	} as any;
	notifyPersistentWarnings(ctx, [{ code: "missing-model", message: "Model unavailable" }], ["Invalid setting"]);
	assert.equal(notifications.length, 2);
	assert.equal(statusCalls, 0);
	assert.match(notifications[0].message, /Invalid setting/);
	assert.match(notifications[1].message, /Model unavailable/);
});
