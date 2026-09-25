/** Project-level warnings about browser capabilities that affect every engine. */
export interface RuntimeAdvisory {
  readonly id: string;
  readonly title: string;
  readonly message: string;
}

const advisories = new Map<string, RuntimeAdvisory>();
const listeners = new Set<(advisory: RuntimeAdvisory) => void>();

/** Reports a capability loss once per page, including when no viewer is mounted yet. */
export function reportRuntimeAdvisory(advisory: RuntimeAdvisory): void {
  if (advisories.has(advisory.id)) return;
  advisories.set(advisory.id, advisory);
  for (const listener of listeners) {
    try {
      listener(advisory);
    } catch {
      // Viewer failures must not change game or audio behavior.
    }
  }
}

/** New viewers receive warnings already raised during startup. */
export function subscribeRuntimeAdvisories(
  listener: (advisory: RuntimeAdvisory) => void,
): () => void {
  listeners.add(listener);
  for (const advisory of advisories.values()) {
    try {
      listener(advisory);
    } catch {
      // A viewer observer does not own the runtime.
    }
  }
  return () => listeners.delete(listener);
}

/** Shared graphics kernels report only when a costly JavaScript path is actually needed. */
export function reportWasmGraphicsFallback(): void {
  reportRuntimeAdvisory({
    id: 'wasm-fallback',
    title: 'WebAssembly graphics fallback',
    message:
      'Some graphics are using JavaScript instead of WebAssembly. Scenes may run very slowly or stall. Check that your browser supports WebAssembly SIMD; large images may also exceed the acceleration limit.',
  });
}
