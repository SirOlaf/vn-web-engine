import {pop32, push32} from '../bp/state.js';
import {pointerBytes} from '../bp/opcodes/operands.js';
import type {AokanaEngineErrors} from './engine-errors.js';
import type {AokanaMapDisplays} from './map-displays.js';
import type {AokanaBpOpcodeContext, AokanaNativeSlotDefinition} from './types.js';

/** Bank 90:70,71,74-76,78-7A, the CDspObjMap services (not Bank 91 Landscape). */
export function createGroup90Maps(
  maps: AokanaMapDisplays,
  errors: AokanaEngineErrors,
): AokanaNativeSlotDefinition[] {
  const fatal = (h: AokanaBpOpcodeContext, message: string): Promise<never> =>
    errors.threadFatal(h.thread, h.diagnostics, errors.files.text.encodeWide(message, 0));
  const invalidHandle = (h: AokanaBpOpcodeContext): Promise<never> =>
    fatal(h, '無効なマップハンドルが指定されました');
  return [
    {
      primary: 0x90,
      secondary: 0x70,
      nativeAddress: 0x1400d97f0,
      name: 'CreateMapDisplay',
      execute: (h) => {
        const handle = maps.create();
        if (handle === 0) return fatal(h, 'これ以上、マップオブジェクトを生成する事は出来ません');
        push32(h.thread, handle);
        return 0;
      },
    },
    {
      primary: 0x90,
      secondary: 0x71,
      nativeAddress: 0x1400d97b0,
      name: 'DestroyMapDisplay',
      execute: (h) => (maps.destroy(pop32(h.thread)) ? 0 : invalidHandle(h)),
    },
    {
      primary: 0x90,
      secondary: 0x74,
      nativeAddress: 0x1400d9760,
      name: 'SetMapActivation',
      execute: (h) => {
        const activation = pop32(h.thread),
          handle = pop32(h.thread);
        return maps.setActivation(handle, activation) ? 0 : invalidHandle(h);
      },
    },
    {
      primary: 0x90,
      secondary: 0x75,
      nativeAddress: 0x1400d9640,
      name: 'ConfigureMapDisplay',
      execute: (h) => {
        const layer = pop32(h.thread),
          level = pop32(h.thread),
          mode = pop32(h.thread),
          surface = pop32(h.thread),
          y = pop32(h.thread),
          x = pop32(h.thread),
          handle = pop32(h.thread);
        if (layer >= 0x10000)
          return fatal(h, `無効なプライオリティ [ ${layer | 0} ] が指定されました`);
        if (level > 0x100)
          return fatal(
            h,
            `無効なエフェクトレベル／トランスペアレンシィ／オパシティ／アディションレベル [ ${level | 0} ] が指定されました`,
          );
        if (!(
          mode <= 9 ||
          (mode >= 0x20 && mode <= 0x27) ||
          [0x40, 0x41, 0x80, 0xc0, 0xc1, 0xf0, 0xff].includes(mode)
        ))
          return fatal(h, `無効なエフェクトモード [ ${mode | 0} ] が指定されました`);
        if (surface >= 0x4000)
          return fatal(h, `無効なビットマップ番号 [ ${surface | 0} ] が指定されました`);
        const result = maps.configure(handle, x, y, surface, mode, level, layer);
        if (result === 1)
          return fatal(
            h,
            `ビットマップ [ ${surface | 0} ] は指定されたマップオブジェクトに適合しません`,
          );
        return result === -1 ? invalidHandle(h) : 0;
      },
    },
    {
      primary: 0x90,
      secondary: 0x76,
      nativeAddress: 0x1400d9550,
      name: 'ConfigureMapGrid',
      execute: (h) => {
        const height = pop32(h.thread),
          width = pop32(h.thread),
          rows = pop32(h.thread),
          columns = pop32(h.thread),
          handle = pop32(h.thread);
        const result = maps.configureGrid(handle, columns, rows, width, height);
        if (result === 2)
          return fatal(h, `無効なビューサイズ [ ${columns | 0} , ${rows | 0} ] が指定されました`);
        if (result === 3)
          return fatal(h, `無効なチップサイズ [ ${width | 0} , ${height | 0} ] が指定されました`);
        return result === -1 ? invalidHandle(h) : 0;
      },
    },
    {
      primary: 0x90,
      secondary: 0x78,
      nativeAddress: 0x1400d94a0,
      name: 'ReplaceMapCells',
      execute: (h) => {
        const source = h.memory.resolve(h.thread, pop32(h.thread)),
          height = pop32(h.thread),
          width = pop32(h.thread),
          handle = pop32(h.thread);
        const result = maps.replaceMap(handle, width, height, (length) => {
          if (source === null) throw new Error('Aokana map copies through a null cell pointer');
          return pointerBytes(source, length);
        });
        if (result === 4)
          return fatal(h, `無効な地形情報幅 [ ${width | 0} , ${height | 0} ] が指定されました`);
        return result === -1 ? invalidHandle(h) : 0;
      },
    },
    {
      primary: 0x90,
      secondary: 0x79,
      nativeAddress: 0x1400d93c0,
      name: 'SetMapView',
      execute: (h) => {
        const wrap = pop32(h.thread),
          pixelY = pop32(h.thread),
          pixelX = pop32(h.thread),
          mapY = pop32(h.thread),
          mapX = pop32(h.thread),
          handle = pop32(h.thread);
        const result = maps.selectView(handle, mapX, mapY, pixelX, pixelY, wrap);
        if (result === 5)
          return fatal(
            h,
            `無効なマップ表示座標が指定されました\n\nマップ座標 [ ${mapX | 0} , ${mapY | 0} ] , チップ座標 [ ${pixelX | 0} , ${pixelY | 0} ]`,
          );
        return result === -1 ? invalidHandle(h) : 0;
      },
    },
    {
      primary: 0x90,
      secondary: 0x7a,
      nativeAddress: 0x1400d9360,
      name: 'InvalidateMapTile',
      execute: (h) => {
        const tile = pop32(h.thread),
          handle = pop32(h.thread),
          result = maps.invalidateTile(handle, tile);
        if (result === 6) return fatal(h, '指定されたオブジェクトは初期化が完了していません');
        return result === -1 ? invalidHandle(h) : 0;
      },
    },
  ];
}
