import type { CheckpointRecord, SessionPaths, SessionRefinementState } from "./types.js";
import { appendCheckpoint, atomicWrite, readMemory } from "./memory-file.js";
import { saveState } from "./session-store.js";

interface CheckpointCommitDependencies {
	readMemory(path: string): Promise<string>;
	append(options: { paths: SessionPaths; body: string; record: CheckpointRecord; budgetTokens: number }): Promise<unknown>;
	write(path: string, content: string): Promise<void>;
	save(paths: SessionPaths, state: SessionRefinementState): Promise<void>;
}

const DEFAULT_DEPENDENCIES: CheckpointCommitDependencies = {
	readMemory,
	append: appendCheckpoint,
	write: atomicWrite,
	save: saveState,
};

function restoreState(target: SessionRefinementState, snapshot: SessionRefinementState): void {
	for (const key of Object.keys(target) as Array<keyof SessionRefinementState>) delete target[key];
	Object.assign(target, structuredClone(snapshot));
}

export async function commitCheckpoint(options: {
	paths: SessionPaths;
	state: SessionRefinementState;
	body: string;
	record: CheckpointRecord;
	budgetTokens: number;
	applyState(state: SessionRefinementState): void;
	dependencies?: CheckpointCommitDependencies;
}): Promise<void> {
	const dependencies = options.dependencies ?? DEFAULT_DEPENDENCIES;
	const previousMemory = await dependencies.readMemory(options.paths.memory);
	const previousState = structuredClone(options.state);
	let memoryChanged = false;
	try {
		await dependencies.append({ paths: options.paths, body: options.body, record: options.record, budgetTokens: options.budgetTokens });
		memoryChanged = true;
		options.applyState(options.state);
		await dependencies.save(options.paths, options.state);
	} catch (error) {
		if (!memoryChanged) throw error;
		restoreState(options.state, previousState);
		try {
			await dependencies.write(options.paths.memory, previousMemory);
		} catch (rollbackError) {
			throw new AggregateError([error, rollbackError], "Checkpoint state commit failed and memory rollback also failed.");
		}
		throw error;
	}
}
