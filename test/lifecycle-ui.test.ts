import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { memoryRecordsMatchBranch, RefinementController } from "../src/lifecycle.ts";
import { appendRecordToMemory, atomicWrite, getSessionPaths, LEGACY_MEMORY_HEADER, writeMemoryGeneration } from "../src/memory-file.ts";
import { createCheckpointRecord } from "../src/rolling-memory.ts";
import { loadState, saveState } from "../src/session-store.ts";

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
	controller.state = { version: 2, sessionId: "session", toolCallsSinceRun: 0, records: [], warnings: [] };
	controller.paths = { root: "/tmp/session", memory: "/tmp/session/memory.md", state: "/tmp/session/state.json" };
	controller.loadedConfig = {
		config: { enabled: true, model: "current", thinking: "high", consolidator: { model: "current", thinking: "high" }, memoryBudgetTokens: 32_000, triggers: { contextPercent: 80, elapsedMinutes: 40, minimumToolCalls: 25 }, runOnManualCompaction: true, maxAttempts: 3 },
		issues: [],
	};
	return controller;
}

const ctx = { mode: "tui", hasUI: true, ui: { notify() {}, setWidget() {} } } as any;
const message = (id: string, content = id) => ({ type: "message", id, parentId: null, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content, timestamp: 1 } }) as any;
const toolResult = (id: string) => ({ type: "message", id, parentId: null, timestamp: "2026-01-01T00:00:00Z", message: { role: "toolResult", toolCallId: id, toolName: "probe", content: [], isError: false, timestamp: 1 } }) as any;

test("early compaction errors use a captured fail-open notifier", async () => {
	const controller = configuredController();
	let callbacks: { onError(error: Error): void } | undefined;
	let stale = false;
	const notifications: string[] = [];
	const ui = { notify(message: string) { notifications.push(message); } };
	const compactionCtx = {
		getContextUsage: () => ({ percent: 81 }),
		compact(options: { onError(error: Error): void }) { callbacks = options; },
		get ui() { if (stale) throw new Error("stale context"); return ui; },
	} as any;
	await controller.agentSettled(compactionCtx);
	stale = true;
	assert.doesNotThrow(() => callbacks?.onError(new Error("cancelled")));
	assert.deepEqual(notifications, ["[Session Refinement] Early compaction failed: cancelled"]);
});

test("consolidation warning pauses mutation but never disables early context compaction", async () => {
	const controller = configuredController();
	controller.state.warnings = [{ code: "consolidation-failed", message: "rebuild" }];
	let compacted = 0;
	await controller.agentSettled({
		getContextUsage: () => ({ percent: 80 }),
		compact() { compacted++; },
		ui: { notify() {} },
	} as any);
	assert.equal(compacted, 1);
	controller.toolResult();
	assert.equal(controller.state.toolCallsSinceRun, 0);
});

test("background examination failure does not reuse a stale context", async () => {
	const controller = configuredController();
	controller.state.lastAttemptAt = "2020-01-01T00:00:00.000Z";
	controller.state.lastProcessedEntryId = "a";
	controller.state.toolCallsSinceRun = 1;
	controller.loadedConfig.config.triggers = { contextPercent: 99, elapsedMinutes: 1, minimumToolCalls: 1 };
	const gate = deferred<any>();
	controller.runExamination = () => gate.promise;
	let stale = false;
	const notifications: string[] = [];
	const backgroundCtx = {
		getContextUsage: () => ({ percent: 1 }),
		sessionManager: { getBranch: () => [message("a"), message("b")] },
		get ui() { if (stale) throw new Error("stale"); return { notify(message: string) { notifications.push(message); } }; },
	} as any;
	await controller.agentSettled(backgroundCtx);
	const run = controller.currentRun;
	stale = true;
	gate.reject(new Error("examiner failed"));
	assert.equal((await run).ok, false);
	assert.match(notifications[0], /examiner failed/);
});

