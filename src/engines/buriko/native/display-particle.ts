import {
  allocateBurikoBitmap,
  cropBurikoBitmap,
  fillBurikoBitmap,
  translateBurikoBitmapRectangle,
  type BurikoBitmap,
  type BurikoBitmapRectangle,
} from './bitmap.js';
import {BurikoDisplayObject, type BurikoDisplayObjectEnvironment} from './display-object.js';
import type {BurikoNativeClock} from './clock.js';
import type {BurikoDistributedProcessing} from './distributed-processing.js';
import {BurikoParticleController} from './particle-controller.js';
import type {BurikoParticleVariants} from './particle-images.js';
import type {BurikoCrtRandom} from './system-timing.js';

export type BurikoParticleDwordReader = ((index: number) => number) | null;
const emptyBitmap = (): BurikoBitmap => ({
  storage: null,
  offset: 0,
  stride: 0,
  width: 0,
  height: 0,
  format: 0,
  bytesPerPixel: 0,
});

/** CDspObjPrtclScrn, 060310: controller, expanded layer images and two damage histories. */
export class BurikoParticleDisplayObject extends BurikoDisplayObject {
  readonly controller: BurikoParticleController;
  private layers: BurikoBitmap[] = [];
  private depths: number[] = [];
  private depthSteps: number[] = [];
  private layerOffsets: number[] = [];
  private centerX = 0;
  private centerY = 0;
  maximumDamageRectangles = 4096;
  private damageIndex = 0;
  private readonly damageHistory: [BurikoBitmapRectangle[], BurikoBitmapRectangle[]] = [[], []];

  constructor(
    environment: BurikoDisplayObjectEnvironment,
    order: number,
    variants: BurikoParticleVariants,
    random: BurikoCrtRandom,
    clock: BurikoNativeClock,
    processing: BurikoDistributedProcessing,
  ) {
    super(environment, 4, order, 1);
    this.controller = new BurikoParticleController(
      variants,
      random,
      clock,
      environment.compositor,
      processing,
    );
    this.configureLayers(1, null, null);
  }

  private clearLayerImages(): void {
    for (let i = 0; i < this.layers.length; i++) {
      this.layers[i]!.storage?.release();
      this.layers[i] = emptyBitmap();
    }
  }
  /** 05fa40/041fe0 selects alpha format two only when the global RGB format is one. */
  private resizeLayerImages(): 0 | 1 {
    if (this.bitmap.width === 0 || this.bitmap.height === 0) return 0;
    this.clearLayerImages();
    const format = this.environment.compositor.defaultFormat;
    for (let i = 0; i < this.layers.length; i++) {
      const bitmap = allocateBurikoBitmap(
        this.bitmap.width,
        this.bitmap.height,
        format === 1 ? 2 : format,
      );
      this.layers[i] = bitmap;
      fillBurikoBitmap(bitmap, 0);
    }
    return 1;
  }
  configureParticle(width: number, height: number): 0 | 1 {
    const result = this.configureGeometry(width, height);
    if (result !== 0) {
      this.resizeLayerImages();
      this.centerX = width >>> 1;
      this.centerY = height >>> 1;
    }
    return result;
  }

