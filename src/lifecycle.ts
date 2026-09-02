import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { ContextEvent, ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { activityBaseMessage, attemptMessage, RefinementActivity, shortModelName, type ActivityHandle } from "./activity.js";
import { linkAbortSignals, waitForPromiseOrAbort } from "./abort.js";
import { commitCandidatePublication } from "./checkpoint-commit.js";
import { loadConfig, type LoadedConfig } from "./config.js";
import { resolveConfiguredModel, runConsolidator, runExaminer, type ExaminerCallbacks } from "./examiner.js";
import {
	cleanupMemoryGenerations,
	formatMemoryRecord,
	getSessionPaths,
	materializeMemoryFromRecords,
	readAuthoritativeMemory,
	readMemory,
	renderMemoryForPrompt,
	sha256,
	validateLegacyMemory,
	validateMemoryDocument,
	validateRecordBody,
	writeMemoryGeneration,
} from "./memory-file.js";
import { buildMemoryOverlay } from "./memory-overlay.js";
import { commitRebuiltMemory } from "./rebuild-commit.js";
import { buildReconstructionSegments } from "./reconstruct.js";
import {
	createCheckpointRecord,
	needsConsolidation,
	replaceMemoryPrefix,
	selectConsolidationPrefix,
	stageCheckpoint,
} from "./rolling-memory.js";
import { buildTranscriptSegment, countToolResults, initialSessionBaseline } from "./session-history.js";
import { clearWarning, createInitialState, inheritForkMemory, loadState, readParentSessionFromFile, saveState, setWarning } from "./session-store.js";
import type {
	ConsolidationRequest,
	ExaminationRequest,
	ExaminationResult,
	PersistentWarning,
	SessionPaths,
	SessionRefinementState,
	SessionRefinementStateV1,
	TranscriptSegment,
	TriggerReason,
} from "./types.js";
import { recordOperationUsage } from "./usage.js";
import { appendWarningInstructions, notifyPersistentWarnings } from "./warnings.js";

function localTime(date: Date): string {
	return new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "long" }).format(date);
}

