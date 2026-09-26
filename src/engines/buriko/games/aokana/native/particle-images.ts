import {allocateAokanaBitmap, type AokanaBitmap} from './bitmap.js';
import {scaleAokanaBitmap} from './bitmap-scale.js';

/** A 110h image record: frame count, 32 scale banks, frame duration and duration spread. */
export class AokanaParticleImages {
  count = 0;
  duration = 0;
  durationSpread = 0;
  readonly scales: Array<AokanaBitmap[] | null> = Array.from({length: 32}, () => null);

  /** 095d70 clears this actual shared image record after releasing its owned scale bitmaps. */
  clear(): void {
    for (let scale = 0; scale < 32; scale++) {
      const frames = this.scales[scale];
      if (frames !== null) for (const frame of frames!) frame.storage?.release();
      this.scales[scale] = null;
    }
    this.count = this.duration = this.durationSpread = 0;
  }

  /** 095e00 validates all descriptors before replacing the record, then builds all 32 scales. */
  configure(
    frames: readonly AokanaBitmap[] | null,
    count: number,
    duration: number,
    durationSpread: number,
  ): number {
    count >>>= 0;
    if (count === 0 || frames === null) {
      this.clear();
      return 0;
    }
    if (count > 32) return 0x80000004;
    const first = frames[0];
    if (first === undefined) throw new Error('Aokana particle image descriptor is absent');
    if ((first.format - 1) >>> 0 > 1) return 0x80000003;
    for (let i = 0; i < count; i++) {
      const frame = frames[i];
      if (frame === undefined) throw new Error('Aokana particle image descriptor is absent');
      if (
        frame.width !== first.width ||
        frame.height !== first.height ||
        frame.format !== first.format
      )
        return 0x80000003;
    }
    this.clear();
    this.count = count;
    this.duration = duration | 0;
    this.durationSpread = durationSpread | 0;
    for (let scale = 0; scale < 32; scale++) {
      const factor = (0x200000 - scale * 0x10000) >>> 5;
      const width = Math.imul(first.width, factor) >>> 16;
      const height = Math.imul(first.height, factor) >>> 16;
      const scaled: AokanaBitmap[] = [];
      this.scales[scale] = scaled;
      for (let i = 0; i < count; i++) {
        const destination = allocateAokanaBitmap(width, height, first.format);
        scaled.push(destination);
        if (destination.storage !== null) scaleAokanaBitmap(destination, frames[i]!, factor);
      }
    }
    return 0;
  }
}

function nativeAbsolute(value: number): number {
  value |= 0;
  return ((value ^ (value >> 31)) - (value >> 31)) | 0;
}

/** Actual 64-variant globals shared by every particle controller. */
export class AokanaParticleVariants {
  readonly snowImages = Array.from({length: 64}, () => new AokanaParticleImages());
  readonly fireflyImages = Array.from({length: 64}, () => new AokanaParticleImages());
  readonly specialFireflyImages = Array.from({length: 64}, () => new AokanaParticleImages());
  readonly specialOptions = new Int32Array(64);
  /** 1e08e0, native 2ch snow records; word zero is the configured flag. */
  readonly snowParameters = Array.from({length: 64}, () => new Int32Array(11));
  /** 1d6de0, native 48h firefly records; word zero is the configured flag. */
  readonly fireflyParameters = Array.from({length: 64}, () => new Int32Array(18));

  /** 09a8a0/09a0d0/09a070 select shared records without maintaining a display-object pool. */
  configureImages(
    kind: 'snow' | 'firefly' | 'special',
    variant: number,
    frames: readonly AokanaBitmap[] | null,
    count: number,
    duration: number,
    durationSpread: number,
    option = 0,
  ): number {
    variant >>>= 0;
    if (variant >= 64) return 0x80000001;
    const images =
      kind === 'snow'
        ? this.snowImages
        : kind === 'firefly'
          ? this.fireflyImages
          : this.specialFireflyImages;
    const result = images[variant]!.configure(frames, count, duration, durationSpread);
    if (kind === 'special' && result === 0) this.specialOptions[variant] = option;
    return result;
  }

  /** 099ff0 and 09a020 use the shared special image count as their availability predicate. */
  hasSpecial(variant: number): boolean {
    variant >>>= 0;
    return variant < 64 && this.specialFireflyImages[variant]!.count !== 0;
  }
  setSpecialOption(variant: number, value: number): number {
    variant >>>= 0;
    if (variant >= 64) return 0x80000001;
    if (!this.hasSpecial(variant)) return 0x80000005;
    this.specialOptions[variant] = value;
    return 0;
  }

  /** 09a8d0 consumes ten DWORD parameters, with the last supplied through a pointer natively. */
  configureSnow(
    variant: number,
    values: readonly number[],
    readAirScale = () => values[9]!,
  ): boolean {
    variant >>>= 0;
    if (variant >= 64) return false;
    if (values.length !== 10)
      throw new Error('Aokana snow configuration requires ten DWORD values');
    const output = this.snowParameters[variant]!;
    output[8] = values[7]! >> 8;
    output[1] = nativeAbsolute(values[0]!) >> 8;
    output[0] = 1;
    for (let i = 1; i < 7; i++)
      output[i + 1] = ([2, 4, 6].includes(i) ? nativeAbsolute(values[i]!) : values[i]!) >> 8;
    const air = readAirScale();
    output[9] = nativeAbsolute(values[8]!) >> 8;
    output[10] = air >> 8;
    return true;
  }

  /** 09a100 preserves raw duration, fade and mode fields while converting selected Q8 inputs. */
  configureFirefly(
    variant: number,
    values: readonly number[],
    readAirScale = () => values[13]!,
  ): boolean {
    variant >>>= 0;
    if (variant >= 64) return false;
    if (values.length !== 17)
      throw new Error('Aokana firefly configuration requires seventeen DWORD values');
    const output = this.fireflyParameters[variant]!;
    output[1] = values[0]!;
    output[0] = 1;
    for (const i of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 14, 16, 12, 15]) {
      let value = values[i]! | 0;
      if ([2, 4, 6, 8, 10].includes(i)) value = nativeAbsolute(value) >> 8;
      else if ([3, 5, 7, 9].includes(i)) value >>= 8;
      else if ((i === 14 || i === 15) && value === 0) value = 1;
      output[i + 1] = value;
    }
    output[14] = readAirScale() >> 8;
    return true;
  }
}
