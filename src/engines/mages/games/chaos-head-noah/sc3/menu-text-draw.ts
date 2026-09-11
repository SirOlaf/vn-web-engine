import {tagGlyph, textLocation, type TextRun} from './dom-text-data.js';
import type {NoahState} from './noah-state.js';
import type {TextHost} from './tips-text.js';
import type {SpriteDraw} from '../../../../../graphics/draw-list.js';
import {romByte, romWord} from './text-rom.js';

/** 140045830, including expression evaluation and palette side effects on each pass. */
export function drawMenuText(
  state: NoahState,
  host: Pick<TextHost, 'byte' | 'expression'>,
  address: number,
  x: number,
  y: number,
  width: number,
  color: number,
  size: number,
  alpha: number,
  texture = 91,
  run?: TextRun,
): SpriteDraw[] {
  const location = run?.slot ?? textLocation(state, 'menu');
  const glyphs: {id: number; raw: number; width: number; offset: number; color: number}[] = [];
  let total = 0,
    current = color;
  while (glyphs.length < 256) {
    const b = host.byte(address);
    if (b === 255) break;
    if (b >= 128) {
      const id = (b & 127) * 256 + host.byte(address + 1),
        raw =
          id < 351 ? romByte((texture === 91 ? 0x1da350 : 0x1da120) + id) : id < 0x2800 ? 32 : 17,
        advance = Math.imul(raw, size) >>> 5;
      glyphs.push({
        id,
        raw,
        width: advance,
        offset:
          id < 384
            ? (((romByte((texture === 91 ? 0x1d9f00 : 0x1d8ac0) + id) << 24) >> 24) * size) >> 5
            : 0,
        color: current,
      });
      total = (total + advance) >>> 0;
      address += 2;
    } else if (b === 4) {
      const expression = host.expression(address + 1);
      address = expression.next;
      let index = expression.value;
      if (index === 255) index = state.variable(0x21d8 / 4);
      if (index === 254) index = state.variable(0x21dc / 4);
      if (index === 253) index = state.variable(0x21e0 / 4);
      current = romWord(0x20db90 + index * 8 + (color === 0 ? 4 : 0));
    } else if (b === 0) {
      total = 0;
      address++;
    } else if (b === 9 || b === 11 || b === 30) address++;
    else
      throw new Error(
        `Native dialog drawing cannot advance on control ${b} at 0x${address.toString(16)}`,
      );
  }
  const limit = width >>> 0 || 1280;
  return glyphs.map((g, i) => {
    const advance = total > limit ? Math.floor((Math.imul(limit, g.width) >>> 0) / total) : g.width,
      draw = {
        texture,
        source: {
          x: (g.id % 64) * 48,
          y: Math.floor(g.id / 64) * 48,
          width: g.raw * 1.5,
          height: 48,
        },
        destination: {
          x: x * 1.5,
          y: (y + g.offset) * 1.5,
          width: advance * 1.5,
          height: size * 1.5,
        },
        color: g.color,
        alpha,
      };
    tagGlyph(
      draw,
      location,
      (run?.index ?? 0) + i,
      g.id,
      {role: 'body', line: run?.line ?? 0},
      draw.destination,
      g.color,
      alpha,
      run?.shadow,
    );
    x = (x + advance) | 0;
    return draw;
  });
}
