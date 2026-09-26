import {
  aokanaBitmapFormatsCompatible,
  aokanaBitmapRectangle,
  clipAokanaBitmapPair,
  cropAokanaBitmap,
  intersectAokanaBitmapRectangle,
  type AokanaBitmap,
} from './bitmap.js';
import {
  addAokana16,
  addAokanaOpaque32,
  copyAokanaTransparent16,
  eraseAokana16,
  eraseAokana32,
  isolateAokanaChannel,
  mixAokana16,
  tintAokana16,
} from './bitmap-scalar.js';
import {
  blendAokanaAlpha,
  blendAokanaAlphaIntoRgb,
  blendAokanaAlphaIntoRgbWithTransparency,
  blendAokanaAlphaWithTransparency,
  mixAokanaAllChannels,
} from './bitmap-alpha.js';
import {
  blendAokanaRgbIntoAlphaWithTransparency,
  clearAokanaBitmap,
  copyAokanaAlphaToRgb,
  copyAokanaBitmapRows,
  copyAokanaMaskToAlpha,
  copyAokanaRgbToAlpha,
} from './bitmap-copy.js';
import {
  addAokanaAlpha,
  addAokanaAlphaIntoRgb,
  dimAokanaAlpha,
  dimAokanaAlphaIntoRgb,
  multiplyAokanaMask,
  multiplyAokanaRgb,
  multiplyAokanaRgbProduct,
} from './bitmap-color.js';
import {
  dimAokanaRgb,
  eraseAokanaAlpha,
  eraseAokanaAlphaFromMask,
  eraseAokanaAlphaFromRgb,
  overlayAokanaBitmap,
  screenAokanaBitmap,
  tintAokanaBitmap32,
} from './bitmap-effects.js';
import type {AokanaDistributedProcessing} from './distributed-processing.js';

export type AokanaBitmapResult = 0 | 1 | 2 | 3;
export type AokanaBitmapDrawResult = AokanaBitmapResult | 4;

/** Native renderer globals, separate from individual CSurfaceManager instances. */
export class AokanaBitmapCompositor {
  /** 1401d1cb4; 1400407b0/1400407c0 select the format of temporary glyph bitmaps. */
  defaultFormat = 0;
  /** 1401D1498; 040730/040740, consumed after raw RGBA surface import. */
  importMatteColor = 0;
  /** 1401d1d10; property 0x01220000. Only the exact value one selects premultiplied addition. */
  additiveAlphaProperty = 0;
  /** 1401d149c; property 0x80111600, consumed by the separately implemented filter operations. */
  filterProperty = 0;
  /** 1401d0478 is null until 1400406c0 explicitly attaches a distributed work manager. */
  processing: AokanaDistributedProcessing | null = null;

  /** 140042720 returns 0x19 for an unknown native selector. */
  setProperty(selector: number, value: number): 0 | 0x19 {
    if (selector >>> 0 === 0x01220000) this.additiveAlphaProperty = value | 0;
    else if (selector >>> 0 === 0x80111600) this.filterProperty = value | 0;
    else return 0x19;
    return 0;
  }

  /** 14003dd70; all other format combinations return without a pixel write. */
  copy(destination: AokanaBitmap, source: AokanaBitmap, maskColor = 0): void {
    if (destination.format === source.format) copyAokanaBitmapRows(destination, source);
    else if (source.format === 1 && destination.format === 2)
      copyAokanaRgbToAlpha(destination, source);
    else if (source.format === 2 && destination.format === 1)
      copyAokanaAlphaToRgb(destination, source);
    else if (source.format === 3 && destination.format === 2)
      copyAokanaMaskToAlpha(destination, source, maskColor);
  }

  private normal(destination: AokanaBitmap, source: AokanaBitmap): void {
    if (source.format === 0) copyAokanaTransparent16(destination, source);
    else if (source.format === 1) {
      if (destination.format === 1) copyAokanaBitmapRows(destination, source);
      else if (destination.format === 2) copyAokanaRgbToAlpha(destination, source);
    } else if (source.format === 2) {
      if (destination.format === 1) blendAokanaAlphaIntoRgb(destination, source);
      else if (destination.format === 2) blendAokanaAlpha(destination, source);
    }
  }

  private transparent(destination: AokanaBitmap, source: AokanaBitmap, transparency: number): void {
    if (transparency === 0) {
      this.normal(destination, source);
      return;
    }
    if (transparency >= 256) return;
    if (source.format === 0 && destination.format === 0)
      mixAokana16(destination, source, transparency, true);
    else if (source.format === 1) {
      if (destination.format === 1) mixAokanaAllChannels(destination, source, transparency);
      else if (destination.format === 2)
        blendAokanaRgbIntoAlphaWithTransparency(destination, source, transparency);
    } else if (source.format === 2) {
      if (destination.format === 1)
        blendAokanaAlphaIntoRgbWithTransparency(destination, source, transparency);
      else if (destination.format === 2)
        blendAokanaAlphaWithTransparency(destination, source, transparency);
    }
  }

