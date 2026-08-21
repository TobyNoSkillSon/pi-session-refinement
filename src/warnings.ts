import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PersistentWarning } from "./types.js";

const BUDGET_WARNING_PATH = fileURLToPath(new URL("../prompts/budget-warning.md", import.meta.url));

export async function budgetRootInstruction(): Promise<string> {
	return (await readFile(BUDGET_WARNING_PATH, "utf8")).trim();
}

export function notifyPersistentWarnings(ctx: ExtensionContext, warnings: PersistentWarning[], extra: string[] = []): void {
	for (const issue of extra) ctx.ui.notify(`[Session Refinement] ${issue}`, "warning");
	for (const warning of warnings) ctx.ui.notify(`[Session Refinement] ${warning.message}`, "warning");
}

export function appendWarningInstructions(systemPrompt: string, warnings: PersistentWarning[]): string {
	const instructions = warnings.map((warning) => warning.rootInstruction).filter((value): value is string => Boolean(value));
	if (instructions.length === 0) return systemPrompt;
	return `${systemPrompt}\n\n<session_refinement_warning>\n${instructions.join("\n\n")}\n</session_refinement_warning>`;
}
