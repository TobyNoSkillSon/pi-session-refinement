import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type {
	LegacyCheckpointRecord,
	MemoryGenerationRef,
	MemoryRecord,
	SessionPaths,
	SessionRefinementState,
	SessionRefinementStateV1,
	TriggerReason,
} from "./types.js";

export const MEMORY_HEADER = `<!-- pi-session-refinement-memory:{"version":2} -->
# Session Memory

Read records chronologically. A consolidation replaces an older range and states continuity at its recorded cutoff.
`;

export const LEGACY_MEMORY_HEADER = `# Session Memory

Read chronologically. When entries conflict, the later explicit correction supersedes the earlier one.
`;

const RECORD_META_PREFIX = "<!-- pi-session-refinement:";
const RECORD_META_RE = /<!-- pi-session-refinement:(\{[^\n]*\}) -->/g;
const MEMORY_META_RE = /<!-- pi-session-refinement-memory:\{[^\n]*\} -->\n?/g;
const UUID_RE_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const GENERATION_FILE_RE = new RegExp(`^generations/memory-${UUID_RE_SOURCE}\\.md$`);
const TRIGGERS = new Set<TriggerReason>(["context", "time", "manual-compaction", "auto-compaction", "resume", "fork", "rebuild", "consolidation"]);

export function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

export function getSessionPaths(agentDir: string, sessionId: string): SessionPaths {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sessionId) || sessionId === "." || sessionId === "..") {
		throw new Error("Invalid session identifier for refinement storage.");
	}
	const root = join(agentDir, "pi-session-refinement", "sessions", sessionId);
	return { root, memory: join(root, "memory.md"), generations: join(root, "generations"), state: join(root, "state.json") };
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

