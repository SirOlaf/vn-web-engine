import type {
  WindowsDynamicLibrary,
  WindowsDynamicLibraryHost,
  WindowsDynamicProcedure,
} from '../../../platform/windows-dynamic-library.js';

const libraryName = new TextEncoder().encode('d3dx9_43.dll\0');

/** 1.658.5 0046a590/0046a7c0: the optional D3DX9 effect library of the configured host.
 * Its export gates 81 6e and the SHADER/129 effect. The implemented presentation shader
 * replaces the compiled effect, so the export is resolved but never invoked. */
export class BurikoD3dxEffectLibrary {
  private module: WindowsDynamicLibrary | null = null; // 005408ac
  private createEffect: WindowsDynamicProcedure | null = null; // 00540924

  constructor(private readonly host: WindowsDynamicLibraryHost | null) {}

  /** 0046aab0. */
  get available(): boolean {
    return this.createEffect !== null;
  }

  /** 0046a590 loads after the adapter checks; a failed load keeps the previous export. */
  load(): void {
    if (this.host === null) return;
    this.module = this.host.loadLibraryA(libraryName);
    if (this.module !== null)
      this.createEffect = this.host.getProcAddress(this.module, 'D3DXCreateEffect');
  }

  /** 0046a7c0 with a nonzero argument. */
  release(): void {
    if (this.module === null) return;
    this.host!.freeLibrary(this.module);
    this.module = null;
    this.createEffect = null;
  }
}
