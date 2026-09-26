import {pop32, push32} from '../bp/state.js';
import type {BurikoNativeLocks} from './exclusion-locks.js';
import type {BurikoNativeSlotDefinition} from './types.js';

/** b95e0..b9730 map the shared DCExclusionControl statuses to the script's small integers. */
function scriptResult(result: number, accepted: readonly number[]): number {
  if (result === 0) return 0;
  return accepted.includes(result >>> 0) ? result & 0x7fffffff : 0xffffffff;
}

export function createGroup80Locks(locks: BurikoNativeLocks): BurikoNativeSlotDefinition[] {
  const unary = (
    secondary: number,
    nativeAddress: number,
    name: string,
    action: (id: number) => number,
    accepted: readonly number[],
  ): BurikoNativeSlotDefinition => ({
    primary: 0x80,
    secondary,
    nativeAddress,
    name,
    execute: (context) => {
      const result = action(pop32(context.thread));
      push32(context.thread, scriptResult(result, accepted));
      return 0;
    },
  });
  return [
    {
      primary: 0x80,
      secondary: 0xb0,
      nativeAddress: 0x1400e7400,
      name: 'CreateScriptLock',
      execute: (context) => {
        push32(context.thread, locks.script.create());
        return 0;
      },
    },
    unary(
      0xb1,
      0x1400e73d0,
      'RemoveScriptLock',
      (id) => locks.script.remove(id, 0),
      [0x80000001, 0x80000004],
    ),
    unary(
      0xb4,
      0x1400e73a0,
      'TryEnterScriptLock',
      (id) => locks.script.tryEnter(id),
      [0x80000001, 0x80000002],
    ),
    unary(0xb5, 0x1400e7370, 'EnterScriptLock', (id) => locks.script.enter(id), [0x80000001]),
    unary(
      0xb6,
      0x1400e7340,
      'LeaveScriptLock',
      (id) => locks.script.leave(id),
      [0x80000001, 0x80000002, 0x80000003],
    ),
  ];
}
