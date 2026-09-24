import {pop32} from '../bp/state.js';
import {pointerView} from '../bp/memory.js';
import type {AokanaDisplayManager} from './display-manager.js';
import type {AokanaDisplayPropertyOutput} from './display-property-output.js';
import type {AokanaEngineErrors} from './engine-errors.js';
import type {AokanaNativeSlotDefinition} from './types.js';

/** E1560 -> B5E60 -> 07F350, real virtual C0 getter and native caller memory. */
export function createGroup91ObjectProperty(
  manager: AokanaDisplayManager,
  errors: AokanaEngineErrors,
): AokanaNativeSlotDefinition[] {
  const hex = (value: number): string => (value >>> 0).toString(16).toUpperCase().padStart(8, '0');
  return [
    {
      primary: 0x91,
      secondary: 0x38,
      nativeAddress: 0x1400e1560,
      name: 'ReadObjectProperty',
      execute: (h) => {
        const selector = pop32(h.thread),
          handle = pop32(h.thread),
          pointer = h.memory.resolve(h.thread, pop32(h.thread)),
          object = manager.resolve(handle);
        const fatal = (message: string): Promise<never> =>
          errors.threadFatal(h.thread, h.diagnostics, errors.files.text.encodeWide(message, 0));
        if (object === null) return fatal('無効なオブジェクトハンドルが指定されました');
        const view = (): DataView => {
          if (pointer === null) throw new Error('CDspObj property accesses null caller output');
          return pointerView(pointer);
        };
        const output: AokanaDisplayPropertyOutput = {
          read32: (index) => view().getUint32(index * 4, true),
          write32: (index, value) => view().setUint32(index * 4, value >>> 0, true),
        };
        const status = object.getProperty(selector, output) >>> 0;
        if (status === 0) return 0;
        if (status === 0xffff0001)
          return fatal(
            `サポートされていないパラメータ番号 [ 0x${hex(selector)} ] が設定されました`,
          );
        const decimal = output.read32(0) | 0,
          hexadecimal = output.read32(0);
        return fatal(
          `取得対象パラメータ [ 0x${hex(selector)} ] に渡された引数 [ ${decimal} ( 0x${hex(hexadecimal)} ) ] に誤りがあります`,
        );
      },
    },
  ];
}
