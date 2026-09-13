import {pop32, push32} from '../bp/state.js';
import {pointerView} from '../bp/memory.js';
import {AokanaSurfaces} from './surfaces.js';
import {AokanaBitmapLoadState} from './bitmap-load-state.js';
import {AokanaEngineErrors} from './engine-errors.js';
import type {
  AokanaBpOpcodeContext,
  AokanaBpOpcodeHandler,
  AokanaNativeSlotDefinition,
} from './types.js';

/** The completed ordinary surface services. Image-loader and transition slots are registered separately. */
export function createGroup90Surfaces(
  surfaces: AokanaSurfaces,
  loading: AokanaBitmapLoadState,
  errors: AokanaEngineErrors,
): AokanaNativeSlotDefinition[] {
  const slots: AokanaNativeSlotDefinition[] = [];
  const add = (
    secondary: number,
    nativeAddress: number,
    name: string,
    execute: AokanaBpOpcodeHandler,
  ): void => {
    slots.push({primary: 0x90, secondary, nativeAddress, name, execute});
  };
  const fatal = (h: AokanaBpOpcodeContext, message: string): Promise<never> =>
    errors.threadFatal(h.thread, h.diagnostics, errors.files.text.encodeWide(message, 0));
  const invalidIndex = (h: AokanaBpOpcodeContext, index: number): Promise<never> =>
    fatal(h, `無効なビットマップ番号 [ ${index | 0} ] が指定されました`);
  add(0x07, 0x1400ddec0, 'SetBitmapLoadDelay', (h) => {
    loading.setDelay(pop32(h.thread));
    return 0;
  });
  add(0x0b, 0x1400dde20, 'PreserveBitmapImageIds', (h) => {
    surfaces.preserveImageIds = pop32(h.thread);
    return 0;
  });
  add(0x0d, 0x1400ddd70, 'SetFontRasterQuality', async (h): Promise<0> => {
    const quality = pop32(h.thread);
    if (!surfaces.fonts.rasterSettings.setQuality(quality))
      return fatal(h, `無効なアンチエイリアスレベル [ ${quality | 0} ] が指定されました`);
    await surfaces.fonts.rebuild();
    return 0;
  });
  add(0x11, 0x1400dd8b0, 'AllocateBitmap', (h) => {
    const format = pop32(h.thread),
      height = pop32(h.thread),
      width = pop32(h.thread),
      index = pop32(h.thread);
    if (index >= 0x4000) return invalidIndex(h, index);
    const result = surfaces.allocateChecked(index, width, height, format);
    if (result === 0x80000006)
      return fatal(
        h,
        `無効なビットマップサイズ [ ${width | 0} × ${height | 0} ] が指定されています`,
      );
    if (result === 0x80000007)
      return fatal(h, `無効なビットマップ番号 [ ${index | 0} ] が指定されています`);
    if (result === 0x80000011)
      return fatal(
        h,
        `無効なピクセルモード [ ${format | 0} ] が指定された、あるいはメモリの確保に失敗しました`,
      );
    return 0;
  });
  add(0x12, 0x1400dd880, 'ReleaseBitmap', (h) => {
    push32(h.thread, surfaces.release(pop32(h.thread)));
    return 0;
  });
  add(0x13, 0x1400dd820, 'FillBitmap', (h) => {
    const color = pop32(h.thread),
      index = pop32(h.thread);
    if (index >= 0x4000) return invalidIndex(h, index);
    return surfaces.fill(index, color) === 0
      ? fatal(
          h,
          `指定されたビットマップエントリ [ ${index | 0} ] にはビットマップが登録されていません`,
        )
      : 0;
  });
  add(0x14, 0x1400dd780, 'ImportRawBitmap', (h) => {
    const source = h.memory.resolve(h.thread, pop32(h.thread)),
      format = pop32(h.thread),
      height = pop32(h.thread),
      width = pop32(h.thread),
      index = pop32(h.thread);
    if (index >= 0x4000) return invalidIndex(h, index);
    surfaces.importRaw(index, width, height, format, source);
    return 0;
  });
  add(0x16, 0x1400dd620, 'ReadBitmapDescriptor', (h) => {
    const index = pop32(h.thread),
      output = h.memory.resolve(h.thread, pop32(h.thread));
    const bitmap = surfaces.snapshot(index);
    if (bitmap !== null) {
      if (output === null) throw new Error('Aokana bitmap descriptor writes through null');
      const view = pointerView(output);
      view.setInt32(4, bitmap.stride, true);
      view.setInt32(8, bitmap.width, true);
      view.setInt32(12, bitmap.height, true);
      view.setInt32(16, bitmap.format, true);
      view.setInt32(20, bitmap.bytesPerPixel, true);
      view.setInt32(0, 0, true);
    }
    push32(h.thread, Number(bitmap !== null));
    return 0;
  });
  add(0x17, 0x1400dd5e0, 'ConvertBitmapFormat', (h) => {
    const format = pop32(h.thread),
      index = pop32(h.thread);
    push32(h.thread, surfaces.convertFormat(index, format));
    return 0;
  });
  add(0x18, 0x1400dd490, 'CompositeBitmap', (h) => {
    const opacity = pop32(h.thread),
      mode = pop32(h.thread),
      source = pop32(h.thread),
      y = pop32(h.thread),
      x = pop32(h.thread),
      destination = pop32(h.thread);
    if (destination >= 0x4000) return invalidIndex(h, destination);
    if (source >= 0x4000) return invalidIndex(h, source);
    if (!(
      mode <= 9 ||
      (mode >= 0x20 && mode <= 0x27) ||
      [0x40, 0x41, 0x80, 0xc0, 0xc1, 0xf0, 0xff].includes(mode)
    ))
      return fatal(h, `無効なエフェクトモード [ ${mode | 0} ] が指定されました`);
    if (opacity > 256)
      return fatal(
        h,
        `無効なエフェクトレベル／トランスペアレンシィ／オパシティ／アディションレベル [ ${opacity | 0} ] が指定されました`,
      );
    const result = surfaces.drawSurface(destination, x, y, source, mode, opacity);
    if (result === 1)
      return fatal(h, `指定された出力先ビットマップ [ ${destination | 0} ] は存在しません`);
    if (result === 2)
      return fatal(h, `指定された出力元ビットマップ [ ${source | 0} ] は存在しません`);
    if (result === 3)
      return fatal(
        h,
        `出力先ビットマップ [ ${destination | 0} ] と出力元ビットマップ [ ${source | 0} ] のピクセルモードには互換性がありません`,
      );
    return 0;
  });
  add(0x1e, 0x1400dcba0, 'CopyBitmapRegion', (h) => {
    const height = pop32(h.thread),
      width = pop32(h.thread),
      sourceY = pop32(h.thread),
      sourceX = pop32(h.thread),
      source = pop32(h.thread),
      y = pop32(h.thread),
      x = pop32(h.thread),
      destination = pop32(h.thread);
    const result = surfaces.copyRegion(destination, x, y, source, sourceX, sourceY, width, height);
    if (result === 1)
      return fatal(h, `指定された転送先ビットマップ [ ${destination | 0} ] は無効です`);
    if (result === 2) return fatal(h, `指定された転送元ビットマップ [ ${source | 0} ] は無効です`);
    return 0;
  });
  add(0x1f, 0x1400dca90, 'ExtractBitmapRegion', (h) => {
    const height = pop32(h.thread),
      width = pop32(h.thread),
      y = pop32(h.thread),
      x = pop32(h.thread),
      source = pop32(h.thread),
      destination = pop32(h.thread);
    const result = surfaces.extractRegion(destination, source, x, y, width, height);
    if (result === 1)
      return fatal(h, `指定された出力先ビットマップ [ ${destination | 0} ] は無効です`);
    if (result === 2) return fatal(h, `指定された複写元ビットマップ [ ${source | 0} ] は無効です`);
    if (result === 3)
      return fatal(h, `無効な複写範囲 [ ${width | 0} , ${height | 0} ] が指定されました`);
    return 0;
  });
  return slots;
}
