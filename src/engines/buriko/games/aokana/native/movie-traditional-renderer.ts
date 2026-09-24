import {type AokanaBitmap} from './bitmap.js';
import {clearAokanaBitmap} from './bitmap-copy.js';
import {AokanaDisplayDevice} from './display-device.js';
import {
  AokanaMovieImage,
  type AokanaMovieMediaType,
  type AokanaMovieSample,
} from './movie-image.js';

function cvtt64Low32(value: number): number {
  const converted =
    !Number.isFinite(value) || value < -9223372036854775808 || value >= 9223372036854775808
      ? -9223372036854775808n
      : BigInt(Math.trunc(value));
  return Number(BigInt.asUintN(32, converted));
}

/** DCTraditionalVR's actual decoded-sample consumer; graph construction belongs to its caller. */
export class AokanaTraditionalMovieRenderer {
  constructor(
    readonly device: AokanaDisplayDevice,
    readonly image: AokanaMovieImage,
  ) {}
  checkMediaType(type: AokanaMovieMediaType | null): number {
    return this.image.checkMediaType(type);
  }
  /** 0A9310 clears the logical movie texture only after the base media type is installed. */
  setMediaType(type: AokanaMovieMediaType): number {
    const status = this.image.setMediaType(type);
    if ((status | 0) < 0) return status;
    const texture = this.device.dynamicTexture;
    if (texture === null) return 0x80004005;
    const locked = texture.lock();
    if (locked === null) return 0x80004005;
    clearAokanaBitmap({
      storage: locked.storage,
      offset: locked.offset,
      stride: locked.pitch,
      width: this.device.display.logicalWidth,
      height: this.device.display.logicalHeight,
      format: 1,
      bytesPerPixel: 4,
    });
    texture.unlock();
    return 0;
  }
  /** 0A90E0 retains the device lock across actual sample copy, quad draw and presentation. */
  async deliver(sample: AokanaMovieSample | null): Promise<number> {
    if (sample === null) return 0x80004003;
    const logicalWidth = this.device.display.logicalWidth >>> 0,
      logicalHeight = this.device.display.logicalHeight >>> 0,
      width = this.image.width >>> 0,
      height = this.image.height >>> 0,
      bottomUp = this.image.bottomUp;
    if (width > logicalWidth || height > logicalHeight) return 0x80004005;
    this.device.nativeLock.enter();
    try {
      const texture = this.device.dynamicTexture;
      if (texture === null) return 0x80004005;
      const locked = texture.lock();
      if (locked === null) return 0x80004005;
      const logicalAspect = logicalWidth / logicalHeight,
        imageAspect = width / height;
      let expandedWidth = width,
        expandedHeight = height;
      // COMISD/JC also selects this branch for an unordered comparison.
      if (!(logicalAspect >= imageAspect))
        expandedHeight = cvtt64Low32((height * imageAspect) / logicalAspect + 0.5);
      else expandedWidth = cvtt64Low32((width * logicalAspect) / imageAspect + 0.5);
      const horizontal = (expandedWidth - width) >>> 1;
      const center = (expandedHeight - height) >>> 1;
      const row = bottomUp ? (expandedHeight - center - 1) >>> 0 : center;
      const bitmap: AokanaBitmap = {
        storage: locked.storage,
        offset:
          locked.offset + (Math.imul(horizontal, 4) >>> 0) + (Math.imul(row, locked.pitch) >>> 0),
        stride: bottomUp ? -locked.pitch | 0 : locked.pitch,
        width,
        height,
        format: 1,
        bytesPerPixel: 4,
      };
      this.image.copySample(bitmap, sample);
      texture.unlock();
      this.device.drawMovieTexture(texture, (expandedWidth - 1) >>> 0, (expandedHeight - 1) >>> 0);
      await this.device.present({waitCount: 0});
      return 0;
    } finally {
      this.device.nativeLock.leave();
    }
  }
}
