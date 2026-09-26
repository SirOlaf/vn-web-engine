import {nativeWaveSineRadians} from '../bp/opcodes/native-math.js';
import type {BurikoBitmap, BurikoBitmapRectangle} from './bitmap.js';
import {rotateCenteredBurikoBitmap} from './bitmap-centered-rotation.js';
import {BurikoBackdrop} from './display-backdrop.js';
import type {BurikoDisplayObjectEnvironment} from './display-object.js';
import type {BurikoSurfaces} from './surfaces.js';

function cvtt64Low32(value: number): number {
  if (!Number.isFinite(value) || value < -(2 ** 63) || value >= 2 ** 63) return 0;
  return Number(BigInt.asIntN(32, BigInt(Math.trunc(value))));
}

/** CDspObjBackRTT:05A330, with native05A070 scale envelope and angle interpolation. */
export class BurikoRotationBackdrop extends BurikoBackdrop {
  private source = -1;
  private imageId: number | undefined;
  private configuration:
    {scale: number; angle: number; scaleDelta: number; angleDelta: number} | undefined;
  constructor(
    environment: BurikoDisplayObjectEnvironment,
    readonly surfaces: BurikoSurfaces,
  ) {
    super(environment, 10);
  }
  setSurface(index: number): number {
    this.check();
    if (this.surfaces.snapshot(index) === null) return 0x80000001;
    this.source = index | 0;
    this.imageId = this.surfaces.imageId(index);
    return 0;
  }
  setBase(scale: number, angle: number): number {
    this.check();
    if (scale >>> 0 === 0) return 0x80000002;
    this.configuration = {scale: scale >>> 0, angle: angle | 0, scaleDelta: 0, angleDelta: 0};
    return 0;
  }
  setDelta(scale: number, angle: number): number {
    this.check();
    if (this.configuration === undefined)
      throw new Error('Buriko rotation backdrop reads unwritten base scale');
    if (((this.configuration.scale + scale) | 0) === 0) return 0x80000002;
    this.configuration.scaleDelta = scale | 0;
    this.configuration.angleDelta = angle | 0;
    return 0;
  }
  override setProperty(selector: number, first: number, second: number): number {
    if (selector >>> 0 === 0x101) return this.setBase(first, second) === 0 ? 0 : 0xffff0002;
    if (selector >>> 0 === 0x80) return this.setDelta(first, second) === 0 ? 0 : 0xffff0002;
    return super.setProperty(selector, first, second);
  }
  override drawContent(destination: BurikoBitmap, _rectangle: BurikoBitmapRectangle): 0 | 1 {
    this.check();
    const source = this.surfaces.snapshot(this.source);
    if (source === null || this.imageId !== this.surfaces.imageId(this.source)) return 0;
    const configuration = this.configuration;
    if (configuration === undefined)
      throw new Error('Buriko rotation backdrop draws before base configuration');
    const blend = this.getBlendValue() >>> 0;
    let scale = configuration.scale;
    const delta = configuration.scaleDelta;
    if (delta !== 0 && blend !== 0) {
      const sine = nativeWaveSineRadians(blend * Math.PI * 0.001953125);
      const s = sine * 256;
      const absolute = ((delta ^ (delta >> 31)) - (delta >> 31)) | 0;
      scale = cvtt64Low32(
        ((256 - s) * (delta < 0 ? 1 : -1) * 0.00390625 +
          delta / (absolute - ((absolute - 65536) | 0) * s * 0.00390625)) *
          65536 +
          configuration.scale,
      );
    }
    const angle =
      (Number(BigInt.asIntN(32, (BigInt(configuration.angleDelta) * BigInt(blend)) >> 8n)) +
        configuration.angle) |
      0;
    rotateCenteredBurikoBitmap(this.environment.compositor, destination, source, scale, angle);
    return 1;
  }
}
