import {AokanaDisplayEffector} from './display-effector.js';
import {AokanaDisplayFilter} from './display-filter.js';
import type {AokanaDisplayManager} from './display-manager.js';

/** The Bank 90/91 Filter and Effector forwarding owner over the one native display manager. */
export class AokanaFilterDisplays {
  constructor(readonly manager: AokanaDisplayManager) {}

  private filter(handle: number): AokanaDisplayFilter | null {
    const object = this.manager.find('filter', handle);
    if (object === null) return null;
    if (!(object instanceof AokanaDisplayFilter))
      throw new Error('Aokana filter pool contains a different native display class');
    return object;
  }

  private effector(handle: number): AokanaDisplayEffector | null {
    const object = this.manager.find('effector', handle);
    if (object === null) return null;
    if (!(object instanceof AokanaDisplayEffector))
      throw new Error('Aokana effector pool contains a different native display class');
    return object;
  }

  /** 084FD0 constructs and publishes one concrete CDspObjFilter. */
  createFilter(): number {
    return this.manager.createSimple(
      'filter',
      (order) => new AokanaDisplayFilter(this.manager.environment, this.manager.surfaces, order),
    );
  }

  /** 084EE0 uses ordinary list invalidation/removal before deleting its filter. */
  destroyFilter(handle: number): boolean {
    return this.manager.destroy('filter', handle);
  }

  /** 084D40 invalidates only when Filter visibility changes zero-ness. */
  setFilterActivation(handle: number, activation: number): boolean {
    const filter = this.filter(handle);
    if (filter === null) return false;
    const before = filter.inputActive() !== 0;
    filter.setActivation(activation);
    if (before !== (filter.inputActive() !== 0)) filter.invalidate();
    return true;
  }

  /** 084DE0 publishes color fields before its optional mask validation. */
  configureFilter(
    handle: number,
    operation: number,
    color: number,
    maskSurface: number,
    maskShift: number,
    blendValue: number,
    layer: number,
  ): -1 | 0 | 1 | 2 | 3 {
    const filter = this.filter(handle);
    if (filter === null) return -1;
    filter.configureColor(operation, color, blendValue, layer);
    const result = filter.configureMask(maskSurface, maskShift);
    if (result !== 0) {
      if (result === 0x80000001) return 1;
      if (result === 0x80000002) return 2;
      if (result === 0x80000003) return 3;
      throw new Error('Aokana Filter returned an unknown native configuration status');
    }
    if (filter.inputActive() !== 0) filter.invalidate();
    this.manager.lists.resort(filter);
    return 0;
  }

  /** 084C00 constructs, registers and publishes one concrete CDspObjEffector. */
  createEffector(): number {
    return this.manager.createSimple(
      'effector',
      (order) =>
        new AokanaDisplayEffector(
          this.manager.environment,
          this.manager.surfaces,
          this.manager.effectors,
          order,
        ),
    );
  }

  /** 084B10 forces full damage for a visible Effector before deleting it. */
  destroyEffector(handle: number): boolean {
    return this.manager.destroy('effector', handle);
  }

  /** 084630 forces full damage only when Effector visibility changes zero-ness. */
  setEffectorActivation(handle: number, activation: number): boolean {
    const effector = this.effector(handle);
    if (effector === null) return false;
    const before = effector.inputActive() !== 0;
    effector.setActivation(activation);
    if (before !== (effector.inputActive() !== 0)) this.manager.environment.damage.force();
    return true;
  }

  private finishEffectorConfiguration(effector: AokanaDisplayEffector): void {
    if (effector.inputActive() !== 0) this.manager.environment.damage.force();
    this.manager.lists.resort(effector);
  }

  /** 084A00 configures screen vector maps and maps the class's four exact statuses. */
  configureVectorEffector(
    handle: number,
    primaryMap: number,
    secondaryMap: number,
    blendValue: number,
    sampling: number,
    layer: number,
  ): -1 | 0 | 1 | 2 | 3 | 4 {
    const effector = this.effector(handle);
    if (effector === null) return -1;
    const result = effector.configureVectorMaps(
      primaryMap,
      secondaryMap,
      blendValue,
      sampling,
      layer,
    );
    if (result !== 0) {
      if (result === 0x80000001) return 1;
      if (result === 0x80000002) return 2;
      if (result === 0x80000003) return 3;
      if (result === 0x80000004) return 4;
      throw new Error('Aokana vector Effector returned an unknown native status');
    }
    this.finishEffectorConfiguration(effector);
    return 0;
  }

  /** 084950 configures the complete six-selector blur family. */
  configureBlurEffector(
    handle: number,
    selector: number,
    blendValue: number,
    layer: number,
  ): -1 | 0 | 5 {
    const effector = this.effector(handle);
    if (effector === null) return -1;
    const result = effector.configureBlur(selector, blendValue, layer);
    if (result !== 0) {
      if (result === 0x80000005) return 5;
      throw new Error('Aokana blur Effector returned an unknown native status');
    }
    this.finishEffectorConfiguration(effector);
    return 0;
  }

  /** 084830 connects the format-six map to the shared coefficient-table owner. */
  configureDisplacementEffector(
    handle: number,
    mapSurface: number,
    coefficientCount: number,
    coefficientSlot: number,
    blendValue: number,
    layer: number,
  ): -1 | 0 | 1 | 3 | 6 | 7 | 8 {
    const effector = this.effector(handle);
    if (effector === null) return -1;
    const result = effector.configureDisplacement(
      mapSurface,
      coefficientCount,
      coefficientSlot,
      blendValue,
      layer,
    );
    if (result !== 0) {
      if (result === 0x80000001) return 1;
      if (result === 0x80000003) return 3;
      if (result === 0x80000006) return 6;
      if (result === 0x80000007) return 7;
      if (result === 0x80000008) return 8;
      throw new Error('Aokana displacement Effector returned an unknown native status');
    }
    this.finishEffectorConfiguration(effector);
    return 0;
  }

  /** 084740 installs transform bases, animation deltas and layer ordering. */
  configureTransformEffector(
    handle: number,
    pivotX: number,
    pivotY: number,
    angle: number,
    scaleX: number,
    scaleY: number,
    transparency: number,
    blendValue: number,
    layer: number,
  ): -1 | 0 | 9 {
    const effector = this.effector(handle);
    if (effector === null) return -1;
    const result = effector.configureTransform(
      pivotX,
      pivotY,
      angle,
      scaleX,
      scaleY,
      transparency,
      blendValue,
      layer,
    );
    if (result !== 0) {
      if (result === 0x80000009) return 9;
      throw new Error('Aokana transform Effector returned an unknown native status');
    }
    this.finishEffectorConfiguration(effector);
    return 0;
  }

  /** 0846C0 selects persistent feedback over the retained private screen buffer. */
  configureFeedbackEffector(handle: number, blendValue: number, layer: number): -1 | 0 {
    const effector = this.effector(handle);
    if (effector === null) return -1;
    effector.configureFeedback(blendValue, layer);
    this.finishEffectorConfiguration(effector);
    return 0;
  }
}
