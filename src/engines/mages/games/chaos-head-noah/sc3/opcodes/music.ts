import type {OpcodeExecution} from './types.js';

/** 1400556e0: immediately pause/resume the six voice/effect devices. */
export function pauseSceneAudio(h: OpcodeExecution): void {
  h.skip(2);
  const paused = h.byte() !== 0,
    s = h.state;
  s.flags[0x97] = paused ? s.flags[0x97]! | 1 : s.flags[0x97]! & ~1;
  for (let channel = 0; channel < 6; channel++) {
    if (
      s.get(0x5a7148 + channel * 0x98) !== 0 &&
      s.get(0x5a70d8 + channel * 4) !== 0 &&
      s.bytes(0x1d90908 + channel * 0x5218, 1)[0] !== 0
    )
      h.pauseAudio(channel, paused);
  }
}

/** 140055410: paired music on the active BGM channel and fixed channel nine. */
export function pairedMusic(h: OpcodeExecution): void {
  h.skip(2);
  const selector = h.byte(),
    s = h.state,
    v = s.variables;
  if (selector === 0) {
    const first = h.expression(),
      second = h.expression();
    s.put(0x17acbd0 + first, 1, 1);
    s.put(0x17acbd0 + second, 1, 1);
    if (v.getInt32(0x4358, true) === first && v.getInt32(0x43ac, true) === second) return;
    const a = 0x5a7110 + (s.get(0x20dde8) >>> 0) * 0x98;
    v.setInt32(0x4358, first, true);
    s.put(a, first);
    s.put(a + 4, 1, 8);
    s.put(a + 12, 1);
    v.setInt32(0x43ac, second, true);
    s.put(0x5a7668, second);
    s.put(0x5a766c, 1, 8);
    s.put(0x5a7674, 1);
    s.flags[0x9d] = s.flags[0x9d]! | 1;
    h.yield();
    return;
  }
  if (selector === 1) {
    const a = 0x5a7110 + (s.get(0x20dde8) >>> 0) * 0x98;
    v.setUint32(0x4358, 65535, true);
    s.put(a, -1);
    s.put(a + 12, 0);
    v.setUint32(0x43ac, 65535, true);
    s.put(0x5a7668, -1);
    s.put(0x5a7674, 0);
    const duration = v.getUint32(0x2238, true);
    if (duration) {
      s.put(a + 0x50, 1);
      s.put(a + 0x54, Math.floor(((s.get(a + 0x68) << 16) >>> 0) / duration));
      s.put(0x5a76b8, 1);
      s.put(0x5a76bc, Math.floor(((s.get(0x5a76d0) << 16) >>> 0) / duration));
      v.setUint32(0x2238, 0, true);
    }
    s.flags[0x137] = s.flags[0x137]! & ~8;
    s.flags[0x9d] = s.flags[0x9d]! & ~1;
    h.yield();
    return;
  }
  if (selector === 2 || selector === 3) {
    const duration = h.expression() >>> 0;
    if (!duration) return;
    const level = v.getUint32(0x43a8, true),
      numerator = selector === 2 ? level : (1000 - level) >>> 0;
    const step = Math.floor(numerator / duration) || 1;
    v.setUint32(0x43b0, selector === 2 ? -step : step, true);
  }
}

/** 1400551b0: request sound with an unconditional dispatch yield. */
export function requestSound(h: OpcodeExecution): void {
  h.skip(2);
  let channel = h.byte();
  if (channel < 3) channel += 3;
  const id = h.expression(),
    mode = h.expression(),
    b = 0x5a7110 + channel * 0x98;
  h.yield();
  h.state.put(b, id);
  h.state.put(b + 4, mode);
  h.state.put(b + 8, 1);
  h.state.put(b + 12, 1);
}

