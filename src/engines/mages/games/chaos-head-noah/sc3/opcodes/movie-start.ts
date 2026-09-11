import type {OpcodeExecution} from './types.js';

/** 140050850, dispatch table 1401da4e0[0x22]. */
export function movieStart(h: OpcodeExecution): void {
  const s = h.state;
  if (s.get(0x81007c) !== 0) {
    h.yield();
    return;
  }
  h.skip(2);
  let selector = h.byte(),
    mode: number;
  if (selector === 99) {
    selector = h.expression();
    mode = h.expression();
  } else mode = h.byte();
  const asset = h.expression(),
    cancel = h.expression();
  const channel = Math.trunc((selector | 0) / 20) >>> 0;
  let kind = (selector | 0) % 20;
  // The native store precedes its bounds check (including mapped adjacent words).
  s.put(0x179cce0 + channel * 4, cancel);
  if (channel >= 4) throw new Error(`Native movie channel bounds failure: ${channel}`);
  s.put(0x179ccf0 + channel, 0, 1);
  if (channel < 2) {
    const bit = 1 << channel,
      base = 0x62f4 + channel * 0x50;
    s.flags[0xe7] = s.flags[0xe7]! | (bit << 3);
    s.flags[0x137] = (s.flags[0x137]! | (bit << 4)) ^ (cancel === 0 ? bit << 4 : 0);
    s.setVariable(base / 4, asset);
    s.setVariable((base + 4) / 4, kind + channel * 20);
    s.setVariable((base + 8) / 4, mode);
    s.setVariable((base + 12) / 4, 65535);
  }
  if (!(s.flags[0x137]! & 1)) {
    for (let i = 0; i < 3; i++) {
      h.stopAudioDevice(i);
      s.put(0x5a70d8 + i * 4, 0);
    }
    for (let i = 0; i < 3; i++) {
      s.put(0x5a7110 + i * 0x98, -1);
      s.put(0x5a711c + i * 0x98, 0);
      s.setVariable((0x435c + i * 4) / 4, 65535);
    }
  }
  for (let i = 3; i < 6; i++) {
    s.put(0x5a7110 + i * 0x98, -1);
    s.put(0x5a711c + i * 0x98, 0);
  }
  let flags = 0;
  if (kind >= 8) {
    kind -= 8;
    flags = 4;
  }
  if (((kind - 2) & 0xfffffffc) === 0 && kind !== 4) flags |= 8;
  if (kind === 0 || kind === 3) flags |= 1;
  if ((kind & 0xfffffffd) === 0) flags |= 2;
  h.movies.stop(channel);
  h.movies.start(channel, asset, flags);
  h.movies.pause(channel, false);
  if (channel < 2) {
    const bit = 1 << channel;
    s.flags[0x9a] = s.flags[0x9a]! | (bit << 4);
    s.flags[0xe7] = s.flags[0xe7]! | (bit << 3);
    s.flags[0xe8] = s.flags[0xe8]! & ~bit;
  }
  h.yield();
}
