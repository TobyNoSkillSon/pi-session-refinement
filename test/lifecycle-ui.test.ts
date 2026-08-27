import assert from "node:assert/strict";
import test from "node:test";
import { RefinementController } from "../src/lifecycle.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
	return { promise, resolve, reject };
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

test("early compaction error does not reuse a stale extension context", async () => {
	const controller = configuredController();
	let callbacks: { onError(error: Error): void } | undefined;
	let stale = false;
	const notifications: Array<{ message: string; type: string }> = [];
	const ui = {
		notify(message: string, type: string) { notifications.push({ message, type }); },
	};
	const compactionCtx = {
		getContextUsage: () => ({ percent: 81 }),
		compact(options: { onError(error: Error): void }) { callbacks = options; },
		get ui() {
			if (stale) throw new Error("stale extension context");
			return ui;
		},
	} as any;

	await controller.agentSettled(compactionCtx);
	assert.ok(callbacks);
	stale = true;
	assert.doesNotThrow(() => callbacks?.onError(new Error("Compaction cancelled")));
	assert.equal(controller.contextCompactionRequested, false);
	assert.deepEqual(notifications, [{
		message: "[Session Refinement] Early compaction failed: Compaction cancelled",
		type: "warning",
	}]);
});

test("early compaction error tolerates a disposed captured UI", async () => {
	const controller = configuredController();
	let callbacks: { onError(error: Error): void } | undefined;
	let disposed = false;
	const compactionCtx = {
		getContextUsage: () => ({ percent: 81 }),
		compact(options: { onError(error: Error): void }) { callbacks = options; },
		ui: {
			notify() {
				if (disposed) throw new Error("disposed UI");
			},
		},
	} as any;

	await controller.agentSettled(compactionCtx);
	assert.ok(callbacks);
	disposed = true;
	assert.doesNotThrow(() => callbacks?.onError(new Error("Compaction cancelled")));
	assert.equal(controller.contextCompactionRequested, false);
});

test("background examination failure does not reuse a stale extension context", async () => {
	const controller = configuredController();
	controller.state.lastAttemptAt = "2020-01-01T00:00:00.000Z";
	controller.state.lastProcessedEntryId = "a";
	controller.state.toolCallsSinceRun = 1;
	controller.loadedConfig.config.triggers = { contextPercent: 100, elapsedMinutes: 0, minimumToolCalls: 1 };
	const gate = deferred<any>();
	controller.runExamination = () => gate.promise;
	let stale = false;
	const notifications: string[] = [];
	const ui = { notify(message: string) { notifications.push(message); } };
	const message = (id: string, parentId: string | null, content: string) => ({
		type: "message", id, parentId, timestamp: "2026-01-01T00:00:00Z",
		message: { role: "user", content, timestamp: 1 },
	});
	const backgroundCtx = {
		getContextUsage: () => ({ percent: 1 }),
		sessionManager: { getBranch: () => [message("a", null, "one"), message("b", "a", "two")] },
		get ui() {
			if (stale) throw new Error("stale extension context");
			return ui;
		},
	} as any;

	await controller.agentSettled(backgroundCtx);
	const run = controller.currentRun;
	assert.ok(run);
	stale = true;
	gate.reject(new Error("examiner failed"));
	const result = await run;
	assert.equal(result.ok, false);
	assert.match(result.error, /examiner failed/);
	assert.deepEqual(notifications, ["[Session Refinement] Background examination failed: examiner failed"]);
});

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
