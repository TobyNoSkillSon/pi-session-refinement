import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { MemoryGenerationRef, SessionPaths, SessionRefinementState } from "./types.js";
import { cleanupMemoryGenerations, writeMemoryGeneration } from "./memory-file.js";
import { saveState } from "./session-store.js";

interface CandidateCommitDependencies {
	writeGeneration(paths: SessionPaths, content: string): Promise<MemoryGenerationRef>;
	save(paths: SessionPaths, state: SessionRefinementState): Promise<void>;
	remove(path: string): Promise<void>;
	cleanup(paths: SessionPaths, keep?: MemoryGenerationRef): Promise<void>;
}

const DEFAULT_DEPENDENCIES: CandidateCommitDependencies = {
	writeGeneration: writeMemoryGeneration,
	save: saveState,
	remove: async (path) => { await rm(path, { force: true }); },
	cleanup: cleanupMemoryGenerations,
};

function replaceState(target: SessionRefinementState, next: SessionRefinementState): void {
	for (const key of Object.keys(target) as Array<keyof SessionRefinementState>) delete target[key];
	Object.assign(target, structuredClone(next));
}

/** Write an immutable generation first, then atomically publish its state pointer. */
export async function commitCandidatePublication(options: {
	paths: SessionPaths;
	state: SessionRefinementState;
	memory: string;
	applyState(state: SessionRefinementState): void;
	dependencies?: CandidateCommitDependencies;
}): Promise<void> {
	const dependencies = options.dependencies ?? DEFAULT_DEPENDENCIES;
	const next = structuredClone(options.state);
	options.applyState(next);
	const generation = await dependencies.writeGeneration(options.paths, options.memory);
	next.memoryGeneration = generation;
	try {
		await dependencies.save(options.paths, next);
	} catch (error) {
		await dependencies.remove(join(options.paths.root, generation.file)).catch(() => undefined);
		throw error;
	}
	replaceState(options.state, next);
	await dependencies.cleanup(options.paths, generation).catch(() => undefined);
}
