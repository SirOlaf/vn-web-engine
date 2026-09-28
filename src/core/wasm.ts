import {reportWasmGraphicsFallback} from '../platform/runtime-advisories.js';

/** Optional embedded kernels do not require fetch, a server MIME setting, or WASI. */
const modules = new Map<string, WebAssembly.Module | null>();

/**
 * Instantiates an embedded base64 module, or returns null when WebAssembly, the module's
 * features (such as SIMD) or its allocation are unavailable. Callers then keep their JavaScript
 * implementation; `reportFallback` tells the user once which capability was lost.
 */
export function instantiateEmbeddedWasm(
  binary: string,
  imports?: WebAssembly.Imports,
  reportFallback: () => void = reportWasmGraphicsFallback,
): WebAssembly.Instance | null {
  try {
    let module = modules.get(binary);
    if (module === undefined) {
      const bytes = Uint8Array.from(atob(binary), (character) => character.charCodeAt(0));
      module = new WebAssembly.Module(bytes);
      modules.set(binary, module);
    }
    if (module === null) return null;
    return imports === undefined
      ? new WebAssembly.Instance(module)
      : new WebAssembly.Instance(module, imports);
  } catch {
    modules.set(binary, null);
    reportFallback();
    return null;
  }
}
