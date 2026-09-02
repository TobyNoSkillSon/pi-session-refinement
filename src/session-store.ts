import { open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	atomicWrite,
	cleanupMemoryGenerations,
	getSessionPaths,
	isValidMemoryRecord,
	materializeLegacyPrefix,
	materializeMemoryFromRecords,
	readAuthoritativeMemory,
	readMemory,
	validateLegacyMemory,
	validateMemoryDocument,
	writeMemoryGeneration,
} from "./memory-file.js";
import type {
	LegacyCheckpointRecord,
	LoadedSessionState,
	LegacyPersistentWarning,
	PersistentWarning,
	SessionPaths,
	SessionRefinementState,
	SessionRefinementStateV1,
	TriggerReason,
	WarningCode,
} from "./types.js";

export class BrokenStateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BrokenStateError";
	}
}

const TRIGGERS = new Set<TriggerReason>(["context", "time", "manual-compaction", "auto-compaction", "resume", "fork", "rebuild", "consolidation"]);
const WARNINGS = new Set<WarningCode>(["broken-state", "missing-model", "missing-consolidator-model", "rebuild-required", "consolidation-failed"]);
const LEGACY_WARNINGS = new Set<WarningCode | "budget-exceeded">([...WARNINGS, "budget-exceeded"]);

function validId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function validOptionalTimestamp(value: unknown): boolean {
	return value === undefined || (typeof value === "string" && Number.isFinite(Date.parse(value)));
}

function validWarnings(value: unknown, allowed: ReadonlySet<string> = WARNINGS): value is Array<PersistentWarning | LegacyPersistentWarning> {
	return Array.isArray(value) && value.every((warning) => warning && typeof warning === "object" && !Array.isArray(warning)
		&& allowed.has((warning as PersistentWarning).code)
		&& typeof (warning as PersistentWarning).message === "string" && (warning as PersistentWarning).message.trim().length > 0
		&& ((warning as PersistentWarning).rootInstruction === undefined
			|| (typeof (warning as PersistentWarning).rootInstruction === "string" && (warning as PersistentWarning).rootInstruction!.trim().length > 0)));
}

function validCounter(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validLegacyCheckpoint(value: unknown): value is LegacyCheckpointRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Partial<LegacyCheckpointRecord>;
	return (record.fromEntryId === undefined || validId(record.fromEntryId)) && validId(record.throughEntryId)
		&& typeof record.createdAt === "string" && Number.isFinite(Date.parse(record.createdAt))
		&& TRIGGERS.has(record.trigger as TriggerReason);
}

export function createInitialState(sessionId: string): SessionRefinementState {
	return { version: 2, sessionId, toolCallsSinceRun: 0, records: [], warnings: [] };
}

function isV1State(value: unknown, sessionId: string): value is SessionRefinementStateV1 {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const state = value as Partial<SessionRefinementStateV1>;
	return state.version === 1 && state.sessionId === sessionId && validCounter(state.toolCallsSinceRun)
		&& (state.lastProcessedEntryId === undefined || validId(state.lastProcessedEntryId))
		&& validOptionalTimestamp(state.lastRunAt) && validOptionalTimestamp(state.lastAttemptAt)
		&& (state.injectedMemoryHash === undefined || /^[0-9a-f]{64}$/.test(state.injectedMemoryHash))
		&& Array.isArray(state.checkpoints) && state.checkpoints.every(validLegacyCheckpoint) && validWarnings(state.warnings, LEGACY_WARNINGS)
		&& (state.fork === undefined || (validId(state.fork.floorEntryId)
			&& validCounter(state.fork.inheritedCheckpointCount)
			&& state.fork.inheritedCheckpointCount <= state.checkpoints.length));
}

