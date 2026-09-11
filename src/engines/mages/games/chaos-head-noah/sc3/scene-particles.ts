import type {NoahState} from './noah-state.js';
import type {TriangleDraw} from '../../../../../graphics/triangle-draw.js';
import {drawRain} from './rain.js';
import {drawSnow} from './snow.js';
/** 140012470 retains rain/snow interleaving and independent duplicate priority passes. */
export function sceneParticlesAtPriority(s: NoahState, priority: number): TriangleDraw[] {
  const out: TriangleDraw[] = [];
  for (const [base, draw] of [
    [0x5de8, drawRain],
    [0x5e80, drawSnow],
    [0x5e04, drawRain],
    [0x5e90, drawSnow],
  ] as const)
    for (let bank = 0; bank < 2; bank++)
      for (const side of [1, 0])
        if (s.variable((base + bank * 80 + side * 4) / 4) === priority) {
          const command = draw(s, side, bank);
          if (command) out.push(command);
        }
  return out;
}
/** 140017d20: native position history and eight delayed character attachments. */
export function advanceCharacterTrail(s: NoahState, bank: number, character: number): void {
  const b = bank * 30,
    offset = bank * 360,
    x = 0x545230 + offset,
    y = 0x56caa0 + offset,
    px = s.variable(0x13ec + character * 40),
    py = s.variable(0x13ed + character * 40);
  if (s.get(0x545658 + bank * 4) === 0) {
    s.put(0x545658 + bank * 4, 1);
    for (let i = 0; i < 90; i++) {
      s.put(x + i * 4, px);
      s.put(y + i * 4, py);
    }
  }
  for (let i = 89; i > 0; i--) {
    s.put(x + i * 4, s.get(x + (i - 1) * 4));
    s.put(y + i * 4, s.get(y + (i - 1) * 4));
  }
  s.put(x, px);
  s.put(y, py);
  const step = s.variable(b + 0x1811) >>> 0,
    fade = s.variable(b + 0x1812);
  let at = 0,
    alpha = 256;
  for (let i = 0; i < 8; i++) {
    at = (at + step) >>> 0;
    alpha = Math.max(0, (alpha - fade) | 0);
    if (at > 80) {
      at = 80;
      alpha = 0;
    }
    s.setVariable(b + 0x1813 + i * 3, s.get(x + at * 4));
    s.setVariable(b + 0x1814 + i * 3, s.get(y + at * 4));
    s.setVariable(b + 0x1815 + i * 3, alpha);
  }
}
/** Side effects before the priority traversal in 140011260. */
export function advanceSceneRenderState(s: NoahState): void {
  s.put(0x56ce48, s.get(0x56ce48) ^ 1);
  const count = s.get(0x5afabc);
  if (count !== 0 && !(s.flags[0x137]! & 4) && !(s.variable(0x2104 / 4) & 4)) {
    if (s.get(0x5afae4) < 1268) s.put(0x5afae4, s.get(0x5afae4) + 8);
    else {
      for (let i = 1; i < count; i++)
        for (let j = 0; j < 3; j++)
          s.put(0x5afae0 + (i - 1) * 12 + j * 4, s.get(0x5afae0 + i * 12 + j * 4));
      s.put(0x5afabc, count - 1);
    }
  }
  s.put(0x578b88, 255);
}
export function advanceSceneRenderTimers(s: NoahState): void {
  for (const [a, step] of [
    [0x5378e0, 1],
    [0x5425a0, 2],
  ] as const) {
    const value = (s.get(a) + step) | 0;
    s.put(a, value > 1919 ? value - 1920 : value);
  }
}
export function prepareCharacterTrails(s: NoahState): void {
  for (let i = 0; i < 16; i++)
    for (let bank = 0; bank < 2; bank++) {
      if (!s.flag(0x983 + bank)) s.put(0x545658 + bank * 4, 0);
      else if (s.variable(bank * 30 + 0x1810) === 1 << i) advanceCharacterTrail(s, bank, i);
    }
}
