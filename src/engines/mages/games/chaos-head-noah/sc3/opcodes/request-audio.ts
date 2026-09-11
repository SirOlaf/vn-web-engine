import type {OpcodeExecution} from './types.js';

/** 140053da0: request, wait for, or resume one script-selected audio channel. */
export function requestAudioChannel(h: OpcodeExecution): void {
  const s = h.state,
    v = s.variables;
  h.skip(2);
  const channel = h.byte(),
    mode = h.byte(),
    base = 0x5a7110 + channel * 0x98;
  if (mode === 2) {
    if (s.get(0x5a70d8 + channel * 4) === 0) {
      h.resumeAudio(channel);
      s.put(0x5a70d8 + channel * 4, 1);
    }
    s.put(base + 0x40, 0, 8);
    s.put(base + 0x48, 0, 8);
    return;
  }
  const id = h.expression(),
    parameter = h.expression();
  if (id > 9999) return;
  if (id !== s.get(base)) {
    if (mode === 0 && s.get(base) !== -1) {
      s.put(base, -1);
      s.put(base + 4, 0, 8);
      s.put(base + 0x48, 0, 8);
      s.put(base + 0x50, 0, 8);
      h.retry();
      return;
    }
    s.put(base, id);
    s.put(base + 4, parameter);
    s.put(base + 0x50, 0, 8);
    s.put(base + 0x44, mode === 1 ? 1 : 0);
    s.put(base + 8, mode === 1 ? 0 : 1);
    s.put(base + 0xc, 1);
    s.put(base + 0x3c, 0);
    const duration = v.getUint32(0x223c, true);
    if (duration === 0) s.put(base + 0x48, 0, 8);
    else {
      s.put(base + 0x48, 1);
      s.put(base + 0x4c, Math.floor(((s.get(base + 0x6c) << 16) >>> 0) / duration));
      v.setUint32(0x223c, 0, true);
    }
    if (channel < 3) v.setUint32(0x435c + channel * 4, parameter === 0 ? 65535 : id, true);
    h.yield();
  }
  if (mode !== 1) return;
  if (s.get(base + 0x14) === id && s.get(base + 0x24) !== 0) {
    h.yield();
    return;
  }
  h.retry();
}
