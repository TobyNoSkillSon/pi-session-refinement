import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { CheckpointRecord, SessionPaths, TriggerReason } from "./types.js";

export const MEMORY_HEADER = `# Session Memory

Read chronologically. When entries conflict, the later explicit correction supersedes the earlier one.
`;

const META_PREFIX = "<!-- pi-session-refinement:";
const META_RE = /<!-- pi-session-refinement:(\{[^\n]*\}) -->/g;

export class BudgetExceededError extends Error {
	constructor(public readonly pendingPath: string, public readonly estimatedTokens: number) {
		super(`Session memory would exceed its configured budget (${estimatedTokens.toLocaleString()} estimated tokens).`);
		this.name = "BudgetExceededError";
	}
}

export function getSessionPaths(agentDir: string, sessionId: string): SessionPaths {
	const root = join(agentDir, "pi-session-refinement", "sessions", sessionId);
	return {
		root,
		memory: join(root, "memory.md"),
		pending: join(root, "pending.md"),
		state: join(root, "state.json"),
	};
}

export function estimateTextTokens(text: string): number {
	return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

export async function ensurePrivateDirectory(path: string): Promise<void> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	await chmod(path, 0o700);
}

export async function readMemory(path: string): Promise<string> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw error;
	}
}

export async function atomicWrite(path: string, content: string): Promise<void> {
	await ensurePrivateDirectory(dirname(path));
	const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
	const handle = await open(temporary, "wx", 0o600);
	try {
		await handle.writeFile(content, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		await rename(temporary, path);
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
}

export function formatCheckpoint(body: string, record: CheckpointRecord): string {
	const normalized = body.trim();
	if (!normalized) throw new Error("Examiner submitted an empty memory checkpoint.");
	const metadata = JSON.stringify({
		fromEntryId: record.fromEntryId,
		throughEntryId: record.throughEntryId,
		createdAt: record.createdAt,
		trigger: record.trigger,
	});
	return `\n\n${META_PREFIX}${metadata} -->\n\n---\n\n## Memory checkpoint — ${record.createdAt}\n\n${normalized}\n`;
}

export async function appendCheckpoint(options: {
	paths: SessionPaths;
	body: string;
	record: CheckpointRecord;
	budgetTokens: number;
}): Promise<{ content: string; estimatedTokens: number }> {
	const current = (await readMemory(options.paths.memory)) || MEMORY_HEADER;
	const block = formatCheckpoint(options.body, options.record);
	const next = current.trimEnd() + block;
	const estimatedTokens = estimateTextTokens(renderMemoryForPrompt(next));
	if (estimatedTokens > options.budgetTokens) {
		await atomicWrite(options.paths.pending, block.trimStart());
		throw new BudgetExceededError(options.paths.pending, estimatedTokens);
	}
	await atomicWrite(options.paths.memory, next);
	try { await rm(options.paths.pending, { force: true }); } catch { /* stale pending cleanup is non-fatal */ }
	return { content: next, estimatedTokens };
}

export function renderMemoryForPrompt(content: string): string {
	return content.replace(META_RE, "").trim();
}

export interface ParsedCheckpoint {
	record: CheckpointRecord;
	block: string;
}

export function parseCheckpoints(content: string): ParsedCheckpoint[] {
	const matches = [...content.matchAll(META_RE)];
	const checkpoints: ParsedCheckpoint[] = [];
	for (let index = 0; index < matches.length; index++) {
		const match = matches[index];
		try {
			const raw = JSON.parse(match[1]) as Partial<CheckpointRecord>;
			if (!raw.throughEntryId || !raw.createdAt || !raw.trigger) continue;
			const start = match.index ?? 0;
			const end = index + 1 < matches.length ? matches[index + 1].index ?? content.length : content.length;
			checkpoints.push({
				record: {
					fromEntryId: raw.fromEntryId,
					throughEntryId: raw.throughEntryId,
					createdAt: raw.createdAt,
					trigger: raw.trigger as TriggerReason,
				},
				block: content.slice(start, end).trimEnd(),
			});
		} catch {
			// Unparseable machine metadata is handled by reconstruction rather than guessed here.
		}
	}
	return checkpoints;
}

export function materializeMemoryFromBlocks(blocks: ParsedCheckpoint[]): string {
	return blocks.length > 0
		? MEMORY_HEADER.trimEnd() + "\n\n" + blocks.map((entry) => entry.block).join("\n\n") + "\n"
		: "";
}

