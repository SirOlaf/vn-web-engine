import {pop32, push32} from '../bp/state.js';
import type {AokanaBpScheduler} from '../bp/scheduler.js';
import {AokanaBrowserMainWindow} from './browser-main-window.js';
import {AokanaCursorPolicy} from './cursor-policy.js';
import {AokanaInlineTextControl} from './inline-text-control.js';
import {AokanaShakeProcess} from './shake-process.js';
import {AokanaProcedureState} from './procedure.js';
import {AokanaCrtRandom} from './system-timing.js';
import {AokanaEngineErrors} from './engine-errors.js';
import type {
  AokanaBpOpcodeContext,
  AokanaBpOpcodeHandler,
  AokanaNativeSlotDefinition,
} from './types.js';

/** Cursor callbacks share the graph's policy without constructing B0's unrelated host owners. */
export function createGroupB0CursorPolicy(
  cursor: AokanaCursorPolicy,
  errors: AokanaEngineErrors,
): AokanaNativeSlotDefinition[] {
  const fatal = (h: AokanaBpOpcodeContext, message: string): Promise<never> =>
    errors.threadFatal(h.thread, h.diagnostics, errors.files.text.encodeWide(message, 0));
  return [
    {
      primary: 0xb0,
      secondary: 0x04,
      nativeAddress: 0x1400d5f60,
      name: 'SetCursorObject',
      execute: (h) => {
        // The first pop remains in R8D across the other two pops; the decompiler drops it.
        const y = pop32(h.thread),
          x = pop32(h.thread),
          handle = pop32(h.thread);
        return cursor.setCustom(handle, x, y) === -1
          ? fatal(h, '無効なスプライトハンドルが指定されました')
          : 0;
      },
    },
    {
      primary: 0xb0,
      secondary: 0x05,
      nativeAddress: 0x1400d5f40,
      name: 'SetCursorAutoHide',
      execute: (h) => {
        cursor.setAutoHide(pop32(h.thread));
        return 0;
      },
    },
    {
      primary: 0xb0,
      secondary: 0x06,
      nativeAddress: 0x1400d5f10,
      name: 'QueryCursorVisibility',
      execute: (h) => {
        push32(h.thread, cursor.queryVisible());
        return 0;
      },
    },
  ];
}

/** The Unicode EDIT callbacks share one scoped control and selected font provider. */
export function createGroupB0InlineText(
  inline: AokanaInlineTextControl,
  errors: AokanaEngineErrors,
): AokanaNativeSlotDefinition[] {
  const slots: AokanaNativeSlotDefinition[] = [];
  const add = (
    secondary: number,
    nativeAddress: number,
    name: string,
    execute: AokanaBpOpcodeHandler,
  ): void => {
    slots.push({primary: 0xb0, secondary, nativeAddress, name, execute});
  };
  const fatal = (h: AokanaBpOpcodeContext, message: string): Promise<never> =>
    errors.threadFatal(h.thread, h.diagnostics, errors.files.text.encodeWide(message, 0));
  add(0x20, 0x1400d5190, 'CreateInlineText', async (h): Promise<0> => {
    const focus = pop32(h.thread),
      limit = pop32(h.thread),
      size = pop32(h.thread),
      font = pop32(h.thread),
      height = pop32(h.thread),
      width = pop32(h.thread),
      y = pop32(h.thread),
      x = pop32(h.thread);
    const result = await inline.create(x, y, width, height, font, size, limit, focus);
    if (result === 1)
      return fatal(h, `無効なウィンドウサイズ [ ${width | 0}, ${height | 0} ] が指定されました`);
    if (result === 2) return fatal(h, `無効なフォント番号 [ ${font | 0} ] が指定されました`);
    if (result === 3) return fatal(h, `無効なフォントサイズ [ ${size | 0} ] が指定されました`);
    if (result === 4) return fatal(h, `無効な有効文字数 [ ${limit | 0} ] が指定されました`);
    return 0;
  });
  add(0x21, 0x1400d5160, 'CloseInlineText', (h) => {
    push32(h.thread, inline.close());
    return 0;
  });
  add(0x22, 0x1400d5130, 'SetInlineTextWidth', (h) => {
    push32(h.thread, inline.state.setWidthPercent(pop32(h.thread)));
    return 0;
  });
  add(0x23, 0x1400d5110, 'ReadInlineTextVisibility', (h) => {
    push32(h.thread, inline.state.visible);
    return 0;
  });
  add(0x24, 0x1400d50f0, 'ShowInlineText', (h) => {
    inline.show(pop32(h.thread));
    return 0;
  });
  add(0x25, 0x1400d50d0, 'SetInlineTextColor', (h) => {
    inline.state.setColor(pop32(h.thread));
    return 0;
  });
  add(0x26, 0x1400d50b0, 'SetInlineInitialText', (h) => {
    inline.state.setInitial(h.memory.resolve(h.thread, pop32(h.thread)));
    return 0;
  });
  add(0x27, 0x1400d5080, 'ReadInlineText', (h) => {
    push32(h.thread, inline.read(h.memory.resolve(h.thread, pop32(h.thread))));
    return 0;
  });
  add(0x28, 0x1400d5060, 'SetInlineHideOnReturn', (h) => {
    inline.state.hideOnReturn = pop32(h.thread);
    return 0;
  });
  add(0x29, 0x1400d5040, 'SetInlineRejectAscii', (h) => {
    inline.state.rejectAscii = pop32(h.thread);
    return 0;
  });
  add(0x2a, 0x1400d5010, 'SetInlineTextAlignment', (h) => {
    push32(h.thread, inline.state.setAlignment(pop32(h.thread)));
    return 0;
  });
  return slots;
}

