import type {OpcodeExecution} from './types.js';
import {LOAD_BUSY} from '../script-load.js';

/** 140053320. Slot eight is the native staging slot, not a separate loader bank. */
export function replaceScript(h: OpcodeExecution): void {
  h.skip(2);
  const asset = h.expression(),
    s = h.state,
    c = h.context,
    host = h.scriptBuffers;
  const phase = s.get(0x17a0c84),
    slot = c.getInt32(0x74, true);
  s.flags[0x98] = s.flags[0x98]! | 0x40;
  const count = (n: number) => s.setVariable(0x3404 / 4, s.variable(0x3404 / 4) + n);
  const cancelled = () => !!(s.flags[0xe7]! & 4);
  if (phase === 0) {
    host.release('script', 8);
    if (cancelled()) {
      s.setVariable(0x43f0 / 4, 65535);
      return;
    }
  }
  if (phase === 0 || phase === 3) {
    const job = host.start(phase === 0 ? 'script' : 'messages', asset, 8);
    s.put(0x179e6fc, job);
    if (job !== LOAD_BUSY) {
      s.put(0x17a0c84, phase === 0 ? 1 : 4);
      count(1);
      s.put(0x20de10, asset);
    }
    h.retry();
    return;
  }
  if (phase === 1 || phase === 2 || phase === 4) {
    const job = s.get(0x179e6fc);
    if (job < 0 || job >= 16) throw new Error(`Invalid native loader job ${job}`);
    const status = s.get(0x587270 + job * 4);
    const clearJob = () => {
      s.put(0x5872c0 + job * 8, 0, 8);
      s.put(0x587230 + job * 4, 0);
      s.put(0x587270 + job * 4, 0);
    };
    if (phase === 2) {
      if (status !== 0 && status !== 3) {
        h.retry();
        return;
      }
      clearJob();
      s.setVariable(0x43f0 / 4, 65535);
      s.setVariable(0x3394 / 4, 0);
      s.put(0x17a0c84, 0);
      s.flags[0x98] = s.flags[0x98]! & ~0x40;
      count(-1);
      host.release('script', 8);
      host.release('messages', 8);
      if (s.get(0x17a0c84) !== 0) h.retry();
      return; // Native leaves the label unread on cancellation.
    }
    if (status !== 0) {
      if (cancelled()) s.put(0x17a0c84, 2);
      h.retry();
      return;
    }
    host.take(phase === 1 ? 'script' : 'messages', 8, job);
    clearJob();
    if (phase === 1) {
      s.put(0x17a0c84, 3);
      count(-1);
      h.retry();
      return;
    }
    s.setVariable(0x43d0 / 4 + slot, asset);
    const pc = Number(c.getBigUint64(0x158, true));
    const label = h.scriptByte(pc) | (h.scriptByte(pc + 1) << 8);
    const target = h.labelAddress(8, label);
    c.setInt32(0x74, slot, true);
    c.setBigUint64(0x158, BigInt(target), true);
    host.release('script', slot);
    host.move('script', 8, slot);
    host.release('messages', slot);
    host.move('messages', 8, slot);
    host.rebuildMessages(slot);
    s.put(0x17a0c84, 0);
    s.setVariable(0x3394 / 4, 0);
    s.flags[0x98] = s.flags[0x98]! & ~0x40;
    count(-1);
    return;
  }
  h.retry(); // Unknown nonzero phases retain their native retry behavior.
}