async function syncDirectory(path: string): Promise<void> {
	try {
		const handle = await open(path, "r");
		try { await handle.sync(); } finally { await handle.close(); }
	} catch {
		// Some platforms cannot fsync directories. The rename remains atomic there.
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
		await syncDirectory(dirname(path));
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
}

export function validateRecordBody(body: string): string {
	const normalized = body.trim();
	if (!normalized) throw new Error("The model submitted an empty memory record.");
	if (normalized.includes(RECORD_META_PREFIX) || normalized.includes("pi-session-refinement-memory:")) {
		throw new Error("Memory record body contains reserved host metadata.");
	}
	if (/^#\s+Session Memory\b/m.test(normalized) || /^##\s+(?:Memory checkpoint|Consolidated memory)\s+—/m.test(normalized)) {
		throw new Error("Memory record body contains a host-owned title.");
	}
	return normalized;
}

function recordHeading(record: MemoryRecord): string {
	return record.kind === "consolidation"
		? `## Consolidated memory — cutoff ${record.cutoffAt}`
		: `## Memory checkpoint — ${record.createdAt}`;
}

export function formatMemoryRecord(body: string, record: MemoryRecord): string {
	const normalized = validateRecordBody(body);
	const metadata = JSON.stringify({ version: 2, ...record });
	return `\n\n${RECORD_META_PREFIX}${metadata} -->\n\n---\n\n${recordHeading(record)}\n\n${normalized}\n`;
}

export function appendRecordToMemory(content: string, body: string, record: MemoryRecord): string {
	const current = content || MEMORY_HEADER;
	return current.trimEnd() + formatMemoryRecord(body, record);
}

export function renderMemoryForPrompt(content: string): string {
	return content.replace(MEMORY_META_RE, "").replace(RECORD_META_RE, "").trim();
}

export interface ParsedMemoryRecord {
	record: MemoryRecord;
	/** Exact bytes from this metadata marker up to the next marker or EOF. */
	block: string;
	body: string;
	start: number;
	end: number;
}

function validTimestamp(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function validId(value: unknown): value is string {
	return typeof value === "string" && value.trim() === value && value.length > 0;
}

export function isValidMemoryRecord(raw: unknown): raw is MemoryRecord & { version?: 2 } {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
	const value = raw as Partial<MemoryRecord> & { version?: number };
	if (value.version !== undefined && value.version !== 2) return false;
	if (value.kind !== "checkpoint" && value.kind !== "consolidation") return false;
	if (!Number.isInteger(value.generation) || (value.generation ?? -1) < 0) return false;
	if (value.fromEntryId !== undefined && !validId(value.fromEntryId)) return false;
	if (!validId(value.throughEntryId) || !Number.isInteger(value.sourceRecordCount) || (value.sourceRecordCount ?? 0) <= 0) return false;
	if (!validTimestamp(value.createdAt) || !validTimestamp(value.cutoffAt) || !TRIGGERS.has(value.trigger as TriggerReason)) return false;
	if (value.kind === "checkpoint" && (value.generation !== 0 || value.sourceRecordCount !== 1)) return false;
	if (value.kind === "consolidation" && value.generation === 0) return false;
	if (Date.parse(value.cutoffAt) > Date.parse(value.createdAt)) return false;
	return true;
}

export function parseMemoryRecords(content: string): ParsedMemoryRecord[] {
	const matches = [...content.matchAll(RECORD_META_RE)];
	const records: ParsedMemoryRecord[] = [];
	for (let index = 0; index < matches.length; index++) {
		const match = matches[index];
		try {
			const raw = JSON.parse(match[1]) as Partial<MemoryRecord> & { version?: number };
			if (!isValidMemoryRecord(raw) || raw.version !== 2) continue;
			const start = match.index ?? 0;
			const end = index + 1 < matches.length ? matches[index + 1].index ?? content.length : content.length;
			const { version: _version, ...record } = raw;
			const block = content.slice(start, end);
			const scaffold = `${match[0]}\n\n---\n\n${recordHeading(record)}\n\n`;
			if (!block.startsWith(scaffold)) continue;
			const body = block.slice(scaffold.length).trim();
			if (!body) continue;
			records.push({ record, block, body, start, end });
		} catch {
			// Strict callers compare the complete canonical document and reject omissions.
		}
	}
	return records;
}

function canonicalMemory(records: ParsedMemoryRecord[]): string {
	return records.reduce((memory, entry) => appendRecordToMemory(memory, entry.body, entry.record), "");
}

export function validateMemoryDocument(content: string): ParsedMemoryRecord[] {
	if (!content) return [];
	const records = parseMemoryRecords(content);
	if (records.length === 0 || canonicalMemory(records).trimEnd() !== content.trimEnd()) {
		throw new Error("Memory generation contains invalid metadata, scaffolding, or untracked prose.");
	}
	for (let index = 1; index < records.length; index++) {
		if (Date.parse(records[index].record.cutoffAt) < Date.parse(records[index - 1].record.cutoffAt)) {
			throw new Error("Memory record cutoff chronology is not monotonic.");
		}
	}
	return records;
}

export interface ParsedLegacyCheckpoint {
	record: LegacyCheckpointRecord;
	block: string;
	body: string;
}

function validLegacyRecord(raw: unknown): raw is LegacyCheckpointRecord {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
	const value = raw as Partial<LegacyCheckpointRecord> & { version?: number };
	return value.version === undefined && (value.fromEntryId === undefined || validId(value.fromEntryId))
		&& validId(value.throughEntryId) && validTimestamp(value.createdAt) && TRIGGERS.has(value.trigger as TriggerReason);
}

export function parseLegacyCheckpoints(content: string): ParsedLegacyCheckpoint[] {
	const matches = [...content.matchAll(RECORD_META_RE)];
	const checkpoints: ParsedLegacyCheckpoint[] = [];
	for (let index = 0; index < matches.length; index++) {
		const match = matches[index];
		try {
			const raw = JSON.parse(match[1]) as unknown;
			if (!validLegacyRecord(raw)) continue;
			const start = match.index ?? 0;
			const end = index + 1 < matches.length ? matches[index + 1].index ?? content.length : content.length;
			const block = content.slice(start, end);
			const scaffold = `${match[0]}\n\n---\n\n## Memory checkpoint — ${raw.createdAt}\n\n`;
			if (!block.startsWith(scaffold)) continue;
			const body = block.slice(scaffold.length).trim();
			if (!body) continue;
			checkpoints.push({ record: raw, block, body });
		} catch {
			// Invalid legacy memory remains rebuild-only.
		}
	}
	return checkpoints;
}

function formatLegacyCheckpoint(body: string, record: LegacyCheckpointRecord): string {
	const metadata = JSON.stringify({ fromEntryId: record.fromEntryId, throughEntryId: record.throughEntryId, createdAt: record.createdAt, trigger: record.trigger });
	return `\n\n${RECORD_META_PREFIX}${metadata} -->\n\n---\n\n## Memory checkpoint — ${record.createdAt}\n\n${body.trim()}\n`;
}

export function validateLegacyMemory(content: string, state: SessionRefinementStateV1): ParsedLegacyCheckpoint[] {
	if (!content && state.checkpoints.length === 0) return [];
	const parsed = parseLegacyCheckpoints(content);
	let canonical = LEGACY_MEMORY_HEADER;
	for (const entry of parsed) canonical = canonical.trimEnd() + formatLegacyCheckpoint(entry.body, entry.record);
	if (!content || parsed.length !== state.checkpoints.length || canonical.trimEnd() !== content.trimEnd()) {
		throw new Error("Legacy memory does not exactly match its checkpoint format and state.");
	}
	if (!parsed.every((entry, index) => JSON.stringify(entry.record) === JSON.stringify(state.checkpoints[index]))) {
		throw new Error("Legacy checkpoint metadata does not match state.json.");
	}
	const expectedCursor = state.fork?.floorEntryId ?? parsed.at(-1)?.record.throughEntryId;
	if (state.lastProcessedEntryId !== expectedCursor) throw new Error("Legacy checkpoint cursor does not match its authoritative coverage.");
	if (state.fork && state.fork.inheritedCheckpointCount !== parsed.length) throw new Error("Legacy fork inheritance count does not match memory.");
	return parsed;
}

export function materializeMemoryFromRecords(records: ParsedMemoryRecord[]): string {
	return records.reduce((memory, entry) => appendRecordToMemory(memory, entry.body, entry.record), "");
}

export function materializeLegacyPrefix(records: ParsedLegacyCheckpoint[]): string {
	return records.reduce((memory, entry) => memory.trimEnd() + formatLegacyCheckpoint(entry.body, entry.record), LEGACY_MEMORY_HEADER);
}

export function generationPath(paths: SessionPaths, ref: MemoryGenerationRef): string {
	if (!GENERATION_FILE_RE.test(ref.file) || !/^[0-9a-f]{64}$/.test(ref.sha256)) throw new Error("Invalid v2 memory generation reference.");
	const target = resolve(paths.root, ref.file);
	const rel = relative(resolve(paths.root), target);
	if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || resolve(paths.generations) !== resolve(dirname(target))) {
		throw new Error("V2 memory generation path escapes the session directory.");
	}
	return target;
}

export async function writeMemoryGeneration(paths: SessionPaths, content: string): Promise<MemoryGenerationRef> {
	validateMemoryDocument(content);
	const file = `generations/memory-${randomUUID()}.md`;
	const ref = { file, sha256: sha256(content) };
	await atomicWrite(generationPath(paths, ref), content);
	return ref;
}

export async function readAuthoritativeMemory(paths: SessionPaths, state: SessionRefinementState): Promise<string> {
	if (!state.memoryGeneration) {
		if (state.records.length > 0) throw new Error("V2 state has records but no memory generation pointer.");
		return "";
	}
	const path = generationPath(paths, state.memoryGeneration);
	const status = await lstat(path);
	if (!status.isFile() || status.isSymbolicLink()) throw new Error("V2 memory generation is not a regular file.");
	const content = await readFile(path, "utf8");
	if (sha256(content) !== state.memoryGeneration.sha256) throw new Error("V2 memory generation hash does not match state.json.");
	validateMemoryDocument(content);
	return content;
}

export async function cleanupMemoryGenerations(paths: SessionPaths, keep?: MemoryGenerationRef): Promise<void> {
	let names: string[];
	try { names = await readdir(paths.generations); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
	const keepName = keep ? basename(generationPath(paths, keep)) : undefined;
	const generatedName = new RegExp(`^memory-${UUID_RE_SOURCE}\\.md$`);
	await Promise.all(names.filter((name) => generatedName.test(name) && name !== keepName)
		.map((name) => rm(join(paths.generations, name), { force: true }).catch(() => undefined)));
}
