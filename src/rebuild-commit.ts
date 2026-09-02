import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { MemoryGenerationRef, SessionPaths, SessionRefinementState } from "./types.js";
import { cleanupMemoryGenerations, writeMemoryGeneration } from "./memory-file.js";
import { saveState } from "./session-store.js";

interface RebuildCommitDependencies {
	writeGeneration(paths: SessionPaths, content: string): Promise<MemoryGenerationRef>;
	save(paths: SessionPaths, state: SessionRefinementState): Promise<void>;
	remove(path: string): Promise<void>;
	cleanup(paths: SessionPaths, keep?: MemoryGenerationRef): Promise<void>;
}

const DEFAULT_DEPENDENCIES: RebuildCommitDependencies = {
	writeGeneration: writeMemoryGeneration,
	save: saveState,
	remove: async (path) => { await rm(path, { force: true }); },
	cleanup: cleanupMemoryGenerations,
};

/** Rebuild publication is the same generation-first transaction, followed by best-effort legacy cleanup. */
export async function commitRebuiltMemory(options: {
	paths: SessionPaths;
	memory: string;
	state: SessionRefinementState;
	dependencies?: RebuildCommitDependencies;
}): Promise<SessionRefinementState> {
	const dependencies = options.dependencies ?? DEFAULT_DEPENDENCIES;
	const next = structuredClone(options.state);
	const generation = options.memory ? await dependencies.writeGeneration(options.paths, options.memory) : undefined;
	next.memoryGeneration = generation;
	try {
		await dependencies.save(options.paths, next);
	} catch (error) {
		if (generation) await dependencies.remove(join(options.paths.root, generation.file)).catch(() => undefined);
		throw error;
	}
	await dependencies.cleanup(options.paths, generation).catch(() => undefined);
	await dependencies.remove(options.paths.memory).catch(() => undefined);
	// V2 has no overflow side file; remove any v1 residue only after the v2 pointer is durable.
	await dependencies.remove(join(options.paths.root, "pending.md")).catch(() => undefined);
	return next;
}
