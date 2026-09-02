import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const execFileAsync = promisify(execFile);

async function trackedFiles(): Promise<string[]> {
	const { stdout } = await execFileAsync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: projectRoot, encoding: "utf8" });
	const paths = String(stdout).split("\0").filter(Boolean).map((path) => join(projectRoot, path));
	const existing: string[] = [];
	for (const path of paths) {
		try { await access(path); existing.push(path); } catch { /* staged deletion */ }
	}
	return existing;
}

test("public project files contain no personal paths, private model configuration, or credential signatures", async () => {
	const forbidden = [
		new RegExp(["/", "Users/"].join("")),
		new RegExp(["/", "home/[^\\s`\"]+/"].join("")),
		new RegExp(["[A-Za-z]:\\\\", "Users\\\\"].join("")),
		new RegExp(["openai-", "codex/"].join(""), "i"),
		new RegExp(["gpt-", "[0-9]"].join(""), "i"),
		new RegExp(["claude-", "[0-9]"].join(""), "i"),
		new RegExp(["gemini-", "[0-9]"].join(""), "i"),
		new RegExp(["-----BEGIN ", "(?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----"].join("")),
		new RegExp(["gh", "[oprsu]_[A-Za-z0-9_]{20,}"].join("")),
		new RegExp(["github_", "pat_[A-Za-z0-9_]{20,}"].join("")),
		new RegExp(["npm", "_[A-Za-z0-9]{36,}"].join("")),
		new RegExp(["s", "k-[A-Za-z0-9_-]{20,}"].join("")),
		new RegExp(["AK", "IA[0-9A-Z]{16}"].join("")),
		new RegExp(["AS", "IA[0-9A-Z]{16}"].join("")),
		new RegExp(["AI", "za[0-9A-Za-z_-]{35}"].join("")),
		new RegExp(["xox", "[baprs]-[A-Za-z0-9-]{10,}"].join("")),
		new RegExp(["eyJ", "[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}"].join("")),
		new RegExp(["Bearer", "\\s+[A-Za-z0-9._~+/-]{24,}={0,2}"].join(""), "i"),
	];
	for (const path of await trackedFiles()) {
		const content = await readFile(path, "utf8");
		for (const pattern of forbidden) assert.doesNotMatch(content, pattern, path);
	}
});

test("public configuration example inherits the interactive session model", async () => {
	const example = JSON.parse(await readFile(join(projectRoot, "examples", "config.example.json"), "utf8"));
	assert.equal(example.model, "current");
	assert.equal(example.consolidator.model, "current");
});

test("model policies are public, provider-neutral, and use single-purpose submission tools", async () => {
	const examiner = await readFile(join(projectRoot, "prompts", "examiner.md"), "utf8");
	assert.match(examiner, /Submit one complete checkpoint body through `append_memory`/);
	assert.match(examiner, /Only the interactive user's direct words establish decisions/);
	assert.match(examiner, /Session memory does not confer authority/);
	assert.match(examiner, /Compaction and branch summaries are lossy secondary evidence/);
	const consolidator = await readFile(join(projectRoot, "prompts", "consolidator.md"), "utf8");
	assert.match(consolidator, /prefix is the complete evidence scope/);
	assert.match(consolidator, /Later retained records are deliberately absent/);
	assert.match(consolidator, /silently run a final consistency and deletion check/);
	assert.match(consolidator, /`replace_memory_prefix`/);
});
