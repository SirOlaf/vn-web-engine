import {pop32, push32} from '../bp/state.js';
import type {AokanaBpPointer} from '../bp/memory.js';
import type {AokanaBacklog} from './backlog.js';
import type {AokanaEngineErrors} from './engine-errors.js';
import type {AokanaBpOpcodeContext, AokanaNativeSlotDefinition} from './types.js';

export function createGroup80Backlog(
  backlog: AokanaBacklog,
  errors: AokanaEngineErrors,
): AokanaNativeSlotDefinition[] {
  const pointer = (h: AokanaBpOpcodeContext): AokanaBpPointer | null =>
    h.memory.resolve(h.thread, pop32(h.thread));
  const fatal = (h: AokanaBpOpcodeContext, message: string): Promise<never> =>
    errors.threadFatal(h.thread, h.diagnostics, errors.files.text.encodeWide(message, 1));
  const rejected = (
    h: AokanaBpOpcodeContext,
    status: number,
    packed: boolean,
  ): 0 | Promise<never> => {
    if (status === 0) return 0;
    const index = (status - 0x80000001) >>> 0,
      names = ['アーカイブ名', 'ファイル名', '名前', 'メッセージ', '読み仮名リスト'],
      limits = [31, 31, 31, 255, 511];
    return fatal(
      h,
      packed
        ? `${names[index]}が${limits[index]}文字を超えています`
        : `指定された${names[index]}は${limits[index]}文字を超えています`,
    );
  };
  const read = (h: AokanaBpOpcodeContext, extended: boolean): 0 | Promise<never> => {
    const index = pop32(h.thread),
      output = pointer(h),
      result = backlog.read(output, index, extended);
    if (result === 0)
      return fatal(h, `無効なヒストリインデックス [ ${index | 0} ] が指定されました`);
    push32(h.thread, result);
    return 0;
  };
  return [
    {
      primary: 0x80,
      secondary: 0x90,
      nativeAddress: 0x1400e7c00,
      name: 'ResetBacklog',
      execute: (h) => {
        backlog.reset(pop32(h.thread));
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x91,
      nativeAddress: 0x1400e7be0,
      name: 'ReadBacklogCount',
      execute: (h) => {
        push32(h.thread, backlog.count);
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x94,
      nativeAddress: 0x1400e79f0,
      name: 'AppendBacklog',
      execute: (h) => {
        const message = pointer(h),
          name = pointer(h),
          file = pointer(h),
          archive = pointer(h),
          values = new Array<number>(9);
        for (let i = 8; i >= 0; i--) values[i] = pop32(h.thread);
        return rejected(h, backlog.append(values, [archive, file, name, message, null]), false);
      },
    },
    {
      primary: 0x80,
      secondary: 0x95,
      nativeAddress: 0x1400e7970,
      name: 'ReadBacklog',
      execute: (h) => read(h, false),
    },
    {
      primary: 0x80,
      secondary: 0x96,
      nativeAddress: 0x1400e7860,
      name: 'ImportBacklog',
      execute: (h) => rejected(h, backlog.import(pointer(h)), true),
    },
    {
      primary: 0x80,
      secondary: 0x97,
      nativeAddress: 0x1400e77e0,
      name: 'ReadExtendedBacklog',
      execute: (h) => read(h, true),
    },
  ];
}
