import {pop32, push32} from '../bp/state.js';
import {pointerBytes} from '../bp/opcodes/operands.js';
import type {BurikoBpPointer} from '../bp/memory.js';
import type {BurikoEngineErrors} from './engine-errors.js';
import type {BurikoLandscapeDisplays} from './landscape-displays.js';
import type {BurikoBpOpcodeContext, BurikoNativeSlotDefinition} from './types.js';

/** Bank 91 Landscape wrappers, 0DF8D0..0E0510, over the shared display owner. */
export function createGroup91Landscapes(
  landscapes: BurikoLandscapeDisplays,
  errors: BurikoEngineErrors,
): BurikoNativeSlotDefinition[] {
  const fatal = (h: BurikoBpOpcodeContext, message: string): Promise<never> =>
    errors.threadFatal(h.thread, h.diagnostics, errors.files.text.encodeWide(message, 0));
  const invalid = (h: BurikoBpOpcodeContext): Promise<never> =>
    fatal(h, '無効なランドスケープハンドルが指定されました');
  const noMap = '指定されたランドスケープオブジェクトにはマップが設定されていません';
  const noTerrain = '指定されたランドスケープオブジェクトには柱が設定されていません';
  const rowError = (value: number): string => `無効なライン番号 [ ${value | 0} ] が指定されました`;
  const columnError = (value: number): string =>
    `無効なカラム番号 [ ${value | 0} ] が指定されました`;
  const bitmapError = (value: number): string =>
    `無効なビットマップ番号 [ ${value | 0} ] が指定されました`;
  const levelError = (value: number): string =>
    `無効なエフェクトレベル／トランスペアレンシィ／オパシティ／アディションレベル [ ${value | 0} ] が指定されました`;
  const words =
    (pointer: BurikoBpPointer | null) =>
    (index: number): number => {
      if (pointer === null) throw new Error('Buriko Landscape dereferences a null input pointer');
      const bytes = pointerBytes(pointer, 4, index * 4);
      return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
    };
  const write = (pointer: BurikoBpPointer | null, index: number, value: number): void => {
    if (pointer === null) throw new Error('Buriko Landscape dereferences a null output pointer');
    const bytes = pointerBytes(pointer, 4, index * 4);
    new DataView(bytes.buffer, bytes.byteOffset, 4).setUint32(0, value, true);
  };
  const cellError = (
    h: BurikoBpOpcodeContext,
    status: number,
    row: number,
    column: number,
  ): Promise<never> | null =>
    status === 11
      ? fatal(h, rowError(row))
      : status === 12
        ? fatal(h, columnError(column))
        : status === 13
          ? fatal(h, noMap)
          : status === -1
            ? invalid(h)
            : null;
  return [
    {
      primary: 0x91,
      secondary: 0x70,
      nativeAddress: 0x1400e0510,
      name: 'CreateLandscapeDisplay',
      execute: (h) => {
        const stackLayer = pop32(h.thread),
          rowLayer = pop32(h.thread),
          baseline = pop32(h.thread),
          stackStep = pop32(h.thread),
          rowStep = pop32(h.thread),
          width = pop32(h.thread);
        const handle = landscapes.create(width, rowStep, stackStep, baseline, rowLayer, stackLayer);
        if (!handle)
          return fatal(h, 'これ以上、ランドスケープオブジェクトを生成する事は出来ません');
        push32(h.thread, handle);
        return 0;
      },
    },
    {
      primary: 0x91,
      secondary: 0x71,
      nativeAddress: 0x1400e04d0,
      name: 'DestroyLandscapeDisplay',
      execute: (h) => (landscapes.destroy(pop32(h.thread)) ? 0 : invalid(h)),
    },
    {
      primary: 0x91,
      secondary: 0x73,
      nativeAddress: 0x1400e0440,
      name: 'HitLandscapePointer',
      execute: (h) => {
        const mode = pop32(h.thread),
          handle = pop32(h.thread),
          output = h.memory.resolve(h.thread, pop32(h.thread));
        const result = landscapes.hitCell(handle, mode, (x, y) => {
          write(output, 0, x);
          write(output, 1, y);
        });
        if (result === 13) return fatal(h, noMap);
        if (result === -1) return invalid(h);
        push32(h.thread, result === 0 ? 1 : 0);
        return 0;
      },
    },
    {
      primary: 0x91,
      secondary: 0x74,
      nativeAddress: 0x1400e03f0,
      name: 'SetLandscapeActivation',
      execute: (h) => {
        const active = pop32(h.thread),
          handle = pop32(h.thread);
        return landscapes.setActivation(handle, active) ? 0 : invalid(h);
      },
    },
    {
      primary: 0x91,
      secondary: 0x75,
      nativeAddress: 0x1400e0310,
      name: 'ConfigureLandscapeDisplay',
      execute: (h) => {
        const layer = pop32(h.thread),
          level = pop32(h.thread),
          mode = pop32(h.thread),
          y = pop32(h.thread),
          x = pop32(h.thread),
          handle = pop32(h.thread);
        if (layer >= 0x10000)
          return fatal(h, `無効なプライオリティ [ ${layer | 0} ] が指定されました`);
        if (level > 256) return fatal(h, levelError(level));
        if (!(
          mode <= 9 ||
          (mode >= 0x20 && mode <= 0x27) ||
          [0x40, 0x41, 0x80, 0xc0, 0xc1, 0xf0, 0xff].includes(mode)
        ))
          return fatal(h, `無効なエフェクトモード [ ${mode | 0} ] が指定されました`);
        return landscapes.configure(handle, x, y, mode, level, layer) === -1 ? invalid(h) : 0;
      },
    },
    {
      primary: 0x91,
      secondary: 0x76,
      nativeAddress: 0x1400e01a0,
      name: 'SetLandscapeCellColor',
      execute: (h) => {
        const color = pop32(h.thread),
          level = pop32(h.thread),
          mode = pop32(h.thread),
          column = pop32(h.thread),
          row = pop32(h.thread),
          handle = pop32(h.thread);
        const result = landscapes.setColor(handle, row, column, mode, level, color);
        if (result === 18)
          return fatal(h, `無効なシルエットタイプ [ ${mode | 0} ] が指定されました`);
        if (result === 19)
          return fatal(h, `無効なシルエットレベル [ ${level | 0} ] が指定されました`);
        return cellError(h, result, row, column) ?? 0;
      },
    },
    {
      primary: 0x91,
      secondary: 0x78,
      nativeAddress: 0x1400e0030,
      name: 'LoadLandscapeTerrain',
      execute: (h) => {
        const terrains = h.memory.resolve(h.thread, pop32(h.thread)),
          terrainCount = pop32(h.thread),
          cover = pop32(h.thread),
          chips = h.memory.resolve(h.thread, pop32(h.thread)),
          count = pop32(h.thread),
          surface = pop32(h.thread),
          handle = pop32(h.thread);
        const result = landscapes.loadTerrain(
          handle,
          surface,
          count,
          words(chips),
          cover,
          terrainCount,
          words(terrains),
        );
        if (result === 1) return fatal(h, bitmapError(surface));
        if (result === 2)
          return fatal(
            h,
            `部品番号 [ ${landscapes.detail(handle) | 0} ] に無効な情報が指定されています`,
          );
        if (result === 3)
          return fatal(
            h,
            `柱番号 [ ${landscapes.detail(handle) | 0} ] に無効な情報が指定されています`,
          );
        return result === -1 ? invalid(h) : 0;
      },
    },
    {
      primary: 0x91,
      secondary: 0x79,
      nativeAddress: 0x1400dff60,
      name: 'ReplaceLandscapeCells',
      execute: (h) => {
        const cells = h.memory.resolve(h.thread, pop32(h.thread)),
          height = pop32(h.thread),
          width = pop32(h.thread),
          handle = pop32(h.thread);
        const result = landscapes.replaceCells(handle, width, height, words(cells));
        if (result === 4) return fatal(h, noTerrain);
        if (result === 5)
          return fatal(h, `無効なマップサイズ [ ${width | 0} , ${height | 0} ] が指定されました`);
        if (result === 6) return fatal(h, '無効なマップ情報が指定されました');
        return result === -1 ? invalid(h) : 0;
      },
    },
    {
      primary: 0x91,
      secondary: 0x7a,
      nativeAddress: 0x1400dfe70,
      name: 'LoadLandscapeOverlays',
      execute: (h) => {
        const chips = h.memory.resolve(h.thread, pop32(h.thread)),
          count = pop32(h.thread),
          surface = pop32(h.thread),
          handle = pop32(h.thread);
        const result = landscapes.loadOverlays(handle, surface, count, words(chips));
        if (result === 1) return fatal(h, bitmapError(surface));
        if (result === 2)
          return fatal(
            h,
            `部品番号 [ ${landscapes.detail(handle) | 0} ] に無効な情報が指定されています`,
          );
        return result === -1 ? invalid(h) : 0;
      },
    },
    {
      primary: 0x91,
      secondary: 0x7b,
      nativeAddress: 0x1400dfd10,
      name: 'SetLandscapeOverlays',
      execute: (h) => {
        const level = pop32(h.thread),
          index = pop32(h.thread),
          channel = pop32(h.thread),
          cells = h.memory.resolve(h.thread, pop32(h.thread)),
          count = pop32(h.thread),
          handle = pop32(h.thread);
        if (level > 256) return fatal(h, levelError(level));
        const result = landscapes.setOverlays(handle, count, words(cells), channel, index, level);
        if (result === 11)
          return fatal(
            h,
            '指定されたフロア情報の中に無効なライン番号が設定されているものが検出されました',
          );
        if (result === 12)
          return fatal(
            h,
            '指定されたフロア情報の中に無効なカラム番号が設定されているものが検出されました',
          );
        if (result === 13) return fatal(h, noMap);
        if (result === 16)
          return fatal(h, `無効なレイヤー番号 [ ${channel | 0} ] が指定されました`);
        if (result === 17) return fatal(h, `無効なガイド番号 [ ${index | 0} ] が指定されました`);
        return result === -1 ? invalid(h) : 0;
      },
    },
    {
      primary: 0x91,
      secondary: 0x7c,
      nativeAddress: 0x1400dfc10,
      name: 'ReplaceLandscapeChip',
      execute: (h) => {
        const source = pop32(h.thread),
          destination = pop32(h.thread),
          handle = pop32(h.thread),
          result = landscapes.replaceChip(handle, destination, source);
        if (result === 1) return fatal(h, bitmapError(source));
        if (result === 4) return fatal(h, noTerrain);
        if (result === 8) return fatal(h, `無効な部品番号 [ ${destination | 0} ] が指定されました`);
        if (result === 9)
          return fatal(
            h,
            `指定された転送元部品 [ ${source | 0} ] のイメージは転送先部品 [ ${destination | 0} ] のイメージと互換性がありません`,
          );
        return result === -1 ? invalid(h) : 0;
      },
    },
    {
      primary: 0x91,
      secondary: 0x7d,
      nativeAddress: 0x1400dfb00,
      name: 'ReplaceLandscapeCell',
      execute: (h) => {
        const index = pop32(h.thread),
          column = pop32(h.thread),
          row = pop32(h.thread),
          handle = pop32(h.thread),
          result = landscapes.replaceCell(handle, row, column, index);
        if (result === 10) return fatal(h, `無効な柱番号 [ ${index | 0} ] が指定されました`);
        return cellError(h, result, row, column) ?? 0;
      },
    },
    {
      primary: 0x91,
      secondary: 0x7e,
      nativeAddress: 0x1400dfa00,
      name: 'ReadLandscapeCellLayer',
      execute: (h) => {
        const column = pop32(h.thread),
          row = pop32(h.thread),
          handle = pop32(h.thread),
          output = h.memory.resolve(h.thread, pop32(h.thread));
        const result = landscapes.readCellLayer(handle, row, column, (value) =>
            write(output, 0, value),
          ),
          error = cellError(h, result, row, column);
        if (error !== null) return error;
        push32(h.thread, result === 0 ? 1 : 0);
        return 0;
      },
    },
    {
      primary: 0x91,
      secondary: 0x7f,
      nativeAddress: 0x1400df8d0,
      name: 'CopyLandscapeCellTop',
      execute: (h) => {
        const column = pop32(h.thread),
          row = pop32(h.thread),
          handle = pop32(h.thread),
          surface = pop32(h.thread),
          result = landscapes.copyCellTop(surface, handle, row, column),
          error = cellError(h, result, row, column);
        if (error !== null) return error;
        if (result === 15)
          return fatal(h, `指定された出力先ビットマップ [ ${surface | 0} ] は存在しません`);
        push32(h.thread, result === 0 ? 1 : 0);
        return 0;
      },
    },
  ];
}
