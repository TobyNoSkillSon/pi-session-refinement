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
import {
	buildConsolidatorTask,
	buildExaminerTask,
	loadConsolidatorPrompt,
	loadExaminerPrompt,
} from "./prompt.js";
import type {
	ConsolidationRequest,
	ExaminationRequest,
	ModelOperationConfig,
	ModelOperationResult,
} from "./types.js";

export type ExaminerProgressEvent =
	| { type: "attempt"; model: string; attempt: number; maximum: number; fallback: boolean }
	| { type: "fallback"; model: string };

export interface ExaminerCallbacks {
	acceptBody(body: string, modelReference: string): Promise<void>;
	warning(message: string): void;
	missingConfiguredModel(reference: string): Promise<void>;
	configuredModelAvailable(): Promise<void>;
	progress?(event: ExaminerProgressEvent): void;
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
	}), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
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

interface IsolatedOperation {
	label: string;
	toolName: "append_memory" | "replace_memory_prefix";
	toolLabel: string;
	toolDescription: string;
	systemPrompt: string;
	task: string;
}

async function runOneAttempt(options: {
	cwd: string;
	agentDir: string;
	model: Model<any>;
	operationConfig: ModelOperationConfig;
	operation: IsolatedOperation;
	acceptBody(body: string, modelReference: string): Promise<void>;
	signal?: AbortSignal;
}): Promise<{ body?: string; usage?: Usage; error?: string }> {
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
		systemPrompt: options.operation.systemPrompt,
	});
	await resourceLoader.reload();

	let acceptedBody: string | undefined;
	let submissionError: string | undefined;
	const submissionTool = defineTool({
		name: options.operation.toolName,
		label: options.operation.toolLabel,
		description: options.operation.toolDescription,
		parameters: Type.Object({ body: Type.String({ description: "Complete memory record body without host metadata or an outer title." }) }),
		async execute(_toolCallId, params) {
			if (acceptedBody) throw new Error("A memory candidate was already accepted during this operation.");
			if (options.signal?.aborted) throw new Error(`${options.operation.label} cancelled before candidate submission.`);
			try {
				await options.acceptBody(params.body, canonicalModel(options.model));
				acceptedBody = params.body;
				return { content: [{ type: "text", text: "Memory candidate accepted." }], details: {} };
			} catch (error) {
				submissionError = error instanceof Error ? error.message : String(error);
				throw error;
			}
		},
	});

	const { session } = await createAgentSession({
		cwd: options.cwd,
		agentDir: options.agentDir,
		model: options.model,
		thinkingLevel: options.operationConfig.thinking,
		tools: [options.operation.toolName],
		customTools: [submissionTool],
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
		if (options.signal?.aborted) return { usage: combineUsage(messages), error: `${options.operation.label} cancelled.` };
		await session.prompt(options.operation.task);
		if (!acceptedBody) return { usage: combineUsage(messages), error: submissionError ?? `Model finished without calling ${options.operation.toolName}.` };
		return { body: acceptedBody, usage: combineUsage(messages) };
	} catch (error) {
		if (acceptedBody) return { body: acceptedBody, usage: combineUsage(messages) };
		return { usage: combineUsage(messages), error: submissionError ?? (error instanceof Error ? error.message : String(error)) };
	} finally {
		options.signal?.removeEventListener("abort", abort);
		unsubscribe();
		session.dispose();
	}
}

