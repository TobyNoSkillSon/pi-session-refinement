import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RefinementController } from "./lifecycle.js";

export function registerCommands(pi: ExtensionAPI, controller: RefinementController): void {
	pi.registerCommand("session-refinement-rebuild", {
		description: "Reconstruct chronological session refinement memory from the current session branch",
		handler: async (_args, ctx) => {
			await controller.rebuild(ctx);
		},
	});
}
