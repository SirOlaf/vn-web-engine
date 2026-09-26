import {pop32, push32} from '../state.js';
import type {AokanaBpOpcodeHandler} from '../../native/types.js';
import {AokanaNativeText, textBytes} from '../../native/text.js';
import {AokanaEngineDialogs} from '../../native/engine-dialogs.js';
import {AokanaEngineErrors} from '../../native/engine-errors.js';
import {writeAokanaClipboard} from '../../native/modal.js';
import {formatAokanaMemoryDump} from '../../native/memory-dump.js';

/** Blocking diagnostics use the same concrete engine-modal state as resource retry dialogs. */
export function createDiagnosticHostOpcodes(
  text: AokanaNativeText,
  dialogs: AokanaEngineDialogs,
  errors: AokanaEngineErrors,
  navigator: Navigator,
): Readonly<Record<number, AokanaBpOpcodeHandler>> {
  const title = (wide: string) => text.encodeWide(wide, 0);
  return {
    0x78: async ({thread, memory}): Promise<0> => {
      const defaultYes = pop32(thread), message = memory.resolve(thread, pop32(thread));
      const answer = await dialogs.show(message, title('確認'), defaultYes !== 0 ? 0x1024 : 0x1124);
      push32(thread, Number(answer === 6));
      return 0;
    },
    0x79: async ({thread, memory, diagnostics}): Promise<0 | 6> => {
      const address = pop32(thread), pointer = memory.resolve(thread, address);
      const message = pointer === null
        ? new TextEncoder().encode(`<Null Pointer ( Address : $${address.toString(16).toUpperCase().padStart(8, '0')} )>`)
        : textBytes(pointer);
      const formatted = diagnostics.formatThreadMessage(thread, message);
      return await dialogs.show(formatted, title('文字列の表示'), 0x1041) === 1 ? 0 : 6;
    },
    0x7a: async ({thread, diagnostics}): Promise<0 | 6> => {
      const value = pop32(thread);
      const message = new TextEncoder().encode(`Number : ${value | 0} ( $${value.toString(16).padStart(8, '0')} )`);
      const formatted = diagnostics.formatThreadMessage(thread, message);
      return await dialogs.show(formatted, title('数値の表示'), 0x1041) === 1 ? 0 : 6;
    },
    0x7b: async (context): Promise<0> => {
      const {thread, memory} = context;
      const count = pop32(thread), pointer = memory.resolve(thread, pop32(thread)), label = memory.resolve(thread, pop32(thread));
      if ((count - 1) >>> 0 > 0x3ff) return errors.threadFatal(thread, context.diagnostics, title(`無効なダンプサイズ [ ${count | 0} ] が指定されました`));
      const message = formatAokanaMemoryDump(pointer, count, label);
      await dialogs.show(message, title('メモリのダンプ'), 0x1000);
      return 0;
    },
    0x7e: async ({thread, memory}): Promise<0> => {
      const pointer = memory.resolve(thread, pop32(thread));
      if (pointer === null) throw new Error('Aokana clipboard decodes a null string');
      const result = await writeAokanaClipboard(navigator, text.decodeAuto(pointer));
      push32(thread, Number(result));
      return 0;
    },
  };
}
