import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RefinementController } from "../src/lifecycle.ts";
import { appendCheckpoint, atomicWrite, formatCheckpoint, getSessionPaths, MEMORY_HEADER } from "../src/memory-file.ts";

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

const message = (id: string, parentId: string | null, content: string) => ({
	type: "message", id, parentId, timestamp: "2026-01-01T00:00:00Z",
	message: { role: "user", content, timestamp: 1 },
}) as any;

const toolResult = (id: string, parentId: string | null) => ({
	type: "message", id, parentId, timestamp: "2026-01-01T00:00:00Z",
	message: { role: "toolResult", toolCallId: id, toolName: "probe", content: [], isError: false, timestamp: 1 },
}) as any;

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

test("fork inheritance starts the elapsed trigger clock", async () => {
	const storageRoot = await mkdtemp(join(tmpdir(), "pi-session-refinement-fork-clock-"));
	const previousRoot = process.env.PI_SESSION_REFINEMENT_ROOT;
	process.env.PI_SESSION_REFINEMENT_ROOT = storageRoot;
	try {
		const parent = getSessionPaths(storageRoot, "parent-session");
		await appendCheckpoint({
			paths: parent,
			body: "shared memory",
			record: { throughEntryId: "shared", createdAt: "2026-01-01T00:00:00Z", trigger: "time" },
			budgetTokens: 32_000,
		});
		const parentSessionFile = join(storageRoot, "parent.jsonl");
		await atomicWrite(parentSessionFile, `${JSON.stringify({ type: "session", id: "parent-session", cwd: "/tmp", timestamp: "2026-01-01T00:00:00Z" })}
`);
		const controller: any = new RefinementController({} as any);
		const before = Date.now();
		await controller.sessionStart({ reason: "fork", previousSessionFile: parentSessionFile }, {
			sessionManager: {
				getSessionFile: () => join(storageRoot, "fork.jsonl"),
				getSessionId: () => "fork-session",
				getBranch: () => [message("shared", null, "shared")],
			},
		} as any);
		const timestamp = Date.parse(controller.state.lastAttemptAt);
		assert.ok(Number.isFinite(timestamp));
		assert.ok(timestamp >= before && timestamp <= Date.now());
	} finally {
		if (previousRoot === undefined) delete process.env.PI_SESSION_REFINEMENT_ROOT;
		else process.env.PI_SESSION_REFINEMENT_ROOT = previousRoot;
		await rm(storageRoot, { recursive: true, force: true });
	}
});

test("pre-compaction refinement preserves retained tool-result activity", async () => {
	const controller = configuredController();
	controller.state.lastProcessedEntryId = "cursor";
	controller.state.toolCallsSinceRun = 2;
	const entries = [
		message("cursor", null, "already processed"),
		message("prefix", "cursor", "about to compact"),
		message("kept", "prefix", "retained user message"),
		toolResult("retained-result", "kept"),
	];
	let captured: { throughEntryId?: string; retainedToolCalls?: number } = {};
	controller.runExamination = async (segment: any, _trigger: any, _ctx: any, _activate: any, _signal: any, retainedToolCalls: number) => {
		captured = { throughEntryId: segment.throughEntryId, retainedToolCalls };
		return { ok: true, appended: true, attempts: 1, fallbackUsed: false };
	};
	await controller.beforeCompact({
		reason: "threshold",
		preparation: { firstKeptEntryId: "kept" },
		branchEntries: entries,
		signal: new AbortController().signal,
	}, ctx);
	assert.deepEqual(captured, { throughEntryId: "prefix", retainedToolCalls: 1 });
});

test("resume with a baseline cursor creates its first memory checkpoint", async () => {
	const controller = configuredController();
	controller.firstPrompt = true;
	controller.stateExisted = true;
	controller.startReason = "startup";
	controller.injectedMemory = "";
	controller.state.lastProcessedEntryId = "baseline";
	let captured: { trigger?: string; fromEntryId?: string; activate?: boolean } = {};
	controller.runExamination = async (segment: any, trigger: string, _ctx: any, activate: boolean) => {
		captured = { trigger, fromEntryId: segment.fromEntryId, activate };
		return { ok: true, appended: true, attempts: 1, fallbackUsed: false };
	};
	await controller.beforeAgentStart({
		...ctx,
		sessionManager: { getBranch: () => [
			{ type: "model_change", id: "baseline", parentId: null, timestamp: "2026-01-01T00:00:00Z" },
			message("first", "baseline", "first completed turn"),
		] },
	} as any, "system");
	assert.deepEqual(captured, { trigger: "resume", fromEntryId: "first", activate: true });
});

test("a genuinely new startup does not refine its first prompt synchronously", async () => {
	const controller = configuredController();
	controller.firstPrompt = true;
	controller.stateExisted = false;
	controller.startReason = "startup";
	controller.injectedMemory = "";
	controller.state.lastProcessedEntryId = "baseline";
	let examinations = 0;
	controller.runExamination = async () => { examinations++; };
	await controller.beforeAgentStart({
		...ctx,
		sessionManager: { getBranch: () => [
			{ type: "model_change", id: "baseline", parentId: null, timestamp: "2026-01-01T00:00:00Z" },
			message("first", "baseline", "initial prompt"),
		] },
	} as any, "system");
	assert.equal(examinations, 0);
});

