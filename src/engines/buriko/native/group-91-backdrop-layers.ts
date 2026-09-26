import {pop32} from '../bp/state.js';
import type {BurikoDisplayManager} from './display-manager.js';
import type {BurikoEngineErrors} from './engine-errors.js';
import type {
  BurikoBpOpcodeContext,
  BurikoBpOpcodeHandler,
  BurikoNativeSlotDefinition,
} from './types.js';

export function createGroup91BackdropLayers(
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
  const result = (
    h: BurikoBpOpcodeContext,
    status: number,
    layer: number,
    surface = 0,
    scaleX = 0,
    scaleY = 0,
  ): 0 | Promise<never> => {
    if (status === 1) return fatal(h, '背景表示モードがマルチレイヤモードではありません');
    if (status === 2) return fatal(h, `指定されたレイヤー [ ${layer | 0} ] は無効です`);
    if (status === 3) return fatal(h, `指定されたビットマップ [ ${surface | 0} ] は無効です`);
    if (status === 4)
      return fatal(h, `無効な伸縮倍率 [ ${scaleX | 0} , ${scaleY | 0} ] が指定されました`);
    return 0;
  };
  const bitmapNumber = (h: BurikoBpOpcodeContext, value: number): 0 | Promise<never> =>
    value >>> 0 >= 0x4000
      ? fatal(h, `無効なビットマップ番号 [ ${value | 0} ] が指定されました`)
      : 0;
  add(0x40, 0x1400e12c0, 'ConfigureMultilayerBackdrop', (h) => {
    const sampling = pop32(h.thread),
      scaleY = pop32(h.thread),
      scaleX = pop32(h.thread),
      angle = pop32(h.thread),
      pivotY = pop32(h.thread),
      pivotX = pop32(h.thread),
      surface = pop32(h.thread),
      y = pop32(h.thread),
      x = pop32(h.thread);
    const valid = bitmapNumber(h, surface);
    if (valid !== 0) return valid;
    const status = manager.configureMultilayerBackdrop(
      x,
      y,
      surface,
      pivotX,
      pivotY,
      angle,
      scaleX,
      scaleY,
      sampling,
    );
    return status === 3 || status === 4 ? result(h, status, 0, surface, scaleX, scaleY) : 0;
  });
  add(0x41, 0x1400e1250, 'SelectBackdropLayer', (h) => {
    const layer = pop32(h.thread);
    return result(h, manager.selectBackdropLayer(layer), layer);
  });
  add(0x42, 0x1400e11d0, 'SetBackdropLayerActivation', (h) => {
    const value = pop32(h.thread),
      layer = pop32(h.thread);
    return result(h, manager.setBackdropLayerActivation(layer, value), layer);
  });
  add(0x43, 0x1400e1140, 'SetBackdropLayerPosition', (h) => {
    const y = pop32(h.thread),
      x = pop32(h.thread),
      layer = pop32(h.thread);
    return result(h, manager.setBackdropLayerPosition(layer, x, y), layer);
  });
  add(0x44, 0x1400e10a0, 'SetBackdropLayerMode', (h) => {
    const value = pop32(h.thread),
      layer = pop32(h.thread);
    if (!(
      value <= 9 ||
      (value >= 0x20 && value <= 0x27) ||
      value === 0x40 ||
      value === 0x41 ||
      value === 0x80 ||
      value === 0xc0 ||
      value === 0xc1 ||
      value === 0xf0 ||
      value === 0xff
    ))
      return fatal(h, `無効なエフェクトモード [ ${value | 0} ] が指定されました`);
    return result(h, manager.setBackdropLayerMode(layer, value), layer);
  });
  add(0x45, 0x1400e1000, 'SetBackdropLayerLevel', (h) => {
    const value = pop32(h.thread),
      layer = pop32(h.thread);
    if (value > 0x100)
      return fatal(
        h,
        `無効なエフェクトレベル／トランスペアレンシィ／オパシティ／アディションレベル [ ${value | 0} ] が指定されました`,
      );
    return result(h, manager.setBackdropLayerLevel(layer, value), layer);
  });
  add(0x46, 0x1400e0f10, 'SetBackdropLayerSurface', (h) => {
    const y = pop32(h.thread),
      x = pop32(h.thread),
      surface = pop32(h.thread),
      layer = pop32(h.thread);
    const valid = bitmapNumber(h, surface);
    if (valid !== 0) return valid;
    return result(h, manager.setBackdropLayerSurface(layer, surface, x, y), layer, surface);
  });
  add(0x47, 0x1400e0e20, 'SetBackdropLayerTransform', (h) => {
    const sampling = pop32(h.thread),
      y = pop32(h.thread),
      x = pop32(h.thread),
      angle = pop32(h.thread),
      layer = pop32(h.thread);
    return result(
      h,
      manager.setBackdropLayerTransform(layer, angle, x, y, sampling),
      layer,
      0,
      x,
      y,
    );
  });
  add(0x48, 0x1400e0d90, 'SetBackdropLayerEasing', (h) => {
    const scale = pop32(h.thread),
      angle = pop32(h.thread),
      layer = pop32(h.thread);
    return result(h, manager.setBackdropLayerEasing(layer, angle, scale), layer);
  });
  add(0x49, 0x1400e0d00, 'SetBackdropLayerPivotDelta', (h) => {
    const y = pop32(h.thread),
      x = pop32(h.thread),
      layer = pop32(h.thread);
    return result(h, manager.setBackdropLayerPivotDelta(layer, x, y), layer);
  });
  add(0x4a, 0x1400e0c60, 'SetBackdropLayerTransformDelta', (h) => {
    const y = pop32(h.thread),
      x = pop32(h.thread),
      angle = pop32(h.thread),
      layer = pop32(h.thread);
    return result(h, manager.setBackdropLayerTransformDelta(layer, angle, x, y), layer);
  });
  return slots;
}
