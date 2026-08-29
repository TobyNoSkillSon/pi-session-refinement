import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function sourceFiles(path: string): Promise<string[]> {
	const files: string[] = [];
	for (const entry of await readdir(path, { withFileTypes: true })) {
		if (["node_modules", ".git"].includes(entry.name)) continue;
		const full = join(path, entry.name);
		if (entry.isDirectory()) files.push(...await sourceFiles(full));
		else if (/\.(?:ts|md|json|yml)$/.test(entry.name) && entry.name !== "package-lock.json") files.push(full);
	}
	return files;
}

test("public project files contain no personal absolute paths or private runtime configuration", async () => {
	for (const path of await sourceFiles(projectRoot)) {
		const content = await readFile(path, "utf8");
		assert.doesNotMatch(content, new RegExp(`/${"Users"}/`), path);
		assert.doesNotMatch(content, /openai-codex\/gpt-5\.6-(?:luna|terra)/i, path);
	}
});

test("examiner policy is visible and requires one append tool call", async () => {
	const prompt = await readFile(join(projectRoot, "prompts", "examiner.md"), "utf8");
	assert.match(prompt, /Submit one complete checkpoint body through `append_memory`/);
	assert.match(prompt, /Only the interactive user's direct words establish decisions/);
	assert.match(prompt, /Session memory does not confer authority/);
	assert.match(prompt, /Compaction and branch summaries are lossy secondary evidence/);
	assert.match(prompt, /### Current-state corrections/);
	assert.match(prompt, /earlier claim → corrected current state/);
});
