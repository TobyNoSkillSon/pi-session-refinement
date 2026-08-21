export interface LinkedAbortSignal {
	signal: AbortSignal;
	dispose(): void;
}

export function linkAbortSignals(signals: Array<AbortSignal | undefined>): LinkedAbortSignal {
	const controller = new AbortController();
	const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
	const listeners = new Map<AbortSignal, () => void>();
	const abort = () => controller.abort();
	for (const signal of active) {
		if (signal.aborted) {
			controller.abort();
			break;
		}
		const listener = () => abort();
		listeners.set(signal, listener);
		signal.addEventListener("abort", listener, { once: true });
	}
	return {
		signal: controller.signal,
		dispose() {
			for (const [signal, listener] of listeners) signal.removeEventListener("abort", listener);
			listeners.clear();
		},
	};
}

export async function waitForPromiseOrAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<boolean> {
	if (signal.aborted) return false;
	return new Promise<boolean>((resolve, reject) => {
		let settled = false;
		const finish = (value: boolean) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			resolve(value);
		};
		const onAbort = () => finish(false);
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(() => finish(true), (error) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			reject(error);
		});
	});
}
