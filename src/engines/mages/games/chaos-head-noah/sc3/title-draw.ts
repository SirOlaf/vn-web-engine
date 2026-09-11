import {nativeSampler, nativeBlend} from './render-state.js';
import type {NoahState} from './noah-state.js';
import type {SpriteDraw} from '../../../../../graphics/draw-list.js';

/** Audited title reveal / press-start draw states in 140031fb0.
 * Other states are explicit renderer boundaries, not approximated animations. */
export function drawTitle(s: NoahState): SpriteDraw[] {
  const phase = s.variable(0x210c / 4),
    frame = s.variable(0x211c / 4) >>> 0,
    out: SpriteDraw[] = [];
  const sprite = (
    x: number,
    y: number,
    width: number,
    height: number,
    dx: number,
    dy: number,
    alpha = 256,
  ) => {
    const draw: SpriteDraw = {
      ...nativeSampler(s),
      texture: 3,
      source: {x, y, width, height},
      destination: {x: dx, y: dy, width, height},
      color: 0xffffff,
      alpha,
    };
    out.push(draw);
    return draw;
  };
  if (phase === 0) {
    if (frame < 272) {
      const scale = Math.fround(256 / 16),
        bias = Math.fround(Math.fround(Math.fround(255 - Math.min(272, frame)) * scale) / 255);
      sprite(0, 0, 1920, 1080, 0, 0).mask = {
        ...nativeSampler(s),
        texture: 3,
        source: {x: 1292, y: 2509, width: 640, height: 360},
        scale,
        bias,
      };
    } else {
      sprite(0, 0, 1920, 1080, 0, 0);
      const t = (frame - 272) >>> 0;
      sprite(0, 2172, 942, 331, 747, Math.fround((frame + 65) >>> 0), (t * 2) | 0);
      sprite(
        0,
        2172,
        942,
        331,
        747,
        Math.fround((465 - t) >>> 0),
        t > 63 ? Math.imul(128 - t, 2) : Math.imul(t, 2),
      );
    }
  } else if (phase === 1) {
    sprite(0, 0, 1920, 1080, 0, 0);
    sprite(0, 2172, 942, 331, 747, 465);
    const pulse = (s.get(0x5af94c) + 1) & 63;
    s.put(0x5af94c, pulse);
    sprite(
      0,
      3843,
      1920,
      35,
      0,
      900,
      pulse < 32 ? pulse << 3 : 256 - ((Math.imul(pulse, 256) - 8192) >> 5),
    );
    sprite(0, 3817, 1920, 24, 0, 986);
  } else throw new Error(`Invalid title leaf rendering state ${phase} (140031fb0)`);
  return out;
}
