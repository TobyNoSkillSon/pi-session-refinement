import type { Message, Model, Usage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent, ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
	createAgentSession,
	defineTool,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { BudgetExceededError } from "./memory-file.js";
import { buildExaminerTask, loadExaminerPrompt } from "./prompt.js";
import type {
	ExaminationRequest,
	ExaminationResult,
	RefinementConfig,
} from "./types.js";

export interface ExaminerCallbacks {
	appendMemory(body: string, modelReference: string): Promise<void>;
	warning(message: string): void;
	missingConfiguredModel(reference: string): Promise<void>;
	configuredModelAvailable(): Promise<void>;
}

function canonicalModel(model: Model<any>): string {
	return `${model.provider}/${model.id}`;
}

export function resolveConfiguredModel(reference: string, registry: Pick<ModelRegistry, "getAvailable">): Model<any> | undefined {
	const trimmed = reference.trim();
	const available = registry.getAvailable();
	const canonical = available.find((model) => `${model.provider}/${model.id}` === trimmed);
	if (canonical) return canonical;
	const bare = available.filter((model) => model.id === trimmed);
	return bare.length === 1 ? bare[0] : undefined;
}

function combineUsage(messages: Message[]): Usage | undefined {
	const usages = messages.flatMap((message) => message.role === "assistant" && message.usage ? [message.usage] : []);
	if (usages.length === 0) return undefined;
	return usages.reduce<Usage>((total, usage) => ({
		input: total.input + (usage.input ?? 0),
		output: total.output + (usage.output ?? 0),
		cacheRead: total.cacheRead + (usage.cacheRead ?? 0),
		cacheWrite: total.cacheWrite + (usage.cacheWrite ?? 0),
		totalTokens: total.totalTokens + (usage.totalTokens ?? 0),
		cost: {
			input: total.cost.input + (usage.cost?.input ?? 0),
			output: total.cost.output + (usage.cost?.output ?? 0),
			cacheRead: total.cost.cacheRead + (usage.cost?.cacheRead ?? 0),
			cacheWrite: total.cost.cacheWrite + (usage.cost?.cacheWrite ?? 0),
			total: total.cost.total + (usage.cost?.total ?? 0),
		},
	}), {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	});
}


function addUsage(total: Usage | undefined, usage: Usage | undefined): Usage | undefined {
	if (!usage) return total;
	if (!total) return usage;
	return {
		input: (total.input ?? 0) + (usage.input ?? 0),
		output: (total.output ?? 0) + (usage.output ?? 0),
		cacheRead: (total.cacheRead ?? 0) + (usage.cacheRead ?? 0),
		cacheWrite: (total.cacheWrite ?? 0) + (usage.cacheWrite ?? 0),
		totalTokens: (total.totalTokens ?? 0) + (usage.totalTokens ?? 0),
		cost: {
			input: (total.cost?.input ?? 0) + (usage.cost?.input ?? 0),
			output: (total.cost?.output ?? 0) + (usage.cost?.output ?? 0),
			cacheRead: (total.cost?.cacheRead ?? 0) + (usage.cost?.cacheRead ?? 0),
			cacheWrite: (total.cost?.cacheWrite ?? 0) + (usage.cost?.cacheWrite ?? 0),
			total: (total.cost?.total ?? 0) + (usage.cost?.total ?? 0),
		},
	};
}

async function runOneAttempt(options: {
	cwd: string;
	agentDir: string;
	model: Model<any>;
	config: RefinementConfig;
	request: ExaminationRequest;
	appendMemory(body: string, modelReference: string): Promise<void>;
	signal?: AbortSignal;
}): Promise<{ appended: boolean; usage?: Usage; error?: string; budgetExceeded?: boolean }> {
	const settingsManager = SettingsManager.create(options.cwd, options.agentDir);
	const resourceLoader = new DefaultResourceLoader({
		cwd: options.cwd,
		agentDir: options.agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: await loadExaminerPrompt(),
	});
	await resourceLoader.reload();

	let appended = false;
	let appendError: string | undefined;
	let budgetExceeded = false;
	const appendTool = defineTool({
		name: "append_memory",
		label: "Append Session Memory",
		description: "Append one complete chronological checkpoint to this session's memory file.",
		parameters: Type.Object({
			body: Type.String({ description: "Complete checkpoint body without the timestamp or outer separator." }),
		}),
		async execute(_toolCallId, params) {
			if (appended) throw new Error("A checkpoint was already appended during this examination.");
			try {
				await options.appendMemory(params.body, canonicalModel(options.model));
				appended = true;
				return { content: [{ type: "text", text: "Checkpoint appended successfully." }], details: {} };
			} catch (error) {
				appendError = error instanceof Error ? error.message : String(error);
				budgetExceeded = error instanceof BudgetExceededError;
				if (budgetExceeded) throw error;
				throw error;
			}
		},
	});

	const { session } = await createAgentSession({
		cwd: options.cwd,
		agentDir: options.agentDir,
		model: options.model,
		thinkingLevel: options.config.thinking,
		tools: ["append_memory"],
		customTools: [appendTool],
		resourceLoader,
		settingsManager,
		sessionManager: SessionManager.inMemory(options.cwd),
	});
	session.setAutoRetryEnabled(false);
	session.setAutoCompactionEnabled(false);
	const messages: Message[] = [];
	const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
		if (event.type === "message_end") messages.push(event.message as Message);
	});
	const abort = () => { void session.abort(); };
	options.signal?.addEventListener("abort", abort, { once: true });
	try {
		if (options.signal?.aborted) void session.abort();
		await session.prompt(buildExaminerTask(options.request));
		if (!appended) return { appended: false, usage: combineUsage(messages), error: appendError ?? "Examiner finished without calling append_memory.", budgetExceeded };
		return { appended: true, usage: combineUsage(messages) };
	} catch (error) {
		if (appended) return { appended: true, usage: combineUsage(messages) };
		return { appended: false, usage: combineUsage(messages), error: appendError ?? (error instanceof Error ? error.message : String(error)), budgetExceeded };
	} finally {
		options.signal?.removeEventListener("abort", abort);
		unsubscribe();
		session.dispose();
	}
}

