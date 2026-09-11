import {checkRange} from '../../../../../../core/binary.js';
import type {OpcodeExecution} from './types.js';
import {advanceMessageGlyphs, markMessageRead, recordMessageHistory} from './message-wait.js';

const STRIDE = 0x11984;

function processTimedItems(h: OpcodeExecution, through: number, all: boolean): void {
  const s = h.state,
    u = (a: number) => s.get(a) >>> 0,
    p = (a: number, v: number, w = 4) => s.put(a, v, w);
  for (let i = 0; i < u(0x6610cc); i++) {
    const time = u(0x7378c0 + i * 4);
    if (time === 0xffffffff || (!all && time > through)) continue;
    const address = Number(s.view(0x80c350 + i * 8, 8).getBigUint64(0, true));
    p(0x7378c0 + i * 4, -1);
    h.textExpression(address);
  }
  for (let i = 0; i < u(0x80c3f0); i++) {
    const time = u(0x79a250 + i * 4);
    if (time === 0xffffffff || (!all && time > through)) continue;
    const id = u(0x799b20 + i * 4),
      bit = Math.imul(id, 3) >>> 0;
    p(0x79a250 + i * 4, -1);
    checkRange(s.auxiliary.length * 8, bit, 1);
    const byte = bit >>> 3,
      mask = 1 << (bit & 7);
    if (s.auxiliary[byte]! & mask) continue;
    s.auxiliary[byte] = s.auxiliary[byte]! | mask;
    if (s.get(0x17adca0) !== 0) {
      const n = u(0x5afabc);
      p(0x5afae0 + n * 12, id);
      p(0x5afae4 + n * 12, 0);
      p(
        0x5afae8 + n * 12,
        h.messageBoxes.measure(
          h.messageAddress(s.get(0x5a9838), (s.get(0x5a7704 + id * 28) + 100) >>> 0),
          20,
        ),
      );
      p(0x5afabc, n + 1);
    }
    const recent = u(0x5b0a3c);
    p(0x5b0a3c, recent + 1);
    p(0x5a9840 + recent * 2, id, 2);
  }
}

/** 14004b2b0 / 14004bc90. The former additionally publishes the shared delay. */
function advanceUntilReady(h: OpcodeExecution, slot: number, sharedDelay: boolean): boolean {
  const s = h.state,
    b = slot * STRIDE,
    g = (a: number) => s.get(a),
    u = (a: number) => g(a) >>> 0,
    p = (a: number, v: number, w = 4) => s.put(a, v, w);
  const old = u(0x5b10a0 + b),
    duration = u(0x5b10a4 + b);
  let step = 0;
  if (old < duration) {
    step = g(0x17add34) === 1 && g(0x179cae8 + slot * 4) !== -1 ? 0x300 : g(0x17ac200 + slot * 4);
    if (step === 0x1000) step = 0x3fff0000;
    if (g(0x17ac1d0 + slot * 4) !== 0) step = 0x3fff0000;
  }
  if (s.bytes(0x5b10b4 + b, 1)[0] === 0) {
    if (g(0x17ac258 + slot * 4) !== 0) p(0x5b10b4 + b, 3, 1);
    else if (old !== 0xffffffff) p(0x5b10a0 + b, Math.min(duration, (old + step) >>> 0));
  }
  advanceMessageGlyphs(h, slot);
  const status = u(0x5b10b0 + b);
  if (status === 1) {
    processTimedItems(h, old, false);
    return true;
  }
  if (status === 2) {
    processTimedItems(h, old, true);
    if (sharedDelay && (g(0x5b10a8 + b) - 4) >>> 0 < 2) {
      p(0x179ccf4, g(0x5b10dc + b));
      p(0xc4dc0c, 1);
    }
  }
  return false;
}

function clearPositiveTimes(h: OpcodeExecution, slot: number): void {
  const s = h.state,
    b = slot * STRIDE;
  for (let i = 0; i < s.get(0x5b10ac + b) >>> 0; i++)
    if (s.get(0x5bfb44 + b + i * 4) > 0) s.put(0x5bfb44 + b + i * 4, 0);
}
function mark(h: OpcodeExecution, slot: number): void {
  markMessageRead(
    h,
    h.state.variable(Math.imul(slot, 2) + 0x92a),
    h.state.variable(Math.imul(slot, 2) + 0x929),
  );
}

