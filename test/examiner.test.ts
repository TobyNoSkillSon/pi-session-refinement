import assert from "node:assert/strict";
import test from "node:test";
import { resolveConfiguredModel } from "../src/examiner.ts";

const models = [
	{ provider: "openai-codex", id: "gpt-a" },
	{ provider: "provider-a", id: "shared" },
	{ provider: "provider-b", id: "shared" },
] as any[];
const registry = { getAvailable: () => models } as any;

test("resolves canonical and uniquely bare available models", () => {
	assert.equal(resolveConfiguredModel("openai-codex/gpt-a", registry), models[0]);
	assert.equal(resolveConfiguredModel("gpt-a", registry), models[0]);
});

test("rejects missing and ambiguous models", () => {
	assert.equal(resolveConfiguredModel("missing", registry), undefined);
	assert.equal(resolveConfiguredModel("shared", registry), undefined);
});
