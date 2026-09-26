import {BurikoDisplayLandscape, type LandscapeWords} from './display-landscape.js';
import type {BurikoDisplayManager} from './display-manager.js';
import type {BurikoNativeInput} from './input.js';

/** 083530..083F00 forwarding owner; all objects live in the shared landscape pool. */
export class BurikoLandscapeDisplays {
  constructor(
    readonly manager: BurikoDisplayManager,
    readonly input: BurikoNativeInput,
  ) {}
  private landscape(handle: number): BurikoDisplayLandscape | null {
    const object = this.manager.find('landscape', handle);
    if (object === null) return null;
    if (!(object instanceof BurikoDisplayLandscape))
      throw new Error('Buriko Landscape pool contains another display class');
    return object;
  }
  create(
    width: number,
    rowStep: number,
    stackStep: number,
    baseline: number,
    rowLayer: number,
    stackLayer: number,
  ): number {
    return this.manager.createSimple(
      'landscape',
      (order) =>
        new BurikoDisplayLandscape(
          this.manager.environment,
          this.manager.surfaces,
          order,
          width,
          rowStep,
          stackStep,
          baseline,
          rowLayer,
          stackLayer,
        ),
    );
  }
  destroy(handle: number): boolean {
    return this.manager.destroy('landscape', handle);
  }
  setActivation(handle: number, value: number): boolean {
    const object = this.landscape(handle);
    if (object === null) return false;
    const active = object.inputActive();
    object.setActivation(value);
    if (active !== object.inputActive()) object.invalidate();
    return true;
  }
  configure(
    handle: number,
    x: number,
    y: number,
    mode: number,
    level: number,
    layer: number,
  ): number {
    const object = this.landscape(handle);
    if (object === null) return -1;
    if (object.inputActive()) object.invalidate();
    object.configure(x, y, mode, level, layer);
    if (object.inputActive()) object.invalidate();
    this.manager.lists.resort(object);
    return 0;
  }
  setColor(
    handle: number,
    row: number,
    column: number,
    mode: number,
    level: number,
    color: number,
  ): number {
    return this.landscape(handle)?.setColor(row, column, mode, level, color) ?? -1;
  }
  loadTerrain(
    handle: number,
    surface: number,
    count: number,
    chips: LandscapeWords,
    cover: number,
    terrainCount: number,
    terrains: LandscapeWords,
  ): number {
    const object = this.landscape(handle);
    if (object === null) return -1;
    const status = object.loadTerrain(surface, count, chips, cover, terrainCount, terrains);
    if (status === 0) {
      if (object.inputActive()) object.invalidate();
      this.manager.lists.resort(object);
    }
    return status;
  }
  replaceCells(handle: number, width: number, height: number, words: LandscapeWords): number {
    const object = this.landscape(handle);
    if (object === null) return -1;
    const status = object.replaceCells(width, height, words);
    if (status === 0) {
      if (object.inputActive()) object.invalidate();
      this.manager.lists.resort(object);
    }
    return status;
  }
  loadOverlays(handle: number, surface: number, count: number, words: LandscapeWords): number {
    return this.landscape(handle)?.loadOverlays(surface, count, words) ?? -1;
  }
  setOverlays(
    handle: number,
    count: number,
    words: LandscapeWords,
    channel: number,
    index: number,
    level: number,
  ): number {
    const object = this.landscape(handle);
    if (object === null) return -1;
    for (let i = 0; i < count >>> 0; i++) {
      const status = object.setOverlay(words(i * 2 + 1), words(i * 2), channel, index, level);
      if (status) return status;
    }
    return 0;
  }
  replaceChip(handle: number, destination: number, source: number): number {
    return this.landscape(handle)?.replaceChip(destination, source) ?? -1;
  }
  replaceCell(handle: number, row: number, column: number, index: number): number {
    const object = this.landscape(handle);
    if (object === null) return -1;
    const status = object.replaceCell(row, column, index);
    if (status === 0) this.manager.lists.resort(object);
    return status;
  }
  readCellLayer(
    handle: number,
    row: number,
    column: number,
    write: (value: number) => void,
  ): number {
    return this.landscape(handle)?.readCellLayer(row, column, write) ?? -1;
  }
  copyCellTop(surface: number, handle: number, row: number, column: number): number {
    return this.landscape(handle)?.copyCellTop(surface, row, column) ?? -1;
  }
  hitCell(handle: number, mode: number, write: (x: number, y: number) => void): number {
    const object = this.landscape(handle);
    if (object === null) return -1;
    const position = object.effectivePosition(),
      [x, y] = this.input.pointerPosition();
    return object.hitCell((x - position.x) | 0, (y - position.y) | 0, mode, write);
  }
  detail(handle: number): number {
    const object = this.landscape(handle);
    if (object === null || object.value124 === undefined)
      throw new Error('Buriko Landscape detail is not initialized');
    return object.value124;
  }
}