test("an old background finalizer cannot clear a newer session operation handle", async () => {
	const controller = configuredController();
	controller.state.lastAttemptAt = "2020-01-01T00:00:00.000Z";
	controller.state.lastProcessedEntryId = "a";
	controller.state.toolCallsSinceRun = 1;
	controller.loadedConfig.config.triggers = { contextPercent: 99, elapsedMinutes: 1, minimumToolCalls: 1 };
	const old = deferred<any>();
	controller.runExamination = () => old.promise;
	await controller.agentSettled({ getContextUsage: () => ({ percent: 1 }), sessionManager: { getBranch: () => [message("a"), message("b")] }, ui: { notify() {} } } as any);
	const oldHandle = controller.currentRun;
	const replacement = Promise.resolve({ ok: true });
	controller.currentRun = replacement;
	old.resolve({ ok: true, attempts: 1, fallbackUsed: false });
	await oldHandle;
	assert.equal(controller.currentRun, replacement);
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

test("pre-compaction refinement preserves retained tool activity", async () => {
	const controller = configuredController();
	controller.state.lastProcessedEntryId = "cursor";
	controller.state.toolCallsSinceRun = 2;
	const entries = [message("cursor"), message("prefix"), message("kept"), toolResult("retained-result")];
	let captured: any;
	controller.runExamination = async (segment: any, _trigger: any, _ctx: any, _activate: any, _signal: any, retainedToolCalls: number) => {
		captured = { through: segment.throughEntryId, retainedToolCalls };
		return { ok: true, attempts: 1, fallbackUsed: false };
	};
	await controller.beforeCompact({ reason: "threshold", preparation: { firstKeptEntryId: "kept" }, branchEntries: entries, signal: new AbortController().signal }, ctx);
	assert.deepEqual(captured, { through: "prefix", retainedToolCalls: 1 });
});

test("valid v1 memory is injected read-only and warns on every turn", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-session-refinement-v1-"));
	const previousRoot = process.env.PI_SESSION_REFINEMENT_ROOT;
	process.env.PI_SESSION_REFINEMENT_ROOT = root;
	try {
		const paths = getSessionPaths(root, "session");
		const meta = JSON.stringify({ throughEntryId: "old", createdAt: "2025-01-01T00:00:00Z", trigger: "time" });
		await atomicWrite(paths.memory, `${LEGACY_MEMORY_HEADER.trimEnd()}\n\n<!-- pi-session-refinement:${meta} -->\n\n---\n\n## Memory checkpoint — 2025-01-01T00:00:00Z\n\nLEGACY_BODY\n`);
		await saveState(paths, { version: 1, sessionId: "session", lastProcessedEntryId: "old", toolCallsSinceRun: 7, checkpoints: [{ throughEntryId: "old", createdAt: "2025-01-01T00:00:00Z", trigger: "time" }], warnings: [{ code: "budget-exceeded", message: "legacy overflow" }] });
		const memoryBefore = await readFile(paths.memory, "utf8");
		const stateBefore = await readFile(paths.state, "utf8");
		const controller: any = new RefinementController({} as any);
		const notifications: string[] = [];
		const context = { mode: "rpc", ui: { notify(value: string) { notifications.push(value); } }, sessionManager: { getSessionFile: () => join(root, "session.jsonl"), getSessionId: () => "session", getBranch: () => [message("old")] } } as any;
		await controller.sessionStart({ reason: "startup" }, context);
		const first = await controller.beforeAgentStart(context, "SYSTEM");
		const second = await controller.beforeAgentStart(context, "SYSTEM");
		assert.match(first, /LEGACY_BODY/);
		assert.match(first, /session-refinement-rebuild/);
		assert.match(second, /session-refinement-rebuild/);
		assert.equal(notifications.filter((value) => /valid v1/.test(value)).length, 2);
		assert.equal(controller.state, undefined);
		assert.equal(await readFile(paths.memory, "utf8"), memoryBefore);
		assert.equal(await readFile(paths.state, "utf8"), stateBefore);
	} finally {
		if (previousRoot === undefined) delete process.env.PI_SESSION_REFINEMENT_ROOT; else process.env.PI_SESSION_REFINEMENT_ROOT = previousRoot;
		await rm(root, { recursive: true, force: true });
	}
});

test("invalid v1 prose or cursor metadata is rebuild-only and never injected", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-session-refinement-invalid-v1-"));
	const previousRoot = process.env.PI_SESSION_REFINEMENT_ROOT;
	process.env.PI_SESSION_REFINEMENT_ROOT = root;
	try {
		const paths = getSessionPaths(root, "session");
		const meta = JSON.stringify({ throughEntryId: "old", createdAt: "2025-01-01T00:00:00Z", trigger: "time" });
		await atomicWrite(paths.memory, `${LEGACY_MEMORY_HEADER.trimEnd()}\nUNTRACKED\n\n<!-- pi-session-refinement:${meta} -->\n\n---\n\n## Memory checkpoint — 2025-01-01T00:00:00Z\n\nDO_NOT_INJECT\n`);
		await saveState(paths, { version: 1, sessionId: "session", lastProcessedEntryId: "wrong-cursor", toolCallsSinceRun: 0, checkpoints: [{ throughEntryId: "old", createdAt: "2025-01-01T00:00:00Z", trigger: "time" }], warnings: [] });
		const controller: any = new RefinementController({} as any);
		const context = { mode: "rpc", ui: { notify() {} }, sessionManager: { getSessionFile: () => join(root, "session.jsonl"), getSessionId: () => "session", getBranch: () => [message("old")] } } as any;
		await controller.sessionStart({ reason: "startup" }, context);
		const prompt = await controller.beforeAgentStart(context, "SYSTEM");
		assert.equal(controller.broken, true);
		assert.doesNotMatch(prompt, /DO_NOT_INJECT/);
		assert.match(prompt, /session-refinement-rebuild/);
	} finally {
		if (previousRoot === undefined) delete process.env.PI_SESSION_REFINEMENT_ROOT; else process.env.PI_SESSION_REFINEMENT_ROOT = previousRoot;
		await rm(root, { recursive: true, force: true });
	}
});