function isV2State(value: unknown, sessionId: string): value is SessionRefinementState {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const state = value as Partial<SessionRefinementState>;
	if (state.version !== 2 || state.sessionId !== sessionId || !validCounter(state.toolCallsSinceRun)
		|| (state.lastProcessedEntryId !== undefined && !validId(state.lastProcessedEntryId))
		|| !validOptionalTimestamp(state.lastRunAt) || !validOptionalTimestamp(state.lastAttemptAt)
		|| (state.injectedMemoryHash !== undefined && !/^[0-9a-f]{64}$/.test(state.injectedMemoryHash))
		|| !Array.isArray(state.records) || !state.records.every(isValidMemoryRecord) || !validWarnings(state.warnings)) return false;
	if (state.memoryGeneration !== undefined && (typeof state.memoryGeneration !== "object"
		|| typeof state.memoryGeneration.file !== "string" || typeof state.memoryGeneration.sha256 !== "string")) return false;
	if ((state.records.length > 0) !== Boolean(state.memoryGeneration)) return false;
	if (state.fork !== undefined && (!validId(state.fork.floorEntryId) || !validCounter(state.fork.inheritedRecordCount)
		|| state.fork.inheritedRecordCount > state.records.length)) return false;
	for (let index = 1; index < state.records.length; index++) {
		if (Date.parse(state.records[index].cutoffAt) < Date.parse(state.records[index - 1].cutoffAt)) return false;
	}
	const expectedCursor = state.fork && state.records.length === state.fork.inheritedRecordCount
		? state.fork.floorEntryId
		: state.records.at(-1)?.throughEntryId;
	if (state.records.length > 0 || state.fork) {
		if (state.lastProcessedEntryId !== expectedCursor) return false;
	}
	return true;
}

export function assertValidState(state: LoadedSessionState, sessionId = state.sessionId): void {
	if (!isV1State(state, sessionId) && !isV2State(state, sessionId)) throw new BrokenStateError(`Invalid state file for session ${sessionId}.`);
}

