import {pop32} from '../bp/state.js';
import type {AokanaEngineErrors} from './engine-errors.js';
import type {AokanaCompressedSurfaceEncoder} from './surface-compressed-encode.js';
import type {AokanaNativeSlotDefinition} from './types.js';

export function createGroup90CompressedEncode(
  encoder: AokanaCompressedSurfaceEncoder,
  errors: AokanaEngineErrors,
): AokanaNativeSlotDefinition[] {
  return [
    {
      primary: 0x90,
      secondary: 0xce,
      nativeAddress: 0x1400d6e40,
      name: 'EncodeCompressedSurface',
      execute: (h) => {
        const quality = pop32(h.thread),
          mode = pop32(h.thread),
          index = pop32(h.thread),
          count = h.memory.resolve(h.thread, pop32(h.thread)),
          output = h.memory.resolve(h.thread, pop32(h.thread)),
          status = encoder.encode(output, count, index, mode, quality);
        let message: string;
        switch (status) {
          case 0x80000006:
            message = `指定されたビットマップ [ ${index | 0} ] はピクセル数が多過ぎます`;
            break;
          case 0x80000008:
            message = '必要なメモリが確保できませんでした';
            break;
          case 0x8000000a:
            message = `参照元に指定されたビットマップ [ ${index | 0} ] は無効です`;
            break;
          case 0x80000011:
            message = `指定されたビットマップ [ ${index | 0} ] のピクセルモードはサポートされていません`;
            break;
          case 0x80000017:
            message = `無効な形式 [ ${mode | 0} ] が指定されました`;
            break;
          case 0x80000018:
            message = `無効なパラメータ [ ${mode | 0} ] が指定されました`;
            break;
          case 0xfffffffe:
            message = 'エンコードに失敗しました';
            break;
          case 0xffffffff:
            message = '想定外のエラーが発生しました';
            break;
          default:
            return 0;
        }
        const encoded = encoder.surfaces.fonts.text.encodeWide(message, 0);
        if (encoded.length > 256)
          throw new RangeError('Aokana encoder diagnostic exceeds native scratch');
        return errors.threadFatal(h.thread, h.diagnostics, encoded);
      },
    },
  ];
}
