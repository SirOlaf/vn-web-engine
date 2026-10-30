import type {AsbTag} from '../../formats/artemis/asb.js';
import {artemisRevision} from './revision.js';

export interface ArtemisShaderCompiler<S extends object> {
  /** Actual compiler/executable owner; nonempty error leaves the old named shader intact. */
  compile(
    id: string,
    bytes: Uint8Array,
  ): Promise<{shader: S; error?: undefined} | {shader?: undefined; error: string}>;
  dispose(shader: S): void;
}
interface ShaderEntry<S> {
  shader: S;
  references: number;
}

/** d8730 loads a named shader, independent of scene-layer existence. Native file
 * and compile diagnostics belong to the command host. Compiler resources remain
 * alive while named registry entries or actor leases retain them.
 */
export class ArtemisShaderLibrary<S extends object> {
  private readonly named = new Map<string, ShaderEntry<S>>();
  private closed = false;
  private pending = false;
  constructor(
    hash: string,
    private readonly readFile: (path: string) => Promise<Uint8Array | null>,
    private readonly compiler: ArtemisShaderCompiler<S>,
    private readonly report: (tag: AsbTag, reason: 'file' | 'compile', error?: string) => void,
  ) {
    artemisRevision(hash);
  }
  private release(entry: ShaderEntry<S>): void {
    if (--entry.references === 0) this.compiler.dispose(entry.shader);
  }
  bind(id: string): {shader: S; release(): void} | null {
    if (this.closed) throw Error('Artemis shader library closed');
    const entry = this.named.get(id);
    if (!entry) return null;
    entry.references++;
    let held = true;
    return {
      shader: entry.shader,
      release: () => {
        if (held) {
          held = false;
          this.release(entry);
        }
      },
    };
  }
  async dispatch(input: AsbTag): Promise<boolean> {
    if (input.name !== 'lyshader') return false;
    if (this.closed) throw Error('Artemis shader library closed');
    if (this.pending) throw Error('Overlapping Artemis shader compilation');
    const tag = {...input, args: new Map(input.args)};
    if (!tag.args.has('file')) tag.args.set('file', '');
    this.pending = true;
    try {
      const bytes = await this.readFile(tag.args.get('file')!.split('\0', 1)[0]!);
      if (this.closed) throw Error('Artemis shader library closed during file load');
      if (bytes === null) {
        this.report(tag, 'file');
        return true;
      }
      if (!tag.args.has('id')) tag.args.set('id', '');
      const id = tag.args.get('id')!,
        result = await this.compiler.compile(id, Uint8Array.from(bytes));
      if (this.closed) {
        if (result.shader) this.compiler.dispose(result.shader);
        throw Error('Artemis shader library closed during compilation');
      }
      if (result.error !== undefined) {
        this.report(tag, 'compile', result.error);
        return true;
      }
      const old = this.named.get(id);
      this.named.set(id, {shader: result.shader, references: 1});
      if (old) this.release(old);
      return true;
    } finally {
      this.pending = false;
    }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.named.values()) this.release(entry);
    this.named.clear();
  }
}
