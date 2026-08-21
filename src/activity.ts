import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Loader } from "@earendil-works/pi-tui";
import type { TriggerReason } from "./types.js";

export const REFINEMENT_WIDGET_KEY = "pi-session-refinement-activity";

type ActivityContext = Pick<ExtensionContext, "mode" | "ui">;

class RefinementLoader extends Loader {
	dispose(): void {
		this.stop();
	}
}

export interface ActivityHandle {
	readonly id: number;
	update(message: string): void;
	clear(): void;
}

export class RefinementActivity {
	private generation = 0;
	private current?: { id: number; ctx: ActivityContext; message: string };

	begin(ctx: ActivityContext, message: string): ActivityHandle {
		const id = ++this.generation;
		this.current = { id, ctx, message };
		this.render(id);
		return {
			id,
			update: (next) => this.update(id, next),
			clear: () => this.clear(id),
		};
	}

	clearAll(): void {
		this.generation++;
		const current = this.current;
		this.current = undefined;
		if (current?.ctx.mode === "tui") {
			try { current.ctx.ui.setWidget(REFINEMENT_WIDGET_KEY, undefined); } catch { /* UI is fail-open */ }
		}
	}

	private update(id: number, message: string): void {
		if (!this.current || this.current.id !== id) return;
		this.current.message = message;
		this.render(id);
	}

	private clear(id: number): void {
		if (!this.current || this.current.id !== id) return;
		const { ctx } = this.current;
		this.current = undefined;
		if (ctx.mode === "tui") {
			try { ctx.ui.setWidget(REFINEMENT_WIDGET_KEY, undefined); } catch { /* UI is fail-open */ }
		}
	}

	private render(id: number): void {
		if (!this.current || this.current.id !== id || this.current.ctx.mode !== "tui") return;
		const { ctx, message } = this.current;
		try {
			ctx.ui.setWidget(
				REFINEMENT_WIDGET_KEY,
				(tui, theme) => new RefinementLoader(
					tui,
					(text) => theme.fg("accent", text),
					(text) => theme.fg("muted", text),
					message,
				),
				{ placement: "aboveEditor" },
			);
		} catch { /* UI is fail-open */ }
	}
}

export function activityBaseMessage(trigger: TriggerReason): string {
	if (["context", "manual-compaction", "auto-compaction"].includes(trigger)) {
		return "Refining memory before compaction";
	}
	if (trigger === "rebuild") return "Rebuilding session memory";
	return "Refining session memory";
}

export function shortModelName(reference: string): string {
	return reference.split("/").at(-1) || reference;
}

export function attemptMessage(base: string, model: string, attempt: number, maximum: number, fallback = false): string {
	const label = fallback ? `fallback ${shortModelName(model)}` : shortModelName(model);
	return `${base} · ${label} · attempt ${attempt}/${maximum}`;
}