/** 140055380: wait for request/load/play completion of a sound channel. */
export function waitSound(h: OpcodeExecution): void {
  h.skip(2);
  let channel = h.byte();
  if (channel < 3) channel += 3;
  const s = h.state,
    b = 0x5a7110 + channel * 0x98;
  if (
    s.get(b + 12) !== 0 ||
    s.get(b + 0x20) !== 0 ||
    (s.get(b + 0x3c) === 0 && s.get(b + 0x38) !== 0)
  )
    h.retry();
}

/** 140053890: complete music request, with readiness supplied by NoahAudio. */
export function requestMusic(h: OpcodeExecution): void {
  const s = h.state,
    v = s.variables;
  h.skip(2);
  let mode = h.byte();
  const unlock = mode !== 10;
  if (!unlock) mode = 1;
  const track = h.expression();
  if (mode === 2) mode = h.expression() >>> 0;
  const active = s.get(0x20dde8) >>> 0;
  const base = (channel: number) => {
    if (channel >= 10) throw new Error(`Invalid native music channel ${channel}`);
    return 0x5a7110 + channel * 0x98;
  };
  let a = base(active);
  if (track >= 10000) {
    v.setUint32(0x4358, 65535, true);
    s.put(a, -1);
    s.put(a + 12, 0);
    return;
  }
  if (v.getInt32(0x4358, true) === track) return;
  // Negative indices alias preceding native global bytes; retain bounded writes.
  const mark = () => s.put(0x17acbd0 + track, 1, 1);
  const remember = () => {
    s.flags[0x136] = mode ? s.flags[0x136]! | 16 : s.flags[0x136]! & ~16;
    v.setInt32(0x4358, track, true);
  };
  const cross = (mode - 3) >>> 0 < 2;
  if (cross) mode -= 3;
  if (cross && s.get(a + 0x38) !== 0) {
    const inactive = s.get(0x20ddec) >>> 0;
    let b = base(inactive);
    if (!(s.flags[0x9d]! & 2)) {
      s.flags[0x9d] = s.flags[0x9d]! | 2;
      s.put(b, track);
      s.put(b + 4, mode);
      s.put(b + 8, 0);
      s.put(b + 12, 1);
    } else if (s.get(b + 0x24) !== 0) {
      let duration = v.getUint32(0x2238, true);
      if (duration) v.setUint32(0x2238, 0, true);
      else duration = 16;
      s.put(0x20dde8, inactive);
      s.put(0x20ddec, active);
      if (s.get(0x5a70d8 + inactive * 4) === 0) {
        h.resumeAudio(inactive);
        s.put(0x5a70d8 + inactive * 4, 1);
      }
      a = base(s.get(0x20dde8) >>> 0);
      b = base(s.get(0x20ddec) >>> 0);
      s.put(a + 0x38, 1, 8);
      s.put(a + 0x2c, s.get(a + 0x14));
      s.put(a + 0x40, 0);
      s.put(a + 0x70, 0);
      s.put(a + 0x48, 1);
      s.put(a + 0x4c, Math.floor(((s.get(a + 0x6c) << 16) >>> 0) / duration));
      s.put(b + 0x50, 1);
      s.put(b + 0x54, Math.floor(((s.get(b + 0x68) << 16) >>> 0) / duration));
      s.put(b, -1);
      s.put(b + 12, 0);
      mark();
      remember();
      s.flags[0x9d] = s.flags[0x9d]! & ~2;
      return;
    }
    h.retry();
    return;
  }
  if (unlock) mark();
  remember();
  s.put(a, track);
  s.put(a + 4, mode);
  s.put(a + 8, 1);
  s.put(a + 12, 1);
  const duration = v.getUint32(0x2238, true);
  if (duration) {
    s.put(a + 0x48, 1);
    s.put(a + 0x4c, Math.floor(((s.get(a + 0x6c) << 16) >>> 0) / duration));
    v.setUint32(0x2238, 0, true);
  }
}

