import type {OpcodeExecution} from './types.js';
import {romWord} from '../text-rom.js';
import {checkRange} from '../../../../../../core/binary.js';

/** 14003eaf0: signed reveal times and byte opacity, including the final fade tick. */
export function advanceMessageGlyphs(h: Pick<OpcodeExecution, 'state'>, slot: number): void {
  const s = h.state,
    b = slot * 0x11984,
    g = (a: number) => s.get(a),
    p = (a: number, v: number, w = 4) => s.put(a, v, w);
  const count = () => g(0x5b10ac + b) >>> 0;
  if (!count()) return;
  const mode = s.bytes(0x5b10b4 + b, 1)[0]!;
  let pending = false;
  if (mode > 4) return; // The native default leaves both opacity and status untouched.
  for (let i = 0; i < count(); i++) {
    const a = 0x5c20c4 + b + i,
      alpha = s.bytes(a, 1)[0]!,
      time = g(0x5bfb44 + b + i * 4);
    if (mode === 0) {
      if (time === -1) p(a, 255, 1);
      else if (g(0x5b10a0 + b) < time) pending = true;
      else if (alpha < 240) {
        pending = true;
        p(a, alpha + 16, 1);
      } else p(a, 255, 1);
    } else if (mode === 1) {
      if (time === -1 || alpha >= 240) p(a, 255, 1);
      else {
        pending = true;
        p(a, alpha + 16, 1);
      }
    } else if (mode === 2) {
      if (time >= 0) {
        if (alpha < 16) p(a, 0, 1);
        else {
          pending = true;
          p(a, alpha - 16, 1);
        }
      }
    } else p(a, mode === 3 ? 255 : 0, 1);
  }
  if (mode === 2 && !pending) for (let i = 0; i < count(); i++) p(0x5c20c4 + b + i, 0, 1);
  p(0x5b10b0 + b, mode === 2 ? (pending ? 3 : 4) : mode === 4 ? 4 : pending ? 1 : 2);
}

/** 140045550: bounded catalog scan, read bit, and first-read aggregate. */
export function markMessageRead(
  h: Pick<OpcodeExecution, 'state'>,
  asset: number,
  index: number,
): void {
  const s = h.state;
  let row = 0;
  while (row < 360 && (romWord(0x20d5a0 + row * 4) | 0) !== asset) row++;
  if (row === 360) return;
  const bit = (Math.imul(row, 1024) + index) >>> 0;
  if (bit === 0xffffffff) return;
  checkRange(s.readFlags.length * 8, bit, 1);
  const byte = bit >>> 3,
    mask = 1 << (bit & 7);
  if (!(s.readFlags[byte]! & mask)) {
    for (let i = 0; ; i++) {
      const id = romWord(0x20d5a0 + i * 4) | 0;
      if (id === 65535) break;
      if (id === asset) {
        s.setVariable(0x1f4c / 4, s.variable(0x1f4c / 4) + 1);
        break;
      }
    }
  }
  s.readFlags[byte] = s.readFlags[byte]! | mask;
}

/** 140045310: drain the native per-slot continuation queue into the history rings. */
export function recordMessageHistory(
  h: Pick<OpcodeExecution, 'state' | 'backlog'>,
  slot: number,
): void {
  const s = h.state,
    g = (a: number) => s.get(a),
    p = (a: number, v: number, w = 4) => s.put(a, v, w),
    ptr = (a: number) => Number(s.view(a, 8).getBigUint64(0, true));
  const properties = () => s.variable((Math.imul(slot, 10) + 0x110a) >>> 0);
  if (s.flags[0x136]! & 8 || properties() & 2) {
    p(0x179e6d0 + slot * 4, 0);
    p(0x20ddc0 + slot * 4, 65535);
    p(0x179e680 + slot * 8, 0, 8);
    return;
  }
  for (let i = 0; i < g(0x179e6d0 + slot * 4) >>> 0; i++) {
    const q = slot * 80 + i;
    if (g(0x179da00 + q * 4) !== 0) continue;
    const voice = g(0x17a0000 + q * 4);
    h.backlog.append(
      ptr(0x179e700 + q * 8),
      voice,
      voice === -1 ? 0 : g(0x179cd80 + q * 4),
      g(0x20ddc0 + slot * 4),
    );
    p(0x20ddc0 + slot * 4, 65535);
  }
  const address = ptr(0x179e680 + slot * 8);
  p(0x179e6d0 + slot * 4, 0);
  if (address && !(properties() & 2)) {
    const voice = g(0x179cae8 + slot * 4);
    h.backlog.append(
      address,
      voice,
      voice === -1 ? 0 : g(0x179cd58 + slot * 4),
      g(0x20ddc0 + slot * 4),
    );
  }
  p(0x179e680 + slot * 8, 0, 8);
}

