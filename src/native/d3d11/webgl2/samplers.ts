import type {D3d11SamplerDesc} from '../contract.js';
import type {D3d11DeviceOwner} from '../runtime/com.js';
import {D3d11State} from '../runtime/states.js';
import {D3d11TextureError} from './textures.js';

const MAX_FLOAT = Math.fround(3.4028234663852886e38);
const DEFAULT: D3d11SamplerDesc = Object.freeze({
  filter: 0x15,
  addressU: 3,
  addressV: 3,
  addressW: 3,
  mipLodBias: 0,
  maxAnisotropy: 1,
  comparisonFunc: 1,
  borderColor: Object.freeze([1, 1, 1, 1]) as readonly [number, number, number, number],
  minLod: -MAX_FLOAT,
  maxLod: MAX_FLOAT,
});
/** Configured GPU samplers kept for this many native descriptions, least recently used first. */
const CACHED_SAMPLERS = 64;

/**
 * One configured GPU sampler per native description; native state remains owned by context
 * bindings. Draws alternate descriptions on a unit, and reconfiguring a sampler costs its
 * parameters plus a synchronous error query on every draw.
 */
export class D3d11GpuSamplers {
  private readonly units: number;
  private readonly samplers = new Map<D3d11SamplerDesc, WebGLSampler>();
  private disposed = false;

  constructor(
    private readonly owner: D3d11DeviceOwner,
    private readonly gl: WebGL2RenderingContext,
  ) {
    this.units = gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS);
  }

  bind(unit: number, state: D3d11State<D3d11SamplerDesc> | null): void {
    if (this.disposed || this.owner.lifetime.closed)
      throw new D3d11TextureError('Using disposed D3D11 samplers');
    if (this.gl.isContextLost())
      throw new D3d11TextureError('D3D11 device removed', 0x887a0005 | 0);
    if (!Number.isInteger(unit) || unit < 0 || unit >= this.units)
      throw new D3d11TextureError('D3D11 sampler unit exceeds pixel texture limit');
    if (
      state !== null &&
      (!(state instanceof D3d11State) ||
        !state.live ||
        state.kind !== 'sampler' ||
        state.lifetime !== this.owner.lifetime)
    )
      throw new D3d11TextureError('Invalid, foreign or released D3D11 sampler');
    const desc = state?.description ?? DEFAULT;
    // The surveyed SM4 subset uses ordinary 2D samples with zero native LOD bias.
    // Never silently map border/mirror-once, comparison, anisotropy or LOD bias.
    if (
      (desc.filter & ~0x15) !== 0 ||
      desc.mipLodBias !== 0 ||
      ![1, 2, 3].includes(desc.addressU) ||
      ![1, 2, 3].includes(desc.addressV)
    )
      throw new D3d11TextureError('Unsupported D3D11 sampler mode', 0x80004001 | 0);
    const gl = this.gl;
    let sampler = this.samplers.get(desc);
    if (sampler) this.samplers.delete(desc);
    else sampler = this.create(desc);
    this.samplers.set(desc, sampler);
    if (this.samplers.size > CACHED_SAMPLERS) {
      const [oldest, evicted] = this.samplers.entries().next().value!;
      this.samplers.delete(oldest);
      gl.deleteSampler(evicted);
    }
    // Texture uploads and other private operations may have changed this binding.
    gl.bindSampler(unit, sampler);
  }

  private create(desc: D3d11SamplerDesc): WebGLSampler {
    const gl = this.gl;
    const sampler = gl.createSampler();
    if (!sampler) throw new D3d11TextureError('D3D11 sampler allocation failed', 0x8007000e | 0);
    const min =
      desc.filter & 0x10
        ? desc.filter & 1
          ? gl.LINEAR_MIPMAP_LINEAR
          : gl.LINEAR_MIPMAP_NEAREST
        : desc.filter & 1
          ? gl.NEAREST_MIPMAP_LINEAR
          : gl.NEAREST_MIPMAP_NEAREST;
    const address = (mode: number) =>
      mode === 1 ? gl.REPEAT : mode === 2 ? gl.MIRRORED_REPEAT : gl.CLAMP_TO_EDGE;
    for (const [parameter, value] of [
      [gl.TEXTURE_WRAP_S, address(desc.addressU)],
      [gl.TEXTURE_WRAP_T, address(desc.addressV)],
      [gl.TEXTURE_MAG_FILTER, desc.filter & 4 ? gl.LINEAR : gl.NEAREST],
      [gl.TEXTURE_MIN_FILTER, min],
      [gl.TEXTURE_COMPARE_MODE, gl.NONE],
    ] as const)
      gl.samplerParameteri(sampler, parameter, value);
    gl.samplerParameterf(sampler, gl.TEXTURE_MIN_LOD, desc.minLod);
    gl.samplerParameterf(sampler, gl.TEXTURE_MAX_LOD, desc.maxLod);
    const error = gl.getError();
    if (error !== gl.NO_ERROR) {
      gl.deleteSampler(sampler);
      throw new D3d11TextureError('D3D11 sampler configuration failed: ' + error);
    }
    return sampler;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const sampler of this.samplers.values()) this.gl.deleteSampler(sampler);
    this.samplers.clear();
  }
}
