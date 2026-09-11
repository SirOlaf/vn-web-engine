import type {NoahState} from './noah-state.js';
import type {SolidDraw} from '../../../../../graphics/draw-list.js';

/** Three ordered solid layers in 140011260 (140011cfe–140011e9f).
 * Both priority matches select one draw; rectangle dimensions default together.
 * Coordinates are physical pixels, unlike the background's 1.5× script space.
 */
export function sceneFills(s: NoahState, priority: number): SolidDraw[] {
  const result: SolidDraw[] = [];
  for (let layer = 0; layer < 3; layer++) {
    const base = 0x44c0 / 4 + layer * 10,
      v = (i: number) => s.variable(base + i);
    if (priority >>> 0 !== v(2) >>> 0 && priority >>> 0 !== v(7) >>> 0) continue;
    const alpha = (v(1) + s.variable(0x2b88 / 4 + layer)) | 0;
    if (alpha === 0) continue;
    const custom = v(5) !== 0 && v(6) !== 0;
    result.push({
      kind: 'solid',
      destination: {
        x: custom ? Math.fround(v(3)) : 0,
        y: custom ? Math.fround(v(4)) : 0,
        width: custom ? Math.fround(v(5)) : 1920,
        height: custom ? Math.fround(v(6)) : 1080,
      },
      color: v(0) & 0xffffff,
      alpha: Math.max(0, Math.min(255, alpha)),
    });
  }
  return result;
}
