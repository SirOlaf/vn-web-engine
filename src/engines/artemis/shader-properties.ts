import {artemisRevision} from './revision.js';
import {artemisDecimal} from './numbers.js';

export interface ArtemisShaderConstant {
  readonly name: string;
  readonly values: readonly number[];
}
export interface ArtemisShaderTexturePath {
  readonly name: string;
  readonly path: string;
}
export interface ArtemisShaderPropertyPatch {
  readonly shader?: string;
  readonly constants?: readonly ArtemisShaderConstant[];
  readonly textures?: readonly ArtemisShaderTexturePath[];
}
/** Native comma splitting retains empty fields and stops at a C-string NUL. */
function fields(value: string): string[] {
  return value.split('\0', 1)[0]!.split(',');
}
/** 115650/d76d0: listed parameter names query the same argument map. Neither
 * missing names nor arbitrary argument keys manufacture constants/textures.
 * Resource acquisition is separate from this parser and must use the file owner.
 */
export function artemisShaderProperties(
  args: ReadonlyMap<string, string>,
  executableSha256?: string,
): ArtemisShaderPropertyPatch {
  const revision = executableSha256 === undefined ? undefined : artemisRevision(executableSha256);
  // Rev.2601 0x4e1b70 never queries these keys, including their named values.
  if (revision && !revision.shaderProperties) return {};
  const acceptsTextures = revision?.shaderTextureProperties ?? true;
  const patch: {
    shader?: string;
    constants?: ArtemisShaderConstant[];
    textures?: ArtemisShaderTexturePath[];
  } = {};
  if (args.has('shader')) patch.shader = args.get('shader')!;
  if (args.has('shaderconstant')) {
    patch.constants = [];
    for (const name of fields(args.get('shaderconstant')!)) {
      if (!args.has(name)) continue;
      const values = fields(args.get(name)!).map((value) => {
        const result = Math.fround(artemisDecimal(value));
        if (!Number.isFinite(result)) throw Error('Unsupported Artemis shader constant');
        return result;
      });
      patch.constants.push({name, values});
    }
  }
  if (acceptsTextures && args.has('shadertexture')) {
    patch.textures = [];
    for (const name of fields(args.get('shadertexture')!))
      if (args.has(name)) patch.textures.push({name, path: args.get(name)!});
  }
  return patch;
}
export interface ArtemisShaderTextureLease<T extends object> {
  readonly resource: T;
  retain(): ArtemisShaderTextureLease<T>;
  release(): void;
}
interface TextureEntry<T extends object> {
  readonly name: string;
  readonly lease: ArtemisShaderTextureLease<T>;
}
/** CLayer a4730/a47c0/a4910 state and resource lifetime. Constants are an ordered
 * list, not a map; names/duplicates and float equality affect native dirty checks.
 * Concrete GPU program selection, reflection/packing and jobs remain host effects.
 */
export class ArtemisShaderProperties<T extends object> {
  private shader = '';
  private constants: ArtemisShaderConstant[] = [];
  private textures: TextureEntry<T>[] = [];
  private revision = 0;
  private closed = false;
  constructor(private readonly hash: string) {
    artemisRevision(hash);
  }
  private check(): void {
    if (this.closed) throw Error('Artemis shader properties closed');
  }
  get propertyRevision(): number {
    return this.revision;
  }
  get shaderName(): string {
    this.check();
    return this.shader;
  }
  constantValues(): readonly ArtemisShaderConstant[] {
    this.check();
    return this.constants.map(({name, values}) => ({name, values: [...values]}));
  }
  /** Borrowed resources remain valid while this owner is alive and unmodified. */
  textureValues(): readonly {readonly name: string; readonly resource: T}[] {
    this.check();
    return this.textures.map(({name, lease}) => ({name, resource: lease.resource}));
  }
  /** Hold texture resources independently through renderer command submission. */
  leaseTextures(): readonly {name: string; lease: ArtemisShaderTextureLease<T>}[] {
    this.check();
    const held: TextureEntry<T>[] = [];
    try {
      for (const entry of this.textures) held.push({name: entry.name, lease: entry.lease.retain()});
    } catch (error) {
      for (const entry of held) entry.lease.release();
      throw error;
    }
    return held;
  }
  setShader(name: string): void {
    this.check();
    if (this.shader === name) return;
    this.shader = name;
    this.revision++;
  }
  setConstants(input: readonly ArtemisShaderConstant[]): void {
    this.check();
    const next = input.map(({name, values}) => ({name, values: values.map(Math.fround)}));
    if (
      next.length === this.constants.length &&
      next.every((entry, i) => {
        const prior = this.constants[i]!;
        return (
          entry.name === prior.name &&
          entry.values.length === prior.values.length &&
          entry.values.every((value, j) => value === prior.values[j])
        );
      })
    )
      return;
    this.constants = next;
    this.revision++;
  }
  /** Retain complete replacement before releasing prior resources. Caller keeps
   * its leases; equal assignments still invalidate preparation, as in a4910.
   */
  setTextures(
    input: readonly {readonly name: string; readonly lease: ArtemisShaderTextureLease<T>}[],
  ): void {
    this.check();
    const next: TextureEntry<T>[] = [];
    try {
      for (const {name, lease} of input) next.push({name, lease: lease.retain()});
    } catch (error) {
      for (const entry of next) entry.lease.release();
      throw error;
    }
    const prior = this.textures;
    this.textures = next;
    this.revision++;
    for (const entry of prior) entry.lease.release();
  }
  copy(): ArtemisShaderProperties<T> {
    this.check();
    const copy = new ArtemisShaderProperties<T>(this.hash);
    copy.setShader(this.shader);
    copy.setConstants(this.constants);
    copy.setTextures(this.textures);
    copy.revision = this.revision;
    return copy;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const prior = this.textures;
    this.textures = [];
    for (const entry of prior) entry.lease.release();
  }
}

/** Native15d120/15e1b0 per-GPU-actor constant storage: concatenate vectors,
 * round capacity to16bytes, grow with zero initialization, never shrink. Reused
 * trailing coefficients persist. Empty input does not bind/update slot1.
 */
export class ArtemisShaderConstantStorage {
  private buffer = new Float32Array(0);
  constructor(private readonly hash: string) {
    artemisRevision(hash);
  }
  /** CGpuLayer15c850 copies shared CPU storage; growth detaches only that copy. */
  copy(): ArtemisShaderConstantStorage {
    const copy = new ArtemisShaderConstantStorage(this.hash);
    copy.buffer = this.buffer;
    return copy;
  }
  get capacityBytes(): number {
    return this.buffer.byteLength;
  }
  update(values: readonly ArtemisShaderConstant[]): Float32Array | null {
    const flat = values.flatMap((entry) => [...entry.values]);
    if (flat.length === 0) {
      if (values.length) throw Error('Unsupported Artemis empty-vector constant buffer');
      return null;
    }
    if (flat.length > 32) throw Error('Unsupported Artemis known-preset constant storage size');
    const count = Math.ceil(flat.length / 4) * 4;
    if (this.buffer.length < count) this.buffer = new Float32Array(count);
    this.buffer.set(flat);
    return this.buffer.slice();
  }
}
