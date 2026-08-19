import { rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadConfig, type LoadedConfig } from "./config.js";
import { runExaminer } from "./examiner.js";
import {
	BudgetExceededError,
	appendCheckpoint,
	atomicWrite,
	estimateTextTokens,
	getSessionPaths,
	readMemory,
	renderMemoryForPrompt,
} from "./memory-file.js";
import { buildReconstructionSegments } from "./reconstruct.js";
import { buildTranscriptSegment, CursorNotOnBranchError } from "./session-history.js";
import {
	BrokenStateError,
	clearWarning,
	createInitialState,
	inheritForkMemory,
	loadState,
	saveState,
	setWarning,
} from "./session-store.js";
import type {
	ExaminationRequest,
	ExaminationResult,
	RefinementConfig,
	SessionPaths,
	SessionRefinementState,
	TranscriptSegment,
	TriggerReason,
} from "./types.js";
import { recordExaminerUsage } from "./usage.js";
import { appendWarningInstructions, budgetRootInstruction, notifyPersistentWarnings } from "./warnings.js";

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function localTime(date: Date): string {
	return new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "long" }).format(date);
}

function rootModel(ctx: ExtensionContext): Model<any> | undefined {
	return ctx.model as Model<any> | undefined;
}

export class RefinementController {
	private readonly agentDir = getAgentDir();
	private active = false;
	private broken = false;
	private sessionId?: string;
	private paths?: SessionPaths;
	private state?: SessionRefinementState;
	private loadedConfig?: LoadedConfig;
	private injectedMemory = "";
	private currentRun?: Promise<ExaminationResult>;
	private abortController = new AbortController();
	private firstPrompt = true;
	private startReason = "startup";
	private stateExisted = false;
	private contextCompactionRequested = false;

	constructor(private readonly pi: ExtensionAPI) {}

	async sessionStart(event: { reason: string; previousSessionFile?: string }, ctx: ExtensionContext): Promise<void> {
		this.abortController.abort();
		this.abortController = new AbortController();
		this.active = false;
		this.broken = false;
		this.sessionId = undefined;
		this.paths = undefined;
		this.state = undefined;
		this.loadedConfig = undefined;
		this.injectedMemory = "";
		this.currentRun = undefined;
		this.firstPrompt = true;
		this.stateExisted = false;
		this.contextCompactionRequested = false;
		this.startReason = event.reason;
		const sessionFile = ctx.sessionManager.getSessionFile();
		this.sessionId = ctx.sessionManager.getSessionId();
		this.active = Boolean(sessionFile && this.sessionId);
		if (!this.active || !this.sessionId) return;
		this.loadedConfig = await loadConfig(this.agentDir);
		if (!this.loadedConfig.config.enabled) {
			this.active = false;
			return;
		}
		this.paths = getSessionPaths(this.agentDir, this.sessionId);
		try {
			if (event.reason === "fork" && event.previousSessionFile) {
				const inherited = await inheritForkMemory({
					agentDir: this.agentDir,
					newSessionId: this.sessionId,
					previousSessionFile: event.previousSessionFile,
					branchEntries: ctx.sessionManager.getBranch(),
				});
				this.state = inherited.state;
				this.injectedMemory = inherited.memory;
				this.stateExisted = inherited.inherited > 0;
				await saveState(this.paths, this.state);
			} else {
				const loaded = await loadState(this.paths, this.sessionId);
				this.state = loaded.state;
				this.stateExisted = loaded.existed;
				this.injectedMemory = await readMemory(this.paths.memory);
				if (!loaded.existed) {
					this.state.lastAttemptAt = new Date().toISOString();
					await saveState(this.paths, this.state);
				}
			}
		} catch (error) {
			this.broken = true;
			this.state = createInitialState(this.sessionId);
			setWarning(this.state, {
				code: "broken-state",
				message: error instanceof Error ? error.message : String(error),
				rootInstruction: "Session refinement state is broken. Inform the user on this turn and ask them to run /session-refinement-rebuild. Do not repair or rewrite the memory files without consulting them.",
			});
			try { this.injectedMemory = await readMemory(this.paths.memory); } catch { this.injectedMemory = ""; }
		}
	}

	toolResult(): void {
		if (this.active && !this.broken && this.state) this.state.toolCallsSinceRun++;
	}