test("historical sessions without memory require manual rebuild without creating state", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-session-refinement-history-"));
	const previousRoot = process.env.PI_SESSION_REFINEMENT_ROOT;
	process.env.PI_SESSION_REFINEMENT_ROOT = root;
	try {
		const controller: any = new RefinementController({} as any);
		const context = { mode: "rpc", ui: { notify() {} }, sessionManager: { getSessionFile: () => join(root, "session.jsonl"), getSessionId: () => "session", getBranch: () => [message("history")] } } as any;
		await controller.sessionStart({ reason: "startup" }, context);
		const prompt = await controller.beforeAgentStart(context, "SYSTEM");
		assert.match(prompt, /session-refinement-rebuild/);
		assert.equal(controller.state, undefined);
		await assert.rejects(() => import("node:fs/promises").then(({ readFile }) => readFile(getSessionPaths(root, "session").state)), /ENOENT/);
	} finally {
		if (previousRoot === undefined) delete process.env.PI_SESSION_REFINEMENT_ROOT; else process.env.PI_SESSION_REFINEMENT_ROOT = previousRoot;
		await rm(root, { recursive: true, force: true });
	}
});

test("fork processing starts after its immutable floor", async () => {
	const controller = configuredController();
	controller.firstPrompt = true;
	controller.stateExisted = true;
	controller.startReason = "fork";
	controller.state.fork = { floorEntryId: "floor", inheritedRecordCount: 0 };
	controller.state.lastProcessedEntryId = "floor";
	let from: string | undefined;
	controller.runExamination = async (segment: any) => { from = segment.fromEntryId; return { ok: true, attempts: 1, fallbackUsed: false }; };
	await controller.beforeAgentStart({ ...ctx, sessionManager: { getBranch: () => [message("ancestor"), message("floor"), message("local")] } } as any, "SYSTEM");
	assert.equal(from, "local");
});

