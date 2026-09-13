import {AokanaDisplayManager} from './display-manager.js';
import {AokanaRainDisplayObject, AokanaRainDisplayState} from './display-rain.js';
import {AokanaCrtRandom} from './system-timing.js';
import {AokanaSystemTicks} from './system-ticks.js';

/** Rain's concrete services operate on the actual shared CObjectManager pool. */
export class AokanaRainDisplays {
  constructor(
    readonly manager: AokanaDisplayManager,
    readonly state: AokanaRainDisplayState,
    readonly random: AokanaCrtRandom,
    readonly ticks: AokanaSystemTicks,
  ) {}

  find(handle: number): AokanaRainDisplayObject | null {
    return this.manager.find('rain', handle) as AokanaRainDisplayObject | null;
  }
  create(width: number, height: number): {result: 0; handle: number} | {result: 1 | 3} {
    return this.manager.createConfigured(
      'rain',
      (order) =>
        new AokanaRainDisplayObject(
          this.manager.environment,
          order,
          this.manager.surfaces,
          this.state,
          this.random,
          this.ticks,
        ),
      (object) => object.configureRain(width, height),
    );
  }
  remove(handle: number): boolean {
    return this.manager.destroy('rain', handle);
  }
  start(handle: number, elapsed: number): boolean {
    const object = this.find(handle);
    if (object === null) return false;
    object.start(elapsed);
    return true;
  }
  selectMask(handle: number, mask: number): number {
    const object = this.find(handle);
    if (object === null) return 0xffffffff;
    const result = object.selectMask(mask);
    if (result === 0) {
      if (object.inputActive() !== 0) object.invalidate();
      return 0;
    }
    return result === 0x80000005 ? 4 : result === 0x80000006 ? 5 : 0xffffffff;
  }
  setActivation(handle: number, value: number): boolean {
    const object = this.find(handle);
    if (object === null) return false;
    const old = object.inputActive();
    object.setActivation(value);
    if (old !== object.inputActive()) object.invalidate();
    return true;
  }
  configureDisplay(
    handle: number,
    x: number,
    y: number,
    mode: number,
    value: number,
    layer: number,
  ): number {
    const object = this.find(handle);
    if (object === null) return 0xffffffff;
    if (object.inputActive() !== 0) object.invalidate();
    object.configureDisplay(x, y, mode, value, layer);
    if (object.inputActive() !== 0) object.invalidate();
    this.manager.lists.resort(object);
    return 0;
  }
  /** 0811d0..081670 all map the same three actual rain-setting statuses. */
  updateSetting(handle: number, apply: (object: AokanaRainDisplayObject) => number): number {
    const object = this.find(handle);
    if (object === null) return 0xffffffff;
    const result = apply(object);
    if (result === 0) {
      if (object.inputActive() !== 0) object.invalidate();
      return 0;
    }
    if (result === 0x80000002) return 2;
    if (result === 0x80000004) return 3;
    throw new Error('Aokana rain setter returned outside its verified native result domain');
  }
}