export async function runExaminer(options: {
	cwd: string;
	agentDir: string;
	registry: ModelRegistry;
	currentModel: Model<any>;
	config: RefinementConfig;
	request: ExaminationRequest;
	callbacks: ExaminerCallbacks;
	signal?: AbortSignal;
}): Promise<ExaminationResult> {
	const configured = options.config.model === "current"
		? options.currentModel
		: resolveConfiguredModel(options.config.model, options.registry);
	if (!configured) {
		await options.callbacks.missingConfiguredModel(options.config.model);
	} else {
		await options.callbacks.configuredModelAvailable();
	}
	const candidates: Array<{ model: Model<any>; fallback: boolean }> = [];
	if (configured) candidates.push({ model: configured, fallback: false });
	if (!configured || canonicalModel(configured) !== canonicalModel(options.currentModel)) {
		candidates.push({ model: options.currentModel, fallback: true });
	}

	let attempts = 0;
	let lastError: string | undefined;
	let aggregateUsage: Usage | undefined;
	for (const candidate of candidates) {
		if (candidate.fallback) options.callbacks.warning(`Session refinement is falling back to ${canonicalModel(candidate.model)}.`);
		for (let attempt = 1; attempt <= options.config.maxAttempts; attempt++) {
			attempts++;
			const result = await runOneAttempt({
				cwd: options.cwd,
				agentDir: options.agentDir,
				model: candidate.model,
				config: options.config,
				request: options.request,
				appendMemory: options.callbacks.appendMemory,
				signal: options.signal,
			});
			aggregateUsage = addUsage(aggregateUsage, result.usage);
			if (result.budgetExceeded) {
				return { ok: false, appended: false, budgetExceeded: true, usedModel: canonicalModel(candidate.model), attempts, fallbackUsed: candidate.fallback, usage: aggregateUsage, error: result.error };
			}
			if (result.appended) {
				return { ok: true, appended: true, usedModel: canonicalModel(candidate.model), attempts, fallbackUsed: candidate.fallback, usage: aggregateUsage };
			}
			lastError = result.error;
			if (options.signal?.aborted) break;
		}
		if (options.signal?.aborted) break;
		options.callbacks.warning(`Session refinement failed with ${canonicalModel(candidate.model)} after ${options.config.maxAttempts} attempts: ${lastError ?? "unknown error"}`);
	}
	return { ok: false, appended: false, attempts, fallbackUsed: candidates.some((entry) => entry.fallback), usage: aggregateUsage, error: lastError ?? "No usable examiner model." };
}
