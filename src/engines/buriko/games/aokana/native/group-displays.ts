import {AokanaDisplayGroup} from './display-group.js';
import type {AokanaDisplayManager} from './display-manager.js';

/** 080860..080B40, sharing the existing F1 group pool and base relationship owner. */
export class AokanaGroupDisplays {
  constructor(readonly manager: AokanaDisplayManager) {}
  private group(handle: number): AokanaDisplayGroup | null {
    const object = this.manager.find('group', handle);
    if (object === null) return null;
    if (!(object instanceof AokanaDisplayGroup))
      throw new Error('Aokana group pool contains another display class');
    return object;
  }
  create(): number {
    return this.manager.createSimple(
      'group',
      (order) => new AokanaDisplayGroup(this.manager.environment, order),
    );
  }
  destroy(handle: number): boolean {
    return this.manager.destroy('group', handle);
  }
  setActivation(handle: number, value: number): boolean {
    const group = this.group(handle);
    if (group === null) return false;
    const active = group.inputActive();
    group.setActivation(value);
    if (active !== group.inputActive()) group.invalidate();
    return true;
  }
  configure(handle: number, x: number, y: number, level: number): boolean {
    const group = this.group(handle);
    if (group === null) return false;
    if (group.inputActive()) group.invalidate();
    group.move(x, y);
    group.setBlendValue(level);
    if (group.inputActive()) group.invalidate();
    return true;
  }
  addChild(handle: number, targetHandle: number, x: number, y: number): -1 | 0 | 1 | 3 | 4 {
    const group = this.group(handle);
    if (group === null) return -1;
    const target = this.manager.resolve(targetHandle);
    if (target === null) return 1;
    if (group === target) return 3;
    return group.addChild(target, x, y) ? 0 : 4;
  }
  removeChild(handle: number, targetHandle: number): -1 | 0 | 1 | 2 {
    const group = this.group(handle);
    if (group === null) return -1;
    const target = this.manager.resolve(targetHandle);
    if (target === null) return 1;
    return group.removeChild(target) ? 0 : 2;
  }
}