/** B0's remaining main-window, cursor, shake and Unicode EDIT services share the real display owner. */
export function createGroupB0Main(
  host: AokanaBrowserMainWindow,
  cursor: AokanaCursorPolicy,
  inline: AokanaInlineTextControl,
  scheduler: AokanaBpScheduler,
  procedures: AokanaProcedureState,
  random: AokanaCrtRandom,
  errors: AokanaEngineErrors,
): AokanaNativeSlotDefinition[] {
  const slots: AokanaNativeSlotDefinition[] = [];
  const add = (
    secondary: number,
    nativeAddress: number,
    name: string,
    execute: AokanaBpOpcodeHandler,
  ): void => {
    slots.push({primary: 0xb0, secondary, nativeAddress, name, execute});
  };
  const fatal = (h: AokanaBpOpcodeContext, message: string): Promise<never> =>
    errors.threadFatal(h.thread, h.diagnostics, errors.files.text.encodeWide(message, 0));
  const [setCursorObject, setCursorAutoHide, queryCursorVisibility] = createGroupB0CursorPolicy(
    cursor,
    errors,
  );
  add(0x00, 0x1400d60b0, 'DrawSurfaceToWindow', (h) => {
    const index = pop32(h.thread),
      y = pop32(h.thread),
      x = pop32(h.thread);
    if (index >= 0x4000)
      return fatal(h, `無効なビットマップ番号 [ ${index | 0} ] が指定されました`);
    if (host.blitSurface(x, y, index) === 2)
      return fatal(h, `指定されたビットマップ [ ${index | 0} ] は存在しません`);
    return 0;
  });
  add(0x02, 0x1400d6080, 'CenterMainWindow', (h) => {
    push32(h.thread, host.center());
    return 0;
  });
  add(0x03, 0x1400d5fc0, 'MoveMainWindow', (h) => {
    const y = pop32(h.thread),
      x = pop32(h.thread);
    push32(h.thread, host.move(x, y));
    return 0;
  });
  add(0x04, 0x1400d5f60, 'SetCursorObject', setCursorObject!.execute);
  add(0x05, 0x1400d5f40, 'SetCursorAutoHide', setCursorAutoHide!.execute);
  add(0x06, 0x1400d5f10, 'QueryCursorVisibility', queryCursorVisibility!.execute);
  add(0x08, 0x1400d5d60, 'ShakeScreen', (h) => {
    const capture = pop32(h.thread),
      tickFrequency = pop32(h.thread),
      decay = pop32(h.thread),
      cycles = pop32(h.thread),
      frequency = pop32(h.thread),
      amplitude = pop32(h.thread),
      mode = pop32(h.thread);
    const process = new AokanaShakeProcess(
      h.thread,
      procedures,
      cursor.clock,
      cursor.input,
      host.display,
      random,
      (x, y) => host.callbacks.presentTransient(x, y),
    );
    const result = process.initialize(
      mode,
      amplitude,
      frequency,
      cycles,
      decay,
      tickFrequency,
      capture,
    );
    if (result === 0x80000001)
      return fatal(h, `無効な振動パターン [ ${mode | 0} ] が指定されました`);
    if (result === 0x80000002)
      return fatal(h, `無効な周波数 [ ${frequency | 0} ] が指定されました`);
    if (result === 0x80000003)
      return fatal(h, `無効な繰り返し回数 [ ${cycles | 0} ] が指定されました`);
    if (result === 0x80000004)
      return fatal(
        h,
        `無効なフレームレート [ ${tickFrequency | 0} ] が指定されました${(tickFrequency | 0) > 0 ? '\n\nフレームレートは周波数より高くなければなりません' : ''}`,
      );
    const scheduled =
      h.thread === scheduler.root.state ? scheduler.root : scheduler.findById(h.thread.id);
    if (scheduled === null || scheduled.state !== h.thread)
      throw new Error('Aokana shake thread is not linked to its scheduler');
    scheduled.installProcess(process);
    return 2;
  });
  slots.push(...createGroupB0InlineText(inline, errors));
  return slots;
}
