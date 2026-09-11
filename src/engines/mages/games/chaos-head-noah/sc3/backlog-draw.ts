import {tagGlyph, fixedTextLocation, historyLayouts} from './dom-text-data.js';
import type {NoahState} from './noah-state.js';
import type {DialogDrawList} from './dialog-draw.js';
import type {Rect} from '../../../../../graphics/surface.js';
import {drawShaderRectangle} from './shader-draw.js';
import {romWord} from './text-rom.js';
import {f, add, sub, mul, div} from './render-math.js';
import {nativeBlend, nativeSampler} from './render-state.js';
import {appendMenuMarker} from './game-menu-draw.js';
/** 140024270 uses atlas 91 and the vertical clipping strip in atlas 154. */
function clippedGlyph(s: NoahState, source: Rect, destination: Rect, color: number, alpha: number) {
  const d = drawShaderRectangle(
    s,
    40,
    [91, 154],
    [source, {x: 1947, y: add(destination.y, 0), width: 6, height: destination.height}],
    destination,
    div(Math.max(0, Math.min(255, alpha | 0)), 255),
  );
  for (let i = 0; i < d.vertices.length; i += 9)
    d.vertices.set(
      [div((color >>> 16) & 255, 255), div((color >>> 8) & 255, 255), div(color & 255, 255)],
      i + 3,
    );
  return d;
}
/** 1400443b0: two passes over the 50,000-entry glyph ring. */
export function drawBacklogText(s: NoahState, alpha: number): DialogDrawList {
  const out: DialogDrawList = {sprites: [], commands: [], regions: []},
    count = s.get(0x810074) >>> 0,
    scroll = s.get(0x5b0a5c),
    read = (a: number, i: number) => s.get(a + i * 4),
    position = (at: number, axis: number) =>
      s.view(0x79a2f0 + at * 4 + axis * 2, 2).getInt16(0, true),
    metric = (at: number, k: number) => s.bytes(0x69ead0 + at * 4 + k, 1)[0]!,
    rowY = (i: number) => (read(0x5b0a60, i) - scroll + 94) | 0,
    visible = (i: number, y: number) => ((read(0x810080, i) + y) | 0) > 46 && y < 646;
  let previousY = 0;
  const layouts = historyLayouts(s);
  const glyph = (at: number, y: number, pass: number, record: number) => {
    const id = s.view(0x6cf810 + at * 2, 2).getUint16(0, true),
      x = (position(at, 0) + 100) | 0,
      dy = (position(at, 1) + y) | 0,
      dx = mul(f(x), 1.5),
      top = mul(f(dy), 1.5),
      endX = (x + metric(at, 2)) | 0,
      endY = (dy + metric(at, 3)) | 0,
      color = romWord(0x20db90 + s.bytes(0x7266c0 + at, 1)[0]! * 8 + (pass === 0 ? 4 : 0));
    out.commands!.push(
      clippedGlyph(
        s,
        {
          x: mul(f((id % 64) * 32), 1.5),
          y: mul(f((id >>> 6) * 32), 1.5),
          width: mul(metric(at, 0), 1.5),
          height: mul(metric(at, 1), 1.5),
        },
        {x: dx, y: top, width: sub(mul(f(endX), 1.5), dx), height: sub(mul(f(endY), 1.5), top)},
        color,
        alpha,
      ),
    );
    const draw = out.commands!.at(-1)!,
      layout = layouts.get(at);
    if (layout)
      tagGlyph(
        draw,
        fixedTextLocation(s, `backlog-${record}`),
        (at - (read(0x7cb040, record) >>> 0) + 50000) % 50000,
        id,
        layout,
        {x: dx, y: top, width: sub(mul(f(endX), 1.5), dx), height: sub(mul(f(endY), 1.5), top)},
        color,
        alpha,
        pass === 0,
        {x: 0, y: 69, width: 1920, height: 900},
        {
          texture: 91,
          source: {
            x: mul(f((id % 64) * 32), 1.5),
            y: mul(f((id >>> 6) * 32), 1.5),
            width: mul(metric(at, 0), 1.5),
            height: mul(metric(at, 1), 1.5),
          },
          alphaOnly: true,
        },
      );
    return {x, y: dy, endX};
  };
  for (let i = 0; i < count; i++) {
    const y = rowY(i);
    let firstX = 65535,
      firstY = 65535,
      lastX = 65535,
      lastY = 65535,
      name = false;
    s.put(0x80d040 + i * 4, 65535);
    s.put(0x80bd10 + i * 4, 0);
    if (visible(i, y)) {
      const record = read(0x80fa30, i) >>> 0;
      let at = read(0x7cb040, record) >>> 0;
      for (
        let j = 0, n = read(0x66d8e0, record) >>> 0;
        j < n;
        j++, at = at === 49999 ? 0 : at + 1
      ) {
        const id = s.view(0x6cf810 + at * 2, 2).getUint16(0, true);
        if (id & 0x8000) {
          if ((id & 0x7fff) === 1) name = true;
          if ((id & 0x7fff) === 2) name = false;
          continue;
        }
        const g = glyph(at, y, 0, record);
        lastX = g.endX;
        lastY = g.y;
        previousY = g.y;
        if (name) {
          if (s.get(0x80d040 + i * 4) === 65535) {
            s.put(0x80d040 + i * 4, g.x);
            s.put(0x80bd10 + i * 4, g.y);
          }
        } else if (firstX === 65535) {
          firstX = g.x;
          firstY = g.y;
        }
      }
    }
    for (const [a, v] of [
      [0x66ad10, firstX],
      [0x80ec10, firstY],
      [0x799460, lastX],
      [0x6610d0, lastY],
    ])
      s.put(a! + i * 4, v!);
  }
  for (let i = 0; i < count; i++) {
    const y = rowY(i);
    if (!visible(i, y)) continue;
    const record = read(0x80fa30, i) >>> 0,
      start = read(0x7cb040, record) >>> 0,
      n = read(0x66d8e0, record) >>> 0;
    let at = start,
      height = 0;
    for (let j = 0; j < n; j++, at = at === 49999 ? 0 : at + 1) {
      if (s.view(0x6cf810 + at * 2, 2).getInt16(0, true) < 0) continue;
      const dy = (position(at, 1) + y) | 0;
      if (j !== 0 && dy !== previousY)
        height = (metric(at, 3) - position(start, 1) + position(at, 1)) | 0;
      glyph(at, y, 1, record);
      previousY = dy;
    }
    const firstY = (position(start, 1) + y) | 0;
    if (firstY > 78 && add(f(firstY), height === 0 ? mul(metric(start, 3), 1.5) : f(height)) < 646)
      out.regions.push({
        group: 20,
        index: i,
        x: mul(f((position(start, 0) + 100) | 0), 1.5),
        y: mul(f(firstY), 1.5),
        width: 1500,
        height: mul(height === 0 ? metric(start, 3) : f(height), 1.5),
      });
  }
  return out;
}
/** 14003db10: selected rows, scroll thumb, clipped text and voice markers. */
export function drawBacklog(s: NoahState): DialogDrawList {
  const out: DialogDrawList = {sprites: [], commands: [], regions: []},
    alpha = (s.variable(0x218c / 4) & 0xffffff) << 3,
    count = s.get(0x810074) >>> 0,
    scroll = s.get(0x5b0a5c),
    rowY = (i: number) => (s.get(0x5b0a60 + i * 4) - scroll + 94) | 0,
    visible = (i: number, y: number) => ((s.get(0x810080 + i * 4) + y) | 0) > 46 && y < 646;
  const sprite = (sx: number, sy: number, width: number, height: number, x: number, y: number) => {
    const d = {
      texture: 153,
      source: {x: sx, y: sy, width, height},
      destination: {x, y, width, height},
      color: 0xffffff,
      alpha: Math.max(0, Math.min(255, alpha | 0)),
      ...nativeSampler(s),
      blendState: nativeBlend(s.view(0x587344, 2).getUint16(0, true)),
    };
    out.sprites.push(d);
    out.commands!.push(d);
  };
  sprite(0, 0, 1920, 1080, 0, 0);
  for (let i = 0; i < count; i++) {
    const y = rowY(i);
    if (visible(i, y) && s.get(0x810078) === i) {
      const named = s.get(0x80f3f0 + i * 4) !== 0;
      let dy = add(mul(f(y), 1.5), 14);
      if (named) dy = add(dy, -16);
      sprite(0, 1086, 1910, named ? 66 : 48, 0, dy);
    }
  }
  const height = s.get(0x80f348),
    thumb = height > 506 ? Math.trunc(Math.imul(scroll, 682) / ((height - 506) | 0)) | 0 : 0;
  sprite(0, 1148, 28, 128, 1672, add(f(thumb), 155));
  out.regions.push({group: 21, index: 0, x: 1672, y: f((thumb + 155) | 0), width: 28, height: 128});
  const text = drawBacklogText(s, alpha);
  out.commands!.push(...text.commands!);
  out.regions.push(...text.regions);
  for (let i = 0; i < count; i++) {
    const y = rowY(i),
      record = s.get(0x80fa30 + i * 4);
    if (!visible(i, y) || s.get(0x8106c0 + Math.imul(record, 8)) === -1) continue;
    const dy = add(add(mul(f(y), 1.5), 7), 15),
      sy = s.get(0x5b0a58) === 1 && s.get(0x80f34c) === i ? 1184 : 1148;
    out.commands!.push(
      drawShaderRectangle(
        s,
        41,
        [153, 154],
        [
          {x: 28, y: sy, width: 42, height: 36},
          {x: 93, y: dy, width: 42, height: 36},
        ],
        {x: 93, y: dy, width: 42, height: 36},
        div(Math.max(0, Math.min(255, alpha | 0)), 255),
      ),
    );
  }
  appendMenuMarker(s, 3);
  return out;
}
