import {pop32, push32} from '../bp/state.js';
import {AokanaTextLayoutState} from './text-layout-state.js';
import {AokanaEngineErrors} from './engine-errors.js';
import type {AokanaBpOpcodeContext, AokanaNativeSlotDefinition} from './types.js';

/** Shared font/policy/overlay settings used by the actual text-procedure and window layout families. */
export function createTextLayoutSettings(
  state: AokanaTextLayoutState,
  errors: AokanaEngineErrors,
): AokanaNativeSlotDefinition[] {
  const fatal = (context: AokanaBpOpcodeContext, message: string): Promise<never> =>
    errors.threadFatal(context.thread, context.diagnostics, state.text.encodeWide(message, 0));
  const readingFont = (context: AokanaBpOpcodeContext, extended: boolean): 0 => {
    const value7 = extended ? pop32(context.thread) : 0xffffffff,
      value6 = extended ? pop32(context.thread) : 0xffffffff,
      y = pop32(context.thread),
      x = pop32(context.thread),
      width = pop32(context.thread),
      size = pop32(context.thread),
      index = pop32(context.thread);
    state.setRegisteredReadingFont(index, size, width, x, y, value6, value7);
    return 0;
  };
  return [
    {
      primary: 0x90,
      secondary: 0x98,
      nativeAddress: 0x1400d8aa0,
      name: 'ConfigureTextOverlayFrames',
      execute: (context) => {
        const source = context.memory.resolve(context.thread, pop32(context.thread)),
          count = pop32(context.thread),
          error = {value: 0};
        if (state.configureOverlayFrames(count, source, error) === 0)
          return fatal(
            context,
            `指定されたビットマップ [ ${error.value | 0} ] は存在しないか、スクリーンと互換性がありません`,
          );
        return 0;
      },
    },
    {
      primary: 0x90,
      secondary: 0x9a,
      nativeAddress: 0x1400d8a10,
      name: 'SetTextOverlayPosition',
      execute: (context) => {
        const y = pop32(context.thread),
          x = pop32(context.thread),
          mode = pop32(context.thread),
          result = state.setOverlayPosition(mode, x, y);
        push32(context.thread, result === 0 ? 0 : result === 0x80000008 ? 1 : 0xffffffff);
        return 0;
      },
    },
    {
      primary: 0x91,
      secondary: 0x97,
      nativeAddress: 0x1400defd0,
      name: 'SetTextReadingFont',
      execute: (context) => readingFont(context, false),
    },
    {
      primary: 0x91,
      secondary: 0x9a,
      nativeAddress: 0x1400dee40,
      name: 'SetTextLayoutPolicy',
      execute: (context) => {
        const value = pop32(context.thread),
          selector = pop32(context.thread),
          result = state.setPolicy(selector, value);
        if (result === 0x80000007)
          return fatal(context, `無効なファンクション番号 [ ${selector | 0} ] が指定されました`);
        if (result === 0x80000008)
          return fatal(context, `無効なファンクションパラメータ [ ${value | 0} ] が指定されました`);
        return 0;
      },
    },
    {
      primary: 0x92,
      secondary: 0x97,
      nativeAddress: 0x1400e3790,
      name: 'SetTextReadingFontExtended',
      execute: (context) => readingFont(context, true),
    },
  ];
}
