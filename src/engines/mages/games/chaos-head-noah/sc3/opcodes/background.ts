import type {OpcodeExecution} from './types.js';
import {SURFACE_BASE, SURFACE_STRIDE} from '../textures.js';
/** 140010d60: a single bit in the low sixteen bits identifies a background slot. */
export function backgroundIndex(mask: number): number {
  const value = mask >>> 0;
  return value !== 0 && value <= 0x8000 && (value & (value - 1)) === 0
    ? 31 - Math.clz32(value)
    : -1;
}
/** Entire 140058c50 state machine, including solid color, cancellation and ignored phases. */
export function loadBackground(h: OpcodeExecution): void {
  const s = h.state;
  if (s.get(0x81007c) !== 0) {
    h.yield();
    return;
  }
  const original = h.context.getBigUint64(0x158, true);
  h.skip(2);
  const index = backgroundIndex(h.expression()),
    asset = h.expression() >>> 0;
  const phase = s.get(0x17a0cb8),
    loader = h.backgroundTextures,
    graphics = loader.textures;
  const target = () => s.variable(0x3520 / 4 + index);
  const count = (delta: number) => s.setVariable(0x3404 / 4, s.variable(0x3404 / 4) + delta);
  const flag = index + 0x4f6,
    finishFlag = () => s.setFlag(flag, 0);
  switch (phase) {
    case 0:
      if (s.variable(0x3394 / 4) === 0) {
        graphics.unload(target());
        s.put(0x17a0cb8, 1);
      }
      break;
    case 1: {
      const id = target();
      graphics.release(id);
      s.setVariable(0x466c / 4 + Math.imul(index, 40), asset);
      if (asset & 0xff000000) {
        graphics.createRgba(id, 1920, 1080);
        graphics.fillRgba(id, [(asset >>> 16) & 255, (asset >>> 8) & 255, asset & 255, 255]);
        h.yield();
        return;
      }
      if (s.flags[0xe7]! & 4) return;
      s.put(0x17a0ca8, loader.start(0, asset));
      s.put(0x17a0cb8, 2);
      s.put(0x17a0cac, id);
      s.setFlag(flag, 1);
      count(1);
      s.setVariable(0x3394 / 4, 1);
      break;
    }
    case 2: {
      const job = s.get(0x17a0ca8) >>> 0,
        status = 0x587270 + job * 4;
      if (s.get(status) !== 0) break;
      const size = s.get(0x587230 + job * 4),
        pointer = Number(s.view(0x5872c0 + job * 8, 8).getBigUint64(0, true));
      s.put(status, 0);
      s.put(0x17a0cc8, size);
      s.put(0x17a0ca0, pointer, 8);
      s.put(0x5872c0 + job * 8, 0, 8);
      s.put(0x587230 + job * 4, 0);
      const id = s.get(0x17a0cac);
      loader.upload(id, pointer, size);
      s.put(0x17a0cb8, 8);
      const a = SURFACE_BASE + id * SURFACE_STRIDE,
        w = (off: number) => s.view(a + off, 2).getUint16(0, true);
      const dimension = (n: number, scale: number, base: number) => {
        const f = Math.fround(Math.fround(w(n) * w(n + 4)) / w(n - 10));
        const converted =
          Number.isFinite(f) && f >= -2147483648 && f < 2147483648 ? Math.trunc(f) : -2147483648;
        return Math.trunc(Math.imul(converted, scale) / base);
      };
      s.setVariable(0x2ee0 / 4 + Math.imul(index, 2), dimension(0x72, 1280, 1920));
      s.setVariable(0x2ee4 / 4 + Math.imul(index, 2), dimension(0x74, 720, 1080));
      h.context.setBigUint64(0x158, original, true);
      return;
    }
    case 5: {
      const job = s.get(0x17a0ca8) >>> 0,
        status = s.get(0x587270 + job * 4);
      if (status !== 0 && status !== 3) break;
      s.put(0x5872c0 + job * 8, 0, 8);
      s.put(0x587230 + job * 4, 0);
      count(-1);
      s.setVariable(0x3394 / 4, 0);
      s.put(0x587270 + job * 4, 0);
      s.put(0x17a0cb8, 0);
      finishFlag();
      return;
    }
    case 8:
      s.put(0x17a0cb8, 10);
      count(-1);
      break;
    case 10:
      s.put(0x17a0cb8, 0);
      s.setVariable(0x3394 / 4, 0);
      s.flags[0x98] = s.flags[0x98]! & ~0x40;
      finishFlag();
      return;
  }
  h.retry();
}