  private add(destination: AokanaBitmap, source: AokanaBitmap, opacity: number): void {
    if (opacity === 0) return;
    if (source.format === 0) addAokana16(destination, source, opacity);
    else if (source.format === 1 && (destination.format === 1 || destination.format === 2))
      addAokanaOpaque32(destination, source, opacity);
    else if (source.format === 2) {
      if (destination.format === 1) addAokanaAlphaIntoRgb(destination, source, opacity);
      else if (destination.format === 2)
        addAokanaAlpha(destination, source, opacity, this.additiveAlphaProperty);
    }
  }

  private subtract(destination: AokanaBitmap, source: AokanaBitmap, opacity: number): void {
    if (opacity !== 0 && source.format === 2 && destination.format === 1)
      addAokanaAlphaIntoRgb(destination, source, opacity, true);
  }

  private multiply(destination: AokanaBitmap, source: AokanaBitmap, opacity: number): void {
    if (opacity === 0) return;
    if (source.format === 1) {
      if (destination.format === 1) multiplyAokanaRgb(destination, source, opacity);
      else if (destination.format === 2)
        multiplyAokanaRgbProduct(destination, source, opacity, false);
    } else if (source.format === 2 && destination.format === 1)
      multiplyAokanaRgbProduct(destination, source, opacity, true);
    else if (source.format === 3 && destination.format === 3)
      multiplyAokanaMask(destination, source, opacity);
  }

  /** 14003a2d0 does not use opacity to attenuate the output alpha of format two. */
  dim(destination: AokanaBitmap, source: AokanaBitmap, transparency: number): void {
    if (transparency === 0) {
      this.copy(destination, source);
      return;
    }
    if (source.format === 0 && destination.format === 0)
      tintAokana16(destination, source, 0, transparency);
    else if (source.format === 1 && destination.format === 1) {
      if (transparency >= 256) clearAokanaBitmap(destination);
      else dimAokanaRgb(destination, source, transparency);
    } else if (source.format === 2) {
      if (destination.format === 1) dimAokanaAlphaIntoRgb(destination, source, transparency);
      else if (destination.format === 2) dimAokanaAlpha(destination, source, transparency);
    }
  }

  /** 140046860: a zero tint takes the separate dimming path. */
  tint(destination: AokanaBitmap, source: AokanaBitmap, color: number, opacity: number): void {
    if ((color | 0) === 0) {
      this.dim(destination, source, opacity);
      return;
    }
    if (destination.format !== source.format) return;
    if (source.format === 0) tintAokana16(destination, source, color, opacity);
    else if (source.format === 1 || source.format === 2)
      tintAokanaBitmap32(destination, source, color, opacity);
  }

  private effect(
    destination: AokanaBitmap,
    source: AokanaBitmap,
    opacity: number,
    mode: number,
  ): void {
    if (opacity === 0) return;
    if (mode === 7) {
      if (source.format !== 2) return;
      if (destination.format === 1) eraseAokanaAlphaFromRgb(destination, source, opacity);
      else if (destination.format === 2) eraseAokanaAlpha(destination, source, opacity);
      else if (destination.format === 3) eraseAokanaAlphaFromMask(destination, source, opacity);
    } else if (destination.format === 1 && (source.format === 1 || source.format === 2)) {
      if (mode === 6) screenAokanaBitmap(destination, source, opacity, source.format === 2);
      else overlayAokanaBitmap(destination, source, opacity, source.format === 2, mode === 9);
    }
  }