/** Entire 01/0d, 14004e040. Waiting retains PC; completion advances exactly three bytes. */
export function waitMessage(h: OpcodeExecution): void {
  const s = h.state,
    c = h.context,
    slot = c.getUint32(0x13c, true),
    b = slot * 0x11984;
  const g = (a: number) => s.get(a),
    u = (a: number) => g(a) >>> 0,
    p = (a: number, v: number, w = 4) => s.put(a, v, w),
    ptr = (a: number) => s.view(a, 8).getBigUint64(0, true);
  const mode = h.scriptByte(Number(c.getBigUint64(0x158, true)) + 2),
    flag = (n: number, v: number) => s.setFlag((slot + n) >>> 0, v);
  const clearPending = () => flag(0x50b, 0),
    clearAdvance = () => {
      s.flags[0xa0] = s.flags[0xa0]! & ~64;
    },
    finish = () => {
      clearPending();
      h.skip(3);
    };
  if (g(0x176e52c) !== 0) {
    h.skip(3);
    clearAdvance();
    clearPending();
    p(0x176e52c, 0);
    return;
  }
  const oldTime = u(0x5b10a0 + b),
    duration = u(0x5b10a4 + b),
    force = s.flag((slot + 0x50e) >>> 0);
  let frames = u(0x17abc0c),
    step = 0;
  if (oldTime < duration) {
    step = g(0x17add34) === 1 && g(0x179cae8 + slot * 4) !== -1 ? 0x300 : g(0x17ac200 + slot * 4);
    if (step === 0x1000) step = 0x3fff0000;
    step = Math.imul(step, frames);
    if (g(0x17ac1d0 + slot * 4) !== 0 || force) step = 0x3fff0000;
  }
  if (s.bytes(0x5b10b4 + b, 1)[0] === 0) {
    if (g(0x17ac258 + slot * 4) !== 0) p(0x5b10b4 + b, 3, 1);
    else if (oldTime !== 0xffffffff) p(0x5b10a0 + b, Math.min(duration, (oldTime + step) >>> 0));
  }
  advanceMessageGlyphs(h, slot);
  const status = u(0x5b10b0 + b);
  const events = (all: boolean) => {
    for (let i = 0; i < u(0x6610cc); i++) {
      const time = u(0x7378c0 + i * 4);
      if (time === 0xffffffff || (!all && time > oldTime)) continue;
      const address = ptr(0x80c350 + i * 8),
        pc = c.getBigUint64(0x158, true);
      p(0x7378c0 + i * 4, -1);
      c.setBigUint64(0x158, address, true);
      h.expression();
      c.setBigUint64(0x158, pc, true);
    }
  };
  const tips = (all: boolean) => {
    for (let i = 0; i < u(0x80c3f0); i++) {
      const time = u(0x79a250 + i * 4);
      if (time === 0xffffffff || (!all && time > oldTime)) continue;
      const id = u(0x799b20 + i * 4),
        bit = Math.imul(id, 3) >>> 0;
      p(0x79a250 + i * 4, -1);
      checkRange(s.auxiliary.length * 8, bit, 1);
      const byte = bit >>> 3,
        mask = 1 << (bit & 7);
      if (s.auxiliary[byte]! & mask) continue;
      s.auxiliary[byte] = s.auxiliary[byte]! | mask;
      if (g(0x17adca0) !== 0) {
        const n = u(0x5afabc);
        p(0x5afae0 + n * 12, id);
        p(0x5afae4 + n * 12, 0);
        const width = h.messageBoxes.measure(
          h.messageAddress(g(0x5a9838), (g(0x5a7704 + id * 28) + 100) >>> 0),
          20,
        );
        const next = u(0x5afabc);
        p(0x5afae8 + next * 12, width);
        p(0x5afabc, next + 1);
      }
      const recent = u(0x5b0a3c);
      p(0x5b0a3c, recent + 1);
      p(0x5a9840 + recent * 2, id, 2);
    }
  };
  const clearTimes = () => {
    for (let i = 0; i < u(0x5b10ac + b); i++)
      if (g(0x5bfb44 + b + i * 4) > 0) p(0x5bfb44 + b + i * 4, 0);
  };
  const mark = () =>
    markMessageRead(
      h,
      s.variable((Math.imul(slot, 2) + 0x92a) >>> 0),
      s.variable((Math.imul(slot, 2) + 0x929) >>> 0),
    );
  if (status === 1) {
    events(false);
    tips(false);
    h.yield();
    return;
  }
  if (status > 1 && g(0x17ac2f0 + slot * 4) === 0) p(0x17ac2f0 + slot * 4, 2);
  if (status === 2) {
    if (u(0x6610cc)) {
      events(true);
      frames = u(0x17abc0c);
    }
    if (u(0x80c3f0)) {
      tips(true);
      frames = u(0x17abc0c);
    }
    let end = g(0x5b10a8 + b);
    if (end !== 4 && end !== 5) {
      if (end === 0 && mode !== 1) {
        clearTimes();
        clearAdvance();
        finish();
        return;
      }
      clearAdvance();
      flag(0x4e3, 1);
      end = g(0x5b10a8 + b);
    }
    const timer = 0x17ac2b0 + slot * 4;
    if (force) p(timer, 0);
    const stopVoice = g(0x17abc04);
    let ignoreVoice = stopVoice;
    const subtract = (amount: number) => p(timer, u(timer) <= amount ? 0 : u(timer) - amount);
    if ((end - 4) >>> 0 < 2) {
      ignoreVoice = 0;
      const delay = u(0x5b10dc + b);
      if (!delay) subtract(Math.imul(g(0x17adca8), frames) >>> 0);
      else {
        const amount = (frames << 8) >>> 0;
        let next = delay <= amount ? 0 : (delay - amount) >>> 0;
        if (frames > 1 && next >= 256) next -= 256;
        p(0x5b10dc + b, next);
        if (!next) p(timer, 0);
      }
    } else if (u(0x17ac288 + slot * 4) < 0xffff1000) {
      subtract(Math.imul(g(0x17ac288 + slot * 4), frames) >>> 0);
      ignoreVoice = 0;
    }
    const audio = () => 0x5a7110 + s.bytes(0x5b10b5 + b, 1)[0]! * 0x98,
      stop = () => {
        p(audio(), -1);
        p(audio() + 12, 0);
      };
    if (!(s.flags[0x9b]! & 16) && g(0x17ac1d0 + slot * 4) !== 0) {
      p(0x17ac1f8, 0);
      p(timer, 0);
      if (stopVoice === 1) stop();
    }
    if (g(timer) !== 0) {
      h.yield();
      return;
    }
    const a = audio();
    if (
      g(a + 0x38) !== 0 &&
      g(a + 0x3c) !== 1 &&
      ignoreVoice !== 1 &&
      g(0x17ac1d0 + slot * 4) !== 1
    ) {
      h.yield();
      return;
    }
    if (stopVoice === 1) stop();
    flag(0x4bd, 0);
    flag(0x4e3, 0);
    s.flags[0xa0] = s.flags[0xa0]! | 64;
    // Disassembly reads the font flags even for the immediate history path.
    const font = s
      .view(0x7fbd80 + (s.variable((Math.imul(slot, 10) + 0x110b) >>> 0) >>> 0) * 48, 2)
      .getUint16(0, true);
    end = g(0x5b10a8 + b);
    if (((end - 3) & 0xfffffffd) === 0) {
      recordMessageHistory(h, slot);
      mark();
      clearTimes();
      h.yield();
      flag(0x771, 1);
      finish();
      return;
    }
    if (end === 2 || mode === 1 || !(font & 2)) {
      p(0x5b10b4 + b, g(0x17ac258 + slot * 4) === 0 ? 2 : 4, 1);
      h.yield();
      return;
    }
    const n = u(0x179e6d0 + slot * 4),
      q = slot * 80 + n,
      hidden = Number(
        !!(s.flags[0x136]! & 8 || s.variable((Math.imul(slot, 10) + 0x110a) >>> 0) & 2),
      );
    p(0x17a0000 + q * 4, g(0x179cae8 + slot * 4));
    p(0x179cd80 + q * 4, g(0x17ac378 + slot * 4));
    s.view(0x179e700 + q * 8, 8).setBigUint64(0, ptr(0x179e680 + slot * 8), true);
    p(0x179da00 + q * 4, hidden);
    p(0x179e6d0 + slot * 4, n + 1);
    p(0x179e680 + slot * 8, 0, 8);
    mark();
    clearTimes();
    h.yield();
    finish();
    return;
  }
  if (status === 3) {
    h.yield();
    return;
  }
  p(0x80c4d0 + slot * 4, 0);
  p(0x80cff0 + slot * 4, 0);
  flag(0x771, 1);
  p(0x5b10ac + b, 0);
  recordMessageHistory(h, slot);
  mark();
  finish();
}
