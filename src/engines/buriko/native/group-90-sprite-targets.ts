import {pop32, push32} from '../bp/state.js';
import type {BurikoEngineErrors} from './engine-errors.js';
import type {BurikoSpriteTargets} from './sprite-targets.js';
import type {BurikoBpOpcodeContext, BurikoNativeSlotDefinition} from './types.js';

/** The capture-target registry is separate from adjacent Bank90 movie services. */
export function createGroup90SpriteTargets(
  targets: BurikoSpriteTargets,
  errors: BurikoEngineErrors,
): BurikoNativeSlotDefinition[] {
  const fatal = (h: BurikoBpOpcodeContext, message: string): Promise<never> =>
    errors.threadFatal(h.thread, h.diagnostics, errors.files.text.encodeWide(message, 0));
  return [
    {
      primary: 0x90,
      secondary: 0xf8,
      nativeAddress: 0x1400d62a0,
      name: 'ClearSpriteTargets',
      execute: () => {
        targets.clear();
        return 0;
      },
    },
    {
      primary: 0x90,
      secondary: 0xfa,
      nativeAddress: 0x1400d6260,
      name: 'RegisterSpriteTarget',
      execute: (h) =>
        targets.register(pop32(h.thread))
          ? 0
          : fatal(h, '指定されたハンドルは無効、若しくはスプライトハンドルではありません'),
    },
    {
      primary: 0x90,
      secondary: 0xfb,
      nativeAddress: 0x1400d6220,
      name: 'UnregisterSpriteTarget',
      execute: (h) =>
        targets.unregister(pop32(h.thread))
          ? 0
          : fatal(h, '指定されたハンドルが示すオブジェクトは登録されていません'),
    },
    {
      primary: 0x90,
      secondary: 0xfc,
      nativeAddress: 0x1400d61f0,
      name: 'HitSpriteTarget',
      execute: (h) => {
        push32(h.thread, targets.hitTarget());
        return 0;
      },
    },
    {
      primary: 0x90,
      secondary: 0xfd,
      nativeAddress: 0x1400d61a0,
      name: 'ReadSpriteTargetState',
      execute: (h) => {
        const state = targets.readState(pop32(h.thread));
        if (state === null) return fatal(h, '無効なターゲット番号が指定されました');
        push32(h.thread, state);
        return 0;
      },
    },
  ];
}
