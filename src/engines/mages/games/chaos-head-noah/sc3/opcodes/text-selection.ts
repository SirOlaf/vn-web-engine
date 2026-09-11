import type {OpcodeExecution} from './types.js';

/** 01/09, 14004ccd0: select a text slot and record the checkpoint label. */
export function selectText(h: OpcodeExecution): void {
  h.skip(2);
  const mode = h.byte(),
    s = h.state;
  let slot: number;
  if (mode === 0) {
    slot = 0;
    const label = h.word();
    if (!(s.flags[0xa1]! & 1)) s.put(0x20d3cc, label);
  } else if (mode === 1) {
    const label = h.word();
    slot = h.expression();
    if (!s.flag((slot + 0x508) >>> 0)) s.put(0x20d3cc, label);
  } else if (mode === 2) slot = h.expression();
  else throw new Error('01/09 reads an uninitialized native stack value for this selector');
  h.context.setInt32(0x13c, slot, true);
  s.put(0x179cd30 + slot * 4, 1);
}

/** 01/0b, 14004d590: begin/continue a text block, with native early returns. */
export function beginText(h: OpcodeExecution): void {
  const s = h.state,
    slot = h.context.getUint32(0x13c, true);
  if (!s.flag((slot + 0x50b) >>> 0)) {
    s.setFlag((slot + 0x50e) >>> 0, 0);
    s.setFlag((slot + 0x50b) >>> 0, 1);
    h.skip(2);
    if (!(s.flags[0xa0]! & 4)) s.flags[0x96] = s.flags[0x96]! | 0x40;
    const channel = s.bytes(0x5b10b5 + slot * 0x11984, 1)[0]!,
      base = 0x5a7110 + channel * 0x98;
    const stop = () => {
      s.put(base, -1);
      s.put(base + 12, 0);
      s.put(0x17ac230 + slot * 4, 0);
      s.put(0x17abca0 + slot * 4, 50);
    };
    if (s.get(0x17ac258 + slot * 4) !== 0) {
      stop();
      return;
    }
    if (s.get(base + 0x2c) === -1) return;
    const voice = s.variable((s.get(0x17abca0 + slot * 4) + 0x814) >>> 0) >>> 0;
    if (s.get(0x17abdc0 + voice * 4) !== 0) return;
    stop();
  } else s.setFlag((slot + 0x50e) >>> 0, 1);
  h.yield();
}
