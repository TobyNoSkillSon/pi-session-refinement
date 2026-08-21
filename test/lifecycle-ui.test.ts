import assert from "node:assert/strict";
import test from "node:test";
import { RefinementController } from "../src/lifecycle.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

function configuredController(): any {
	const controller: any = new RefinementController({} as any);
	controller.active = true;
	controller.firstPrompt = false;
	controller.state = { version: 1, sessionId: "session", toolCallsSinceRun: 0, checkpoints: [], warnings: [] };
	controller.paths = { root: "/tmp/session", memory: "/tmp/session/memory.md", pending: "/tmp/session/pending.md", state: "/tmp/session/state.json" };
	controller.loadedConfig = {
		config: { enabled: true, model: "current", thinking: "high", memoryBudgetTokens: 32_000, triggers: { contextPercent: 80, elapsedMinutes: 40, minimumToolCalls: 25 }, runOnManualCompaction: true, maxAttempts: 3 },
		issues: [],
	};
	return controller;
}

const ctx = {
	mode: "tui",
	hasUI: true,
	ui: { notify() {}, setWidget() {} },
} as any;

test("before_agent_start waits for a foreground rebuild", async () => {
	const controller = configuredController();
	const gate = deferred<boolean>();
	controller.foregroundRun = gate.promise;
	let settled = false;
	const prompt = controller.beforeAgentStart(ctx, "system").then((value: string) => { settled = true; return value; });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(settled, false);
	gate.resolve(true);
	assert.equal(await prompt, "system");
});

test("compaction cancellation stops waiting for unrelated background refinement", async () => {
	const controller = configuredController();
	const gate = deferred<any>();
	controller.currentRun = gate.promise;
	const abort = new AbortController();
	const waiting = controller.beforeCompact({
		reason: "threshold",
		preparation: { firstKeptEntryId: "next" },
		branchEntries: [],
		signal: abort.signal,
	}, ctx);
	abort.abort();
	await waiting;
	gate.resolve({ ok: true });
});

test("ordinary shutdown aborts a background examiner before awaiting it", async () => {
	const previous = process.env.PI_AGENT_RUNNER_ROLE;
	delete process.env.PI_AGENT_RUNNER_ROLE;
	try {
		const controller: any = new RefinementController({} as any);
		controller.currentRun = new Promise((resolve) => {
			controller.abortController.signal.addEventListener("abort", () => resolve({ ok: false, cancelled: true }), { once: true });
		});
		await controller.shutdown();
		assert.equal(controller.abortController.signal.aborted, true);
	} finally {
		if (previous === undefined) delete process.env.PI_AGENT_RUNNER_ROLE;
		else process.env.PI_AGENT_RUNNER_ROLE = previous;
	}
});
