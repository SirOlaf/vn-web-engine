import {pointerView, type AokanaBpPointer} from '../bp/memory.js';
import {pop32} from '../bp/state.js';
import type {AokanaEngineErrors} from './engine-errors.js';
import {validateAokanaFontTransform, type AokanaFontTransform} from './font-raster.js';
import type {AokanaNativeFonts} from './fonts.js';
import {textBytes} from './text.js';
import type {AokanaBpOpcodeContext, AokanaNativeSlotDefinition} from './types.js';

/** 0E/0F mutate the font manager's existing transform records and live raster spacing. */
export function createGroup92FontTransform(
  fonts: AokanaNativeFonts,
  errors: AokanaEngineErrors,
): AokanaNativeSlotDefinition[] {
  const address = (context: AokanaBpOpcodeContext) =>
    context.memory.resolve(context.thread, pop32(context.thread));
  const nameBytes = (pointer: AokanaBpPointer | null): Uint8Array => {
    if (pointer === null) throw new Error('Aokana font transform reads a null name');
    return textBytes(pointer, true);
  };
  const fatal = (context: AokanaBpOpcodeContext, message: string): Promise<never> =>
    errors.threadFatal(context.thread, context.diagnostics, fonts.text.encodeWide(message, 0));
  const spacing = (value: number) =>
    Math.fround(Math.fround(value | 0) * Math.fround(1 / 65536)).toFixed(3);
  const hex = (value: number) => (value >>> 0).toString(16).toUpperCase().padStart(5, '0');
  return [
    {
      primary: 0x92,
      secondary: 0x0e,
      nativeAddress: 0x1400e4d10,
      name: 'SetNamedFontTransform',
      execute: async (context): Promise<0> => {
        const vector = address(context),
          count = pop32(context.thread),
          name = address(context);
        if ((count - 4) >>> 0 >= 2)
          return fatal(context, `無効なパラメータ数 [ ${count | 0} ] が指定されました`);
        if (vector === null) throw new Error('Aokana font transform reads a null vector');
        const word = (index: number) =>
          pointerView({bytes: vector.bytes, offset: vector.offset + index * 4}, 4).getInt32(
            0,
            true,
          );
        // B61C0's explicit load order is extra, offsetX, scaleX, offsetY, scaleY.
        const extra = count === 5 ? word(4) : 0,
          offsetX = word(2),
          scaleX = word(0),
          offsetY = word(3),
          scaleY = word(1);
        const transform: AokanaFontTransform = [scaleX, scaleY, offsetX, offsetY, extra];
        // Validation precedes native name traversal, including for null names.
        let status = validateAokanaFontTransform(transform);
        if (status === 0) status = await fonts.setTransform(nameBytes(name), transform);
        if (status === 0x80000005)
          return fatal(
            context,
            `無効な倍率 [ 0x${hex(word(0))} , 0x${hex(word(1))} ] が指定されました`,
          );
        if (status === 0x80000006)
          return fatal(
            context,
            `無効な座標 [ 0x${hex(word(2))} , 0x${hex(word(3))} ] が指定されました`,
          );
        if (status === 0x80000007)
          return fatal(context, `無効な文字間隔の調整値 [ ${spacing(word(4))} ] が指定されました`);
        return 0;
      },
    },
    {
      primary: 0x92,
      secondary: 0x0f,
      nativeAddress: 0x1400e4c50,
      name: 'SetNamedFontExtraSpacing',
      execute: (context) => {
        const extra = pop32(context.thread) | 0,
          name = address(context);
        if (extra < -65536 || extra > 65536)
          return fatal(context, `無効な文字間隔の調整値 [ ${spacing(extra)} ] が指定されました`);
        const status = fonts.setExtra(nameBytes(name), extra);
        if (status === 0x80000008)
          return fatal(
            context,
            `指定されたフォント [ ${fonts.text.decodeCp932(textBytes(name!))} ] の拡張情報は登録されていません`,
          );
        return 0;
      },
    },
  ];
}