test("a historical session without refinement state still requires an authorized rebuild", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-session-refinement-legacy-"));
	try {
		const controller = configuredController();
		controller.paths = getSessionPaths(root, "session");
		controller.firstPrompt = true;
		controller.stateExisted = false;
		controller.startReason = "startup";
		controller.injectedMemory = "";
		controller.state.lastProcessedEntryId = undefined;
		let examinations = 0;
		controller.runExamination = async () => { examinations++; };
		await controller.beforeAgentStart({
			...ctx,
			sessionManager: { getBranch: () => [message("existing", null, "historical prompt")] },
		} as any, "system");
		assert.equal(examinations, 0);
		assert.equal(controller.state.warnings[0]?.code, "rebuild-required");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("attempt completion preserves retained and in-flight tool activity", () => {
	const controller = configuredController();
	controller.state.toolCallsSinceRun = 5;
	controller.recordAttemptCompletion(controller.state, 3, 1);
	assert.equal(controller.state.toolCallsSinceRun, 3, "one retained result plus two arriving during examination");
	assert.ok(Number.isFinite(Date.parse(controller.state.lastAttemptAt)));
});

test("missing memory with recorded checkpoints is treated as broken state", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-session-refinement-missing-memory-"));
	try {
		const controller = configuredController();
		controller.paths = getSessionPaths(root, "session");
		controller.firstPrompt = true;
		controller.stateExisted = true;
		controller.startReason = "startup";
		controller.injectedMemory = "";
		controller.state.lastProcessedEntryId = "checkpoint";
		controller.state.checkpoints = [{ throughEntryId: "checkpoint", createdAt: "2026-01-01T00:00:00Z", trigger: "time" }];
		let examinations = 0;
		controller.runExamination = async () => { examinations++; };
		await controller.beforeAgentStart({
			...ctx,
			sessionManager: { getBranch: () => [
				message("checkpoint", null, "previously checkpointed"),
				message("tail", "checkpoint", "new tail"),
			] },
		} as any, "system");
		assert.equal(examinations, 0);
		assert.equal(controller.broken, true);
		assert.equal(controller.state.warnings[0]?.code, "broken-state");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("truncated or unrelated memory cannot resume from checkpointed state", async () => {
	const bodylessMetadata = JSON.stringify({ throughEntryId: "checkpoint", createdAt: "2026-01-01T00:00:00Z", trigger: "time" });
	const memories = [
		MEMORY_HEADER,
		`${MEMORY_HEADER}${formatCheckpoint("unrelated", { throughEntryId: "other", createdAt: "2026-01-01T00:00:00Z", trigger: "time" })}`,
		`${MEMORY_HEADER}\n<!-- pi-session-refinement:${bodylessMetadata} -->\n\n---\n\n## Memory checkpoint — 2026-01-01T00:00:00Z\n`,
	];
	for (const injectedMemory of memories) {
		const root = await mkdtemp(join(tmpdir(), "pi-session-refinement-inconsistent-memory-"));
		try {
			const controller = configuredController();
			controller.paths = getSessionPaths(root, "session");
			controller.firstPrompt = true;
			controller.stateExisted = true;
			controller.startReason = "startup";
			controller.injectedMemory = injectedMemory;
			controller.state.lastProcessedEntryId = "checkpoint";
			controller.state.checkpoints = [{ throughEntryId: "checkpoint", createdAt: "2026-01-01T00:00:00Z", trigger: "time" }];
			let examinations = 0;
			controller.runExamination = async () => { examinations++; };
			await controller.beforeAgentStart({
				...ctx,
				sessionManager: { getBranch: () => [
					message("checkpoint", null, "previously checkpointed"),
					message("tail", "checkpoint", "new tail"),
				] },
			} as any, "system");
			assert.equal(examinations, 0);
			assert.equal(controller.broken, true);
			assert.equal(controller.state.warnings[0]?.code, "broken-state");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}
});

test("a checkpoint cursor divergent from memory metadata is treated as broken", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-session-refinement-divergent-cursor-"));
	try {
		const record = { throughEntryId: "checkpoint", createdAt: "2026-01-01T00:00:00Z", trigger: "time" } as const;
		const controller = configuredController();
		controller.paths = getSessionPaths(root, "session");
		controller.firstPrompt = true;
		controller.stateExisted = true;
		controller.startReason = "startup";
		controller.injectedMemory = `${MEMORY_HEADER}${formatCheckpoint("valid checkpoint", record)}`;
		controller.state.lastProcessedEntryId = "uncheckpointed-tail";
		controller.state.checkpoints = [record];
		let examinations = 0;
		controller.runExamination = async () => { examinations++; };
		await controller.beforeAgentStart({
			...ctx,
			sessionManager: { getBranch: () => [
				message("checkpoint", null, "checkpointed"),
				message("uncheckpointed-tail", "checkpoint", "tail"),
			] },
		} as any, "system");
		assert.equal(examinations, 0);
		assert.equal(controller.broken, true);
		assert.equal(controller.state.warnings[0]?.code, "broken-state");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
