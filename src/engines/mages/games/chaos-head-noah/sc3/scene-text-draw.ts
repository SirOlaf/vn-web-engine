import {tagGlyph, fixedTextLocation, packedLayouts} from './dom-text-data.js';
import {nativeBlend, nativeSampler} from './render-state.js';
import type {NoahState} from './noah-state.js';
import type {DrawCommand, SpriteDraw} from '../../../../../graphics/draw-list.js';
const clamp = (n: number) => Math.max(0, Math.min(255, n | 0));
/** 14003f2a0: packed scene glyphs, shadow pass followed by foreground pass. */
export function drawSceneGlyphs(
  s: NoahState,
  font: number,
  slot: number,
  alpha: number,
  x: number,
  y: number,
  shadowInset = false,
): SpriteDraw[] {
  const location = fixedTextLocation(s, `scene-${slot}`),
    layouts = packedLayouts(s, slot);
  const b = slot * 0x11984,
    n = s.get(0x5b10ac + b) >>> 0,
    out: SpriteDraw[] = [];
  const byte = (a: number, i: number) => s.bytes(a + b + i, 1)[0]!,
    word = (a: number, i: number, signed = false) =>
      signed
        ? s.view(a + b + i * 2, 2).getInt16(0, true)
        : s.view(a + b + i * 2, 2).getUint16(0, true);
  for (const shadow of [true, false])
    for (let i = 0; i < n; i++) {
      if (s.get(0x5b10e4 + b + i * 4) !== font) continue;
      const opacity = byte(0x5c20c4, i),
        color = s.get((shadow ? 0x5b5be4 : 0x5b3664) + b + i * 4);
      if (shadow && (!opacity || color === -1)) continue;
      const px = (x + word(0x5ba6e4, i, true) + (shadow ? 1 : 0)) | 0,
        py = (y + word(0x5bb9a4, i, true) + (shadow ? 1 : 0)) | 0,
        toPixel = (n: number) => Math.fround(Math.fround(n | 0) * 1.5),
        dx = toPixel(px),
        dy = toPixel(py),
        width = Math.fround(toPixel((px + word(0x5bcc64, i)) | 0) - dx),
        height = Math.fround(toPixel((py + word(0x5bdf24, i)) | 0) - dy);
      out.push({
        texture: 91 + font,
        source: {
          x: (byte(0x5b8164, i) << 5) * 1.5 + (shadow && shadowInset ? 1 : 0),
          y: (byte(0x5b8ac4, i) << 5) * 1.5 + (shadow && shadowInset ? 1 : 0),
          width: byte(0x5b9424, i) * 1.5 - (shadow && shadowInset ? 2 : 0),
          height: byte(0x5b9d84, i) * 1.5 - (shadow && shadowInset ? 2 : 0),
        },
        destination: {x: dx, y: dy, width, height},
        color: color & 0xffffff,
        alpha: clamp(Math.imul(opacity, alpha) >>> 8),
      });
      const draw = out.at(-1)!,
        id = byte(0x5b8ac4, i) * 64 + byte(0x5b8164, i),
        layout = layouts[i];
      if (layout)
        tagGlyph(draw, location, i, id, layout, draw.destination, color, draw.alpha, shadow);
    }
  return out;
}
/** 1400425f0: scene window and per-slot wait marker, including its state writes. */
export function drawSceneWindow(s: NoahState, opacity: number, slot: number): DrawCommand[] {
  const out: DrawCommand[] = [];
  if (!opacity) return out;
  const product = Math.imul(opacity, s.get(0x17adc88)) >>> 0,
    alpha = product >>> 8,
    style = s.variable(0x442c / 4 + slot * 10) >>> 0,
    font = 0x7fbd80 + style * 0x30,
    word = (o: number) => s.view(font + o, 2).getInt16(0, true);
  s.put(0x66d8dc, (s.get(0x66d8dc) + 2) & 255);
  const clear = () => {
    s.put(0x7fc910 + slot * 4, 0);
    s.zero(0x799aa0 + slot * 12, 12);
    s.put(0x7686e8 + slot * 4, 0);
    s.put(0x7fbf68 + slot * 4, 0);
  };
  if (!(s.flags[0x9b]! & 16)) {
    if (word(2) === 0 || word(2) === 1)
      out.push({
        kind: 'solid',
        destination: {
          x: 0,
          y: word(2) === 0 ? 810 : 0,
          width: 1920,
          height: word(2) === 0 ? 270 : 1080,
        },
        color: 0,
        alpha: clamp(Math.imul(alpha, 140) >>> 8),
      });
  } else clear();
  if (!(s.variable(0x4428 / 4 + slot * 10) & 128)) {
    if (word(22) === 0) {
      clear();
      return out;
    }
    if (!alpha || s.variable(0x2104 / 4) & 4) return out;
    s.put(0x7fc910 + slot * 4, 0);
    s.put(0x7686e8 + slot * 4, 0);
    if (!s.flag(0x4e3 + slot)) return out;
    let frame = (s.get(0x17acc98 + slot * 4) + 1) >>> 0;
    if (frame >= 84) frame = 0;
    s.put(0x17acc98 + slot * 4, frame);
    out.push({
      ...nativeSampler(s),
      blendState: nativeBlend(s.get(0x587344) & 65535),
      texture: 80,
      source: {
        x: ((frame >>> 2) % 7) * 42 + 200,
        y: Math.floor((frame >>> 2) / 7) * 42,
        width: 42,
        height: 42,
      },
      destination: {x: 1651, y: 988, width: 42, height: 42},
      color: 0xffffff,
      alpha: clamp(alpha),
    });
  }
  return out;
}
/** 140046e20: native three-slot painter order and position policy. */
export function drawSceneText(s: NoahState): DrawCommand[] {
  const out: DrawCommand[] = [],
    order = s.variable(0x441c / 4);
  for (let priority = 0; priority < 3; priority++)
    for (let slot = 2; slot >= 0; slot--) {
      const opacity = s.variable(0x20e4 / 4 + slot);
      if (((order >>> (slot * 4)) & 15) !== priority || !opacity) continue;
      const flags = s.variable(0x4428 / 4 + slot * 10),
        style = s.variable(0x442c / 4 + slot * 10) >>> 0,
        base = 0x7fbd80 + style * 48;
      const ox = s.view(base + 4, 2).getInt16(0, true),
        oy = s.view(base + 6, 2).getInt16(0, true),
        x = flags & 1 ? s.variable(0x4420 / 4 + slot * 10) : ox,
        y = flags & 1 ? s.variable(0x4424 / 4 + slot * 10) : oy;
      if (!(flags & 8)) out.push(...drawSceneWindow(s, opacity, slot));
      if (!(flags & 32))
        for (let font = 0; font < 2; font++)
          out.push(
            ...drawSceneGlyphs(
              s,
              font,
              slot,
              Math.imul(opacity, s.get(0x17adc88)) >>> 8,
              (s.variable(0x2b70 / 4 + slot * 2) + x - ox) | 0,
              (s.variable(0x2b74 / 4 + slot * 2) + y - oy) | 0,
            ),
          );
    }
  return out;
}
