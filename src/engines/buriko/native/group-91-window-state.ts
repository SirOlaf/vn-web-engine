import {pop32, push32} from '../bp/state.js';
import {BurikoWindowDisplayObject} from './display-window.js';
import type {BurikoWindowDisplayState} from './display-window-state.js';
import type {BurikoEngineErrors} from './engine-errors.js';
import type {
  BurikoBpOpcodeContext,
  BurikoBpOpcodeHandler,
  BurikoNativeSlotDefinition,
} from './types.js';

/** 91:88..8E share actual Window font/layout state and the real font registry. */
export function createGroup91WindowState(
  state: BurikoWindowDisplayState,
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
  const missing = (h: BurikoBpOpcodeContext): Promise<never> =>
    fatal(h, '無効なウィンドウハンドルが指定されました');
  const find = (handle: number): BurikoWindowDisplayObject | null => {
    const object = state.manager.find('window', handle);
    if (object === null) return null;
    if (!(object instanceof BurikoWindowDisplayObject))
      throw new Error('Buriko Window pool contains a different native class');
    return object;
  };
  add(0x88, 0x1400df780, 'ConfigureWindowFont', async (h): Promise<0> => {
    const extension = pop32(h.thread),
      spacing = pop32(h.thread),
      bold = pop32(h.thread),
      width = pop32(h.thread),
      size = pop32(h.thread),
      font = pop32(h.thread),
      handle = pop32(h.thread);
    const name = state.manager.surfaces.fonts.name(font);
    if (name === null) return fatal(h, `無効なフォント番号 [ ${font | 0} ] が指定されました`);
    const object = find(handle);
    if (object === null) return missing(h);
    object.setCharacterSpacing(spacing);
    object.setTextRightExtension(extension);
    const status = await object.configureFont(name, size, width, bold);
    if (status === 0) return 0;
    if (status === 0x80000002)
      return fatal(h, `指定されたフォントサイズ [ ${size | 0} ] は無効です`);
    if (status === 0x80000003) return fatal(h, `指定されたフォント幅 [ ${width | 0} ] は無効です`);
    if (status === 0x80000004) return fatal(h, `指定されたフォント番号 [ ${font | 0} ] は無効です`);
    throw new Error('Buriko Window font facade reads an unwritten native status');
  });
  add(0x89, 0x1400df700, 'SetWindowLineSpacing', (h) => {
    const value = pop32(h.thread),
      object = find(pop32(h.thread));
    if (object === null) return missing(h);
    return object.setLineSpacing(value) !== 0
      ? 0
      : fatal(h, `指定された隙間係数 [ ${value | 0} ] は無効です`);
  });
  add(0x8a, 0x1400df680, 'SetWindowWritingDirection', (h) => {
    const value = pop32(h.thread),
      object = find(pop32(h.thread));
    if (object === null) return missing(h);
    return object.setWritingDirection(value) !== 0
      ? 0
      : fatal(h, `無効なメッセージ描画スタイル [ ${value | 0} ] が指定されました`);
  });
  add(0x8b, 0x1400df600, 'SetWindowAlignment', (h) => {
    const value = pop32(h.thread),
      object = find(pop32(h.thread));
    if (object === null) return missing(h);
    return object.setAlignment(value) !== 0
      ? 0
      : fatal(h, `無効なメッセージスインギングスタイル [ ${value | 0} ] が指定されました`);
  });
  add(0x8c, 0x1400df5b0, 'SetWindowTextCursor', (h) => {
    const y = pop32(h.thread),
      x = pop32(h.thread),
      object = find(pop32(h.thread));
    if (object === null) return missing(h);
    object.setTextCursor(x, y);
    return 0;
  });
  add(0x8d, 0x1400df550, 'GetWindowTextCursor', (h) => {
    const object = find(pop32(h.thread));
    if (object === null) return missing(h);
    const point = object.getTextCursor();
    push32(h.thread, 1);
    push32(h.thread, point.x);
    push32(h.thread, point.y);
    return 0;
  });
  add(0x8e, 0x1400df500, 'IsWindowTextLineStart', (h) => {
    const object = find(pop32(h.thread));
    if (object === null) return missing(h);
    push32(h.thread, object.atTextLineStart());
    return 0;
  });
  return slots;
}
