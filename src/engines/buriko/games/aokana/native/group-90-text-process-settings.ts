import {pop32} from '../bp/state.js';
import type {AokanaEngineErrors} from './engine-errors.js';
import type {AokanaTextLayoutState} from './text-layout-state.js';
import type {AokanaBpOpcodeContext, AokanaNativeSlotDefinition} from './types.js';

/** Eleven installed settings feed the same live state consumed by CProcDspMsg/Ex/VE. */
export function createGroup90TextProcessSettings(
  state: AokanaTextLayoutState,
  errors: AokanaEngineErrors,
): AokanaNativeSlotDefinition[] {
  const fatal = (context: AokanaBpOpcodeContext, message: string): Promise<never> =>
    errors.threadFatal(context.thread, context.diagnostics, state.text.encodeWide(message, 0));
  const steps = (context: AokanaBpOpcodeContext, fade: boolean): 0 | Promise<never> => {
    const interval = pop32(context.thread),
      count = pop32(context.thread);
    if ((count - 1) >>> 0 >= 256)
      return fatal(context, `無効な分割回数 [ ${count | 0} ] が指定されました`);
    if (fade) state.setFadeTiming(count, interval);
    else state.setScrollTiming(count, interval);
    return 0;
  };
  return [
    {
      primary: 0x90,
      secondary: 0x91,
      nativeAddress: 0x1400d8c20,
      name: 'SetMessageCapture',
      execute: (context) => {
        const layer = pop32(context.thread),
          mode = pop32(context.thread),
          status = state.setCapture(mode, layer);
        if (status === 0x80000004)
          return fatal(context, `無効なモード [ ${mode | 0} ] が指定されました`);
        if (status === 0x80000005)
          return fatal(context, `無効なプライオリティ [ ${layer | 0} ] が指定されました`);
        return 0;
      },
    },
    {
      primary: 0x90,
      secondary: 0x92,
      nativeAddress: 0x1400d8c00,
      name: 'SetMessageRedrawSuppression',
      execute: (context) => {
        state.suppressProcedureRedraw = pop32(context.thread);
        return 0;
      },
    },
    {
      primary: 0x90,
      secondary: 0x94,
      nativeAddress: 0x1400d8be0,
      name: 'SetMessageGlyphInterval',
      execute: (context) => {
        state.glyphInterval = pop32(context.thread);
        return 0;
      },
    },
    {
      primary: 0x90,
      secondary: 0x95,
      nativeAddress: 0x1400d8b90,
      name: 'SetMessageScrollTiming',
      execute: (context) => steps(context, false),
    },
    {
      primary: 0x90,
      secondary: 0x96,
      nativeAddress: 0x1400d8b40,
      name: 'SetMessageFadeTiming',
      execute: (context) => steps(context, true),
    },
    {
      primary: 0x90,
      secondary: 0x97,
      nativeAddress: 0x1400d8b10,
      name: 'SetMessageAutomaticWait',
      execute: (context) => {
        const interval = pop32(context.thread),
          enabled = pop32(context.thread);
        state.autoWaitEnabled = enabled;
        state.autoWaitInterval = interval;
        return 0;
      },
    },
    {
      primary: 0x90,
      secondary: 0x99,
      nativeAddress: 0x1400d8a80,
      name: 'SetMessageOverlayInterval',
      execute: (context) => {
        state.overlayFrameInterval = pop32(context.thread);
        return 0;
      },
    },
    {
      primary: 0x90,
      secondary: 0x9b,
      nativeAddress: 0x1400d89e0,
      name: 'SetMessageInitialWait',
      execute: (context) => {
        const interval = pop32(context.thread),
          enabled = pop32(context.thread);
        state.initialWaitEnabled = enabled;
        state.initialWaitInterval = interval;
        return 0;
      },
    },
    {
      primary: 0x90,
      secondary: 0x9c,
      nativeAddress: 0x1400d89c0,
      name: 'SetMessageDefaultEffectMode',
      execute: (context) => {
        state.defaultEffect.mode = pop32(context.thread);
        return 0;
      },
    },
    {
      primary: 0x90,
      secondary: 0x9d,
      nativeAddress: 0x1400d8920,
      name: 'SetMessageDefaultEffectParameters',
      execute: (context) => {
        const opacity = pop32(context.thread),
          y = pop32(context.thread),
          x = pop32(context.thread);
        if ((x | 0) < 0 || (y | 0) < 0)
          return fatal(context, `無効な座標 [ ${x | 0} , ${y | 0} ] が指定されました`);
        if (opacity > 256) return fatal(context, `無効な濃度 [ ${opacity | 0} ] が指定されました`);
        state.setDefaultEffectParameters(x, y, opacity);
        return 0;
      },
    },
    {
      primary: 0x90,
      secondary: 0x9f,
      nativeAddress: 0x1400d8830,
      name: 'SetMessageFinishOnInput',
      execute: (context) => {
        state.finishOnInput = pop32(context.thread);
        return 0;
      },
    },
  ];
}
