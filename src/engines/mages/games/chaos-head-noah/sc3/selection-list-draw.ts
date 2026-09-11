import type {Sc3Runtime} from './runtime.js';
import type {DialogDrawList} from './dialog-draw.js';
import type {SpriteDraw} from '../../../../../graphics/draw-list.js';
import {drawWrappedText} from './wrapped-text-draw.js';
import {f, add} from './render-math.js';
import {nativeBlend, nativeSampler} from './render-state.js';
/** 14000b370: the scrolling checkbox list, including its independent footer hit region. */
export function drawSelectionList(vm: Sc3Runtime): DialogDrawList {
  const s = vm.state,
    out: DialogDrawList = {sprites: [], commands: [], regions: []},
    alpha = s.get(0x5358d4);
  if (s.get(0x53208c) === 0 || alpha === 0) return out;
  const sprite = (x: number, y: number, width: number, height: number, dx: number, dy: number) => {
    const d: SpriteDraw = {
      texture: 179,
      source: {x, y, width, height},
      destination: {x: dx, y: dy, width, height},
      color: 0xffffff,
      alpha: Math.max(0, Math.min(255, alpha)),
      ...nativeSampler(s),
      blendState: nativeBlend(s.get(0x587344) & 65535),
    };
    out.sprites.push(d);
    out.commands!.push(d);
  };
  const host = {
      byte: (a: number) => vm.dataByte(a),
      expression: (a: number) => vm.textExpression(a),
    },
    word = (a: number) =>
      (host.byte(a) |
        (host.byte(a + 1) << 8) |
        (host.byte(a + 2) << 16) |
        (host.byte(a + 3) << 24)) >>>
      0;
  sprite(0, 0, 1920, 1080, 0, 0);
  const top = (88 - Math.imul(s.get(0x5320ac), 57)) | 0;
  if (top > -268) sprite(0, 1086, 1500, 268, 210, f(top));
  let y = (top + 268) | 0,
    textY = (Math.imul(y, 2) + 18) | 0,
    hitY = (y + 4) | 0;
  for (let i = 0; i < s.get(0x531fac) >>> 0; i++) {
    if ((hitY + 52) >>> 0 < 1136) {
      sprite(0, 1354, 1500, 57, 210, f(y));
      if (((s.get(0x5320ac) + s.get(0x5358a4)) | 0) === i && s.get(0x5358b4) === 0)
        sprite(1506, 1086, 42, 42, 298, add(f(y), 1));
      if (s.get(0x531fc0 + i * 4) !== 0) sprite(1548, 1086, 42, 42, 298, add(f(y), 1));
      if (i < 65535)
        out.regions.push({group: 30, index: i, x: 298, y: f(hitY), width: 38, height: 38});
      const slot = s.get(0x535878),
        id = s.get(0x5320b0 + i * 4);
      let address: number;
      if (s.get(0x531fb0) !== 0) address = vm.messageAddress(slot, id);
      else {
        const base = Number(s.view(0x17adcb0 + slot * 8, 8).getBigUint64(0, true));
        address = base + word(base + (word(base + 4) | 0) + (Math.imul(id, 4) >>> 0));
      }
      const glyphs = drawWrappedText(
        s,
        host,
        address,
        236,
        f(Math.trunc(textY / 3)),
        1000,
        256,
        0x555555,
        20,
        25,
        alpha,
      ).sprites;
      out.sprites.push(...glyphs);
      out.commands!.push(...glyphs);
    }
    y = (y + 57) | 0;
    hitY = (hitY + 57) | 0;
    textY = (textY + 114) | 0;
  }
  if (y < 1080) {
    sprite(0, 1412, 1500, 232, 210, f(y));
    if (s.get(0x5358b4) !== 0) sprite(1506, 1128, 274, 80, 823, add(f(y), 115));
    out.regions.push({group: 31, index: 0, x: 823, y: f((y + 115) | 0), width: 274, height: 80});
  }
  return out;
}
