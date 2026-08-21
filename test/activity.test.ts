import assert from "node:assert/strict";
import test from "node:test";
import {
	REFINEMENT_WIDGET_KEY,
	RefinementActivity,
	activityBaseMessage,
	attemptMessage,
	shortModelName,
} from "../src/activity.ts";

type WidgetCall = { key: string; content: unknown; options?: { placement?: string } };

function fakeContext(mode: "tui" | "rpc" = "tui") {
	const calls: WidgetCall[] = [];
	return {
		ctx: {
			mode,
			ui: {
				setWidget(key: string, content: unknown, options?: { placement?: string }) {
					calls.push({ key, content, options });
				},
			},
		} as any,
		calls,
	};
}

test("renders an animated loader above the editor and clears it", () => {
	const { ctx, calls } = fakeContext();
	const activity = new RefinementActivity();
	const handle = activity.begin(ctx, "Refining session memory");
	assert.equal(calls.length, 1);
	assert.equal(calls[0].key, REFINEMENT_WIDGET_KEY);
	assert.equal(calls[0].options?.placement, "aboveEditor");
	assert.equal(typeof calls[0].content, "function");

	const renders: string[][] = [];
	const tui = { requestRender() {} } as any;
	const theme = { fg: (_kind: string, value: string) => value } as any;
	const component = (calls[0].content as Function)(tui, theme);
	renders.push(component.render(100));
	assert.match(renders[0].join("\n"), /Refining session memory/);
	assert.equal(typeof component.dispose, "function");
	component.dispose();

	handle.clear();
	assert.equal(calls.at(-1)?.content, undefined);
});

test("stale operations cannot update or clear a newer widget", () => {
	const { ctx, calls } = fakeContext();
	const activity = new RefinementActivity();
	const first = activity.begin(ctx, "first");
	const second = activity.begin(ctx, "second");
	const count = calls.length;
	first.update("stale update");
	first.clear();
	assert.equal(calls.length, count);
	second.update("current update");
	assert.equal(calls.length, count + 1);
	second.clear();
	assert.equal(calls.at(-1)?.content, undefined);
});

test("clearAll invalidates late handles and is idempotent", () => {
	const { ctx, calls } = fakeContext();
	const activity = new RefinementActivity();
	const handle = activity.begin(ctx, "active");
	activity.clearAll();
	const count = calls.length;
	handle.update("late");
	handle.clear();
	activity.clearAll();
	assert.equal(calls.length, count);
});

test("component widgets stay inert outside TUI mode", () => {
	const { ctx, calls } = fakeContext("rpc");
	const activity = new RefinementActivity();
	const handle = activity.begin(ctx, "hidden");
	handle.update("still hidden");
	handle.clear();
	assert.deepEqual(calls, []);
});

test("formats the three agreed user-facing operation families", () => {
	assert.equal(activityBaseMessage("time"), "Refining session memory");
	assert.equal(activityBaseMessage("resume"), "Refining session memory");
	assert.equal(activityBaseMessage("fork"), "Refining session memory");
	assert.equal(activityBaseMessage("context"), "Refining memory before compaction");
	assert.equal(activityBaseMessage("manual-compaction"), "Refining memory before compaction");
	assert.equal(activityBaseMessage("rebuild"), "Rebuilding session memory");
	assert.equal(shortModelName("provider/model-id"), "model-id");
	assert.equal(attemptMessage("Refining session memory", "provider/model-id", 2, 3), "Refining session memory · model-id · attempt 2/3");
	assert.equal(attemptMessage("Refining session memory", "provider/model-id", 1, 3, true), "Refining session memory · fallback model-id · attempt 1/3");
});
