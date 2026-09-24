import {pop32} from '../bp/state.js';
import {AokanaWindowDisplayObject} from './display-window.js';
import type {AokanaWindowDisplayState} from './display-window-state.js';
import type {AokanaEngineErrors} from './engine-errors.js';
import type {
  AokanaBpOpcodeContext,
  AokanaBpOpcodeHandler,
  AokanaNativeSlotDefinition,
} from './types.js';

/** Actual Window background/text composition, damage publication and retained-owner reset. */
export function createGroup92WindowImages(
  state: AokanaWindowDisplayState,
  errors: AokanaEngineErrors,
): AokanaNativeSlotDefinition[] {
  const slots: AokanaNativeSlotDefinition[] = [];
  const add = (
    secondary: number,
    nativeAddress: number,
    name: string,
    execute: AokanaBpOpcodeHandler,
  ): void => {
    slots.push({primary: 0x92, secondary, nativeAddress, name, execute});
  };
  const fatal = (h: AokanaBpOpcodeContext, message: string): Promise<never> =>
    errors.threadFatal(h.thread, h.diagnostics, errors.files.text.encodeWide(message, 0));
  const missing = (h: AokanaBpOpcodeContext): Promise<never> =>
    fatal(h, '無効なウィンドウハンドルが指定されました');
  const find = (handle: number): AokanaWindowDisplayObject | null => {
    const object = state.manager.find('window', handle);
    if (object === null) return null;
    if (!(object instanceof AokanaWindowDisplayObject))
      throw new Error('Aokana Window pool contains a different native class');
    return object;
  };
  const invalidate = (object: AokanaWindowDisplayObject): void => {
    if (object.inputActive() !== 0) object.invalidate();
  };
  const draw = (h: AokanaBpOpcodeContext, text: boolean): 0 | Promise<never> => {
    const transparency = pop32(h.thread),
      mode = pop32(h.thread),
      surface = pop32(h.thread),
      y = pop32(h.thread),
      x = pop32(h.thread),
      handle = pop32(h.thread);
    if (surface >= 0x4000)
      return fatal(h, `無効なビットマップ番号 [ ${surface | 0} ] が指定されました`);
    if (!(
      mode <= 9 ||
      (mode >= 0x20 && mode <= 0x27) ||
      mode === 0x40 ||
      mode === 0x41 ||
      mode === 0x80 ||
      mode === 0xc0 ||
      mode === 0xc1 ||
      mode === 0xf0 ||
      mode === 0xff
    ))
      return fatal(h, `無効なエフェクトモード [ ${mode | 0} ] が指定されました`);
    if (transparency > 256)
      return fatal(
        h,
        `無効なエフェクトレベル／トランスペアレンシィ／オパシティ／アディションレベル [ ${transparency | 0} ] が指定されました`,
      );
    const object = find(handle);
    if (object === null) return missing(h);
    const output = {left: 0, top: 0, right: 0, bottom: 0};
    const status = text
      ? object.drawTextSurface(output, x, y, surface, mode, transparency)
      : object.drawBackgroundSurface(output, x, y, surface, mode, transparency);
    if (status === 0) {
      if (object.inputActive() !== 0) state.manager.damage.record(object.sortKey(), output);
      return 0;
    }
    if (status === 2) return fatal(h, `指定されたビットマップ [ ${surface | 0} ] は存在しません`);
    if (status === 4)
      return fatal(
        h,
        `指定されたビットマップ [ ${surface | 0} ] とスクリーンのピクセルモードが一致しません`,
      );
    // Leaf5/6/7 become facade3/4/5; the wrapper returns normally for all three.
    if (status === 5 || status === 6 || status === 7) return 0;
    throw new Error('Aokana Window image facade reads an unwritten native status');
  };
  add(0x88, 0x1400e3ef0, 'SetWindowBackgroundEnabled', (h) => {
    const value = pop32(h.thread),
      object = find(pop32(h.thread));
    if (object === null) return missing(h);
    object.setBackgroundEnabled(value);
    invalidate(object);
    return 0;
  });
  add(0x89, 0x1400e3dc0, 'DrawWindowBackgroundSurface', (h) => draw(h, false));
  add(0x8a, 0x1400e3d70, 'FillWindowBackground', (h) => {
    const value = pop32(h.thread),
      object = find(pop32(h.thread));
    if (object === null) return missing(h);
    object.fillBackground(value);
    return 0;
  });
  add(0x8c, 0x1400e3d20, 'SetWindowTextEnabled', (h) => {
    const value = pop32(h.thread),
      object = find(pop32(h.thread));
    if (object === null) return missing(h);
    object.setTextEnabled(value);
    object.composeAll();
    invalidate(object);
    return 0;
  });
  add(0x8d, 0x1400e3bf0, 'DrawWindowTextSurface', (h) => draw(h, true));
  add(0x8e, 0x1400e3bb0, 'ResetWindowText', (h) => {
    const object = find(pop32(h.thread));
    if (object === null) return missing(h);
    object.resetTextCursor();
    object.clearText();
    object.disableOverlays();
    object.configureInnerObjects(0);
    invalidate(object);
    return 0;
  });
  return slots;
}
