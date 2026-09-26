import {pop32, push32} from '../bp/state.js';
import type {BurikoEngineErrors} from './engine-errors.js';
import type {BurikoGroupDisplays} from './group-displays.js';
import type {BurikoBpOpcodeContext, BurikoNativeSlotDefinition} from './types.js';

/** Six Group services. Bank 91:DB is the separate current-knob pointer query. */
export function createGroup90Groups(
  groups: BurikoGroupDisplays,
  errors: BurikoEngineErrors,
): BurikoNativeSlotDefinition[] {
  const fatal = (h: BurikoBpOpcodeContext, message: string): Promise<never> =>
    errors.threadFatal(h.thread, h.diagnostics, errors.files.text.encodeWide(message, 0));
  const invalid = (h: BurikoBpOpcodeContext): Promise<never> =>
    fatal(h, '無効なグループハンドルが指定されました');
  return [
    {
      primary: 0x90,
      secondary: 0xe0,
      nativeAddress: 0x1400d68b0,
      name: 'CreateGroupDisplay',
      execute: (h) => {
        const handle = groups.create();
        if (handle === 0) return fatal(h, 'これ以上、グループオブジェクトを生成する事は出来ません');
        push32(h.thread, handle);
        return 0;
      },
    },
    {
      primary: 0x90,
      secondary: 0xe1,
      nativeAddress: 0x1400d6870,
      name: 'DestroyGroupDisplay',
      execute: (h) => (groups.destroy(pop32(h.thread)) ? 0 : invalid(h)),
    },
    {
      primary: 0x90,
      secondary: 0xe4,
      nativeAddress: 0x1400d6820,
      name: 'SetGroupActivation',
      execute: (h) => {
        const value = pop32(h.thread),
          handle = pop32(h.thread);
        return groups.setActivation(handle, value) ? 0 : invalid(h);
      },
    },
    {
      primary: 0x90,
      secondary: 0xe5,
      nativeAddress: 0x1400d6780,
      name: 'ConfigureGroupDisplay',
      execute: (h) => {
        const level = pop32(h.thread),
          y = pop32(h.thread),
          x = pop32(h.thread),
          handle = pop32(h.thread);
        if (level > 256)
          return fatal(
            h,
            `無効なエフェクトレベル／トランスペアレンシィ／オパシティ／アディションレベル [ ${level | 0} ] が指定されました`,
          );
        return groups.configure(handle, x, y, level) ? 0 : invalid(h);
      },
    },
    {
      primary: 0x90,
      secondary: 0xe8,
      nativeAddress: 0x1400d66e0,
      name: 'AddGroupChild',
      execute: (h) => {
        const y = pop32(h.thread),
          x = pop32(h.thread),
          target = pop32(h.thread),
          handle = pop32(h.thread);
        const status = groups.addChild(handle, target, x, y);
        if (status === 1) return fatal(h, '無効なオブジェクトハンドルが指定されました');
        if (status === 3) return fatal(h, '自分自身をグループに登録することはできません');
        if (status === 4) return fatal(h, '指定されたオブジェクトにはオーナーが存在します');
        return status === -1 ? invalid(h) : 0;
      },
    },
    {
      primary: 0x90,
      secondary: 0xe9,
      nativeAddress: 0x1400d6670,
      name: 'RemoveGroupChild',
      execute: (h) => {
        const target = pop32(h.thread),
          handle = pop32(h.thread),
          status = groups.removeChild(handle, target);
        if (status === 1) return fatal(h, '無効なオブジェクトハンドルが指定されました');
        if (status === 2) return fatal(h, '指定されたオブジェクトはグループに登録されていません');
        return status === -1 ? invalid(h) : 0;
      },
    },
  ];
}
