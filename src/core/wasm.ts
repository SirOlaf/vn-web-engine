/** Optional embedded kernels do not require fetch, a server MIME setting, or WASI. */
const modules = new Map<string, WebAssembly.Module | null>();

export function instantiateEmbeddedWasm(binary: string): WebAssembly.Instance | null {
  try {
    let module = modules.get(binary);
    if (module === undefined) {
      const bytes = Uint8Array.from(atob(binary), (character) => character.charCodeAt(0));
      module = new WebAssembly.Module(bytes);
      modules.set(binary, module);
    }
    return module === null ? null : new WebAssembly.Instance(module);
  } catch {
    // Unsupported SIMD, unavailable WebAssembly, CSP, or allocation failure:
    // callers retain their ordinary JavaScript implementation.
    modules.set(binary, null);
    return null;
  }
}
