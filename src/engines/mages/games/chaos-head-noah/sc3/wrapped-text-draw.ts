import {tagGlyph, textLocation, type TextRun} from './dom-text-data.js';
import type {NoahState} from './noah-state.js';
import type {TextHost} from './tips-text.js';
import type {SpriteDraw} from '../../../../../graphics/draw-list.js';
import {romByte, romWord} from './text-rom.js';
import {f, add, sub, mul} from './render-math.js';
import {nativeBlend} from './render-state.js';
type Host = Pick<TextHost, 'byte' | 'expression'>;
/** 1400460d0 uses integer advances; its extended glyph width differs from 140045c30. */
export function wrappedLineCount(host: Host, address: number, width: number, size: number): number {
  let lines = 1,
    advance = 0,
    wrapped = false;
  for (;;) {
    const b = host.byte(address);
    if (b === 255) return advance === 0 && wrapped ? lines - 1 : lines;
    if (b >= 128) {
      const id = (b & 127) * 256 + host.byte(address + 1),
        w =
          id < 351 ? Math.imul(romByte(0x1da120 + id), size) >>> 5 : id < 0x2800 ? size >>> 0 : 17;
      advance = (advance + w) >>> 0;
      if (width >>> 0 < advance) {
        if (w > width >>> 0)
          throw new Error('Native text measurement cannot advance: glyph exceeds line width');
        lines = (lines + 1) | 0;
        advance = 0;
        wrapped = true;
      } else address += 2;
    } else if (b === 0 || b === 31) {
      address++;
      lines = (lines + 1) | 0;
      advance = 0;
      wrapped = false;
    } else if (b === 4) address = host.expression(address + 1).next;
    else if (b === 9 || b === 30 || b === 11) address++;
    else throw new Error(`Native wrapped measurement cannot advance on control ${b}`);
  }
}
/** 140045c30 / 140024110: float advances, inserted line markers and inset alternate-font atlas. */
export function drawWrappedText(
  s: NoahState,
  host: Host,
  address: number,
  x: number,
  y: number,
  width: number,
  limit: number,
  color: number,
  size: number,
  lineHeight: number,
  alpha: number,
  run?: TextRun,
): {sprites: SpriteDraw[]; endX: number} {
  const location = run?.slot ?? textLocation(s, 'wrapped');
  const entries: ({id: number; raw: number; advance: number; color: number} | null)[] = [],
    max = limit >>> 0 || 255;
  let advance = 0,
    current = color;
  width = f(width || 1280);
  x = f(x);
  y = f(y);
  size = f(size);
  lineHeight = f(lineHeight);
  while (host.byte(address) !== 255 && entries.length <= max) {
    const b = host.byte(address);
    if (b >= 128) {
      const id = (b & 127) * 256 + host.byte(address + 1),
        raw = id < 351 ? romByte(0x1da120 + id) : id < 0x2800 ? 32 : 17,
        w =
          id < 351 ? mul(mul(raw, size), 1 / 32) : id < 0x2800 ? size : mul(mul(size, 17), 1 / 32);
      if (width < add(w, advance)) {
        entries.push(null);
        advance = 0;
      }
      entries.push({id, raw, advance: w, color: current});
      advance = add(advance, w);
      address += 2;
    } else if (b === 0 || b === 31) {
      entries.push(null);
      advance = 0;
      address++;
    } else if (b === 4) {
      const e = host.expression(address + 1);
      address = e.next;
      let i = e.value;
      if (i === 255) i = s.variable(0x21d8 / 4);
      if (i === 254) i = s.variable(0x21dc / 4);
      if (i === 253) i = s.variable(0x21e0 / 4);
      current = romWord(0x20db90 + Math.imul(i, 8) + (color === 0 ? 4 : 0));
    } else throw new Error(`Native wrapped drawing cannot advance on control ${b}`);
  }
  const sprites: SpriteDraw[] = [];
  let pen = x,
    line = run?.line ?? 0,
    index = run?.index ?? 0;
  for (const g of entries) {
    if (g === null) {
      y = add(y, lineHeight);
      pen = x;
      line++;
      continue;
    }
    const right = add(pen, g.advance),
      dx = mul(pen, 1.5),
      dy = mul(y, 1.5);
    sprites.push({
      texture: 93,
      source: {
        x: mul(add(mul(g.id % 64, 32), 1), 1.5),
        y: mul(add(mul(g.id >>> 6, 32), 1), 1.5),
        width: mul(sub(g.raw, 2), 1.5),
        height: 45,
      },
      destination: {
        x: dx,
        y: dy,
        width: sub(mul(right, 1.5), dx),
        height: sub(mul(add(y, size), 1.5), dy),
      },
      color: g.color & 0xffffff,
      alpha: Math.max(0, Math.min(255, alpha | 0)),
      blendState: nativeBlend(0),
    });
    const draw = sprites.at(-1)!;
    tagGlyph(
      draw,
      location,
      index++,
      g.id,
      {role: 'body', line},
      draw.destination,
      g.color,
      draw.alpha,
      run?.shadow,
    );
    pen = right;
  }
  return {sprites, endX: pen};
}
