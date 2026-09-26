import {pop32, push32} from '../bp/state.js';
import {pointerView} from '../bp/memory.js';
import {BurikoWindowDisplayState} from './display-window-state.js';
import {BurikoWindowDisplayObject} from './display-window.js';
import {BurikoEngineErrors} from './engine-errors.js';
import type {
  BurikoBpOpcodeContext,
  BurikoBpOpcodeHandler,
  BurikoNativeSlotDefinition,
} from './types.js';

/** Completed window bitmap/geometry slots. Destruction and text procedures use separate native paths. */
export function createGroup90Windows(
  state: BurikoWindowDisplayState,
  errors: BurikoEngineErrors,
): BurikoNativeSlotDefinition[] {
  const manager = state.manager,
    slots: BurikoNativeSlotDefinition[] = [];
  const add = (
    secondary: number,
    nativeAddress: number,
    name: string,
    execute: BurikoBpOpcodeHandler,
  ): void => {
    slots.push({primary: 0x90, secondary, nativeAddress, name, execute});
  };
  const fatal = (h: BurikoBpOpcodeContext, message: string): Promise<never> =>
    errors.threadFatal(h.thread, h.diagnostics, errors.files.text.encodeWide(message, 0));
  const missing = (h: BurikoBpOpcodeContext): Promise<never> =>
    fatal(h, '無効なウィンドウハンドルが指定されました');
  const find = (handle: number): BurikoWindowDisplayObject | null => {
    const object = manager.find('window', handle);
    if (object === null) return null;
    if (!(object instanceof BurikoWindowDisplayObject))
      throw new Error('Buriko window pool contains a different native display class');
    return object;
  };
  const activeDamage = (object: BurikoWindowDisplayObject): void => {
    if (object.inputActive() !== 0) object.invalidate();
  };
  add(0x80, 0x1400d92b0, 'CreateWindow', (h) => {
    const height = pop32(h.thread),
      width = pop32(h.thread);
    const created = manager.createConfigured(
      'window',
      (order) => new BurikoWindowDisplayObject(state, order),
      (object) => object.configureInitial(width, height),
    );
    if (created.result !== 0)
      return fatal(
        h,
        created.result === 9
          ? 'これ以上、ウィンドウオブジェクトを生成することはできません'
          : `無効なウィンドウ幅 [ ${width | 0} , ${height | 0} ] が指定されました`,
      );
    push32(h.thread, created.handle);
    return 0;
  });
  add(0x82, 0x1400d9140, 'SetWindowCompositionOrder', (h) => {
    const order = pop32(h.thread),
      object = find(pop32(h.thread));
    if (object === null) return missing(h);
    // 067180 returns one for every selector, leaving unknown selectors unchanged.
    object.setCompositionOrder(order);
    object.composeAll();
    activeDamage(object);
    return 0;
  });
  add(0x83, 0x1400d91c0, 'CaptureWindowBitmap', (h) => {
    const handle = pop32(h.thread),
      surface = pop32(h.thread);
    if (surface >= 0x4000)
      return fatal(h, `無効なビットマップ番号 [ ${surface | 0} ] が指定されました`);
    const object = find(handle);
    if (object === null) return missing(h);
    const rectangle = object.localRectangle();
    let format = manager.environment.compositor.defaultFormat;
    if (format === 1) format = 2;
    if (
      manager.surfaces.allocate(
        surface,
        (rectangle.right - rectangle.left + 1) | 0,
        (rectangle.bottom - rectangle.top + 1) | 0,
        format,
      ) !== 0
    ) {
      const destination = manager.surfaces.snapshot(surface);
      if (destination === null)
        throw new Error('Buriko window capture has no allocated surface descriptor');
      object.copyCompositionTo(destination);
    }
    return 0;
  });
  add(0x84, 0x1400d90f0, 'SetWindowActivation', (h) => {
    const value = pop32(h.thread),
      object = find(pop32(h.thread));
    if (object === null) return missing(h);
    const before = object.inputActive();
    object.setActivation(value);
    const after = object.inputActive();
    if ((before === 0) !== (after === 0)) object.invalidate();
    return 0;
  });
  add(0x85, 0x1400d9000, 'ConfigureWindowDisplay', (h) => {
    const layer = pop32(h.thread),
      unusedTransparency = pop32(h.thread),
      blendValue = pop32(h.thread),
      mode = pop32(h.thread),
      y = pop32(h.thread),
      x = pop32(h.thread),
      handle = pop32(h.thread);
    if (layer >= 0x10000) return fatal(h, `無効なプライオリティ [ ${layer | 0} ] が指定されました`);
    for (const value of [unusedTransparency, blendValue])
      if (value > 256)
        return fatal(
          h,
          `無効なエフェクトレベル／トランスペアレンシィ／オパシティ／アディションレベル [ ${value | 0} ] が指定されました`,
        );
    if (!(
      mode <= 9 ||
      (mode >= 0x20 && mode <= 0x27) ||
      [0x40, 0x41, 0x80, 0xc0, 0xc1, 0xf0, 0xff].includes(mode)
    ))
      return fatal(h, `無効なエフェクトモード [ ${mode | 0} ] が指定されました`);
    const object = find(handle);
    if (object === null) return missing(h);
    activeDamage(object);
    object.configureDisplay(x, y, mode, blendValue, layer);
    activeDamage(object);
    manager.lists.resort(object);
    return 0;
  });
  add(0x86, 0x1400d8f10, 'SetWindowBackground', (h) => {
    const background = pop32(h.thread),
      frame = pop32(h.thread),
      decoration = pop32(h.thread),
      object = find(pop32(h.thread));
    if (object === null) return missing(h);
    // D8F10/B4E20 pass only the final bitmap into 068DE0; the other two are diagnostic arguments.
    const result = object.setBackgroundSurface(background);
    if (result === 1) return fatal(h, '指定されたウィンドウは必要なリソースが確保されていません');
    if (result === 2)
      return fatal(
        h,
        `指定されたビットマップのうち、いずれかは登録されていません\n\nDecoration [ ${decoration | 0} ] , Frame [ ${frame | 0} ] , Back [ ${background | 0} ]`,
      );
    activeDamage(object);
    return 0;
  });
  add(0x87, 0x1400d8ec0, 'SetWindowTextMaskMode', (h) => {
    const mode = pop32(h.thread),
      object = find(pop32(h.thread));
    if (object === null) return missing(h);
    object.setTextMaskMode(mode);
    return 0;
  });
  add(0x88, 0x1400d8df0, 'SetWindowTextRegion', (h) => {
    const height = pop32(h.thread),
      width = pop32(h.thread),
      y = pop32(h.thread),
      x = pop32(h.thread),
      object = find(pop32(h.thread));
    if (object === null) return missing(h);
    if (object.setTextRegion(x, y, width, height) === 0)
      return fatal(
        h,
        `ウィンドウの有効範囲として指定された値は無効です\n\n原点座標 [ ${x | 0} , ${y | 0} ] , 横幅 [ ${width | 0} ] , 縦幅 [ ${height | 0} ]`,
      );
    return 0;
  });
  add(0x89, 0x1400d8d90, 'ReadWindowTextRectangle', (h) => {
    const handle = pop32(h.thread),
      output = h.memory.resolve(h.thread, pop32(h.thread)),
      object = find(handle);
    if (object === null) return missing(h);
    if (output === null) throw new Error('Buriko window text rectangle writes through null');
    const rectangle = object.getTextRectangle(),
      view = pointerView(output);
    [rectangle.left, rectangle.top, rectangle.right, rectangle.bottom].forEach((value, index) =>
      view.setInt32(index * 4, value, true),
    );
    push32(h.thread, 1);
    return 0;
  });
  return slots;
}
