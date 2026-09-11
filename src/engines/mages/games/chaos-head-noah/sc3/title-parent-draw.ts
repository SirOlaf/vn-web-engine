import {textInteractionBoundary} from './dom-text-data.js';
import type {NoahState} from './noah-state.js';
import type {DialogDrawList} from './dialog-draw.js';
import type {SpriteDraw} from '../../../../../graphics/draw-list.js';
import {drawTitle} from './title-draw.js';
import {drawTitleMenu} from './title-menu-draw.js';
import {drawTitleExit} from './title-exit-draw.js';
import {drawExtras} from './extras-draw.js';
import {drawSceneLens} from './scene-effects.js';
import {nativeBlend, nativeSampler} from './render-state.js';
import {f, sub, mul} from './render-math.js';
import {appendMenuMarker} from './game-menu-draw.js';
/** Complete 140031fb0 parent dispatcher, including title lens/zoom transitions. */
export function drawTitleParent(s: NoahState): DialogDrawList {
  const out: DialogDrawList = {sprites: [], commands: [], regions: []},
    phase = s.variable(0x210c / 4),
    frame = s.variable(0x211c / 4) >>> 0;
  const push = (layer: DialogDrawList) => {
    textInteractionBoundary(layer.commands ?? layer.sprites);
    out.sprites.push(...layer.sprites);
    out.commands!.push(...(layer.commands ?? layer.sprites));
    out.regions.push(...layer.regions);
  };
  const sprite = (
    sx: number,
    sy: number,
    width: number,
    height: number,
    x: number,
    y: number,
    alpha = 256,
    texture = 3,
    dw = width,
    dh = height,
  ) => {
    const d: SpriteDraw = {
      texture,
      source: {x: sx, y: sy, width, height},
      destination: {x, y, width: dw, height: dh},
      color: 0xffffff,
      alpha: Math.max(0, Math.min(255, alpha | 0)),
      ...nativeSampler(s),
      blendState: nativeBlend(s.view(0x587344, 2).getUint16(0, true)),
    };
    out.sprites.push(d);
    out.commands!.push(d);
    return d;
  };
  const solid = (color: number, alpha: number) =>
    out.commands!.push({
      kind: 'solid',
      destination: {x: 0, y: 0, width: 1920, height: 1080},
      color,
      alpha: Math.max(0, Math.min(255, alpha | 0)),
      blendState: nativeBlend(0),
    });
  switch (phase) {
    case 0:
    case 1: {
      const ds = drawTitle(s);
      out.sprites.push(...ds);
      out.commands!.push(...ds);
      break;
    }
    case 2:
    case 3:
      push(drawTitleMenu(s));
      break;
    case 4:
    case 5:
      push(drawTitleExit(s));
      break;
    case 6:
    case 7: {
      if (phase === 7)
        for (const a of [0x5f78, 0x5f7c, 0x5f80, 0x5f84, 0x5f8c, 0x5f90]) s.setVariable(a / 4, 0);
      out.commands!.push({kind: 'target', texture: 206, width: 1920, height: 1080});
      sprite(0, 0, 1920, 1080, 0, 0);
      sprite(0, 2172, 942, 331, 747, 465);
      sprite(0, 3817, 1920, 24, 0, 986);
      if (phase === 6) {
        s.setVariable(0x5f78 / 4, 0);
        s.setVariable(0x5f7c / 4, 0);
        s.setVariable(0x5f84 / 4, 540);
        s.setVariable(0x5f80 / 4, Math.imul(frame, 960) >>> 6);
        s.setVariable(0x5f90 / 4, Math.imul(frame, 1000) >>> 6);
        s.setVariable(0x5f8c / 4, Math.min(256, (frame & 0xffffff) << 4));
        out.commands!.push(...drawSceneLens(s));
      }
      out.commands!.push({kind: 'target', texture: null, width: 1920, height: 1080});
      const t = phase === 6 ? frame : (64 - frame) >>> 0;
      sprite(
        0,
        0,
        sub(1920, mul(mul(f(t), 1280), 0.015625)),
        sub(1080, mul(mul(f(t), 720), 0.015625)),
        0,
        0,
        256,
        206,
        1920,
        1080,
      );
      if (phase === 7) solid(0xffffff, (t & 0xffffff) << 2);
      break;
    }
    case 8:
      sprite(0, 0, 1920, 1080, 0, 0);
      sprite(0, 2172, 942, 331, 747, 465);
      sprite(0, 3817, 1920, 24, 0, 986);
      solid(0, (Math.imul(frame & 0xffffff, -4) + 256) | 0);
      break;
    case 9: {
      sprite(0, 0, 1920, 1080, 0, 0);
      sprite(0, 1086, 1920, 1080, 0, 0);
      sprite(0, 3817, 1920, 24, 0, 986);
      sprite(0, 2172, 942, 331, 747, 465);
      solid(0, (Math.imul(frame & 0xffffff, -8) + 256) | 0);
      if (frame > 32) {
        const a = Math.min(16, (frame - 32) >>> 0) << 4;
        sprite(0, 3197, 732, 136, 0, 80, a);
        sprite(948, 2242, 196, 32, 586, 218, a);
        sprite(0, 2875, 206, 322, 534, 0, a);
        sprite(948, 2306, 196, 32, 586, 290, a);
      }
      if (s.flags[0xf1]! & 4 && frame > 48) {
        const t = Math.min(272, (Math.imul(frame, 272) - 0x3300) >>> 4),
          d = sprite(824, 2875, 254, 184, 516, 0);
        d.mask = {
          texture: 3,
          source: {x: 824, y: 3243, width: 254, height: 184},
          scale: 16,
          bias: Math.fround(Math.fround((255 - t) * 16) / 255),
          invert: true,
        };
      }
      appendMenuMarker(s, 2);
      break;
    }
    case 10:
    case 12:
      push(drawTitleMenu(s));
      push(drawExtras(s));
      break;
    case 11:
    case 15:
      push(drawExtras(s));
      break;
    // The native switch has no draws or state writes for 13, 14, or unknown values.
  }
  return out;
}
