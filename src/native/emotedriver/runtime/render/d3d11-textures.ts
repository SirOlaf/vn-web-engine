import type {EmoteTexture} from '../../../../formats/kirikiri/emote-model.js';
import {dxgiLayout} from '../../../../graphics/dxgi-layout.js';
import type {
  ID3D11Device,
  ID3D11ShaderResourceView,
  ID3D11Texture2D,
} from '../../../d3d11/contract.js';
import {EmoteUnsupportedError} from '../errors.js';
import type {EmoteD3d11TextureKind} from './d3d11-shaders.js';

/** Native atlas resource; borrowed while the corresponding cache reference is held. */
export interface EmoteD3d11Texture {
  readonly texture: ID3D11Texture2D;
  readonly view: ID3D11ShaderResourceView;
  readonly width: number;
  readonly height: number;
  readonly kind: EmoteD3d11TextureKind;
}

interface Entry {
  readonly value: EmoteD3d11Texture;
  readonly source: EmoteTexture;
  readonly spec: string;
  references: number;
}

/** Native source format selection (0x18005d4f0); software converters are outside this subset. */
function formatOf(type: string, spec: string): number {
  if (spec !== 'win' && spec !== 'common') throw new EmoteUnsupportedError(`texture spec ${spec}`);
  const software = type.endsWith('_SW');
  if (software && spec !== 'win') throw new EmoteUnsupportedError(`texture type ${type} (${spec})`);
  switch (software ? type.slice(0, -3) : type) {
    case 'L8':
      return 61;
    case 'A8':
      return 65;
    case 'A8L8':
      return 49;
    case 'RGBA8':
    case 'RGBX8':
      return spec === 'common' ? 28 : 87;
    case 'DXT1':
      return 71;
    case 'DXT3':
      return 74;
    case 'DXT5':
      return 77;
    case 'BC7':
      if (spec === 'win') return 98;
  }
  throw new EmoteUnsupportedError(`texture type ${type} (${spec})`);
}

/**
 * Native single-level atlas creation (0x18005e3a0 -> 0x180066590), DLL SHA-256
 * 80d28bd088dda8e97c7c47a9c664e55159f70505b0f9fde3158d8ce2a3e1e051.
 * The x64 path uses the source width/height, one mip and direct initial data; it
 * does not inherit the x86 truncated-dimension or optional-mip upload behavior.
 * Entries retain live owners. After the last release an atlas stays idle, keyed by its
 * immutable parsed pixel resource, until the next draw, a texture miss or disposal, so
 * a same-file player re-created between frames reuses the GPU image. Otherwise both
 * native handles retire exactly as before; context bindings follow COM ownership.
 */
export class EmoteD3d11Textures {
  private readonly entries = new Map<EmoteTexture, Entry>();
  private readonly idle = new Map<EmoteTexture['pixel'], Entry>();
  private disposed = false;

  constructor(private readonly device: ID3D11Device) {}

  acquire(source: EmoteTexture, spec: string): EmoteD3d11Texture {
    if (this.disposed) throw new Error('Using a released E-mote texture cache');
    const cached = this.entries.get(source);
    if (cached) {
      if (cached.spec !== spec) throw new Error('E-mote source texture spec changed');
      cached.references++;
      return cached.value;
    }
    const idle = this.idle.get(source.pixel);
    if (
      idle &&
      idle.spec === spec &&
      idle.source.type === source.type &&
      idle.source.width === source.width &&
      idle.source.height === source.height
    ) {
      this.idle.delete(source.pixel);
      this.entries.set(source, {value: idle.value, source, spec, references: 1});
      return idle.value;
    }
    this.retireIdle();
    const format = formatOf(source.type, spec),
      layout = dxgiLayout(format)!,
      {width, height} = source,
      rowPitch = Math.ceil(width / layout.blockWidth) * layout.blockBytes,
      rows = Math.ceil(height / layout.blockHeight),
      bytes = rowPitch * rows;
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > 0xffffffff ||
      height > 0xffffffff ||
      !Number.isSafeInteger(bytes) ||
      source.pixel.bytes.byteLength < bytes
    )
      throw new Error(`Invalid E-mote texture data: ${source.type} ${width}x${height}`);
    const created = this.device.createTexture2D(
      {
        width,
        height,
        mipLevels: 1,
        arraySize: 1,
        format,
        sampleDesc: {count: 1, quality: 0},
        usage: 0,
        bindFlags: 8,
        cpuAccessFlags: 0,
        miscFlags: 0,
      },
      [{data: source.pixel.bytes.subarray(0, bytes), rowPitch, slicePitch: 0}],
    );
    if (created.hr !== 0 || !created.value)
      throw new Error(`E-mote texture creation failed: ${created.hr}`);
    const texture = created.value;
    let view: ID3D11ShaderResourceView;
    try {
      const result = this.device.createShaderResourceView(texture, null);
      if (result.hr !== 0 || !result.value)
        throw new Error(`E-mote texture view creation failed: ${result.hr}`);
      view = result.value;
    } catch (error) {
      texture.release();
      throw error;
    }
    const value: EmoteD3d11Texture = {
      texture,
      view,
      width,
      height,
      kind: format === 65 ? 2 : format === 61 ? 3 : format === 49 ? 4 : 1,
    };
    this.entries.set(source, {value, source, spec, references: 1});
    return value;
  }

  release(source: EmoteTexture): void {
    const entry = this.entries.get(source);
    if (!entry) throw new Error('Releasing an unowned E-mote texture');
    if (--entry.references !== 0) return;
    this.entries.delete(source);
    const replaced = this.idle.get(source.pixel);
    this.idle.set(source.pixel, entry);
    if (replaced) this.retire(replaced);
  }

  /** Draws and misses retire idle atlases, so GPU memory then matches immediate release. */
  retireIdle(): void {
    if (!this.idle.size) return;
    const errors: unknown[] = [];
    for (const entry of [...this.idle.values()])
      try {
        this.retire(entry);
      } catch (error) {
        errors.push(error);
      }
    this.idle.clear();
    if (errors.length) throw new AggregateError(errors, 'E-mote texture retirement failed');
  }

  private retire(entry: Entry): void {
    try {
      entry.value.view.release();
    } finally {
      entry.value.texture.release();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const errors: unknown[] = [];
    for (const {value} of [...this.entries.values(), ...this.idle.values()])
      for (const object of [value.view, value.texture])
        try {
          object.release();
        } catch (error) {
          errors.push(error);
        }
    this.entries.clear();
    this.idle.clear();
    if (errors.length) throw new AggregateError(errors, 'E-mote texture retirement failed');
  }
}