  /** 05f8b0 validates layer offsets before optionally replacing the reversed expanded keys. */
  private applyLayerOffsets(
    count: number,
    read: BurikoParticleDwordReader,
    validateOnly: boolean,
  ): number {
    count >>>= 0;
    if ((count - 1) >>> 0 >= 16) return 0x80000001;
    const layer = this.getLayer(),
      key = this.sortKey();
    const keys = new Uint32Array(count);
    for (let i = 0; i < count; i++) {
      if (read === null) throw new Error('Buriko particle layer offset pointer is null');
      const offset = read(i) | 0;
      if ((offset + layer) >>> 0 > 65535) return 0x80000004;
      keys[count - i - 1] = (Math.imul(offset, 65536) + key) >>> 0;
    }
    if (!validateOnly) this.replaceExpandedSortKeys(keys);
    return 0;
  }
  /** 05fea0 uses one default far-depth layer and ignores the offset pointer for count one. */
  configureLayers(
    count: number,
    readDepth: BurikoParticleDwordReader,
    readOffset: BurikoParticleDwordReader,
  ): number {
    this.check();
    count >>>= 0;
    if (count === 1) {
      readDepth ??= () => 32767;
      readOffset = () => 0;
    }
    const result = this.applyLayerOffsets(count, readOffset, true);
    if (result !== 0) return result;
    this.clearLayerImages();
    this.layers = Array.from({length: count}, emptyBitmap);
    this.depths = new Array(count);
    this.depthSteps = new Array(count);
    this.layerOffsets = new Array(count);
    let depth = 0;
    for (let i = 0; i < count; i++) {
      if (readDepth === null) throw new Error('Buriko particle layer depth pointer is null');
      depth = (depth + Math.imul(readDepth(i), 256)) | 0;
      this.depths[i] = depth;
      this.depthSteps[i] = readDepth(i) | 0;
      this.layerOffsets[i] = readOffset!(i) | 0;
    }
    this.applyLayerOffsets(count, readOffset, false);
    this.resizeLayerImages();
    return 0;
  }
  override hasExpandedSortKeys(): number {
    this.check();
    return 1;
  }
  override findExpandedSortKey(key: number): number {
    const index = super.findExpandedSortKey(key) | 0;
    return index < 0 ? 0xffffffff : (this.layers.length - index - 1) >>> 0;
  }
  /** 0600a0 rolls the layer field back if its existing offsets no longer fit. */
  override setLayer(value: number): 0 | 1 {
    const previous = this.getLayer();
    if (super.setLayer(value) !== 0) {
      if (this.applyLayerOffsets(this.layers.length, (i) => this.layerOffsets[i]!, false) === 0)
        return 1;
      super.setLayer(previous);
    }
    return 0;
  }
  configureDisplay(x: number, y: number, mode: number, value: number, layer: number): void {
    this.move(x, y);
    this.blendMode = mode | 0;
    this.setBlendValue(value);
    this.setLayer(layer);
  }
  /** 05fc40 saves the draw center even if camera validation subsequently fails. */
  configureCamera(values: readonly number[]): boolean {
    if (values.length !== 9) throw new Error('Buriko particle camera requires nine DWORDs');
    this.centerX = values[7]! | 0;
    this.centerY = values[8]! | 0;
    return this.controller.configureCamera(
      values[0]!,
      values[1]!,
      values[2]!,
      values[3]!,
      values[4]!,
      values[5]!,
      values[6]!,
    );
  }
  updateParticle(): void {
    this.check();
    this.controller.updateFromClock();
  }
  /** 05fc70 draws the new history before recording both current and preceding frame damage. */
  refreshParticle(): void {
    this.check();
    if (this.layers[0]?.storage == null) return;
    for (const layer of this.layers) fillBurikoBitmap(layer, 0);
    this.damageHistory[this.damageIndex as 0 | 1] = this.controller.draw(
      this.layers,
      this.depths,
      this.centerX,
      this.centerY,
    );
    if (
      ((this.damageHistory[0].length + this.damageHistory[1].length) | 0) <
      (this.maximumDamageRectangles | 0)
    ) {
      const key = this.sortKey(),
        position = this.effectivePosition();
      for (const history of this.damageHistory)
        for (const damage of history) {
          const rectangle = {...damage};
          translateBurikoBitmapRectangle(rectangle, position.x, position.y);
          this.environment.damage.record(key, rectangle);
        }
    } else this.invalidate();
    this.damageIndex ^= 1;
  }
  override draw(destination: BurikoBitmap, rectangle: BurikoBitmapRectangle, key: number): void {
    this.check();
    if (this.layers[0]?.storage == null) return;
    const index = this.findExpandedSortKey(key) | 0;
    if (index < 0) return;
    const source = {...this.layers[index]!};
    cropBurikoBitmap(source, rectangle);
    this.environment.compositor.composite(
      destination,
      source,
      this.blendMode,
      this.effectiveBlendValue(),
      true,
    );
  }
  override dispose(): void {
    this.check();
    this.controller.clear();
    this.clearLayerImages();
    this.layers = [];
    this.depths = this.depthSteps = this.layerOffsets = [];
    super.dispose();
  }
}
