import {BurikoDisplayMap} from './display-map.js';
import type {BurikoDisplayManager} from './display-manager.js';

/** 084070..0844F0, over the actual shared Map pool and display lists. */
export class BurikoMapDisplays {
  constructor(readonly manager: BurikoDisplayManager) {}

  private map(handle: number): BurikoDisplayMap | null {
    const object = this.manager.find('map', handle);
    if (object === null) return null;
    if (!(object instanceof BurikoDisplayMap))
      throw new Error('Buriko map pool contains another display class');
    return object;
  }
  create(): number {
    return this.manager.createSimple(
      'map',
      (order) => new BurikoDisplayMap(this.manager.environment, this.manager.surfaces, order),
    );
  }
  destroy(handle: number): boolean {
    return this.manager.destroy('map', handle);
  }
  setActivation(handle: number, activation: number): boolean {
    const map = this.map(handle);
    if (map === null) return false;
    const before = map.inputActive();
    map.setActivation(activation);
    if (before !== map.inputActive()) map.invalidate();
    return true;
  }
  configure(
    handle: number,
    x: number,
    y: number,
    surface: number,
    blendMode: number,
    blendValue: number,
    layer: number,
  ): -1 | 0 | 1 {
    const map = this.map(handle);
    if (map === null) return -1;
    if (map.inputActive() !== 0) map.invalidate();
    if (!map.configure(x, y, surface, blendMode, blendValue, layer)) return 1;
    if (map.inputActive() !== 0) map.invalidate();
    this.manager.lists.resort(map);
    return 0;
  }
  configureGrid(
    handle: number,
    columns: number,
    rows: number,
    width: number,
    height: number,
  ): -1 | 0 | 2 | 3 {
    const map = this.map(handle);
    if (map === null) return -1;
    const active = map.inputActive();
    if (active !== 0) map.invalidate();
    const result = map.configureGrid(columns, rows, width, height);
    if (result === 0 && active !== 0) map.invalidate();
    return result;
  }
  replaceMap(
    handle: number,
    width: number,
    height: number,
    readBytes: (length: number) => Uint8Array,
  ): -1 | 0 | 4 {
    const map = this.map(handle);
    return map === null ? -1 : map.replaceMap(width, height, readBytes) ? 0 : 4;
  }
  selectView(
    handle: number,
    mapX: number,
    mapY: number,
    pixelX: number,
    pixelY: number,
    wrap: number,
  ): -1 | 0 | 5 {
    const map = this.map(handle);
    if (map === null) return -1;
    if (!map.selectView(mapX, mapY, pixelX, pixelY, wrap)) return 5;
    if (map.inputActive() !== 0) map.invalidate();
    return 0;
  }
  invalidateTile(handle: number, tile: number): -1 | 0 | 6 {
    const map = this.map(handle);
    return map === null ? -1 : map.invalidateTile(tile) ? 0 : 6;
  }
}
