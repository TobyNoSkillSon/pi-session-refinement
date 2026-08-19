import { readFile } from "node:fs/promises";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { atomicWrite, getSessionPaths, materializeMemoryFromBlocks, parseCheckpoints, readMemory } from "./memory-file.js";
import type { PersistentWarning, SessionPaths, SessionRefinementState } from "./types.js";

export class BrokenStateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BrokenStateError";
	}
}

export function createInitialState(sessionId: string): SessionRefinementState {
	return {
		version: 1,
		sessionId,
		toolCallsSinceRun: 0,
		checkpoints: [],
		warnings: [],
	};
}

function isState(value: unknown, sessionId: string): value is SessionRefinementState {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const state = value as Partial<SessionRefinementState>;
	return state.version === 1
		&& state.sessionId === sessionId
		&& typeof state.toolCallsSinceRun === "number"
		&& Array.isArray(state.checkpoints)
		&& Array.isArray(state.warnings);
}

export async function loadState(paths: SessionPaths, sessionId: string): Promise<{ state: SessionRefinementState; existed: boolean }> {
	try {
		const parsed = JSON.parse(await readFile(paths.state, "utf8")) as unknown;
		if (!isState(parsed, sessionId)) throw new BrokenStateError(`Invalid state file for session ${sessionId}.`);
		return { state: parsed, existed: true };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: createInitialState(sessionId), existed: false };
		if (error instanceof BrokenStateError) throw error;
		throw new BrokenStateError(`Could not read session refinement state: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export async function saveState(paths: SessionPaths, state: SessionRefinementState): Promise<void> {
	await atomicWrite(paths.state, JSON.stringify(state, null, 2) + "\n");
}

export async function readSessionIdFromFile(path: string): Promise<string | undefined> {
	try {
		const file = await readFile(path, "utf8");
		const firstLine = file.split("\n", 1)[0];
		const header = JSON.parse(firstLine) as { type?: string; id?: string };
		return header.type === "session" && typeof header.id === "string" ? header.id : undefined;
	} catch {
		return undefined;
	}
}

export async function inheritForkMemory(options: {
	agentDir: string;
	newSessionId: string;
	previousSessionFile: string;
	branchEntries: SessionEntry[];
}): Promise<{ state: SessionRefinementState; memory: string; inherited: number }> {
	const state = createInitialState(options.newSessionId);
	const parentId = await readSessionIdFromFile(options.previousSessionFile);
	if (!parentId) return { state, memory: "", inherited: 0 };
	const parentPaths = getSessionPaths(options.agentDir, parentId);
	const parentMemory = await readMemory(parentPaths.memory);
	if (!parentMemory) return { state, memory: "", inherited: 0 };
	const branchIds = new Set(options.branchEntries.map((entry) => entry.id));
	const inherited = parseCheckpoints(parentMemory).filter((checkpoint) => branchIds.has(checkpoint.record.throughEntryId));
	const memory = materializeMemoryFromBlocks(inherited);
	if (memory) await atomicWrite(getSessionPaths(options.agentDir, options.newSessionId).memory, memory);
	if (inherited.length > 0) {
		state.lastProcessedEntryId = inherited[inherited.length - 1].record.throughEntryId;
		state.checkpoints = inherited.map((checkpoint) => checkpoint.record);
	}
	return { state, memory, inherited: inherited.length };
}

export function setWarning(state: SessionRefinementState, warning: PersistentWarning): void {
	state.warnings = [...state.warnings.filter((entry) => entry.code !== warning.code), warning];
}

export function clearWarning(state: SessionRefinementState, code?: PersistentWarning["code"]): void {
	state.warnings = code ? state.warnings.filter((entry) => entry.code !== code) : [];
}
