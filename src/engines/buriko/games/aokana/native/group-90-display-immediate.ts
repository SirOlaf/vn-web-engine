import {pop32} from '../bp/state.js';
import type {AokanaDisplayManager} from './display-manager.js';
import type {AokanaEngineErrors} from './engine-errors.js';
import type {
  AokanaBpOpcodeContext,
  AokanaBpOpcodeHandler,
  AokanaNativeSlotDefinition,
} from './types.js';

/** 90:30–3A immediate generic object operations over the actual display manager. */
export function createGroup90DisplayImmediate(
  manager: AokanaDisplayManager,
  errors: AokanaEngineErrors,
): AokanaNativeSlotDefinition[] {
  const slots: AokanaNativeSlotDefinition[] = [],
    fatal = (context: AokanaBpOpcodeContext, message: string): Promise<never> =>
      errors.threadFatal(
        context.thread,
        context.diagnostics,
        errors.files.text.encodeWide(message, 0),
      ),
    invalid = (context: AokanaBpOpcodeContext): Promise<never> =>
      fatal(context, '無効なオブジェクトハンドルが指定されました'),
    hex = (value: number): string => (value >>> 0).toString(16).toUpperCase().padStart(8, '0');
  const add = (
    secondary: number,
    nativeAddress: number,
    name: string,
    execute: AokanaBpOpcodeHandler,
  ): void => {
    slots.push({primary: 0x90, secondary, nativeAddress, name, execute});
  };
  const scalar =
    (apply: (handle: number, value: number) => boolean, validate = false): AokanaBpOpcodeHandler =>
    (context) => {
      const value = pop32(context.thread),
        handle = pop32(context.thread);
      if (validate && value > 0x100)
        return fatal(
          context,
          `無効なエフェクトレベル／トランスペアレンシィ／オパシティ／アディションレベル [ ${value | 0} ] が指定されました`,
        );
      return apply(handle, value) ? 0 : invalid(context);
    };
  const point =
    (apply: (handle: number, x: number, y: number) => boolean): AokanaBpOpcodeHandler =>
    (context) => {
      const y = pop32(context.thread),
        x = pop32(context.thread),
        handle = pop32(context.thread);
      return apply(handle, x, y) ? 0 : invalid(context);
    };
  add(
    0x30,
    0x1400dbe90,
    'SetObjectActivation',
    scalar((handle, value) => manager.setActivation(handle, value)),
  );
  add(
    0x31,
    0x1400dbe40,
    'SetObjectSecondaryVisibility',
    scalar((handle, value) => manager.setSecondaryVisibility(handle, value)),
  );
  add(
    0x32,
    0x1400dbdd0,
    'SetObjectBlendValue',
    scalar((handle, value) => manager.setObjectBlendValue(handle, value), true),
  );
  add(
    0x33,
    0x1400dbd80,
    'MoveObject',
    point((handle, x, y) => manager.move(handle, x, y)),
  );
  add(
    0x34,
    0x1400dbd10,
    'SetObjectTransparency',
    scalar((handle, value) => manager.setObjectTransparency(handle, value), true),
  );
  add(
    0x35,
    0x1400dbca0,
    'SetObjectValueD8',
    scalar((handle, value) => manager.setObjectValueD8(handle, value), true),
  );
  add(
    0x36,
    0x1400dbc50,
    'SetObjectSecondaryOffset',
    point((handle, x, y) => manager.setObjectOffset(handle, x, y, true)),
  );
  add(
    0x37,
    0x1400dbc00,
    'SetObjectOffset',
    point((handle, x, y) => manager.setObjectOffset(handle, x, y, false)),
  );
  add(0x38, 0x1400dbb10, 'SetObjectProperty', (context) => {
    const second = pop32(context.thread),
      first = pop32(context.thread),
      selector = pop32(context.thread),
      handle = pop32(context.thread),
      status = manager.setObjectProperty(handle, selector, first, second);
    if (status === -1) return invalid(context);
    if (status === 5)
      return fatal(
        context,
        `サポートされていないパラメータ番号 [ 0x${hex(selector)} ] が設定されました`,
      );
    if (status === 0xffff)
      return fatal(
        context,
        `設定対象パラメータ [ 0x${hex(selector)} ] の引数 [ ${first | 0} ( 0x${hex(first)} ) , ${second | 0} ( 0x${hex(second)} ) ] に誤りがあります`,
      );
    return 0;
  });
  add(
    0x39,
    0x1400dbaa0,
    'SetObjectOpacityScale',
    scalar((handle, value) => manager.setObjectOpacityScale(handle, value), true),
  );
  add(0x3a, 0x1400dba30, 'SetObjectLayer', (context) => {
    const value = pop32(context.thread),
      handle = pop32(context.thread);
    if (value >= 0x10000)
      return fatal(context, `無効なプライオリティ [ ${value | 0} ] が指定されました`);
    return manager.setObjectLayer(handle, value) === -1 ? invalid(context) : 0;
  });
  return slots;
}
