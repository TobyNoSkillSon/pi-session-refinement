import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RefinementController } from "./lifecycle.js";

export function registerCommands(pi: ExtensionAPI, controller: RefinementController): void {
	pi.registerCommand("session-refinement-rebuild", {
		description: "Rebuild v2 rolling session memory from the authorized branch history",
		handler: async (_args, ctx) => {
			await controller.rebuild(ctx);
		},
	});
}
