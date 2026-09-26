import {pop32, push32} from '../bp/state.js';
import type {BurikoWindowDisplayState} from './display-window-state.js';
import {BurikoWindowDisplayObject} from './display-window.js';
import type {BurikoEngineErrors} from './engine-errors.js';
import type {BurikoTextLayoutState} from './text-layout-state.js';
import {collectBurikoRegisteredTextAbc} from './text-abc.js';
import type {BurikoBpOpcodeContext, BurikoNativeSlotDefinition} from './types.js';

/** Registered link-font selection needs only the shared text layout and its font-name registry. */
export function createGroup92RegisteredLinkFont(
  state: BurikoTextLayoutState,
): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x92,
      secondary: 0x9d,
      nativeAddress: 0x1400e3170,
      name: 'SetRegisteredLinkFont',
      execute: (context) => {
        const italic = pop32(context.thread),
          bold = pop32(context.thread),
          width = pop32(context.thread),
          size = pop32(context.thread),
          index = pop32(context.thread),
          status = state.setRegisteredAlternateFont(index, size, width, bold, italic);
        push32(
          context.thread,
          status === 0
            ? 0
            : status === 0x80000004
              ? 1
              : status === 0x80000005
                ? 2
                : status === 0x80000006
                  ? 3
                  : 0xffffffff,
        );
        return 0;
      },
    },
  ];
}

/** Actual line-height/link registries, window extent, glyph ABC and layout-result services. */
export function createGroup92TextResults(
  windows: BurikoWindowDisplayState,
  errors: BurikoEngineErrors,
): BurikoNativeSlotDefinition[] {
  const state = windows.textLayout;
  const address = (context: BurikoBpOpcodeContext) =>
    context.memory.resolve(context.thread, pop32(context.thread));
  const fatal = (context: BurikoBpOpcodeContext, message: string): Promise<never> =>
    errors.threadFatal(context.thread, context.diagnostics, state.text.encodeWide(message, 0));
  const registeredLinkFont = createGroup92RegisteredLinkFont(state)[0]!;
  return [
    {
      primary: 0x92,
      secondary: 0x94,
      nativeAddress: 0x1400e3870,
      name: 'CollectTextLineHeights',
      execute: (context) => {
        const id = pop32(context.thread),
          output = address(context);
        push32(context.thread, state.collectLineHeightLayout(output, id));
        return 0;
      },
    },
    {
      primary: 0x92,
      secondary: 0x95,
      nativeAddress: 0x1400e3820,
      name: 'GetWindowTextLineExtent',
      execute: (context) => {
        const handle = pop32(context.thread),
          window = windows.manager.find('window', handle);
        if (window === null) return fatal(context, '無効なウィンドウハンドルが指定されました');
        if (!(window instanceof BurikoWindowDisplayObject))
          throw new Error('Buriko text line query lacks its concrete window');
        push32(context.thread, window.lineExtent);
        return 0;
      },
    },
    {
      primary: 0x92,
      secondary: 0x99,
      nativeAddress: 0x1400e35b0,
      name: 'GetRegisteredTextAbc',
      execute: async (context): Promise<0> => {
        const bold = pop32(context.thread),
          width = pop32(context.thread),
          size = pop32(context.thread),
          font = pop32(context.thread),
          source = address(context),
          count = address(context),
          output = address(context);
        push32(
          context.thread,
          await collectBurikoRegisteredTextAbc(
            state,
            output,
            count,
            source,
            font,
            size,
            width,
            bold,
          ),
        );
        return 0;
      },
    },
    {
      primary: 0x92,
      secondary: 0x9b,
      nativeAddress: 0x1400e3540,
      name: 'GetTextLayoutResult',
      execute: (context) => {
        const selector = pop32(context.thread),
          output = address(context);
        if (state.copyLayoutResult(output, selector) === 0x80000007)
          return fatal(context, `無効なファンクション番号 [ ${selector | 0} ] が指定されました`);
        return 0;
      },
    },
    {
      primary: 0x92,
      secondary: 0x9d,
      nativeAddress: 0x1400e3170,
      name: 'SetRegisteredLinkFont',
      execute: registeredLinkFont.execute,
    },
    {
      primary: 0x92,
      secondary: 0x9e,
      nativeAddress: 0x1400e3140,
      name: 'CollectTextLinkRegions',
      execute: (context) => {
        push32(context.thread, state.collectLinkRegions(address(context)));
        return 0;
      },
    },
    {
      primary: 0x92,
      secondary: 0x9f,
      nativeAddress: 0x1400e3120,
      name: 'SetTextLinkColor',
      execute: (context) => {
        state.linkColor = pop32(context.thread);
        return 0;
      },
    },
  ];
}
