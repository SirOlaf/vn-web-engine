import {pop32} from '../bp/state.js';
import type {BurikoEngineErrors} from './engine-errors.js';
import type {BurikoNativeFonts} from './fonts.js';
import {textBytes} from './text.js';
import type {BurikoBpOpcodeContext, BurikoNativeSlotDefinition} from './types.js';

export function createGroup91FontRasterSettings(
  fonts: BurikoNativeFonts,
  errors: BurikoEngineErrors,
): BurikoNativeSlotDefinition[] {
  const fatal = (h: BurikoBpOpcodeContext, message: string): Promise<never> =>
    errors.threadFatal(h.thread, h.diagnostics, fonts.text.encodeWide(message, 0));
  const hex = (value: number): string => (value >>> 0).toString(16).toUpperCase().padStart(5, '0');
  return [
    {
      primary: 0x91,
      secondary: 0x0e,
      nativeAddress: 0x1400e28c0,
      name: 'SetFontTransform',
      execute: async (h): Promise<0> => {
        const offsetY = pop32(h.thread),
          offsetX = pop32(h.thread),
          scaleY = pop32(h.thread),
          scaleX = pop32(h.thread),
          name = h.memory.resolve(h.thread, pop32(h.thread));
        const result = await fonts.setTransform(() => {
          if (name === null) throw new Error('Buriko font transform consumes a null name');
          return textBytes(name);
        }, [scaleX | 0, scaleY | 0, offsetX | 0, offsetY | 0, 0]);
        if (result === 0x80000005)
          return fatal(h, `無効な倍率 [ 0x${hex(scaleX)} , 0x${hex(scaleY)} ] が指定されました`);
        if (result === 0x80000006)
          return fatal(h, `無効な座標 [ 0x${hex(offsetX)} , 0x${hex(offsetY)} ] が指定されました`);
        return 0;
      },
    },
    {
      primary: 0x91,
      secondary: 0x0f,
      nativeAddress: 0x1400e27b0,
      name: 'SetFontRasterFields',
      execute: async (h): Promise<0> => {
        const field48 = pop32(h.thread),
          field44 = pop32(h.thread),
          bold = pop32(h.thread),
          widthPercent = pop32(h.thread),
          size = pop32(h.thread),
          registeredFont = pop32(h.thread);
        const name = fonts.name(registeredFont);
        const result =
          name === null
            ? 0x80000004
            : await fonts.setRasterFields(name, size, widthPercent, bold, field44, field48);
        if (result === 0x80000002)
          return fatal(h, `無効なフォントサイズ [ ${size | 0} ] が指定されました`);
        if (result === 0x80000003)
          return fatal(h, `無効なフォント幅 [ ${widthPercent | 0} ] が指定されました`);
        if (result === 0x80000004)
          return fatal(h, `無効なフォント番号 [ ${registeredFont | 0} ] が指定されました`);
        return 0;
      },
    },
  ];
}
