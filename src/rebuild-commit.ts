import type { SessionPaths, SessionRefinementState } from "./types.js";
import { atomicWrite, readMemory } from "./memory-file.js";
import { saveState } from "./session-store.js";

interface RebuildCommitDependencies {
	readMemory(path: string): Promise<string>;
	write(path: string, content: string): Promise<void>;
	save(paths: SessionPaths, state: SessionRefinementState): Promise<void>;
}

const DEFAULT_DEPENDENCIES: RebuildCommitDependencies = {
	readMemory,
	write: atomicWrite,
	save: saveState,
};

export async function commitRebuiltMemory(options: {
	paths: SessionPaths;
	memory: string;
	state: SessionRefinementState;
	dependencies?: RebuildCommitDependencies;
}): Promise<void> {
	const dependencies = options.dependencies ?? DEFAULT_DEPENDENCIES;
	const previousMemory = await dependencies.readMemory(options.paths.memory);
	await dependencies.write(options.paths.memory, options.memory);
	try {
		await dependencies.save(options.paths, options.state);
	} catch (error) {
		try {
			await dependencies.write(options.paths.memory, previousMemory);
		} catch (rollbackError) {
			throw new AggregateError([error, rollbackError], "Rebuild state commit failed and active memory rollback also failed.");
		}
		throw error;
	}
}