test("missing memory for recorded v2 records is broken", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-session-refinement-broken-"));
	try {
		const controller = configuredController();
		controller.paths = getSessionPaths(root, "session");
		controller.firstPrompt = true;
		controller.stateExisted = true;
		controller.state.lastProcessedEntryId = "checkpoint";
		controller.state.records = [createCheckpointRecord({ throughEntryId: "checkpoint", createdAt: "2026-01-01T00:00:00Z", trigger: "time" })];
		await controller.beforeAgentStart({ ...ctx, sessionManager: { getBranch: () => [message("checkpoint"), message("tail")] } } as any, "system");
		assert.equal(controller.broken, true);
		assert.equal(controller.state.warnings[0].code, "broken-state");
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("fork rebuild reads the authoritative generation rather than a stale injected snapshot", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-session-refinement-fork-baseline-"));
	try {
		const controller = configuredController();
		controller.sessionId = "session";
		controller.paths = getSessionPaths(root, "session");
		const record = createCheckpointRecord({ throughEntryId: "shared", createdAt: "2026-01-01T00:00:00Z", trigger: "time" });
		const memory = appendRecordToMemory("", "AUTHORITATIVE_INHERITED", record);
		controller.state = { version: 2, sessionId: "session", toolCallsSinceRun: 0, records: [record], lastProcessedEntryId: "floor", fork: { floorEntryId: "floor", inheritedRecordCount: 1 }, warnings: [], memoryGeneration: await writeMemoryGeneration(controller.paths, memory) };
		controller.injectedMemory = appendRecordToMemory("", "STALE_INJECTED", record);
		const baseline = await controller.rebuildBaseline();
		assert.match(baseline.memory, /AUTHORITATIVE_INHERITED/);
		assert.doesNotMatch(baseline.memory, /STALE_INJECTED/);
		assert.equal(baseline.floor, "floor");
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("invalid v1 fork rebuild applies the explicit lossy baseline rule but keeps its floor", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-session-refinement-v1-lossy-"));
	try {
		const controller = configuredController();
		controller.sessionId = "child";
		controller.paths = getSessionPaths(root, "child");
		controller.state = undefined;
		controller.legacyState = { version: 1, sessionId: "child", lastProcessedEntryId: "floor", toolCallsSinceRun: 0, checkpoints: [{ throughEntryId: "shared", createdAt: "2025-01-01T00:00:00Z", trigger: "fork" }], warnings: [], fork: { floorEntryId: "floor", inheritedCheckpointCount: 1 } };
		await atomicWrite(controller.paths.memory, "corrupt inherited prose");
		const baseline = await controller.rebuildBaseline();
		assert.equal(baseline.memory, "");
		assert.equal(baseline.floor, "floor");
		assert.deepEqual(baseline.state.fork, { floorEntryId: "floor", inheritedRecordCount: 0 });
		assert.equal(baseline.state.lastProcessedEntryId, "floor");
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("rebuild baseline retains still-applicable missing-model warnings", async () => {
	const controller = configuredController();
	controller.sessionId = "session";
	controller.state.warnings = [
		{ code: "missing-model", message: "examiner missing" },
		{ code: "missing-consolidator-model", message: "consolidator missing" },
		{ code: "consolidation-failed", message: "old failure" },
	];
	const baseline = await controller.rebuildBaseline();
	assert.deepEqual(baseline.state.warnings.map((warning: any) => warning.code), ["missing-model", "missing-consolidator-model"]);
});

test("rebuild segments use the normal staged path and publish only its consolidated result", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-session-refinement-rebuild-stage-"));
	try {
		const controller = configuredController();
		controller.sessionId = "session";
		controller.paths = getSessionPaths(root, "session");
		controller.injectedMemory = "";
		let stagedCalls = 0;
		controller.runExaminationWithTarget = async (segment: any, trigger: string, _ctx: any, paths: any, state: any) => {
			stagedCalls++;
			assert.equal(trigger, "rebuild");
			const checkpoint = createCheckpointRecord({ throughEntryId: segment.throughEntryId, createdAt: "2026-01-02T00:00:00Z", cutoffAt: segment.cutoffAt, trigger: "rebuild" });
			const consolidation = { ...checkpoint, kind: "consolidation", generation: 1, sourceRecordCount: 1 } as const;
			const memory = appendRecordToMemory("", "### Learned information and decisions\n\n- Consolidated rebuild result.", consolidation);
			state.records = [consolidation];
			state.lastProcessedEntryId = segment.throughEntryId;
			state.memoryGeneration = await writeMemoryGeneration(paths, memory);
			return { ok: true, attempts: 1, fallbackUsed: false };
		};
		const notifications: string[] = [];
		const context = {
			mode: "rpc", cwd: root,
			ui: { notify(message: string) { notifications.push(message); }, setWidget() {} },
			sessionManager: { getBranch: () => [message("entry", "history")] },
		} as any;
		assert.equal(await controller.performRebuild(context, new AbortController().signal), true);
		assert.equal(stagedCalls, 1);
		assert.match(controller.injectedMemory, /Consolidated rebuild result/);
		assert.equal(controller.state.records[0].kind, "consolidation");
		assert.match(notifications.at(-1) ?? "", /rebuilt from 1 chronological segment/);
	} finally { await rm(root, { recursive: true, force: true }); }
});


test("rebuild staging consolidates an oversized inherited baseline even with no fork-local tail", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-session-refinement-rebuild-baseline-roll-"));
	try {
		const controller = configuredController();
		controller.sessionId = "session";
		controller.paths = getSessionPaths(root, "session");
		controller.loadedConfig.config.memoryBudgetTokens = 100;
		const exact = createCheckpointRecord({ fromEntryId: "floor", throughEntryId: "floor", createdAt: "2026-01-01T00:00:00Z", trigger: "fork" });
		const baselineMemory = appendRecordToMemory("", "x".repeat(500), exact);
		const baselineState = { version: 2, sessionId: "session", toolCallsSinceRun: 0, records: [exact], warnings: [], lastProcessedEntryId: "floor", fork: { floorEntryId: "floor", inheritedRecordCount: 1 } };
		controller.rebuildBaseline = async () => ({ memory: baselineMemory, state: structuredClone(baselineState), floor: "floor" });
		let consolidated = 0;
		controller.consolidateCandidate = async () => {
			consolidated++;
			const record = { ...exact, kind: "consolidation", generation: 1, sourceRecordCount: 1, trigger: "consolidation" } as const;
			return { memory: appendRecordToMemory("", "### Learned information and decisions\n\n- compact baseline", record), range: { start: 0, count: 1 } };
		};
		const context = {
			mode: "rpc", cwd: root, model: { provider: "synthetic", id: "model" }, modelRegistry: {}, getContextUsage: () => undefined,
			ui: { notify() {}, setWidget() {} },
			sessionManager: { getBranch: () => [message("floor")] },
		} as any;
		assert.equal(await controller.performRebuild(context, new AbortController().signal), true);
		assert.equal(consolidated, 1);
		assert.equal(controller.state.records[0].kind, "consolidation");
		assert.equal(controller.state.fork.inheritedRecordCount, 1);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("ordinary shutdown aborts background work", async () => {
	const controller: any = new RefinementController({} as any);
	controller.currentRun = new Promise((resolve) => controller.abortController.signal.addEventListener("abort", () => resolve({ ok: false, cancelled: true }), { once: true }));
	await controller.shutdown();
	assert.equal(controller.abortController.signal.aborted, true);
});

test("v2 memory source cursors must form an ordered prefix of the active branch", () => {
	const records = [
		createCheckpointRecord({ fromEntryId: "a", throughEntryId: "b", createdAt: "2026-01-01T00:00:00Z", trigger: "time" }),
		createCheckpointRecord({ fromEntryId: "c", throughEntryId: "c", createdAt: "2026-01-02T00:00:00Z", trigger: "time" }),
	];
	const branch = [message("a"), message("b"), message("c")];
	assert.equal(memoryRecordsMatchBranch({ version: 2, sessionId: "session", toolCallsSinceRun: 0, records, warnings: [], lastProcessedEntryId: "c" }, branch), true);
	assert.equal(memoryRecordsMatchBranch({ version: 2, sessionId: "session", toolCallsSinceRun: 0, records: [{ ...records[0], throughEntryId: "missing" }], warnings: [], lastProcessedEntryId: "missing" }, branch), false);
	assert.equal(memoryRecordsMatchBranch({ version: 2, sessionId: "session", toolCallsSinceRun: 0, records, warnings: [], lastProcessedEntryId: "c", fork: { floorEntryId: "b", inheritedRecordCount: 2 } }, branch), false);
});

test("exhausted consolidation persists a rebuild-required pause while Pi stays usable", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-session-refinement-consolidation-failure-"));
	try {
		const controller = configuredController();
		controller.paths = getSessionPaths(root, "session");
		const notices: string[] = [];
		await controller.pauseForConsolidationFailure(controller.state, controller.paths, "synthetic failure", { ui: { notify(message: string) { notices.push(message); } } } as any);
		assert.equal(controller.automaticPaused(), true);
		assert.equal(controller.state.warnings[0]?.code, "consolidation-failed");
		assert.match(controller.state.warnings[0]?.rootInstruction ?? "", /session-refinement-rebuild/);
		assert.match(notices.join("\n"), /Automatic refinement paused/);
		const stored = JSON.parse(await readFile(controller.paths.state, "utf8"));
		assert.equal(stored.warnings[0].code, "consolidation-failed");
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("an impossible legal consolidation range pauses automatic mutation without calling a model", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-session-refinement-impossible-roll-"));
	try {
		const controller = configuredController();
		controller.sessionId = "session";
		controller.paths = getSessionPaths(root, "session");
		controller.loadedConfig.config.memoryBudgetTokens = 500;
		const first = createCheckpointRecord({ fromEntryId: "a", throughEntryId: "b", createdAt: "2026-01-01T00:00:00Z", trigger: "time" });
		const second = createCheckpointRecord({ fromEntryId: "c", throughEntryId: "d", createdAt: "2026-01-02T00:00:00Z", trigger: "time" });
		let memory = appendRecordToMemory("", "a".repeat(1_000), first);
		memory = appendRecordToMemory(memory, "b".repeat(1_000), second);
		controller.state = {
			version: 2, sessionId: "session", lastProcessedEntryId: "d", toolCallsSinceRun: 0,
			records: [first, second], warnings: [], fork: { floorEntryId: "b", inheritedRecordCount: 1 },
			memoryGeneration: await writeMemoryGeneration(controller.paths, memory),
		};
		await saveState(controller.paths, controller.state);
		const notices: string[] = [];
		const outcome = await controller.consolidateCandidate({
			memory, trigger: "time", paths: controller.paths, state: controller.state,
			model: { provider: "synthetic", id: "must-not-run" },
			activity: { update() {}, clear() {} }, base: "test", signal: new AbortController().signal,
			ctx: { cwd: root, ui: { notify(message: string) { notices.push(message); } } },
		});
		assert.equal(outcome.failure?.ok, false);
		assert.equal(outcome.memory, memory);
		assert.match(outcome.failure?.error ?? "", /No legal consolidation range/);
		assert.equal(controller.automaticPaused(), true);
		assert.equal(JSON.parse(await readFile(controller.paths.state, "utf8")).warnings[0].code, "consolidation-failed");
		assert.match(notices.join("\n"), /Automatic refinement paused/);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("startup without state removes crash-orphaned generations before creating a baseline", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-session-refinement-orphan-startup-"));
	try {
		const controller = configuredController();
		controller.storageRoot = root;
		const paths = getSessionPaths(root, "fresh-session");
		const record = createCheckpointRecord({ throughEntryId: "orphan", createdAt: "2026-01-01T00:00:00Z", trigger: "time" });
		await writeMemoryGeneration(paths, appendRecordToMemory("", "orphan", record));
		const context = {
			mode: "rpc", cwd: root, ui: { notify() {}, setWidget() {} },
			sessionManager: { getSessionFile: () => join(root, "fresh.jsonl"), getSessionId: () => "fresh-session", getBranch: () => [] },
		} as any;
		await controller.sessionStart({ reason: "new" }, context);
		const generationFiles = await import("node:fs/promises").then(({ readdir }) => readdir(paths.generations).catch(() => []));
		assert.deepEqual(generationFiles, []);
		assert.equal((await loadState(paths, "fresh-session")).existed, false);
		await controller.beforeAgentStart(context, "SYSTEM");
		assert.equal((await loadState(paths, "fresh-session")).existed, true);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("a corrected model configuration clears stale missing-model warnings before prompt injection", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-session-refinement-model-warning-"));
	try {
		const controller = configuredController();
		controller.paths = getSessionPaths(root, "session");
		controller.state.warnings = [
			{ code: "missing-model", message: "Configured examiner model \"old/missing\" is unavailable." },
			{ code: "missing-consolidator-model", message: "Configured consolidator model \"old/missing\" is unavailable." },
		];
		await saveState(controller.paths, controller.state);
		const notices: string[] = [];
		await controller.beforeAgentStart({
			model: { provider: "synthetic", id: "current" }, modelRegistry: { getAvailable: () => [] },
			ui: { notify(message: string) { notices.push(message); } }, sessionManager: { getBranch: () => [] },
		} as any, "SYSTEM");
		assert.deepEqual(controller.state.warnings, []);
		assert.deepEqual(JSON.parse(await readFile(controller.paths.state, "utf8")).warnings, []);
		assert.deepEqual(notices, []);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("model-warning reconciliation fails open when the registry is unavailable", async () => {
	const controller = configuredController();
	controller.loadedConfig.config.model = "configured/model";
	controller.state.warnings = [{ code: "missing-model", message: "Configured examiner model \"configured/model\" is unavailable." }];
	const notices: string[] = [];
	const system = await controller.beforeAgentStart({
		model: { provider: "synthetic", id: "current" }, modelRegistry: { getAvailable() { throw new Error("registry offline"); } },
		ui: { notify(message: string) { notices.push(message); } }, sessionManager: { getBranch: () => [] },
	} as any, "SYSTEM");
	assert.match(system, /SYSTEM/);
	assert.equal(controller.state.warnings[0].code, "missing-model");
	assert.match(notices.join("\n"), /configured\/model/);
});

test("a delegated agent marker disables refinement before a deferred ordinary baseline is published", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-session-refinement-delegated-child-"));
	try {
		const controller = configuredController();
		controller.storageRoot = root;
		let branch: any[] = [];
		const context = {
			mode: "print", cwd: root, ui: { notify() {}, setWidget() {} },
			sessionManager: { getSessionFile: () => join(root, "child.jsonl"), getSessionId: () => "child-session", getBranch: () => branch },
		} as any;
		await controller.sessionStart({ reason: "new" }, context);
		const paths = getSessionPaths(root, "child-session");
		await assert.rejects(access(paths.state), /ENOENT/);
		branch = [{ type: "custom", id: "marker", parentId: null, timestamp: "2026-01-01T00:00:00Z", customType: "pi-repl-agents-child", data: {} }];
		assert.equal(await controller.beforeAgentStart(context, "SYSTEM"), "SYSTEM");
		await assert.rejects(access(paths.root), /ENOENT/);
		assert.equal(controller.active, false);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("an already-marked delegated session never loads or mutates refinement storage", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-session-refinement-existing-child-"));
	try {
		const controller = configuredController();
		controller.storageRoot = root;
		const context = {
			mode: "print", cwd: root, ui: { notify() {}, setWidget() {} },
			sessionManager: {
				getSessionFile: () => join(root, "child.jsonl"), getSessionId: () => "child-session",
				getBranch: () => [{ type: "custom", id: "marker", parentId: null, timestamp: "2026-01-01T00:00:00Z", customType: "pi-repl-agents-child", data: {} }],
			},
		} as any;
		await controller.sessionStart({ reason: "resume" }, context);
		assert.equal(controller.active, false);
		assert.equal(await (await import("node:fs/promises")).stat(getSessionPaths(root, "child-session").root).then(() => true, () => false), false);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("shutdown removes only a newly created ordinary baseline that never reached a prompt", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-session-refinement-idle-cleanup-"));
	try {
		const controller = configuredController(); controller.storageRoot = root;
		const context = { mode: "rpc", cwd: root, ui: { notify() {}, setWidget() {} }, sessionManager: { getSessionFile: () => join(root, "idle.jsonl"), getSessionId: () => "idle-session", getBranch: () => [] } } as any;
		await controller.sessionStart({ reason: "new" }, context);
		const paths = getSessionPaths(root, "idle-session"); await assert.rejects(access(paths.state), /ENOENT/);
		await controller.shutdown();
		await assert.rejects(access(paths.root), /ENOENT/);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("shutdown preserves a fresh fork baseline even before its first prompt", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-session-refinement-idle-fork-"));
	try {
		const parentFile = join(root, "parent.jsonl");
		await import("../src/memory-file.ts").then(({ atomicWrite }) => atomicWrite(parentFile, JSON.stringify({ type: "session", id: "parent" }) + "\n"));
		const controller = configuredController(); controller.storageRoot = root;
		const branch = [{ type: "custom", id: "floor", parentId: null, timestamp: "2026-01-01T00:00:00Z", customType: "fixture", data: {} }];
		const context = { mode: "rpc", cwd: root, ui: { notify() {}, setWidget() {} }, sessionManager: { getSessionFile: () => join(root, "fork.jsonl"), getSessionId: () => "fork-session", getBranch: () => branch } } as any;
		await controller.sessionStart({ reason: "fork", previousSessionFile: parentFile }, context);
		const paths = getSessionPaths(root, "fork-session"); await access(paths.state);
		await controller.shutdown();
		await access(paths.state);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("a resumed empty v2 state without a baseline cursor examines from branch start", async () => {
	const controller = configuredController();
	controller.stateExisted = true;
	controller.state.lastProcessedEntryId = undefined;
	controller.injectedMemory = "";
	let segment: any;
	controller.runExamination = async (value: any, _trigger: string) => { segment = value; return { ok: true, attempts: 1, fallbackUsed: false }; };
	const branch = [message("first", "first user turn"), message("second", "first assistant turn")];
	await controller.handleFirstPrompt({ sessionManager: { getBranch: () => branch } } as any);
	assert.equal(segment.fromEntryId, "first");
	assert.equal(segment.throughEntryId, "second");
});

test("a late delegated marker removes fork bootstrap state created during child binding", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-session-refinement-delegated-fork-race-"));
	try {
		const parentFile = join(root, "parent.jsonl");
		const childFile = join(root, "child.jsonl");
		const { atomicWrite } = await import("../src/memory-file.ts");
		await atomicWrite(parentFile, JSON.stringify({ type: "session", id: "parent" }) + "\n");
		await atomicWrite(childFile, JSON.stringify({ type: "session", id: "child-session", parentSession: parentFile }) + "\n");
		const controller = configuredController(); controller.storageRoot = root;
		let branch: any[] = [{ type: "custom", id: "floor", parentId: null, timestamp: "2026-01-01T00:00:00Z", customType: "fixture", data: {} }];
		const context = { mode: "print", cwd: root, ui: { notify() {}, setWidget() {} }, sessionManager: { getSessionFile: () => childFile, getSessionId: () => "child-session", getBranch: () => branch } } as any;
		await controller.sessionStart({ reason: "startup" }, context);
		const paths = getSessionPaths(root, "child-session"); await access(paths.state);
		branch = [...branch, { type: "custom", id: "marker", parentId: "floor", timestamp: "2026-01-01T00:00:01Z", customType: "pi-repl-agents-child", data: {} }];
		assert.equal(await controller.beforeAgentStart(context, "SYSTEM"), "SYSTEM");
		await assert.rejects(access(paths.root), /ENOENT/);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("shutdown catches an unprompted delegated child after its marker arrives", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-session-refinement-delegated-shutdown-"));
	try {
		const parentFile = join(root, "parent.jsonl"), childFile = join(root, "child.jsonl");
		const { atomicWrite } = await import("../src/memory-file.ts");
		await atomicWrite(parentFile, JSON.stringify({ type: "session", id: "parent" }) + "\n");
		await atomicWrite(childFile, JSON.stringify({ type: "session", id: "child-session", parentSession: parentFile }) + "\n");
		const controller = configuredController(); controller.storageRoot = root;
		let branch: any[] = [{ type: "custom", id: "floor", parentId: null, timestamp: "2026-01-01T00:00:00Z", customType: "fixture", data: {} }];
		const context = { mode: "print", cwd: root, ui: { notify() {}, setWidget() {} }, sessionManager: { getSessionFile: () => childFile, getSessionId: () => "child-session", getBranch: () => branch } } as any;
		await controller.sessionStart({ reason: "startup" }, context);
		const paths = getSessionPaths(root, "child-session"); await access(paths.state);
		branch = [...branch, { type: "custom", id: "marker", parentId: "floor", timestamp: "2026-01-01T00:00:01Z", customType: "pi-repl-agents-child", data: {} }];
		await controller.shutdown(context);
		await assert.rejects(access(paths.root), /ENOENT/);
	} finally { await rm(root, { recursive: true, force: true }); }
});