export async function loadState(paths: SessionPaths, sessionId: string): Promise<{ state: LoadedSessionState; existed: boolean }> {
	try {
		const parsed = JSON.parse(await readFile(paths.state, "utf8")) as unknown;
		assertValidState(parsed as LoadedSessionState, sessionId);
		return { state: parsed as LoadedSessionState, existed: true };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: createInitialState(sessionId), existed: false };
		if (error instanceof BrokenStateError) throw error;
		throw new BrokenStateError(`Could not read session refinement state: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export async function saveState(paths: SessionPaths, state: SessionRefinementState | SessionRefinementStateV1): Promise<void> {
	assertValidState(state);
	await atomicWrite(paths.state, JSON.stringify(state, null, 2) + "\n");
}

async function readSessionHeader(path: string): Promise<{ id?: string; parentSession?: string } | undefined> {
	try {
		const handle = await open(path, "r");
		try {
			const buffer = Buffer.alloc(16_384);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
			const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0];
			const header = JSON.parse(firstLine) as { type?: string; id?: string; parentSession?: string };
			return header.type === "session" ? header : undefined;
		} finally { await handle.close(); }
	} catch { return undefined; }
}

export async function readSessionIdFromFile(path: string): Promise<string | undefined> {
	const header = await readSessionHeader(path);
	return header && validId(header.id) ? header.id : undefined;
}

export async function readParentSessionFromFile(path: string): Promise<string | undefined> {
	const header = await readSessionHeader(path);
	return header && typeof header.parentSession === "string" && header.parentSession.length > 0 ? header.parentSession : undefined;
}

function forkPoint(entries: SessionEntry[]): string | undefined {
	return [...entries].reverse().find((entry) => validId(entry.id))?.id;
}

export type ForkInheritance =
	| { mode: "v2"; state: SessionRefinementState; memory: string; inherited: number }
	| { mode: "legacy"; state: SessionRefinementStateV1; memory: string; inherited: number }
	| { mode: "none"; state: SessionRefinementState; memory: ""; inherited: 0 };

async function publishForkV2(paths: SessionPaths, state: SessionRefinementState, memory: string): Promise<void> {
	if (memory) state.memoryGeneration = await writeMemoryGeneration(paths, memory);
	try { await saveState(paths, state); }
	catch (error) {
		if (state.memoryGeneration) await rm(join(paths.root, state.memoryGeneration.file), { force: true }).catch(() => undefined);
		throw error;
	}
	await cleanupMemoryGenerations(paths, state.memoryGeneration).catch(() => undefined);
}

export async function inheritForkMemory(options: {
	agentDir: string;
	newSessionId: string;
	previousSessionFile: string;
	branchEntries: SessionEntry[];
}): Promise<ForkInheritance> {
	const floorEntryId = forkPoint(options.branchEntries);
	const empty = createInitialState(options.newSessionId);
	empty.lastAttemptAt = new Date().toISOString();
	if (floorEntryId) empty.fork = { floorEntryId, inheritedRecordCount: 0 };
	empty.lastProcessedEntryId = floorEntryId;
	const childPaths = getSessionPaths(options.agentDir, options.newSessionId);
	const noInheritance = async (): Promise<ForkInheritance> => {
		await publishForkV2(childPaths, empty, "");
		return { mode: "none", state: empty, memory: "", inherited: 0 };
	};
	const parentId = await readSessionIdFromFile(options.previousSessionFile);
	if (!parentId) return noInheritance();
	const parentPaths = getSessionPaths(options.agentDir, parentId);
	const loaded = await loadState(parentPaths, parentId);
	if (!loaded.existed) return noInheritance();
	const branchIds = new Set(options.branchEntries.map((entry) => entry.id));

	if (loaded.state.version === 1) {
		const parentMemory = await readMemory(parentPaths.memory);
		if (!parentMemory) return noInheritance();
		const parsed = validateLegacyMemory(parentMemory, loaded.state);
		let inherited = 0;
		while (inherited < parsed.length
			&& branchIds.has(parsed[inherited].record.throughEntryId)
			&& (parsed[inherited].record.fromEntryId === undefined || branchIds.has(parsed[inherited].record.fromEntryId!))) inherited++;
		if (inherited === 0) return noInheritance();
		const selected = parsed.slice(0, inherited);
		const memory = materializeLegacyPrefix(selected);
		const state: SessionRefinementStateV1 = {
			version: 1,
			sessionId: options.newSessionId,
			lastProcessedEntryId: floorEntryId,
			lastAttemptAt: new Date().toISOString(),
			toolCallsSinceRun: 0,
			checkpoints: selected.map((entry) => entry.record),
			warnings: [],
			...(floorEntryId ? { fork: { floorEntryId, inheritedCheckpointCount: inherited } } : {}),
		};
		if (memory) await atomicWrite(childPaths.memory, memory);
		await saveState(childPaths, state);
		return { mode: "legacy", state, memory, inherited };
	}

	const parentState = loaded.state;
	const parentMemory = await readAuthoritativeMemory(parentPaths, parentState);
	const parsed = validateMemoryDocument(parentMemory);
	if (parsed.length !== parentState.records.length
		|| !parsed.every((entry, index) => JSON.stringify(entry.record) === JSON.stringify(parentState.records[index]))) {
		throw new BrokenStateError(`Parent v2 memory does not match state for session ${parentId}.`);
	}
	let inherited = 0;
	while (inherited < parsed.length
		&& branchIds.has(parsed[inherited].record.throughEntryId)
		&& (parsed[inherited].record.fromEntryId === undefined || branchIds.has(parsed[inherited].record.fromEntryId!))) inherited++;
	const selected = parsed.slice(0, inherited);
	const memory = materializeMemoryFromRecords(selected);
	const state = createInitialState(options.newSessionId);
	state.lastAttemptAt = new Date().toISOString();
	state.records = selected.map((entry) => entry.record);
	state.lastProcessedEntryId = floorEntryId;
	if (floorEntryId) state.fork = { floorEntryId, inheritedRecordCount: inherited };
	await publishForkV2(childPaths, state, memory);
	return { mode: "v2", state, memory, inherited };
}

export function setWarning(state: SessionRefinementState, warning: PersistentWarning): void {
	state.warnings = [...state.warnings.filter((entry) => entry.code !== warning.code), warning];
}

export function clearWarning(state: SessionRefinementState, code?: PersistentWarning["code"]): void {
	state.warnings = code ? state.warnings.filter((entry) => entry.code !== code) : [];
}