  /** 140052e80/140052d70 partition rows using unsigned Q16 steps and per-descriptor last heights. */
  private distribute(
    destination: AokanaBitmap,
    source: AokanaBitmap,
    mode: number,
    opacity: number,
  ): boolean {
    const processing = this.processing;
    if (processing === null) return false;
    const common = {...source};
    cropAokanaBitmap(common, aokanaBitmapRectangle(destination));
    cropAokanaBitmap(common, aokanaBitmapRectangle(source));
    const width = common.width >>> 0;
    const height = common.height >>> 0;
    if (Math.imul(width, height) >>> 0 <= 0x9ff || processing.capacity <= 1) return false;
    let count = processing.capacity >>> 0;
    let step = Math.trunc(((height << 16) >>> 0) / count) >>> 0;
    let pixelsPerJob = Math.imul(Math.trunc(height / count), width) >>> 0;
    while (pixelsPerJob > 0xa000) {
      count = (count * 2) >>> 0;
      step >>>= 1;
      pixelsPerJob >>>= 1;
    }
    if (step <= 65535) return false;
    const jobs: {destination: AokanaBitmap; source: AokanaBitmap}[] = [];
    let fraction = 0;
    let firstRow = 0;
    for (let index = 0; index < count; index++) {
      const next = (fraction + step) >>> 0;
      const rows = next >>> 16;
      const partition = (bitmap: AokanaBitmap): AokanaBitmap => ({
        ...bitmap,
        offset: bitmap.offset + Math.imul(bitmap.stride, firstRow),
        height: index + 1 === count ? (bitmap.height - firstRow) | 0 : rows,
      });
      jobs.push({destination: partition(destination), source: partition(source)});
      fraction = next & 65535;
      firstRow = (firstRow + rows) | 0;
    }
    const work = {next: 0, jobs};
    processing.setCallback(() => {
      const ownership = processing.enterShared();
      const job = work.jobs[work.next];
      if (job !== undefined) work.next++;
      processing.leaveShared(ownership);
      if (job === undefined) return 0;
      this.composite(job.destination, job.source, mode, opacity, false);
      return 1;
    }, work);
    processing.run(1);
    processing.setCallback(null, null);
    return true;
  }

  /** 14003ddc0 dispatches every supported mode; worker callbacks suppress recursive distribution. */
  composite(
    destination: AokanaBitmap,
    source: AokanaBitmap,
    mode: number,
    opacity: number,
    parallel = false,
  ): AokanaBitmapResult {
    mode >>>= 0;
    opacity >>>= 0;
    if (!aokanaBitmapFormatsCompatible(destination.format, source.format)) return 1;
    if (opacity > 256) return 3;
    if (parallel && this.distribute(destination, source, mode, opacity)) return 0;
    switch (mode) {
      case 0:
        this.normal(destination, source);
        break;
      case 1:
      case 0x20:
        this.transparent(destination, source, opacity);
        break;
      case 2:
        this.add(destination, source, opacity);
        break;
      case 3:
        this.subtract(destination, source, opacity);
        break;
      case 4:
        this.multiply(destination, source, opacity);
        break;
      case 5:
      case 0xc0:
        this.dim(destination, source, opacity);
        break;
      case 6:
      case 7:
      case 8:
      case 9:
        this.effect(destination, source, opacity, mode);
        break;
      case 0x21:
        this.add(destination, source, 256 - opacity);
        break;
      case 0x22:
        this.subtract(destination, source, 256 - opacity);
        break;
      case 0x23:
        this.multiply(destination, source, 256 - opacity);
        break;
      case 0x24:
      case 0x25:
      case 0x26:
      case 0x27:
        this.effect(destination, source, 256 - opacity, mode - 0x1e);
        break;
      case 0x40:
        if (source.format === 0) eraseAokana16(destination, source);
        else if (
          (source.format === 1 || source.format === 2) &&
          (destination.format === 1 || destination.format === 2)
        )
          eraseAokana32(destination, source, opacity);
        break;
      case 0x41: {
        const rectangle = aokanaBitmapRectangle(destination);
        if (intersectAokanaBitmapRectangle(rectangle, aokanaBitmapRectangle(source)))
          clearAokanaBitmap(destination, rectangle);
        break;
      }
      case 0x80:
        this.copy(destination, source);
        break;
      case 0xc1:
        this.tint(destination, source, 0xffffff, opacity);
        break;
      case 0xf0:
        if (opacity === 0) this.copy(destination, source);
        else if (opacity < 256) {
          if (source.format === 0) mixAokana16(destination, source, opacity, false);
          else if (source.format === 1 || source.format === 2)
            mixAokanaAllChannels(destination, source, opacity);
        }
        break;
      case 0xff:
        if (opacity > 3) this.normal(destination, source);
        else if (source.format === 1 || source.format === 2)
          isolateAokanaChannel(destination, source, opacity);
        break;
      default:
        return 2;
    }
    return 0;
  }

  /** 1400414b0 clips both descriptors before composition and permits native row distribution. */
  draw(
    destination: AokanaBitmap,
    x: number,
    y: number,
    source: AokanaBitmap,
    mode: number,
    opacity: number,
  ): AokanaBitmapDrawResult {
    const clipped = clipAokanaBitmapPair(destination, x, y, source);
    return clipped === null
      ? 4
      : this.composite(clipped.destination, clipped.source, mode, opacity, true);
  }
}
