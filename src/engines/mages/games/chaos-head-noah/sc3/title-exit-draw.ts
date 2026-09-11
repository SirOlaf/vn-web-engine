import {nativeSampler, nativeBlend} from './render-state.js';
import type {NoahState} from './noah-state.js';
import type {DialogDrawList} from './dialog-draw.js';
import type {SpriteDraw} from '../../../../../graphics/draw-list.js';
import {drawTitleSweep} from './title-menu-draw.js';
/** 1400306e0: title states 4/5 under the destination menu. No hit regions. */
export function drawTitleExit(s: NoahState): DialogDrawList {
  const out: DialogDrawList = {sprites: [], commands: [], regions: []},
    alpha = Math.imul(32 - s.variable(0x218c / 4), 8);
  const sprite = (
    x: number,
    y: number,
    width: number,
    height: number,
    dx: number,
    dy: number,
    a = 256,
  ) => {
    const d: SpriteDraw = {
      ...nativeSampler(s),
      texture: 3,
      source: {x, y, width, height},
      destination: {x: dx, y: dy, width, height},
      color: 0xffffff,
      alpha: a,
    };
    out.sprites.push(d);
    out.commands!.push(d);
    return d;
  };
  sprite(0, 0, 1920, 1080, 0, 0);
  sprite(0, 1086, 1920, 1080, 0, 0);
  drawTitleSweep(s, sprite);
  sprite(0, 3817, 1920, 24, 0, 986);
  sprite(0, 2172, 942, 331, 747, 465, alpha);
  if (s.flags[0xf1]! & 4) sprite(824, 2875, 254, 184, 516, 0, alpha);
  sprite(0, 3197, 732, 136, 0, 80, alpha);
  sprite(948, 2242, 196, 32, 586, 218, alpha);
  sprite(0, 2875, 206, 322, 534, 0, alpha);
  sprite(412, 2875, 206, 322, 534, 0);
  const selected = s.get(0x5afa9c) >>> 0;
  if (selected === 3) sprite(206, 2875, 206, 322, 534, 0, alpha);
  else if (selected === 4) sprite(618, 2875, 206, 322, 534, 0, alpha);
  else if (selected === 2 && s.get(0x5b0a40) !== 0) {
    sprite(1078, 2875, 502, 156, 93, 97, alpha);
    (s.flags[0x6f]! & 32 ? [112, 154, 196] : [127, 184]).forEach((y, i) =>
      sprite(1586, 2875 + i * 120 + (s.get(0x5af918) === i ? 40 : 0), 350, 40, 109, y, alpha),
    );
  }
  const i = s.get(0x5b04b8) >>> 0;
  s.put(0x5b09b8 + i * 4, 2);
  s.put(0x5b04b8, i + 1);
  return out;
}
