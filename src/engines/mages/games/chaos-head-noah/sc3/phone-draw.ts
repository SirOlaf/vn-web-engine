import type {Sc3Runtime} from './runtime.js';
import type {DrawCommand, SpriteDraw} from '../../../../../graphics/draw-list.js';
import {drawWrappedText, wrappedLineCount} from './wrapped-text-draw.js';
import {f, add, mul} from './render-math.js';
import {nativeBlend, nativeSampler} from './render-state.js';
/** 1400069c0, 140006fb0, 140007320, called after each matching background draw. */
export function drawPhone(vm: Sc3Runtime, index: number): DrawCommand[] {
  const s = vm.state,
    mode = s.variable(0x6d20 / 4),
    out: DrawCommand[] = [];
  if (!(s.flags[0x160]! & 64) || mode < 0 || mode > 2) return out;
  if (mode === 2) s.put(0x5358dc, (s.get(0x5358dc) + 1) & 31);
  const bits = s.variable(0x6c98 / 4) >>> 0,
    slot = bits !== 0 && (bits & (bits - 1)) === 0 ? 31 - Math.clz32(bits) : -1;
  if (slot !== index) return out;
  const v = (a: number) => s.variable(a / 4),
    alpha = s.variable(0x11a1 + index * 40),
    bx = (s.variable(0x1194 + index * 40) + s.variable(0x960 + index * 10)) | 0,
    by = (s.variable(0x1195 + index * 40) + s.variable(0x961 + index * 10)) | 0,
    host = {byte: (a: number) => vm.dataByte(a), expression: (a: number) => vm.textExpression(a)};
  const sprite = (
    texture: number,
    x: number,
    y: number,
    width: number,
    height: number,
    dx: number,
    dy: number,
    opacity = alpha,
  ) => {
    const d: SpriteDraw = {
      texture,
      source: {x, y, width, height},
      destination: {x: dx, y: dy, width, height},
      color: 0xffffff,
      alpha: Math.max(0, Math.min(255, opacity)),
      ...nativeSampler(s),
      blendState: nativeBlend(s.get(0x587344) & 65535),
    };
    out.push(d);
  };
  const target = (texture: number | null) =>
    out.push({kind: 'target', texture, width: 1920, height: 1080});
  const word = (a: number) =>
    (vm.dataByte(a) |
      (vm.dataByte(a + 1) << 8) |
      (vm.dataByte(a + 2) << 16) |
      (vm.dataByte(a + 3) << 24)) >>>
    0;
  const message = (i: number) => {
    const slot = v(0x6d1c),
      id = s.variable(0x1b27 + i);
    if (v(0x6d10) !== 0) return vm.messageAddress(slot, id);
    const base = Number(s.view(0x17adcb0 + slot * 8, 8).getBigUint64(0, true)),
      entry = base + (word(base + 4) | 0) + (Math.imul(id, 4) >>> 0);
    return base + word(entry);
  };
  const text = (
    i: number,
    address: number,
    x: number,
    y: number,
    width: number,
    size: number,
    line: number,
  ) =>
    out.push(
      ...drawWrappedText(
        s,
        host,
        address,
        x,
        y,
        width,
        256,
        s.variable(0x1b35 + i),
        size,
        line,
        alpha,
      ).sprites,
    );
  if (mode === 0) {
    const dx = f((788 - Math.trunc(Math.imul(bx, 3) / 2)) | 0),
      dy = f((-12 - Math.trunc(Math.imul(by, 3) / 2)) | 0);
    sprite(174, 0, 0, 969, 1119, dx, dy);
    sprite(174, f(Math.imul(v(0x6d14), 391)), 1129, 381, 180, add(dx, 31), add(dy, 185));
    const icon = v(0x6d18) >>> 0,
      row = Math.trunc(icon / 5);
    sprite(
      174,
      f((Math.imul(icon, 42) - Math.imul(row, 210) + 782) | 0),
      f((Math.imul(row, 28) + 1129) | 0),
      42,
      28,
      add(add(dx, 221), s.get(0x17ac318) === 1 ? 64 : 0),
      add(dy, 329),
    );
    target(206);
    sprite(174, 0, 0, 969, 1119, dx, dy);
    let ty = (251 - by) | 0;
    for (let i = 0; i < v(0x6d0c) >>> 0; i++) {
      const address = message(i),
        lines = wrappedLineCount(host, address, 614, 20);
      text(i, address, f((538 - bx) | 0), f(ty), 614, 20, 25);
      ty = (ty + Math.imul(lines, 25) + 13) | 0;
      sprite(174, 1002, 1129, 970, 8, dx, f((Math.trunc(Math.imul(ty, 3) / 2) - 17) | 0));
    }
    target(null);
    sprite(206, dx, add(dy, 389), 969, 724, dx, add(dy, 389));
    s.put(0x587344, 2);
    sprite(174, 979, 0, 969, 1119, dx, dy);
    s.put(0x587344, 0);
  } else {
    out.push({kind: 'capture', texture: 203, width: 1920, height: 1080});
    target(206);
    sprite(203, 0, 0, 1920, 1080, 0, 0, 256);
    if (mode === 1) {
      let ty = (699 - by) | 0;
      const tx = (100 - bx) | 0;
      for (let i = 0; i < v(0x6d0c) >>> 0; i++) {
        const address = message(i),
          lines = wrappedLineCount(host, address, 836, 26);
        text(i, address, f(tx), f(ty), 836, 26, 38);
        ty = (ty + Math.imul(lines, 38)) | 0;
      }
      target(null);
      const dx = f(Math.trunc(Math.imul(tx, 3) / 2)),
        dy = f(Math.trunc(Math.imul((699 - by) | 0, 3) / 2));
      sprite(206, dx, dy, 1254, 270, dx, dy);
    } else {
      let lines = 0;
      for (let i = 0; i < v(0x6d0c) >>> 0; i++)
        lines = (lines + wrappedLineCount(host, message(i), 688, 20)) >>> 0;
      const height = lines > 12 ? 468 : (Math.imul(lines, 35) + 48) | 0;
      let ty = height;
      for (let i = 0; i < v(0x6d0c) >>> 0; i++) {
        const address = message(i),
          count = wrappedLineCount(host, address, 688, 20);
        ty = (ty - Math.imul(count, 35)) | 0;
        text(i, address, 248, f(ty), 688, 20, 35);
        if (ty <= ((48 - s.variable(0x1195 + index * 40)) | 0)) break;
      }
      if (s.get(0x5358dc) & 8)
        out.push(
          ...drawWrappedText(
            s,
            host,
            vm.messageAddress(1, 2500),
            248,
            f(height),
            688,
            256,
            0xffffff,
            20,
            35,
            alpha,
          ).sprites,
        );
      target(null);
      sprite(206, 372, 72, 1032, mul(mul(f((height + 22) | 0), 3), 0.5), 372, 72);
    }
  }
  return out;
}
