import type {BurikoBpPointer} from '../bp/memory.js';
import {pop32, push32} from '../bp/state.js';
import type {
  BurikoBpOpcodeContext,
  BurikoBpOpcodeHandler,
  BurikoNativeSlotDefinition,
} from './types.js';
import {BurikoChildWindows} from './child-windows.js';
import {BurikoEngineErrors} from './engine-errors.js';
import {readPropertyWord} from './property-values.js';

function pointer(h: BurikoBpOpcodeContext): BurikoBpPointer | null {
  return h.memory.resolve(h.thread, pop32(h.thread));
}
const invalidHandle = '無効なチャイルドウィンドウハンドルが指定されました';
const validModes = new Set([
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x40, 0x41, 0x80,
  0xc0, 0xc1, 0xf0, 0xff,
]);

/** The fourteen B0 auxiliary-window slots, including their intentionally selective fatal statuses. */
export function createGroupB0Children(
  children: BurikoChildWindows,
  errors: BurikoEngineErrors,
): BurikoNativeSlotDefinition[] {
  const definitions: BurikoNativeSlotDefinition[] = [];
  const add = (
    secondary: number,
    nativeAddress: number,
    name: string,
    execute: BurikoBpOpcodeHandler,
  ): void => {
    definitions.push({primary: 0xb0, secondary, nativeAddress, name, execute});
  };
  const fatal = (h: BurikoBpOpcodeContext, message: string): Promise<never> =>
    errors.threadFatal(h.thread, h.diagnostics, children.text.encodeWide(message, 0));
  const checkSurface = async (h: BurikoBpOpcodeContext, slot: number): Promise<void> => {
    if (slot >= 0x4000) await fatal(h, `無効なビットマップ番号 [ ${slot | 0} ] が指定されました`);
  };
  const create = async (h: BurikoBpOpcodeContext, flags: number): Promise<0> => {
    const height = pop32(h.thread),
      width = pop32(h.thread),
      y = pop32(h.thread),
      x = pop32(h.thread),
      title = pointer(h);
    const output = {bytes: new Uint8Array(4), offset: 0};
    const result = children.create(output, title, x, y, width, height, flags);
    if (result === 0x80000001)
      return fatal(h, `無効なウィンドウサイズ [ ${width | 0} , ${height | 0} ] が指定されました`);
    if (result === 0x80000002)
      return fatal(h, 'これ以上、チャイルドウィンドウを生成することはできません');
    push32(h.thread, readPropertyWord(output));
    return 0;
  };
  add(0x10, 0x1400d5c80, 'CreateChildWindow', (h) => create(h, 0));
  add(0x11, 0x1400d5c40, 'DestroyChildWindow', (h) => {
    if (children.close(pop32(h.thread)) === 0)
      return fatal(h, '無効なチャイルドチャイルドウィンドウハンドルが指定されました');
    return 0;
  });
  add(0x12, 0x1400d5b40, 'CreateChildWindowWithScrollbars', (h) => create(h, pop32(h.thread)));
  add(0x14, 0x1400d5af0, 'ShowChildWindow', (h) => {
    const visible = pop32(h.thread),
      id = pop32(h.thread);
    return children.show(id, visible) === 0 ? fatal(h, invalidHandle) : 0;
  });
  add(0x15, 0x1400d5aa0, 'SetChildWindowTitle', (h) => {
    const title = pointer(h),
      id = pop32(h.thread);
    return children.setTitle(id, title) === 0 ? fatal(h, invalidHandle) : 0;
  });
  add(0x16, 0x1400d5a50, 'MoveChildWindow', (h) => {
    const y = pop32(h.thread),
      x = pop32(h.thread),
      id = pop32(h.thread);
    return children.setPosition(id, x, y) === 0 ? fatal(h, invalidHandle) : 0;
  });
  add(0x17, 0x1400d59f0, 'GetChildWindowPosition', (h) => {
    const id = pop32(h.thread),
      output = {bytes: new Uint8Array(8), offset: 0};
    if (children.getPosition(output, id) === 0) return fatal(h, invalidHandle);
    push32(h.thread, readPropertyWord(output));
    push32(h.thread, readPropertyWord({bytes: output.bytes, offset: 4}));
    return 0;
  });
  add(0x18, 0x1400d59a0, 'FillChildWindow', (h) => {
    const color = pop32(h.thread),
      id = pop32(h.thread);
    return children.fill(id, color) === 0 ? fatal(h, invalidHandle) : 0;
  });
  add(0x19, 0x1400d5840, 'CompositeIntoChildWindow', async (h): Promise<0> => {
    const opacity = pop32(h.thread),
      mode = pop32(h.thread),
      surface = pop32(h.thread),
      y = pop32(h.thread),
      x = pop32(h.thread),
      id = pop32(h.thread);
    const actor = h.actor ?? children.surfaces.allocator.currentActor;
    await checkSurface(h, surface);
    if (!validModes.has(mode))
      return fatal(h, `無効なエフェクトモード [ ${mode | 0} ] が指定されました`);
    if (opacity > 256)
      return fatal(
        h,
        `無効なエフェクトレベル／トランスペアレンシィ／オパシティ／アディションレベル [ ${opacity | 0} ] が指定されました`,
      );
    const result = children.surfaces.allocator.withActor(actor, () =>
      children.copy(id, x, y, surface, mode, opacity),
    );
    if (result === 0x80000003)
      return fatal(h, `指定されたビットマップ [ ${surface | 0} ] は存在しません`);
    if (result === 0x80000004)
      return fatal(
        h,
        `画面モードとビットマップ [ ${surface | 0} ] のピクセルモードには互換性がありません`,
      );
    if (result === 0x80000007)
      return fatal(
        h,
        `指定された出力座標 [ ${x | 0} , ${y | 0} ] ではチャイルドウィンドウのクライアント外になります`,
      );
    if (result === 0xffffffff) return fatal(h, invalidHandle);
    return 0;
  });
  add(0x1a, 0x1400d5690, 'DrawTextIntoChildWindow', async (h): Promise<0> => {
    const color = pop32(h.thread),
      proportional = pop32(h.thread),
      bold = pop32(h.thread),
      width = pop32(h.thread),
      size = pop32(h.thread),
      font = pop32(h.thread);
    const source = pointer(h),
      y = pop32(h.thread),
      x = pop32(h.thread),
      id = pop32(h.thread);
    if (children.bitmapText.fonts.name(font) === null)
      return fatal(h, `無効なフォント番号 [ ${font | 0} ] が指定されました`);
    let local: number | undefined;
    const output = {
      get value() {
        if (local === undefined)
          throw new Error('Buriko child text opcode reads its unwritten native output DWORD');
        return local;
      },
      set value(value: number) {
        local = value;
      },
    };
    const result = await children.drawText(
      id,
      x,
      y,
      source,
      font,
      size,
      width,
      bold,
      proportional,
      color,
      output,
      h.actor,
    );
    if (result === 0x80000009)
      return fatal(h, `指定されたフォントサイズ [ ${size | 0} ] は無効です`);
    if (result === 0x8000000a) return fatal(h, `指定されたフォント幅 [ ${width | 0} ] は無効です`);
    if (result === 0x8000000b) return fatal(h, `指定されたフォント番号 [ ${font | 0} ] は無効です`);
    if (result === 0xffffffff) return fatal(h, invalidHandle);
    push32(h.thread, output.value);
    return 0;
  });
  add(0x1b, 0x1400d54b0, 'CopyCropIntoChildWindow', async (h): Promise<0> => {
    const height = pop32(h.thread),
      width = pop32(h.thread),
      top = pop32(h.thread),
      left = pop32(h.thread),
      surface = pop32(h.thread),
      y = pop32(h.thread),
      x = pop32(h.thread),
      id = pop32(h.thread);
    const actor = h.actor ?? children.surfaces.allocator.currentActor;
    await checkSurface(h, surface);
    const result = children.surfaces.allocator.withActor(actor, () =>
      children.copyCrop(id, x, y, surface, left, top, width, height),
    );
    if (result === 0x80000008)
      return fatal(h, `指定されたコピー幅 [ ${width | 0} , ${height | 0} ] は無効な値です`);
    if (result === 0x80000003)
      return fatal(h, `指定されたビットマップ [ ${surface | 0} ] は存在しません`);
    if (result === 0x80000004)
      return fatal(
        h,
        `画面モードとビットマップ [ ${surface | 0} ] のピクセルモードには互換性がありません`,
      );
    if (result === 0x80000007)
      return fatal(
        h,
        `指定されたコピー先座標 [ ${x | 0} , ${y | 0} ] はチャイルドウィンドウのクライアント外になります`,
      );
    if (result === 0x8000000e)
      return fatal(
        h,
        `指定されたコピー元座標 [ ${left | 0} , ${top | 0} ] はコピー元ビットマップの外になります`,
      );
    if (result === 0xffffffff) return fatal(h, invalidHandle);
    return 0;
  });
  add(0x1c, 0x1400d5460, 'SetChildClipboardText', (h) => {
    const source = pointer(h),
      id = pop32(h.thread);
    return children.setClipboard(id, source) === 0xffffffff ? fatal(h, invalidHandle) : 0;
  });
  add(0x1e, 0x1400d5390, 'SetChildScrollProperty', (h) => {
    const value = pop32(h.thread),
      selector = pop32(h.thread),
      id = pop32(h.thread);
    const result = children.setScrollProperty(id, selector, value);
    if (result === 0x8000000c)
      return fatal(
        h,
        `無効なパラメータ番号 [ $${selector.toString(16).toUpperCase().padStart(8, '0')} ] が指定されました`,
      );
    if (result === 0x8000000d)
      return fatal(h, `無効なパラメータの値 [ ${value | 0} ] が指定されました`);
    if (result === 0xffffffff) return fatal(h, invalidHandle);
    push32(h.thread, result);
    return 0;
  });
  add(0x1f, 0x1400d52f0, 'GetChildScrollProperty', (h) => {
    const selector = pop32(h.thread),
      id = pop32(h.thread),
      output = pointer(h);
    const result = children.getScrollProperty(output, id, selector);
    if (result === 0x8000000c)
      return fatal(
        h,
        `無効なパラメータ番号 [ $${selector.toString(16).toUpperCase().padStart(8, '0')} ] が指定されました`,
      );
    if (result === 0xffffffff) return fatal(h, invalidHandle);
    push32(h.thread, result);
    return 0;
  });
  return definitions;
}