/** 14004b720 / 14004c0d0. Returns the native nonzero/pending result. */
function finishMessage(h: OpcodeExecution, slot: number, sharedDelay: boolean): boolean {
  const s = h.state,
    b = slot * STRIDE,
    g = (a: number) => s.get(a),
    u = (a: number) => g(a) >>> 0,
    p = (a: number, v: number, w = 4) => s.put(a, v, w),
    flag = (id: number, v: number) => s.setFlag((slot + id) >>> 0, v);
  advanceMessageGlyphs(h, slot);
  const status = g(0x5b10b0 + b);
  if (status !== 2) {
    if (status === 3) return true;
    flag(0x771, 1);
    p(0x5b10ac + b, 0);
    flag(0x50b, 0);
    recordMessageHistory(h, slot);
    mark(h, slot);
    return false;
  }
  const end = g(0x5b10a8 + b);
  if (end === 0) {
    flag(0x50b, 0);
    clearPositiveTimes(h, slot);
    return false;
  }
  const timer = 0x17ac2b0 + slot * 4,
    amount = u(0x17ac288 + slot * 4);
  let subtract = false;
  if (sharedDelay) {
    if (g(0xc4dc0c) === 0) {
      s.flags[0xa0] = s.flags[0xa0]! & ~64;
      flag(0x4e3, 1);
      subtract = amount <= 0xffff0fff;
    } else if (g(0x179ccf4) !== 0) {
      const delay = (u(0x179ccf4) - 1) >>> 0;
      p(0x179ccf4, delay);
      if (delay === 0) p(timer, 0);
    } else subtract = true;
  } else if ((end - 4) >>> 0 < 2) {
    if (g(0x5b10dc + b) !== 0) {
      const delay = (u(0x5b10dc + b) - 1) >>> 0;
      p(0x5b10dc + b, delay);
      if (delay === 0) p(timer, 0);
    } else subtract = true;
  } else {
    s.flags[0xa0] = s.flags[0xa0]! & ~64;
    flag(0x4e3, 1);
    subtract = amount <= 0xffff0fff;
  }
  if (subtract) p(timer, amount < u(timer) ? (u(timer) - amount) >>> 0 : 0);
  const audio = 0x5a7110 + s.bytes(0x5b10b5 + b, 1)[0]! * 0x98,
    mode = g(0x17abc04);
  if (!(s.flags[0x9b]! & 16) && g(0x17ac1d0 + slot * 4) !== 0) {
    p(0x17ac1f8, 0);
    p(timer, 0);
    if (mode === 1) {
      p(audio, -1);
      p(audio + 12, 0);
    }
  }
  if (g(timer) !== 0) return true;
  if (g(audio + 0x38) !== 0 && g(audio + 0x3c) !== 1 && mode !== 0) return true;
  if (mode === 1) {
    p(audio, -1);
    p(audio + 12, 0);
  }
  flag(0x4bd, 0);
  flag(0x4e3, 0);
  s.flags[0xa0] = s.flags[0xa0]! | 64;
  if (((end - 3) & 0xfffffffd) === 0) {
    recordMessageHistory(h, slot);
    mark(h, slot);
    clearPositiveTimes(h, slot);
    flag(0x50b, 0);
    flag(0x771, 1);
    return false;
  }
  const font = s
    .view(0x7fbd80 + (s.variable(Math.imul(slot, 10) + 0x110b) >>> 0) * 48, 2)
    .getUint16(0, true);
  if (end === 2 || !(font & 2)) {
    p(0x5b10b4 + b, g(0x17ac258 + slot * 4) === 0 ? 2 : 4, 1);
    return true;
  }
  const n = u(0x179e6d0 + slot * 4),
    q = slot * 80 + n,
    hidden = Number(!!(s.flags[0x136]! & 8 || s.variable(Math.imul(slot, 10) + 0x110a) & 2));
  p(0x17a0000 + q * 4, g(0x179cae8 + slot * 4));
  p(0x179cd80 + q * 4, g(0x17ac378 + slot * 4));
  s.view(0x179e700 + q * 8, 8).setBigUint64(
    0,
    s.view(0x179e680 + slot * 8, 8).getBigUint64(0, true),
    true,
  );
  p(0x179e6d0 + slot * 4, n + 1);
  p(0x179da00 + q * 4, hidden);
  p(0x179e680 + slot * 8, 0, 8);
  flag(0x50b, 0);
  mark(h, slot);
  clearPositiveTimes(h, slot);
  return false;
}

