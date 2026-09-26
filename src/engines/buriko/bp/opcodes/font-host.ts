import {pop32, push32} from '../state.js';
import type {BurikoBpOpcodeHandler} from '../../native/types.js';
import {BurikoSurfaces} from '../../native/surfaces.js';
import {BurikoFontResources} from '../../native/font-resources.js';
import {BurikoSelectionDialog} from '../../native/selection-dialog.js';
import {BurikoBitmapText} from '../../native/font-bitmap.js';
import {BurikoEngineErrors} from '../../native/engine-errors.js';
import {BurikoNativeLanguage} from '../../native/group-81-language.js';

/** Primary 7C/7D consume the concrete native font-resource and surface owners. */
export function createFontHostOpcodes(
  surfaces: BurikoSurfaces,
  resources: BurikoFontResources,
  selection: BurikoSelectionDialog,
  errors: BurikoEngineErrors,
  language: BurikoNativeLanguage,
): Readonly<Record<number, BurikoBpOpcodeHandler>> {
  if (resources.fonts !== surfaces.fonts) throw new Error('Buriko font host owners disagree');
  const text = surfaces.fonts.text;
  const painter = new BurikoBitmapText(surfaces.fonts, surfaces.compositor);
  return {
    0x7c: async ({thread, memory}): Promise<0> => {
      const title = memory.resolve(thread, pop32(thread));
      const output = memory.resolve(thread, pop32(thread));
      push32(
        thread,
        await selection.chooseFont(resources, (language.value & 0x3ff) === 0x11, output, title),
      );
      return 0;
    },
    0x7d: async (context): Promise<0> => {
      const {thread, memory, diagnostics} = context;
      const color = pop32(thread),
        size = pop32(thread),
        count = pop32(thread);
      const source = memory.resolve(thread, pop32(thread));
      const y = pop32(thread),
        x = pop32(thread),
        slot = pop32(thread);
      const fatal = (message: string) =>
        errors.threadFatal(thread, diagnostics, text.encodeWide(message, 0));
      if (slot >= 0x4000) return fatal(`無効なビットマップ番号 [ ${slot | 0} ] が指定されました`);
      if ((count - 1) >>> 0 > 0x3ff)
        return fatal(`無効なデータサイズ [ ${count | 0} ] が指定されました`);
      const bitmap = surfaces.snapshot(slot);
      if (bitmap === null) return fatal(`指定されたビットマップ [ ${slot | 0} ] は存在しません`);
      const font = await surfaces.fonts.get(surfaces.fonts.name(0), size, 100, 0);
      if (font.result === 0x80000002)
        return fatal(`指定されたフォントサイズ [ ${size | 0} ] は無効です`);
      // 1400377a0 returns the initialized output ID zero for its other font errors.
      if (font.result !== 0) return 0;
      painter.drawHex(bitmap, x, y, source, count, font.id, color);
      return 0;
    },
  };
}
