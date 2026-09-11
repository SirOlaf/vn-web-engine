import type {OpcodeExecution} from './types.js';
/** Complete 00/31, 140054d00. Owned system data, not image decoding. */
export function loadSystemData(h: OpcodeExecution): void {
  h.skip(2);
  const asset = h.expression(),
    s = h.state,
    phase = s.get(0x17a0c80);
  s.flags[0x98] = s.flags[0x98]! | 0x40;
  const release = () => {
    h.rawAssets.release(Number(s.view(0x17ac1b0, 8).getBigUint64(0, true)));
    s.put(0x17ac1b0, 0, 8);
  };
  if (phase === 0) {
    release();
    if (s.flags[0xe7]! & 4) return;
    const job = h.rawAssets.start(2, asset);
    s.put(0x17a0c90, job);
    if (job !== 0xf4236) {
      s.put(0x17a0c80, 1);
      s.setVariable(0x3404 / 4, s.variable(0x3404 / 4) + 1);
    }
  } else if (phase === 1 || phase === 2) {
    const job = s.get(0x17a0c90);
    if (job < 0 || job >= 16) throw new Error(`Invalid native system-data job ${job}`);
    const status = s.get(0x587270 + job * 4);
    if (status === 0 || (phase === 2 && status === 3)) {
      if (phase === 1)
        s.put(0x17ac1b0, Number(s.view(0x5872c0 + job * 8, 8).getBigUint64(0, true)), 8);
      s.put(0x5872c0 + job * 8, 0, 8);
      s.put(0x587230 + job * 4, 0);
      s.put(0x587270 + job * 4, 0);
      s.put(0x17a0c80, 0);
      s.setVariable(0x3394 / 4, 0);
      s.flags[0x98] = s.flags[0x98]! & ~0x40;
      s.setVariable(0x3404 / 4, s.variable(0x3404 / 4) - 1);
      if (phase === 2) release();
      return;
    }
    if (phase === 1 && s.flags[0xe7]! & 4) s.put(0x17a0c80, 2);
  }
  h.retry();
}