/** 140053ca0: stop/fade the active music voice, or clear both music modes. */
export function stopMusic(h: OpcodeExecution): void {
  const s = h.state,
    v = s.variables;
  h.skip(2);
  const mode = h.byte();
  const base = (channel: number) => {
    if (channel >= 10) throw new Error(`Invalid native music channel ${channel}`);
    return 0x5a7110 + channel * 0x98;
  };
  const active = base(s.get(0x20dde8) >>> 0);
  if (mode !== 0) {
    if (s.bytes(0x1db47b0, 1)[0]) s.put(0x1db47bb, 0, 1);
    for (const channel of [active, base(s.get(0x20ddec) >>> 0)])
      for (const offset of [4, 0x18, 0x30]) s.put(channel + offset, 0);
    s.flags[0x136] = s.flags[0x136]! & ~16;
    return;
  }
  v.setUint32(0x4358, 65535, true);
  s.put(active, -1);
  s.put(active + 12, 0);
  const duration = v.getUint32(0x2238, true);
  if (duration !== 0) {
    s.put(active + 0x50, 1);
    s.put(active + 0x54, Math.floor(((s.get(active + 0x68) << 16) >>> 0) / duration));
    v.setUint32(0x2238, 0, true);
  }
  h.yield();
}

/** 140055280: stop/fade one of the script-selected non-BGM audio channels. */
export function stopSound(h: OpcodeExecution): void {
  const s = h.state;
  h.skip(2);
  let channel = h.byte();
  const duration = h.expression() >>> 0;
  if (channel < 3) channel += 3;
  const base = 0x5a7110 + channel * 0x98,
    current = s.get(base + 0x2c);
  s.put(base, -1);
  s.put(base + 4, 0, 8);
  s.put(base + 12, 0);
  if (current !== -1 && s.get(base + 0x38) !== 0 && s.get(base + 0x3c) !== 1 && duration !== 0) {
    let step = Math.floor(((s.get(base + 0x68) << 16) >>> 0) / duration) >>> 0;
    if (step < 0x10000) step = 0x10000;
    s.put(base + 0x50, 1);
    s.put(base + 0x54, step);
  }
  h.yield();
}

/** 140054080: stop/fade a general audio channel, or synchronously reset its device. */
export function stopAudioChannel(h: OpcodeExecution): void {
  const s = h.state,
    v = s.variables;
  h.skip(2);
  const selector = h.byte();
  const base = (channel: number) => 0x5a7110 + channel * 0x98;
  const clearRequest = (channel: number) => {
    const a = base(channel);
    s.put(a, -1);
    s.put(a + 4, 0, 8);
    s.put(a + 12, 0);
  };
  const clearCurrent = (channel: number) => {
    if (channel < 3) v.setUint32(0x435c + channel * 4, 65535, true);
  };
  if (selector === 255) {
    for (let channel = 0; channel < 3; channel++) {
      clearRequest(channel);
      clearCurrent(channel);
    }
    h.yield();
    return;
  }
  if (selector >= 10 && selector <= 12) {
    const channel = selector - 10,
      device = 0x1d90900 + channel * 0x5218;
    if (s.bytes(device + 8, 1)[0] !== 0) s.put(device + 0x13, 0, 1);
    clearCurrent(channel);
    for (const offset of [4, 0x18, 0x30]) s.put(base(channel) + offset, 0);
    return;
  }
  const channel = selector,
    a = base(channel),
    current = s.get(a + 0x2c);
  clearRequest(channel);
  if (current !== -1 && s.get(a + 0x38) !== 0 && s.get(a + 0x3c) !== 1) {
    const duration = v.getUint32(0x223c, true);
    if (duration === 0) {
      s.put(a + 0x50, 0);
      s.put(a + 0x54, 0);
    } else {
      let step = Math.floor(((s.get(a + 0x68) << 16) >>> 0) / duration) >>> 0;
      if (step < 0x10000) step = 0x10000;
      s.put(a + 0x50, 1);
      s.put(a + 0x54, step);
    }
  }
  v.setUint32(0x223c, 0, true);
  clearCurrent(channel);
  h.yield();
}