async function runIsolatedOperation(options: {
	cwd: string;
	agentDir: string;
	registry: ModelRegistry;
	currentModel: Model<any>;
	operationConfig: ModelOperationConfig;
	maxAttempts: number;
	operation: IsolatedOperation;
	callbacks: ExaminerCallbacks;
	signal?: AbortSignal;
}): Promise<ModelOperationResult> {
	const configured = options.operationConfig.model === "current" || options.operationConfig.model === canonicalModel(options.currentModel)
		? options.currentModel
		: resolveConfiguredModel(options.operationConfig.model, options.registry);
	if (!configured) await options.callbacks.missingConfiguredModel(options.operationConfig.model);
	else await options.callbacks.configuredModelAvailable();
	const candidates: Array<{ model: Model<any>; fallback: boolean }> = [];
	if (configured) candidates.push({ model: configured, fallback: false });
	if (!configured || canonicalModel(configured) !== canonicalModel(options.currentModel)) candidates.push({ model: options.currentModel, fallback: true });

	let attempts = 0;
	let lastError: string | undefined;
	let lastAttemptedModel: string | undefined;
	let fallbackAttempted = false;
	let aggregateUsage: Usage | undefined;
	for (const candidate of candidates) {
		if (options.signal?.aborted) break;
		const modelReference = canonicalModel(candidate.model);
		if (candidate.fallback) {
			options.callbacks.progress?.({ type: "fallback", model: modelReference });
			options.callbacks.warning(`${options.operation.label} is falling back to ${modelReference}.`);
		}
		for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
			if (options.signal?.aborted) break;
			attempts++;
			lastAttemptedModel = modelReference;
			if (candidate.fallback) fallbackAttempted = true;
			options.callbacks.progress?.({ type: "attempt", model: modelReference, attempt, maximum: options.maxAttempts, fallback: candidate.fallback });
			let result: { body?: string; usage?: Usage; error?: string };
			try {
				result = await runOneAttempt({
					cwd: options.cwd,
					agentDir: options.agentDir,
					model: candidate.model,
					operationConfig: options.operationConfig,
					operation: options.operation,
					acceptBody: options.callbacks.acceptBody,
					signal: options.signal,
				});
			} catch (error) {
				result = { error: error instanceof Error ? error.message : String(error) };
			}
			aggregateUsage = addUsage(aggregateUsage, result.usage);
			if (result.body !== undefined) return { ok: true, body: result.body, usedModel: modelReference, attempts, fallbackUsed: fallbackAttempted, usage: aggregateUsage };
			lastError = result.error;
		}
		if (!options.signal?.aborted) options.callbacks.warning(`${options.operation.label} failed with ${modelReference} after ${options.maxAttempts} attempts: ${lastError ?? "unknown error"}`);
	}
	return {
		ok: false,
		cancelled: options.signal?.aborted || undefined,
		usedModel: lastAttemptedModel,
		attempts,
		fallbackUsed: fallbackAttempted,
		usage: aggregateUsage,
		error: options.signal?.aborted ? `${options.operation.label} cancelled.` : lastError ?? `No usable ${options.operation.label.toLowerCase()} model.`,
	};
}

export async function runExaminer(options: {
	cwd: string;
	agentDir: string;
	registry: ModelRegistry;
	currentModel: Model<any>;
	config: ModelOperationConfig & { maxAttempts: number };
	request: ExaminationRequest;
	callbacks: ExaminerCallbacks;
	signal?: AbortSignal;
}): Promise<ModelOperationResult> {
	return runIsolatedOperation({
		...options,
		operationConfig: options.config,
		maxAttempts: options.config.maxAttempts,
		operation: {
			label: "Session refinement",
			toolName: "append_memory",
			toolLabel: "Submit Session Memory",
			toolDescription: "Submit one complete chronological checkpoint candidate for host validation and staged publication.",
			systemPrompt: await loadExaminerPrompt(),
			task: buildExaminerTask(options.request),
		},
	});
}

export async function runConsolidator(options: {
	cwd: string;
	agentDir: string;
	registry: ModelRegistry;
	currentModel: Model<any>;
	config: ModelOperationConfig & { maxAttempts: number };
	request: ConsolidationRequest;
	callbacks: ExaminerCallbacks;
	signal?: AbortSignal;
}): Promise<ModelOperationResult> {
	return runIsolatedOperation({
		...options,
		operationConfig: options.config,
		maxAttempts: options.config.maxAttempts,
		operation: {
			label: "Memory consolidation",
			toolName: "replace_memory_prefix",
			toolLabel: "Replace Memory Prefix",
			toolDescription: "Submit one consolidated prefix replacement for deterministic host validation.",
			systemPrompt: await loadConsolidatorPrompt(),
			task: buildConsolidatorTask(options.request),
		},
	});
}