function beginClose(h: OpcodeExecution, slot: number): void {
  const s = h.state,
    b = slot * STRIDE,
    p = (a: number, v: number, w = 4) => s.put(a, v, w);
  p(0x179ccf8 + slot * 4, 2);
  if (s.get(0x179cae8 + slot * 4) !== -1 && s.get(0x17ac258 + slot * 4) === 0) {
    const channel = s.bytes(0x5b10b5 + b, 1)[0]!;
    if (s.get(0x5a70d8 + channel * 4) === 0) {
      h.resumeAudio(channel);
      p(0x5a70d8 + channel * 4, 1);
    }
    p(0x5a7110 + channel * 0x98 + 0x40, 0);
    p(0x5a7110 + channel * 0x98 + 0x48, 0, 8);
  }
  p(0x17ac1f8, 1);
  s.setFlag((slot + 0x4bd) >>> 0, 1);
  p(0x5b10b4 + b, 0, 1);
  h.yield();
}

/** Entire 01/08, 14004c670: all-slot and selected-slot staged message control. */
export function controlSceneMessages(h: OpcodeExecution): void {
  const s = h.state,
    c = h.context,
    original = c.getBigUint64(0x158, true);
  h.skip(2);
  const selector = h.byte(),
    retry = () => {
      c.setBigUint64(0x158, original, true);
      h.yield();
    };
  switch (selector) {
    case 0:
      s.put(0xc4dc0c, 0);
      for (let slot = 0; slot < 3; slot++) {
        s.put(0x179ccf8 + slot * 4, 0);
        const b = slot * STRIDE;
        if (s.get(0x5b10d8 + b) !== 0) {
          s.put(0x5b10d8 + b, 0);
          s.put(0x179ccf8 + slot * 4, 1);
          if (!s.flag(0x9c6 + slot)) {
            s.setFlag(0x9c6 + slot, 1);
            h.yield();
          }
        }
      }
      return;
    case 1:
      if (
        [0, 1, 2].some(
          (slot) => s.get(0x179ccf8 + slot * 4) === 1 && s.variable(0x839 + slot) >>> 0 < 0x100,
        )
      )
        retry();
      return;
    case 2:
      for (let slot = 0; slot < 3; slot++)
        if (s.get(0x179ccf8 + slot * 4) === 1) beginClose(h, slot);
      return;
    case 3: {
      let pending = false;
      for (let slot = 0; slot < 3; slot++)
        if (s.get(0x179ccf8 + slot * 4) === 2) {
          if (!advanceUntilReady(h, slot, true)) s.put(0x179ccf8 + slot * 4, 3);
          pending = true;
        }
      if (pending) retry();
      return;
    }
    case 4: {
      let pending = false;
      for (let slot = 0; slot < 3; slot++)
        if (s.get(0x179ccf8 + slot * 4) === 3) {
          if (!finishMessage(h, slot, true)) s.put(0x179ccf8 + slot * 4, 0);
          pending = true;
        }
      if (pending) retry();
      return;
    }
    case 10: {
      s.put(0xc4dc0c, 0);
      const slot = h.expression() >>> 0,
        b = slot * STRIDE;
      c.setUint32(0x13c, slot, true);
      s.put(0x179ccf8 + slot * 4, 0);
      if (s.get(0x5b10d8 + b) !== 0) {
        s.put(0x5b10d8 + b, 0);
        s.put(0x179ccf8 + slot * 4, 1);
        if (!s.flag((slot + 0x9c6) >>> 0)) {
          s.setFlag((slot + 0x9c6) >>> 0, 1);
          h.yield();
        }
      }
      return;
    }
    case 11: {
      const slot = c.getUint32(0x13c, true);
      if (s.get(0x179ccf8 + slot * 4) === 1 && s.variable((slot + 0x839) >>> 0) >>> 0 < 0x100)
        retry();
      return;
    }
    case 12: {
      const slot = c.getUint32(0x13c, true);
      if (s.get(0x179ccf8 + slot * 4) === 1) beginClose(h, slot);
      return;
    }
    case 13: {
      const slot = c.getUint32(0x13c, true);
      if (s.get(0x179ccf8 + slot * 4) === 2) {
        if (advanceUntilReady(h, slot, false)) retry();
        else s.put(0x179ccf8 + slot * 4, 3);
      }
      return;
    }
    case 14: {
      const slot = c.getUint32(0x13c, true);
      if (s.get(0x179ccf8 + slot * 4) === 3) {
        if (finishMessage(h, slot, false)) retry();
        else s.put(0x179ccf8 + slot * 4, 0);
      }
      return;
    }
    case 20:
      if (
        [0, 1, 2].some(
          (slot) => s.get(0x179ccf8 + slot * 4) !== 0 && s.get(0x5b10b0 + slot * STRIDE) !== 2,
        )
      )
        retry();
      return;
  }
}
