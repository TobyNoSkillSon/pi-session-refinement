import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "./commands.js";
import { RefinementController } from "./lifecycle.js";

function warn(ctx: ExtensionContext, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	try { ctx.ui.notify(`[Session Refinement] ${message}`, "warning"); } catch { /* lifecycle errors must remain fail-open */ }
}

export default function sessionRefinement(pi: ExtensionAPI): void {
	const controller = new RefinementController(pi);
	registerCommands(pi, controller);

	pi.on("session_start", async (event, ctx) => {
		try { await controller.sessionStart(event, ctx); } catch (error) { warn(ctx, error); }
	});

	pi.on("tool_result", () => {
		controller.toolResult();
	});

	pi.on("context", async (event) => {
		try { return controller.contextMessages(event.messages); } catch { return undefined; }
	});

	pi.on("before_agent_start", async (event, ctx) => {
		try {
			const systemPrompt = await controller.beforeAgentStart(ctx, event.systemPrompt);
			return systemPrompt === event.systemPrompt ? undefined : { systemPrompt };
		} catch (error) {
			warn(ctx, error);
			return undefined;
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		try { await controller.agentSettled(ctx); } catch (error) { warn(ctx, error); }
	});

	pi.on("session_before_compact", async (event, ctx) => {
		try { await controller.beforeCompact(event, ctx); } catch (error) { warn(ctx, error); }
	});

	pi.on("session_compact", async (_event, ctx) => {
		try { await controller.afterCompact(); } catch (error) { warn(ctx, error); }
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		try { await controller.shutdown(ctx); } catch (error) { warn(ctx, error); }
	});
}
