import {NoahState} from './noah-state.js';

export type ScriptBank = 'script' | 'messages';
export const LOAD_BUSY = 0xf4236;
export interface ScriptLoadHost {
  release(bank: ScriptBank, slot: number): void;
  removeSlotContexts(slot: number): void;
  start(bank: ScriptBank, asset: number, slot: number): number;
  take(bank: ScriptBank, slot: number, job: number): void;
  rebuildMessages(slot: number): void;
}
/** Buffer ownership operations; opcode-specific transition rules stay in their handlers. */
export interface ScriptBufferHost extends ScriptLoadHost {
  move(bank: ScriptBank, source: number, destination: number): void;
}
/** Complete 140051f30 state machine. Returns true only when native restores PC and yields.
 * Operand evaluation happens in the dispatcher on EVERY invocation, before this function. */
export function scriptLoad(
  s: NoahState,
  host: ScriptLoadHost,
  mode: number,
  slot: number,
  asset: number,
): boolean {
  if (!Number.isInteger(slot) || slot < 0 || slot >= 16)
    throw new Error(`Invalid script load slot ${slot}`);
  let phase = s.get(0x17a0c84);
  if (phase === 0 && mode === 1) {
    host.release('messages', slot);
    phase = 3;
    s.put(0x17a0c84, 3);
  }
  s.flags[0x98] = s.flags[0x98]! | 0x40;
  const cancelled = () => !!(s.flags[0xe7]! & 4);
  const count = (n: number) => s.setVariable(0x3404 / 4, s.variable(0x3404 / 4) + n);
  const clearJob = (job: number) => {
    s.put(0x5872c0 + job * 8, 0, 8);
    s.put(0x587230 + job * 4, 0);
    s.put(0x587270 + job * 4, 0);
  };
  if (phase === 0) {
    if (!(s.flags[0x9d]! & 0x40)) {
      host.removeSlotContexts(slot);
      s.flags[0xa1] = s.flags[0xa1]! & ~0xf8;
      s.flags[0xa2] = s.flags[0xa2]! & ~1;
    }
    host.release('script', slot);
    host.release('messages', slot);
    if (cancelled()) {
      s.setVariable(slot + 0x10f4, 65535);
      return false;
    }
    const job = host.start('script', asset, slot);
    s.put(0x179e6fc, job);
    if (job !== LOAD_BUSY) {
      s.put(0x17a0c84, 1);
      count(1);
      s.put(0x20ddf0 + slot * 4, asset);
    }
    return true;
  }
  const job = s.get(0x179e6fc);
  if ([1, 2, 4].includes(phase) && (job < 0 || job >= 16))
    throw new Error(`Invalid native loader job ${job}`);
  const status = () => s.get(0x587270 + job * 4);
  if (phase === 1) {
    if (status() === 0) {
      host.take('script', slot, job);
      clearJob(job);
      s.put(0x17a0c84, 3);
      s.setVariable(slot + 0x10f4, asset);
      count(-1);
      return true;
    }
    if (cancelled()) s.put(0x17a0c84, 2);
    return true;
  }
  if (phase === 2) {
    if (status() !== 0 && status() !== 3) return true;
    clearJob(job);
    s.put(0x17a0c84, 0);
    s.setVariable(slot + 0x10f4, 65535);
    s.setVariable(0x3394 / 4, 0);
    s.flags[0x98] = s.flags[0x98]! & ~0x40;
    count(-1);
    host.release('script', slot);
    host.release('messages', slot);
    // Native re-reads this global after allocator calls.
    return s.get(0x17a0c84) !== 0;
  }
  if (phase === 3) {
    const next = host.start('messages', asset, slot);
    s.put(0x179e6fc, next);
    if (next !== LOAD_BUSY) {
      s.put(0x17a0c84, 4);
      count(1);
    }
    return true;
  }
  if (phase === 4) {
    if (status() === 0) {
      host.take('messages', slot, job);
      clearJob(job);
      host.rebuildMessages(slot);
      s.put(0x17a0c84, 0);
      s.setVariable(0x3394 / 4, 0);
      s.flags[0x98] = s.flags[0x98]! & ~0x40;
      count(-1);
      return false;
    }
    if (cancelled()) s.put(0x17a0c84, 2);
    return true;
  }
  return phase !== 0; // Native unknown nonzero phases retry without other effects.
}