	async beforeAgentStart(ctx: ExtensionContext, systemPrompt: string): Promise<string> {
		if (!this.active || !this.state || !this.paths || !this.loadedConfig) return systemPrompt;
		if (this.firstPrompt) {
			this.firstPrompt = false;
			await this.handleFirstPrompt(ctx);
		}
		notifyPersistentWarnings(ctx, this.state.warnings, this.loadedConfig.issues);
		let result = systemPrompt;
		const memory = renderMemoryForPrompt(this.injectedMemory);
		if (memory) result += `\n\n<session_memory>\n${memory}\n</session_memory>`;
		return appendWarningInstructions(result, this.state.warnings);
	}

	private async handleFirstPrompt(ctx: ExtensionContext): Promise<void> {
		if (this.broken || !this.state || !this.paths) return;
		const branch = ctx.sessionManager.getBranch();
		const hasConversation = branch.some((entry) => entry.type === "message");
		if (!this.stateExisted && !this.injectedMemory && hasConversation && this.startReason === "fork") {
			const rebuilt = await this.performRebuild(ctx, "fork");
			if (!rebuilt && this.state) {
				setWarning(this.state, {
					code: "rebuild-required",
					message: "Fork memory could not be reconstructed automatically. Run /session-refinement-rebuild to retry.",
					rootInstruction: "Session refinement could not reconstruct this fork. Inform the user and ask whether to retry with /session-refinement-rebuild.",
				});
				await saveState(this.paths, this.state);
			}
			return;
		}
		if (!this.stateExisted && !this.injectedMemory && hasConversation && this.startReason !== "new") {
			setWarning(this.state, {
				code: "rebuild-required",
				message: "This existing session has no refinement memory. Run /session-refinement-rebuild to reconstruct it chronologically.",
				rootInstruction: "This resumed session predates its refinement memory. Inform the user that /session-refinement-rebuild can reconstruct it; do not run the rebuild without their request.",
			});
			await saveState(this.paths, this.state);
			return;
		}
		if (!this.state.lastProcessedEntryId || !this.injectedMemory) return;
		try {
			const segment = buildTranscriptSegment({ branchEntries: branch, lastProcessedEntryId: this.state.lastProcessedEntryId });
			if (segment) {
				await this.runExamination(segment, this.startReason === "fork" ? "fork" : "resume", ctx, true);
			}
		} catch (error) {
			await this.markBroken(error);
		}
	}

