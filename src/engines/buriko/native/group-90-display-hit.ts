import {pop32, push32} from '../bp/state.js';
import type {BurikoDisplayManager} from './display-manager.js';
import type {BurikoEngineErrors} from './engine-errors.js';
import type {BurikoNativeInput} from './input.js';
import type {BurikoBpOpcodeContext, BurikoNativeSlotDefinition} from './types.js';

/** 90:3C/3D share the real packed hit mask and logical pointer owners. */
export function createGroup90DisplayHit(
  manager: BurikoDisplayManager,
  input: BurikoNativeInput,
  errors: BurikoEngineErrors,
): BurikoNativeSlotDefinition[] {
  const fatal = (context: BurikoBpOpcodeContext, message: string): Promise<never> =>
      errors.threadFatal(
        context.thread,
        context.diagnostics,
        errors.files.text.encodeWide(message, 0),
      ),
    invalid = (context: BurikoBpOpcodeContext): Promise<never> =>
      fatal(context, '無効なオブジェクトハンドルが指定されました');
  return [
    {
      primary: 0x90,
      secondary: 0x3c,
      nativeAddress: 0x1400db990,
      name: 'SetObjectHitMask',
      execute: (context) => {
        const surface = pop32(context.thread),
          handle = pop32(context.thread),
          status = manager.setObjectHitMask(handle, surface);
        if (status === -1) return invalid(context);
        if (status === 1)
          return fatal(context, '指定されたディスプレイオブジェクトは仮想オブジェクトです');
        if (status === 2)
          return fatal(context, `指定されたビットマップ [ ${surface | 0} ] は無効です`);
        return 0;
      },
    },
    {
      primary: 0x90,
      secondary: 0x3d,
      nativeAddress: 0x1400db940,
      name: 'HitObjectAtLogicalPointer',
      execute: (context) => {
        const result = manager.hitObjectAtPointer(pop32(context.thread), input);
        if (result === null) return invalid(context);
        push32(context.thread, result);
        return 0;
      },
    },
  ];
}