function sameRecord(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

export function memoryStateMatches(memory: string, state: SessionRefinementState): boolean {
	let actual;
	try { actual = validateMemoryDocument(memory); } catch { return false; }
	if (actual.length !== state.records.length) return false;
	if (!actual.every((entry, index) => sameRecord(entry.record, state.records[index]) && Boolean(renderMemoryForPrompt(entry.block)))) return false;
	if (state.fork && state.records.length === state.fork.inheritedRecordCount) {
		return state.lastProcessedEntryId === state.fork.floorEntryId;
	}
	if (state.records.length > 0) return state.lastProcessedEntryId === state.records.at(-1)?.throughEntryId;
	return true;
}


export function memoryRecordsMatchBranch(state: SessionRefinementState, branch: SessionEntry[]): boolean {
	const positions = new Map(branch.map((entry, index) => [entry.id, index]));
	const floor = state.fork ? positions.get(state.fork.floorEntryId) : undefined;
	if (state.fork && floor === undefined) return false;
	let previous = -1;
	for (let index = 0; index < state.records.length; index++) {
		const record = state.records[index];
		const through = positions.get(record.throughEntryId);
		if (through === undefined || through <= previous) return false;
		if (record.fromEntryId !== undefined) {
			const from = positions.get(record.fromEntryId);
			if (from === undefined || from <= previous || from > through) return false;
		}
		if (floor !== undefined) {
			if (index < state.fork!.inheritedRecordCount && through > floor) return false;
			if (index >= state.fork!.inheritedRecordCount && through <= floor) return false;
		}
		previous = through;
	}
	return state.lastProcessedEntryId === undefined || positions.has(state.lastProcessedEntryId);
}

function isDelegatedAgentSession(branch: SessionEntry[]): boolean {
	return branch.some((entry) => entry.type === "custom" && entry.customType === "pi-repl-agents-child");
}

function contextBranch(ctx: ExtensionContext): SessionEntry[] {
	try { return ctx.sessionManager?.getBranch?.() ?? []; } catch { return []; }
}

function applyPublishedRecords(state: SessionRefinementState, memory: string, range?: { start: number; count: number }): void {
	state.records = validateMemoryDocument(memory).map((entry) => entry.record);
	if (state.fork && state.fork.inheritedRecordCount > 0 && range?.start === 0) {
		if (range.count > state.fork.inheritedRecordCount) throw new Error("Consolidation crossed the immutable fork boundary.");
		state.fork.inheritedRecordCount = state.fork.inheritedRecordCount - range.count + 1;
	}
}

function captureNotifier(ctx: ExtensionContext): ExtensionContext["ui"]["notify"] {
	try {
		const ui = ctx.ui;
		return (message, type) => { try { ui.notify(message, type); } catch { /* disposed UI */ } };
	} catch {
		return () => {};
	}
}

function rootModel(ctx: ExtensionContext): Model<any> | undefined {
	return ctx.model as Model<any> | undefined;
}

const REBUILD_INSTRUCTION = "Inform the user that automatic session refinement is paused and ask them to run /session-refinement-rebuild. Continue helping with their current work; this warning does not disable Pi or context compaction.";

interface ConsolidationCandidateOptions {
	memory: string;
	trigger: TriggerReason;
	ctx: ExtensionContext;
	paths: SessionPaths;
	state: SessionRefinementState;
	model: Model<any>;
	activity: ActivityHandle;
	base: string;
	signal: AbortSignal;
}

interface ConsolidationCandidateOutcome {
	memory: string;
	range?: { start: number; count: number };
	failure?: ExaminationResult;
}

export class RefinementController {
	private readonly agentDir = process.env.PI_SESSION_REFINEMENT_AGENT_DIR?.trim() || getAgentDir();
	private readonly storageRoot = process.env.PI_SESSION_REFINEMENT_ROOT?.trim() || this.agentDir;
	private active = false;
	private broken = false;
	private readOnlyWarning?: PersistentWarning;
	private sessionId?: string;
	private paths?: SessionPaths;
	private state?: SessionRefinementState;
	private legacyState?: SessionRefinementStateV1;
	private loadedConfig?: LoadedConfig;
	private injectedMemory = "";
	private promptMemorySnapshot = "";
	private currentRun?: Promise<ExaminationResult>;
	private foregroundRun?: Promise<boolean>;
	private foregroundAbort?: AbortController;
	private readonly activity = new RefinementActivity();
	private abortController = new AbortController();
	private firstPrompt = true;
	private startReason = "startup";
	private stateExisted = false;
	private forkStatePublishedThisStart = false;
	private deferredBaselineThisStart = false;
	private contextCompactionRequested = false;
	private operationGeneration = 0;
	private deferredCheckpointUpdates: string[] = [];
	private continuationCheckpointUpdates: string[] = [];

	constructor(private readonly pi: ExtensionAPI) {}

	async sessionStart(event: { reason: string; previousSessionFile?: string }, ctx: ExtensionContext): Promise<void> {
		const ownership = ++this.operationGeneration;
		const previousBackground = this.currentRun;
		const previousForeground = this.foregroundRun;
		this.activity.clearAll();
		this.foregroundAbort?.abort();
		this.abortController.abort();
		await Promise.allSettled([previousBackground, previousForeground].filter(Boolean) as Promise<unknown>[]);
		if (ownership !== this.operationGeneration) return;

		this.abortController = new AbortController();
		this.active = false;
		this.broken = false;
		this.readOnlyWarning = undefined;
		this.sessionId = undefined;
		this.paths = undefined;
		this.state = undefined;
		this.legacyState = undefined;
		this.loadedConfig = undefined;
		this.injectedMemory = "";
		this.promptMemorySnapshot = "";
		this.currentRun = undefined;
		this.foregroundRun = undefined;
		this.foregroundAbort = undefined;
		this.firstPrompt = true;
		this.stateExisted = false;
		this.forkStatePublishedThisStart = false;
		this.deferredBaselineThisStart = false;
		this.contextCompactionRequested = false;
		this.deferredCheckpointUpdates = [];
		this.continuationCheckpointUpdates = [];
		this.startReason = event.reason;
		const sessionFile = ctx.sessionManager.getSessionFile();
		this.sessionId = ctx.sessionManager.getSessionId();
		this.active = Boolean(sessionFile && this.sessionId);
		if (!this.active || !this.sessionId) return;
		if (isDelegatedAgentSession(contextBranch(ctx))) { this.active = false; return; }
		this.loadedConfig = await loadConfig(this.storageRoot);
		if (ownership !== this.operationGeneration) return;
		if (!this.loadedConfig.config.enabled) { this.active = false; return; }
		this.paths = getSessionPaths(this.storageRoot, this.sessionId);
		try {
			const loaded = await loadState(this.paths, this.sessionId);
			const startupParent = !loaded.existed && event.reason === "startup" && sessionFile
				? await readParentSessionFromFile(sessionFile)
				: undefined;
			const forkParent = event.reason === "fork" ? event.previousSessionFile : startupParent;
			if (forkParent) {
				const inherited = await inheritForkMemory({
					agentDir: this.storageRoot,
					newSessionId: this.sessionId,
					previousSessionFile: forkParent,
					branchEntries: ctx.sessionManager.getBranch(),
				});
				if (ownership !== this.operationGeneration) return;
				this.forkStatePublishedThisStart = true;
				this.startReason = "fork";
				this.injectedMemory = inherited.memory;
				this.stateExisted = true;
				if (inherited.mode === "legacy") this.setLegacyReadOnly(inherited.state);
				else this.state = inherited.state;
				return;
			}
			if (loaded.existed && loaded.state.version === 1) {
				this.legacyState = loaded.state;
				const legacyMemory = await readMemory(this.paths.memory);
				validateLegacyMemory(legacyMemory, loaded.state);
				this.injectedMemory = legacyMemory;
				this.stateExisted = true;
				this.setLegacyReadOnly(loaded.state);
				return;
			}
			if (!loaded.existed) {
				await cleanupMemoryGenerations(this.paths).catch(() => undefined);
				const branch = ctx.sessionManager.getBranch();
				const historical = branch.some((entry) => entry.type === "message") && event.reason !== "new";
				const legacyMemory = await readMemory(this.paths.memory);
				if (historical || legacyMemory) {
					this.readOnlyWarning = {
						code: "rebuild-required",
						message: "This historical session has no v2 refinement memory. Run /session-refinement-rebuild to create it.",
						rootInstruction: REBUILD_INSTRUCTION,
					};
					return;
				}
				this.state = loaded.state as SessionRefinementState;
				this.state.lastAttemptAt = new Date().toISOString();
				this.deferredBaselineThisStart = true;
				const baseline = initialSessionBaseline(branch);
				if (baseline) this.state.lastProcessedEntryId = baseline;
				return;
			}
			this.state = loaded.state as SessionRefinementState;
			this.injectedMemory = await readAuthoritativeMemory(this.paths, this.state);
			if (!memoryStateMatches(this.injectedMemory, this.state)) throw new Error("V2 state does not exactly match its authoritative memory generation.");
			if (!memoryRecordsMatchBranch(this.state, ctx.sessionManager.getBranch())) throw new Error("V2 memory source cursors do not match the current session branch.");
			await cleanupMemoryGenerations(this.paths, this.state.memoryGeneration).catch(() => undefined);
			this.stateExisted = true;
		} catch (error) {
			this.broken = true;
			this.state = undefined;
			this.injectedMemory = "";
			this.readOnlyWarning = {
				code: "broken-state",
				message: error instanceof Error ? error.message : String(error),
				rootInstruction: REBUILD_INSTRUCTION,
			};
		}
	}

	private async reconcileConfiguredModelWarnings(ctx: ExtensionContext): Promise<void> {
		if (!this.state || !this.paths || !this.loadedConfig) return;
		const current = rootModel(ctx);
		const pairs: Array<{ code: "missing-model" | "missing-consolidator-model"; reference: string }> = [
			{ code: "missing-model", reference: this.loadedConfig.config.model },
			{ code: "missing-consolidator-model", reference: this.loadedConfig.config.consolidator.model },
		];
		let changed = false;
		for (const pair of pairs) {
			const warning = this.state.warnings.find((entry) => entry.code === pair.code);
			if (!warning) continue;
			let available = false;
			try {
				available = Boolean(current && (pair.reference === "current"
					|| pair.reference === `${current.provider}/${current.id}`
					|| resolveConfiguredModel(pair.reference, ctx.modelRegistry)));
			} catch { continue; }
			if (available) {
				clearWarning(this.state, pair.code);
				changed = true;
			} else if (!warning.message.includes(`"${pair.reference}"`)) {
				setWarning(this.state, {
					code: pair.code,
					message: `Configured ${pair.code === "missing-model" ? "examiner" : "consolidator"} model "${pair.reference}" is unavailable; using the interactive session model as fallback.`,
				});
				changed = true;
			}
		}
		if (changed) {
			try { await saveState(this.paths, this.state); }
			catch { try { ctx.ui.notify("[Session Refinement] Corrected model warning could not be persisted; refinement remains usable.", "warning"); } catch { /* disposed UI */ } }
		}
	}

	private setLegacyReadOnly(state: SessionRefinementStateV1): void {
		this.state = undefined;
		this.legacyState = state;
		this.readOnlyWarning = {
			code: "rebuild-required",
			message: "This session has valid v1 refinement memory. It remains injected read-only; run /session-refinement-rebuild to create v2 memory.",
			rootInstruction: REBUILD_INSTRUCTION,
		};
	}

	private warnings(): PersistentWarning[] {
		return this.readOnlyWarning ? [this.readOnlyWarning] : this.state?.warnings ?? [];
	}

	private automaticPaused(): boolean {
		return this.broken || Boolean(this.readOnlyWarning) || Boolean(this.state?.warnings.some((warning) =>
			warning.code === "broken-state" || warning.code === "rebuild-required" || warning.code === "consolidation-failed"));
	}

	toolResult(): void {
		if (this.active && !this.automaticPaused() && this.state) this.state.toolCallsSinceRun++;
	}

	async beforeAgentStart(ctx: ExtensionContext, systemPrompt: string): Promise<string> {
		if (!this.active || !this.paths || !this.loadedConfig) return systemPrompt;
		if (isDelegatedAgentSession(contextBranch(ctx))) {
			this.active = false;
			this.activity.clearAll();
			this.abortController.abort();
			if (this.forkStatePublishedThisStart) await rm(this.paths.root, { recursive: true, force: true }).catch(() => undefined);
			this.state = undefined;
			this.legacyState = undefined;
			this.injectedMemory = "";
			return systemPrompt;
		}
		if (this.foregroundRun) await this.foregroundRun;
		if (this.firstPrompt) {
			this.firstPrompt = false;
			await this.handleFirstPrompt(ctx);
		}
		if (this.deferredBaselineThisStart && this.state && this.paths) {
			await saveState(this.paths, this.state);
			this.deferredBaselineThisStart = false;
		}
		await this.reconcileConfiguredModelWarnings(ctx);
		const warnings = this.warnings();
		notifyPersistentWarnings(ctx, warnings, this.loadedConfig.issues);
		let result = systemPrompt;
		const memory = renderMemoryForPrompt(this.injectedMemory);
		if (memory) result += `\n\n<session_memory>\n${memory}\n</session_memory>`;
		this.promptMemorySnapshot = memory;
		this.continuationCheckpointUpdates = [];
		return appendWarningInstructions(result, warnings);
	}

	contextMessages(messages: ContextEvent["messages"]): { messages: ContextEvent["messages"] } | undefined {
		if (!this.active) return undefined;
		let active = renderMemoryForPrompt(this.injectedMemory);
		if (this.continuationCheckpointUpdates.length > 0) {
			const additions = this.continuationCheckpointUpdates.join("\n\n");
			active = this.promptMemorySnapshot ? `${this.promptMemorySnapshot.trimEnd()}\n\n${additions}` : additions;
		}
		const overlay = buildMemoryOverlay(this.promptMemorySnapshot, active);
		return overlay ? { messages: [...messages, overlay.message] } : undefined;
	}

	private async handleFirstPrompt(ctx: ExtensionContext): Promise<void> {
		if (this.automaticPaused() || !this.state || !this.paths) return;
		if (!memoryStateMatches(this.injectedMemory, this.state)) {
			await this.markBroken(new Error("Record metadata in state.json does not match the active memory generation."));
			return;
		}
		if (!memoryRecordsMatchBranch(this.state, ctx.sessionManager.getBranch())) {
			await this.markBroken(new Error("Memory source cursors do not match the active session branch."));
			return;
		}
		if (!this.state.lastProcessedEntryId && !this.stateExisted) return;
		try {
			const segment = buildTranscriptSegment({ branchEntries: ctx.sessionManager.getBranch(), lastProcessedEntryId: this.state.lastProcessedEntryId });
			if (segment) await this.runExamination(segment, this.startReason === "fork" ? "fork" : "resume", ctx, true);
		} catch (error) {
			await this.markBroken(error);
		}
	}

	async agentSettled(ctx: ExtensionContext): Promise<void> {
		if (!this.active || !this.paths || !this.loadedConfig || this.currentRun || this.foregroundRun) return;
		if (this.state && !this.broken) await saveState(this.paths, this.state);
		const usage = ctx.getContextUsage();
		if (!this.contextCompactionRequested && usage?.percent !== null && usage?.percent !== undefined
			&& usage.percent >= this.loadedConfig.config.triggers.contextPercent) {
			this.contextCompactionRequested = true;
			const notify = captureNotifier(ctx);
			ctx.compact({
				onComplete: () => { this.contextCompactionRequested = false; },
				onError: (error) => {
					this.contextCompactionRequested = false;
					notify(`[Session Refinement] Early compaction failed: ${error.message}`, "warning");
				},
			});
			return;
		}
		if (this.automaticPaused() || !this.state) return;
		const lastAttempt = Date.parse(this.state.lastAttemptAt ?? "") || Date.now();
		const elapsed = Date.now() - lastAttempt;
		if (elapsed < this.loadedConfig.config.triggers.elapsedMinutes * 60_000
			|| this.state.toolCallsSinceRun < this.loadedConfig.config.triggers.minimumToolCalls) return;
		let segment: TranscriptSegment | undefined;
		try {
			segment = buildTranscriptSegment({ branchEntries: ctx.sessionManager.getBranch(), lastProcessedEntryId: this.state.lastProcessedEntryId });
		} catch (error) {
			await this.markBroken(error);
			return;
		}
		if (!segment) {
			this.state.lastAttemptAt = new Date().toISOString();
			this.state.toolCallsSinceRun = 0;
			await saveState(this.paths, this.state);
			return;
		}
		const notify = captureNotifier(ctx);
		const operation = this.runExamination(segment, "time", ctx, false)
			.catch((error): ExaminationResult => {
				notify(`[Session Refinement] Background examination failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
				return { ok: false, attempts: 0, fallbackUsed: false, error: error instanceof Error ? error.message : String(error) };
			})
			.finally(() => { if (this.currentRun === operation) this.currentRun = undefined; });
		this.currentRun = operation;
		void operation;
	}

	async beforeCompact(event: {
		reason: "manual" | "threshold" | "overflow";
		preparation: { firstKeptEntryId: string };
		branchEntries: SessionEntry[];
		signal: AbortSignal;
	}, ctx: ExtensionContext): Promise<void> {
		if (!this.active || this.automaticPaused() || !this.state || !this.loadedConfig) return;
		const contextTriggered = this.contextCompactionRequested;
		if (event.reason === "manual" && !contextTriggered && !this.loadedConfig.config.runOnManualCompaction) return;
		if (this.foregroundRun && !await waitForPromiseOrAbort(this.foregroundRun, event.signal)) return;
		if (event.signal.aborted) return;
		if (this.currentRun && !await waitForPromiseOrAbort(this.currentRun, event.signal)) return;
		if (event.signal.aborted) return;
		let segment: TranscriptSegment | undefined;
		try {
			segment = buildTranscriptSegment({
				branchEntries: event.branchEntries,
				lastProcessedEntryId: this.state.lastProcessedEntryId,
				throughBeforeEntryId: event.preparation.firstKeptEntryId,
			});
		} catch (error) {
			await this.markBroken(error);
			return;
		}
		if (!segment) return;
		const trigger: TriggerReason = contextTriggered ? "context" : event.reason === "manual" ? "manual-compaction" : "auto-compaction";
		const firstKeptIndex = event.branchEntries.findIndex((entry) => entry.id === event.preparation.firstKeptEntryId);
		const retainedToolCalls = firstKeptIndex >= 0 ? countToolResults(event.branchEntries.slice(firstKeptIndex)) : 0;
		await this.runExamination(segment, trigger, ctx, false, event.signal, retainedToolCalls);
	}

	async afterCompact(): Promise<void> {
		this.contextCompactionRequested = false;
		if (!this.active || !this.paths || !this.state) return;
		this.injectedMemory = await readAuthoritativeMemory(this.paths, this.state);
		this.continuationCheckpointUpdates = this.deferredCheckpointUpdates;
		this.deferredCheckpointUpdates = [];
		this.state.injectedMemoryHash = sha256(this.injectedMemory);
		await saveState(this.paths, this.state);
	}

	async rebuild(ctx: ExtensionContext): Promise<boolean> {
		if (!this.active || !this.sessionId || !this.paths || !this.loadedConfig) {
			ctx.ui.notify("Session refinement is unavailable for this session.", "warning");
			return false;
		}
		if (this.foregroundRun) {
			ctx.ui.notify("Session refinement rebuild is already running.", "info");
			return this.foregroundRun;
		}
		const confirmed = await ctx.ui.confirm("Rebuild session refinement memory?", "This may make many configured-model calls. Existing memory remains untouched unless the rebuild completes.");
		return confirmed ? this.runForegroundRebuild(ctx) : false;
	}

	private async runForegroundRebuild(ctx: ExtensionContext): Promise<boolean> {
		if (this.foregroundRun) return this.foregroundRun;
		const controller = new AbortController();
		this.foregroundAbort = controller;
		const unsubscribe = ctx.mode === "tui" ? ctx.ui.onTerminalInput((data) => {
			if (!matchesKey(data, "escape")) return undefined;
			controller.abort();
			return { consume: true };
		}) : undefined;
		const operation = this.performRebuild(ctx, controller.signal);
		this.foregroundRun = operation;
		try { return await operation; }
		finally {
			unsubscribe?.();
			if (this.foregroundRun === operation) { this.foregroundRun = undefined; this.foregroundAbort = undefined; }
		}
	}

	private async rebuildBaseline(): Promise<{ memory: string; state: SessionRefinementState; floor?: string }> {
		const state = createInitialState(this.sessionId!);
		const existingWarnings = this.state?.warnings ?? this.legacyState?.warnings ?? [];
		state.warnings = existingWarnings.filter((warning): warning is PersistentWarning =>
			warning.code === "missing-model" || warning.code === "missing-consolidator-model");
		if (this.state?.fork && this.paths) {
			const authoritative = await readAuthoritativeMemory(this.paths, this.state);
			const parsed = validateMemoryDocument(authoritative);
			const inherited = parsed.slice(0, this.state.fork.inheritedRecordCount);
			state.records = inherited.map((entry) => entry.record);
			state.fork = structuredClone(this.state.fork);
			state.lastProcessedEntryId = state.fork.floorEntryId;
			return { memory: materializeMemoryFromRecords(inherited), state, floor: state.fork.floorEntryId };
		}
		if (this.legacyState?.fork && this.paths) {
			const floor = this.legacyState.fork.floorEntryId;
			state.fork = { floorEntryId: floor, inheritedRecordCount: 0 };
			state.lastProcessedEntryId = floor;
			try {
				const legacy = validateLegacyMemory(await readMemory(this.paths.memory), this.legacyState)
					.slice(0, this.legacyState.fork.inheritedCheckpointCount);
				let memory = "";
				for (const entry of legacy) {
					const record = createCheckpointRecord({
						fromEntryId: entry.record.fromEntryId,
						throughEntryId: entry.record.throughEntryId,
						createdAt: entry.record.createdAt,
						cutoffAt: entry.record.createdAt,
						trigger: entry.record.trigger,
					});
					memory = stageCheckpoint(memory, entry.body, record);
					state.records.push(record);
				}
				state.fork.inheritedRecordCount = state.records.length;
				return { memory, state, floor };
			} catch {
				// Explicit lossy rule: invalid inherited v1 prose is dropped, but the recorded fork floor remains authoritative.
				return { memory: "", state, floor };
			}
		}
		return { memory: "", state };
	}

	private async performRebuild(ctx: ExtensionContext, signal: AbortSignal): Promise<boolean> {
		if (!this.sessionId || !this.paths || !this.loadedConfig) return false;
		const sessionId = this.sessionId;
		const livePaths = this.paths;
		const ownership = this.operationGeneration;
		if (this.currentRun && !await waitForPromiseOrAbort(this.currentRun, signal)) return false;
		if (signal.aborted) return false;
		let baseline: Awaited<ReturnType<RefinementController["rebuildBaseline"]>>;
		try { baseline = await this.rebuildBaseline(); }
		catch (error) { ctx.ui.notify(`[Session Refinement] Rebuild failed: ${error instanceof Error ? error.message : String(error)}`, "warning"); return false; }
		let segments: TranscriptSegment[];
		try { segments = buildReconstructionSegments(ctx.sessionManager.getBranch(), baseline.floor); }
		catch (error) { ctx.ui.notify(`[Session Refinement] Rebuild failed: ${error instanceof Error ? error.message : String(error)}`, "warning"); return false; }
		if (segments.length === 0 && !baseline.memory) {
			ctx.ui.notify("No conversation entries are available to reconstruct.", "warning");
			return false;
		}
		const rebuildRoot = join(livePaths.root, `.rebuild-${randomUUID()}`);
		const rebuildPaths: SessionPaths = {
			root: rebuildRoot,
			memory: join(rebuildRoot, "memory.md"),
			generations: join(rebuildRoot, "generations"),
			state: join(rebuildRoot, "state.json"),
		};
		const rebuildState = baseline.state;
		if (baseline.memory) rebuildState.memoryGeneration = await writeMemoryGeneration(rebuildPaths, baseline.memory);
		await saveState(rebuildPaths, rebuildState);
		const suffix = " · Esc to cancel";
		const activity = this.activity.begin(ctx, `Rebuilding session memory · 0/${segments.length}${suffix}`);
		let commitStarted = false;
		try {
			if (baseline.memory && needsConsolidation(baseline.memory, this.loadedConfig.config.memoryBudgetTokens)) {
				const model = rootModel(ctx);
				if (!model) throw new Error("The interactive session has no current model for rebuild consolidation.");
				const base = `Rebuilding session memory · consolidating inherited baseline${suffix}`;
				const rolled = await this.consolidateCandidate({
					memory: baseline.memory,
					trigger: "rebuild",
					ctx,
					paths: rebuildPaths,
					state: rebuildState,
					model,
					activity,
					base,
					signal,
				});
				if (rolled.failure || signal.aborted) throw new Error(rolled.failure?.error ?? "Rebuild consolidation cancelled.");
				if (rolled.range) {
					await commitCandidatePublication({
						paths: rebuildPaths,
						state: rebuildState,
						memory: rolled.memory,
						applyState(value) { applyPublishedRecords(value, rolled.memory, rolled.range); },
					});
				}
			}
			for (let index = 0; index < segments.length; index++) {
				if (signal.aborted) throw new Error("Rebuild cancelled.");
				const base = `Rebuilding session memory · ${index + 1}/${segments.length}${suffix}`;
				activity.update(base);
				const outcome = await this.runExaminationWithTarget(segments[index], "rebuild", ctx, rebuildPaths, rebuildState, false, signal, activity, base);
				if (outcome.cancelled || signal.aborted) throw new Error("Rebuild cancelled.");
				if (!outcome.ok) throw new Error(outcome.error ?? `Rebuild failed at segment ${index + 1}.`);
			}
			if (signal.aborted) throw new Error("Rebuild cancelled.");
			activity.update("Rebuilding session memory · saving replacement");
			const rebuiltMemory = await readAuthoritativeMemory(rebuildPaths, rebuildState);
			commitStarted = true;
			const rebuiltState = { ...rebuildState, sessionId, injectedMemoryHash: sha256(rebuiltMemory) };
			delete rebuiltState.memoryGeneration;
			const publishedState = await commitRebuiltMemory({ paths: livePaths, memory: rebuiltMemory, state: rebuiltState });
			if (ownership === this.operationGeneration && this.sessionId === sessionId && this.paths === livePaths) {
				this.state = publishedState;
				this.legacyState = undefined;
				this.injectedMemory = rebuiltMemory;
				this.stateExisted = true;
				this.deferredBaselineThisStart = false;
				this.broken = false;
				this.readOnlyWarning = undefined;
			}
			ctx.ui.notify(`Session refinement rebuilt from ${segments.length} chronological segment${segments.length === 1 ? "" : "s"}.`, "info");
			return true;
		} catch (error) {
			if (signal.aborted && !commitStarted) ctx.ui.notify("Session refinement rebuild cancelled; active memory was not replaced.", "info");
			else ctx.ui.notify(`[Session Refinement] Rebuild failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
			return false;
		} finally {
			activity.clear();
			await rm(rebuildRoot, { recursive: true, force: true });
		}
	}

	async shutdown(ctx?: ExtensionContext): Promise<void> {
		const delegated = Boolean(ctx && isDelegatedAgentSession(contextBranch(ctx)));
		this.activity.clearAll();
		this.foregroundAbort?.abort();
		if (this.foregroundRun) { try { await this.foregroundRun; } catch { /* reported by rebuild */ } }
		const drainBackground = Boolean(process.env.PI_AGENT_RUNNER_ROLE);
		if (!drainBackground) this.abortController.abort();
		if (this.currentRun) { try { await this.currentRun; } catch { /* fail-open */ } }
		if (drainBackground) this.abortController.abort();
		if (delegated) {
			this.active = false;
			if (this.forkStatePublishedThisStart && this.paths) await rm(this.paths.root, { recursive: true, force: true }).catch(() => undefined);
			this.state = undefined;
			this.legacyState = undefined;
			return;
		}
		if (this.deferredBaselineThisStart && this.firstPrompt && this.paths) {
			await rm(this.paths.root, { recursive: true, force: true }).catch(() => undefined);
			this.state = undefined;
			return;
		}
		if (this.state && this.paths && !this.broken) { try { await saveState(this.paths, this.state); } catch { /* preserve shutdown */ } }
	}

	private recordAttemptCompletion(state: SessionRefinementState, toolCallsAtStart: number, postRunToolCalls: number): void {
		const toolCallsDuringRun = Math.max(0, state.toolCallsSinceRun - toolCallsAtStart);
		state.lastAttemptAt = new Date().toISOString();
		state.toolCallsSinceRun = postRunToolCalls + toolCallsDuringRun;
	}

	private async runExamination(segment: TranscriptSegment, trigger: TriggerReason, ctx: ExtensionContext, activate: boolean, signal?: AbortSignal, postRunToolCalls = 0): Promise<ExaminationResult> {
		if (!this.paths || !this.state) return { ok: false, attempts: 0, fallbackUsed: false, error: "Session state unavailable." };
		return this.runExaminationWithTarget(segment, trigger, ctx, this.paths, this.state, activate, signal, undefined, undefined, postRunToolCalls);
	}

	private modelCallbacks(options: {
		ctx: ExtensionContext;
		state: SessionRefinementState;
		paths: SessionPaths;
		activity: ActivityHandle;
		base: string;
		warningCode: "missing-model" | "missing-consolidator-model";
		label: "examiner" | "consolidator";
		acceptBody(body: string, modelReference: string): Promise<void>;
	}): ExaminerCallbacks {
		return {
			acceptBody: options.acceptBody,
			warning: (message) => { try { options.ctx.ui.notify(`[Session Refinement] ${message}`, "warning"); } catch { /* disposed UI */ } },
			missingConfiguredModel: async (reference) => {
				setWarning(options.state, { code: options.warningCode, message: `Configured ${options.label} model "${reference}" is unavailable; using the interactive session model as fallback.` });
				await saveState(options.paths, options.state);
			},
			configuredModelAvailable: async () => {
				clearWarning(options.state, options.warningCode);
				await saveState(options.paths, options.state);
			},
			progress: (event) => {
				if (event.type === "fallback") options.activity.update(`${options.base} · fallback ${shortModelName(event.model)}`);
				else options.activity.update(attemptMessage(options.base, event.model, event.attempt, event.maximum, event.fallback));
			},
		};
	}

	private async consolidateCandidate(options: ConsolidationCandidateOptions): Promise<ConsolidationCandidateOutcome> {
		try {
			return await this.consolidateCandidateUnchecked(options);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			const failure: ExaminationResult = {
				ok: false,
				cancelled: options.signal.aborted || undefined,
				attempts: 0,
				fallbackUsed: false,
				error: options.signal.aborted ? "Memory consolidation cancelled." : detail,
			};
			if (!options.signal.aborted) await this.pauseForConsolidationFailure(options.state, options.paths, detail, options.ctx);
			return { memory: options.memory, failure };
		}
	}

	private async consolidateCandidateUnchecked(options: ConsolidationCandidateOptions): Promise<ConsolidationCandidateOutcome> {
		if (!this.loadedConfig || !this.sessionId || !needsConsolidation(options.memory, this.loadedConfig.config.memoryBudgetTokens)) {
			return { memory: options.memory };
		}
		const config = this.loadedConfig.config;
		const selection = selectConsolidationPrefix(options.memory, config.memoryBudgetTokens, {
			inheritedRecordCount: options.state.fork?.inheritedRecordCount,
			createdAt: new Date().toISOString(),
			trigger: "consolidation",
		});
		const record = selection.replacementRecord;
		const request: ConsolidationRequest = {
			sessionId: this.sessionId,
			trigger: options.trigger,
			prefixMemory: renderMemoryForPrompt(materializeMemoryFromRecords(selection.records)),
			prefixRecords: selection.count,
			firstSourceEntry: selection.records[0].record.fromEntryId,
			lastSourceEntry: record.throughEntryId,
			cutoffAt: record.cutoffAt,
			outputBudgetTokens: selection.bodyAllowanceTokens,
		};
		let consolidatedMemory = "";
		const consolidationBase = options.trigger === "rebuild" ? `${options.base} · consolidating` : "Consolidating session memory";
		options.activity.update(consolidationBase);
		const result = await runConsolidator({
			cwd: options.ctx.cwd,
			agentDir: this.agentDir,
			registry: options.ctx.modelRegistry,
			currentModel: options.model,
			config: { ...config.consolidator, maxAttempts: config.maxAttempts },
			request,
			callbacks: this.modelCallbacks({
				ctx: options.ctx,
				state: options.state,
				paths: options.paths,
				activity: options.activity,
				base: consolidationBase,
				warningCode: "missing-consolidator-model",
				label: "consolidator",
				acceptBody: async (body) => {
					consolidatedMemory = replaceMemoryPrefix({
						candidateMemory: options.memory,
						selection,
						body,
						budgetTokens: config.memoryBudgetTokens,
					}).memory;
				},
			}),
			signal: options.signal,
		});
		recordOperationUsage({ pi: this.pi, operation: "consolidation", trigger: options.trigger, config: config.consolidator, result });
		if (!result.ok || !consolidatedMemory) {
			if (!result.cancelled) {
				await this.pauseForConsolidationFailure(options.state, options.paths, result.error ?? "Consolidator did not return a valid compressed prefix.", options.ctx);
			}
			return { memory: options.memory, failure: result };
		}
		return { memory: consolidatedMemory, range: { start: selection.start, count: selection.count } };
	}

	private async runExaminationWithTarget(
		segment: TranscriptSegment,
		trigger: TriggerReason,
		ctx: ExtensionContext,
		paths: SessionPaths,
		state: SessionRefinementState,
		activate: boolean,
		externalSignal?: AbortSignal,
		providedActivity?: ActivityHandle,
		baseOverride?: string,
		postRunToolCalls = 0,
	): Promise<ExaminationResult> {
		if (!this.loadedConfig || !this.sessionId) return { ok: false, attempts: 0, fallbackUsed: false, error: "Configuration unavailable." };
		const model = rootModel(ctx);
		if (!model) return { ok: false, attempts: 0, fallbackUsed: false, error: "The interactive session has no current model." };
		const base = baseOverride ?? activityBaseMessage(trigger);
		const activity = providedActivity ?? this.activity.begin(ctx, base);
		const ownsActivity = providedActivity === undefined;
		const linked = linkAbortSignals([this.abortController.signal, externalSignal]);
		const toolCallsAtStart = state.toolCallsSinceRun;
		const config = this.loadedConfig.config;
		try {
			if (linked.signal.aborted) return { ok: false, cancelled: true, attempts: 0, fallbackUsed: false, error: "Examination cancelled." };
			const previousMemory = await readAuthoritativeMemory(paths, state);
			const now = new Date();
			const contextUsage = ctx.getContextUsage();
			const request: ExaminationRequest = {
				sessionId: this.sessionId,
				trigger,
				contextTokens: contextUsage?.tokens ?? undefined,
				contextWindow: contextUsage?.contextWindow,
				previousMemory: renderMemoryForPrompt(previousMemory),
				segment,
				currentTimeUtc: now.toISOString(),
				currentTimeLocal: localTime(now),
			};
			let checkpointBody = "";
			const examination = await runExaminer({
				cwd: ctx.cwd,
				agentDir: this.agentDir,
				registry: ctx.modelRegistry,
				currentModel: model,
				config: { model: config.model, thinking: config.thinking, maxAttempts: config.maxAttempts },
				request,
				callbacks: this.modelCallbacks({
					ctx, state, paths, activity, base, warningCode: "missing-model", label: "examiner",
					acceptBody: async (body) => { checkpointBody = validateRecordBody(body); },
				}),
				signal: linked.signal,
			});
			recordOperationUsage({ pi: this.pi, operation: "refinement", trigger, config, result: examination });
			if (!examination.ok || !checkpointBody) {
				if (!examination.cancelled) {
					this.recordAttemptCompletion(state, toolCallsAtStart, postRunToolCalls);
					await saveState(paths, state);
					ctx.ui.notify(`[Session Refinement] Examination interval skipped: ${examination.error ?? "unknown failure"}`, "warning");
				}
				return examination;
			}

			const checkpoint = createCheckpointRecord({
				fromEntryId: segment.fromEntryId,
				throughEntryId: segment.throughEntryId,
				createdAt: now.toISOString(),
				cutoffAt: segment.cutoffAt,
				trigger,
			});
			let stagedMemory = stageCheckpoint(previousMemory, checkpointBody, checkpoint);
			const rolled = await this.consolidateCandidate({
				memory: stagedMemory,
				trigger,
				ctx,
				paths,
				state,
				model,
				activity,
				base,
				signal: linked.signal,
			});
			if (rolled.failure) return rolled.failure;
			stagedMemory = rolled.memory;
			const consolidatedRange = rolled.range;

			const injectedHash = activate && paths === this.paths ? sha256(stagedMemory) : undefined;
			activity.update(`${base} · saving checkpoint`);
			await commitCandidatePublication({
				paths,
				state,
				memory: stagedMemory,
				applyState(value) {
					const toolCallsDuringRun = Math.max(0, value.toolCallsSinceRun - toolCallsAtStart);
					value.lastProcessedEntryId = segment.throughEntryId;
					value.lastRunAt = now.toISOString();
					value.lastAttemptAt = new Date().toISOString();
					value.toolCallsSinceRun = postRunToolCalls + toolCallsDuringRun;
					applyPublishedRecords(value, stagedMemory, consolidatedRange);
					if (injectedHash) value.injectedMemoryHash = injectedHash;
					clearWarning(value, "rebuild-required");
					clearWarning(value, "consolidation-failed");
				},
			});
			if (injectedHash) this.injectedMemory = stagedMemory;
			if (paths === this.paths && !activate) {
				this.deferredCheckpointUpdates.push(renderMemoryForPrompt(formatMemoryRecord(checkpointBody, checkpoint)));
			}
			return examination;
		} finally {
			linked.dispose();
			if (ownsActivity) activity.clear();
		}
	}

	private async pauseForConsolidationFailure(state: SessionRefinementState, paths: SessionPaths, detail: string, ctx: ExtensionContext): Promise<void> {
		setWarning(state, {
			code: "consolidation-failed",
			message: `Memory consolidation failed: ${detail} Run /session-refinement-rebuild before automatic refinement resumes.`,
			rootInstruction: REBUILD_INSTRUCTION,
		});
		let persistenceError: unknown;
		try { await saveState(paths, state); } catch (error) { persistenceError = error; }
		if (paths !== this.paths && this.state && this.paths) {
			setWarning(this.state, {
				code: "consolidation-failed",
				message: `Rebuild staging could not consolidate memory: ${detail} Run /session-refinement-rebuild to retry.`,
				rootInstruction: REBUILD_INSTRUCTION,
			});
			try { await saveState(this.paths, this.state); } catch (error) { persistenceError ??= error; }
		}
		const persistenceNote = persistenceError ? " The warning could not be persisted; avoid restarting before rebuilding." : "";
		try { ctx.ui.notify(`[Session Refinement] Automatic refinement paused for this session. Run /session-refinement-rebuild.${persistenceNote}`, "warning"); } catch { /* disposed UI */ }
	}

	private async markBroken(error: unknown): Promise<void> {
		if (!this.state) return;
		this.broken = true;
		this.injectedMemory = "";
		setWarning(this.state, { code: "broken-state", message: error instanceof Error ? error.message : String(error), rootInstruction: REBUILD_INSTRUCTION });
		if (this.paths) { try { await saveState(this.paths, this.state); } catch { /* retain in-memory warning */ } }
	}
}