	async agentSettled(ctx: ExtensionContext): Promise<void> {
		if (!this.active || this.broken || !this.state || !this.paths || !this.loadedConfig || this.currentRun) return;
		if (this.state.warnings.some((warning) => warning.code === "budget-exceeded" || warning.code === "rebuild-required")) return;
		await saveState(this.paths, this.state);
		const usage = ctx.getContextUsage();
		if (!this.contextCompactionRequested && usage?.percent !== null && usage?.percent !== undefined
			&& usage.percent >= this.loadedConfig.config.triggers.contextPercent) {
			this.contextCompactionRequested = true;
			ctx.compact({
				onComplete: () => { this.contextCompactionRequested = false; },
				onError: (error) => {
					this.contextCompactionRequested = false;
					ctx.ui.notify(`[Session Refinement] Early compaction failed: ${error.message}`, "warning");
				},
			});
			return;
		}
		const lastAttempt = Date.parse(this.state.lastAttemptAt ?? "") || Date.now();
		const elapsed = Date.now() - lastAttempt;
		const timeReady = elapsed >= this.loadedConfig.config.triggers.elapsedMinutes * 60_000;
		const activityReady = this.state.toolCallsSinceRun >= this.loadedConfig.config.triggers.minimumToolCalls;
		if (!timeReady || !activityReady) return;
		let segment: TranscriptSegment | undefined;
		try {
			segment = buildTranscriptSegment({
				branchEntries: ctx.sessionManager.getBranch(),
				lastProcessedEntryId: this.state.lastProcessedEntryId,
			});
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
		this.currentRun = this.runExamination(segment, "time", ctx, false)
			.catch((error): ExaminationResult => {
				ctx.ui.notify(`[Session Refinement] Background examination failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
				return { ok: false, appended: false, attempts: 0, fallbackUsed: false, error: error instanceof Error ? error.message : String(error) };
			})
			.finally(() => { this.currentRun = undefined; });
		void this.currentRun;
	}

	async beforeCompact(event: {
		reason: "manual" | "threshold" | "overflow";
		preparation: { firstKeptEntryId: string };
		branchEntries: SessionEntry[];
	}, ctx: ExtensionContext): Promise<void> {
		if (!this.active || this.broken || !this.state || !this.loadedConfig) return;
		if (this.state.warnings.some((warning) => warning.code === "budget-exceeded" || warning.code === "rebuild-required")) return;
		const contextTriggered = this.contextCompactionRequested;
		if (event.reason === "manual" && !contextTriggered && !this.loadedConfig.config.runOnManualCompaction) return;
		if (this.currentRun) await this.currentRun;
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
		const trigger: TriggerReason = contextTriggered
			? "context"
			: event.reason === "manual" ? "manual-compaction" : "auto-compaction";
		await this.runExamination(segment, trigger, ctx, false);
	}

	async afterCompact(): Promise<void> {
		this.contextCompactionRequested = false;
		if (!this.active || !this.paths || !this.state) return;
		this.injectedMemory = await readMemory(this.paths.memory);
		this.state.injectedMemoryHash = sha256(this.injectedMemory);
		await saveState(this.paths, this.state);
	}

	async rebuild(ctx: ExtensionContext): Promise<boolean> {
		if (!this.active || !this.sessionId || !this.paths || !this.loadedConfig) {
			ctx.ui.notify("Session refinement is unavailable for this session.", "warning");
			return false;
		}
		const confirmed = await ctx.ui.confirm(
			"Rebuild session refinement memory?",
			"This may make many configured-model calls. Existing memory remains untouched unless the rebuild completes.",
		);
		if (!confirmed) return false;
		return this.performRebuild(ctx, "rebuild");
	}

	private async performRebuild(ctx: ExtensionContext, trigger: "rebuild" | "fork"): Promise<boolean> {
		if (!this.sessionId || !this.paths) return false;
		if (this.currentRun) await this.currentRun;
		const segments = buildReconstructionSegments(ctx.sessionManager.getBranch());
		if (segments.length === 0) {
			ctx.ui.notify("No conversation entries are available to reconstruct.", "warning");
			return false;
		}
		const rebuildRoot = join(this.paths.root, `.rebuild-${randomUUID()}`);
		const rebuildPaths: SessionPaths = {
			root: rebuildRoot,
			memory: join(rebuildRoot, "memory.md"),
			pending: join(rebuildRoot, "pending.md"),
			state: join(rebuildRoot, "state.json"),
		};
		const rebuildState = createInitialState(this.sessionId);
		ctx.ui.setStatus("pi-session-refinement", `Rebuilding memory 0/${segments.length}`);
		try {
			for (let index = 0; index < segments.length; index++) {
				ctx.ui.setStatus("pi-session-refinement", `Rebuilding memory ${index + 1}/${segments.length}`);
				const outcome = await this.runExaminationWithTarget(segments[index], trigger, ctx, rebuildPaths, rebuildState, false);
				if (!outcome.ok) throw new Error(outcome.error ?? `Rebuild failed at segment ${index + 1}.`);
			}
			const rebuiltMemory = await readMemory(rebuildPaths.memory);
			await atomicWrite(this.paths.memory, rebuiltMemory);
			this.state = { ...rebuildState, sessionId: this.sessionId };
			await saveState(this.paths, this.state);
			this.injectedMemory = rebuiltMemory;
			this.stateExisted = true;
			this.broken = false;
			ctx.ui.notify(`Session refinement rebuilt from ${segments.length} chronological segment${segments.length === 1 ? "" : "s"}.`, "info");
			return true;
		} catch (error) {
			ctx.ui.notify(`[Session Refinement] Rebuild failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
			return false;
		} finally {
			ctx.ui.setStatus("pi-session-refinement", undefined);
			await rm(rebuildRoot, { recursive: true, force: true });
		}
	}

	async shutdown(): Promise<void> {
		this.abortController.abort();
		if (this.state && this.paths && !this.broken) {
			try { await saveState(this.paths, this.state); } catch { /* preserve shutdown */ }
		}
	}

	private async runExamination(segment: TranscriptSegment, trigger: TriggerReason, ctx: ExtensionContext, activate: boolean): Promise<ExaminationResult> {
		if (!this.paths || !this.state) return { ok: false, appended: false, attempts: 0, fallbackUsed: false, error: "Session state unavailable." };
		return this.runExaminationWithTarget(segment, trigger, ctx, this.paths, this.state, activate);
	}

	private async runExaminationWithTarget(
		segment: TranscriptSegment,
		trigger: TriggerReason,
		ctx: ExtensionContext,
		paths: SessionPaths,
		state: SessionRefinementState,
		activate: boolean,
	): Promise<ExaminationResult> {
		if (!this.loadedConfig || !this.sessionId) return { ok: false, appended: false, attempts: 0, fallbackUsed: false, error: "Configuration unavailable." };
		const model = rootModel(ctx);
		if (!model) return { ok: false, appended: false, attempts: 0, fallbackUsed: false, error: "The interactive session has no current model." };
		const previousMemory = await readMemory(paths.memory);
		const usage = ctx.getContextUsage();
		const now = new Date();
		const request: ExaminationRequest = {
			sessionId: this.sessionId,
			trigger,
			contextTokens: usage?.tokens ?? undefined,
			contextWindow: usage?.contextWindow,
			previousMemory: renderMemoryForPrompt(previousMemory),
			segment,
			currentTimeUtc: now.toISOString(),
			currentTimeLocal: localTime(now),
		};
		const config = this.loadedConfig.config;
		const result = await runExaminer({
			cwd: ctx.cwd,
			agentDir: this.agentDir,
			registry: ctx.modelRegistry,
			currentModel: model,
			config,
			request,
			callbacks: {
				appendMemory: async (body) => {
					const record = {
						fromEntryId: segment.fromEntryId,
						throughEntryId: segment.throughEntryId,
						createdAt: now.toISOString(),
						trigger,
					} as const;
					try {
						await appendCheckpoint({ paths, body, record, budgetTokens: config.memoryBudgetTokens });
					} catch (error) {
						if (error instanceof BudgetExceededError) {
							setWarning(state, {
								code: "budget-exceeded",
								message: `Session memory exceeded ${config.memoryBudgetTokens.toLocaleString()} tokens. A proposed checkpoint is in ${error.pendingPath}.`,
								rootInstruction: `${await budgetRootInstruction()}

Memory file: ${paths.memory}
Pending checkpoint: ${paths.pending}`,
							});
							await saveState(paths, state);
						}
						throw error;
					}
					state.lastProcessedEntryId = segment.throughEntryId;
					state.lastRunAt = now.toISOString();
					state.checkpoints.push(record);
					clearWarning(state, "rebuild-required");
					await saveState(paths, state);
				},
				warning: (message) => ctx.ui.notify(`[Session Refinement] ${message}`, "warning"),
				missingConfiguredModel: async (reference) => {
					setWarning(state, {
						code: "missing-model",
						message: `Configured examiner model "${reference}" is unavailable; using the interactive session model as fallback.`,
					});
					await saveState(paths, state);
				},
				configuredModelAvailable: async () => {
					clearWarning(state, "missing-model");
					await saveState(paths, state);
				},
			},
			signal: this.abortController.signal,
		});
		state.lastAttemptAt = new Date().toISOString();
		state.toolCallsSinceRun = 0;
		await saveState(paths, state);
		recordExaminerUsage({ pi: this.pi, trigger, config, result });
		if (!result.ok && !result.budgetExceeded) {
			ctx.ui.notify(`[Session Refinement] Examination interval skipped: ${result.error ?? "unknown failure"}`, "warning");
		}
		if (result.ok && activate && paths === this.paths) {
			this.injectedMemory = await readMemory(paths.memory);
			state.injectedMemoryHash = sha256(this.injectedMemory);
			await saveState(paths, state);
		}
		return result;
	}

	private async markBroken(error: unknown): Promise<void> {
		if (!this.state) return;
		this.broken = true;
		setWarning(this.state, {
			code: "broken-state",
			message: error instanceof Error ? error.message : String(error),
			rootInstruction: "Session refinement state is inconsistent with the current branch. Inform the user and ask them to run /session-refinement-rebuild. Do not silently repair or delete memory.",
		});
		if (this.paths) {
			try { await saveState(this.paths, this.state); } catch { /* keep the in-memory warning */ }
		}
	}
}
