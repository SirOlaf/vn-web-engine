import {pop32} from '../bp/state.js';
import {pointerView} from '../bp/memory.js';
import {BurikoDisplayObject} from './display-object.js';
import type {BurikoDisplayManager} from './display-manager.js';
import type {BurikoEngineErrors} from './engine-errors.js';
import type {
  BurikoBpOpcodeContext,
  BurikoBpOpcodeHandler,
  BurikoNativeSlotDefinition,
} from './types.js';

export function createGroup91ObjectCoordinates(
  manager: BurikoDisplayManager,
  errors: BurikoEngineErrors,
): BurikoNativeSlotDefinition[] {
  const slots: BurikoNativeSlotDefinition[] = [];
  const add = (
    secondary: number,
    nativeAddress: number,
    name: string,
    execute: BurikoBpOpcodeHandler,
  ): void => {
    slots.push({primary: 0x91, secondary, nativeAddress, name, execute});
  };
  const fatal = (h: BurikoBpOpcodeContext, message: string): Promise<never> =>
    errors.threadFatal(h.thread, h.diagnostics, errors.files.text.encodeWide(message, 0));
  const invalid = (h: BurikoBpOpcodeContext): Promise<never> =>
    fatal(h, '無効なオブジェクトハンドルが指定されました');
  const coordinates =
    (apply: (handle: number, x: number, y: number, z: number) => boolean): BurikoBpOpcodeHandler =>
    (h) => {
      const z = pop32(h.thread),
        y = pop32(h.thread),
        x = pop32(h.thread),
        handle = pop32(h.thread);
      return apply(handle, x, y, z) ? 0 : invalid(h);
    };
  add(0x31, 0x1400e1760, 'SetObjectSuppression', (h) => {
    const value = pop32(h.thread),
      handle = pop32(h.thread);
    return manager.setObjectSuppression(handle, value) ? 0 : invalid(h);
  });
  add(
    0x33,
    0x1400e1700,
    'SetObjectCoordinates',
    coordinates((handle, x, y, z) => manager.setObjectCoordinates(handle, x, y, z)),
  );
  add(
    0x36,
    0x1400e16a0,
    'SetObjectSecondaryCoordinateOffset',
    coordinates((handle, x, y, z) => manager.setObjectSecondaryCoordinateOffset(handle, x, y, z)),
  );
  add(
    0x37,
    0x1400e1640,
    'SetObjectCoordinateOffset',
    coordinates((handle, x, y, z) => manager.setObjectCoordinateOffset(handle, x, y, z)),
  );
  add(0x3d, 0x1400e1510, 'ReadObjectEffectivePosition', (h) => {
    const handle = pop32(h.thread),
      output = h.memory.resolve(h.thread, pop32(h.thread)),
      object = manager.resolve(handle);
    if (object === null) return invalid(h);
    if (output === null) throw new Error('Buriko effective-position query writes through null');
    const point = BurikoDisplayObject.prototype.effectivePosition.call(object),
      view = pointerView(output);
    view.setInt32(0, point.x, true);
    view.setInt32(4, point.y, true);
    return 0;
  });
  const childStatus = (h: BurikoBpOpcodeContext, status: number): 0 | Promise<never> => {
    if (status === -1) return fatal(h, '無効なマスターオブジェクトハンドルが指定されました');
    if (status === 6) return fatal(h, '無効なスレーブオブジェクトハンドルが指定されました');
    if (status === 7)
      return fatal(h, '指定されたスレーブオブジェクトはマスターオブジェクト自身です');
    if (status === 8) return fatal(h, '指定されたスレーブオブジェクトにはオーナーが存在します');
    if (status === 9) return fatal(h, '指定されたスレーブオブジェクトは従属していません');
    return 0;
  };
  add(0x3e, 0x1400e1470, 'AttachObjectChild', (h) => {
    const y = pop32(h.thread),
      x = pop32(h.thread),
      child = pop32(h.thread),
      parent = pop32(h.thread);
    return childStatus(h, manager.addObjectChild(parent, child, x, y));
  });
  add(0x3f, 0x1400e1400, 'DetachObjectChild', (h) => {
    const child = pop32(h.thread),
      parent = pop32(h.thread);
    return childStatus(h, manager.removeObjectChild(parent, child));
  });
  return slots;
}
