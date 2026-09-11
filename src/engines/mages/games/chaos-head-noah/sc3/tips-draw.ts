import {extraGlyph, tagGlyph, fixedTextLocation, tipsLayouts} from './dom-text-data.js';
import {nativeSampler, nativeBlend} from './render-state.js';
import type {Sc3Runtime} from './runtime.js';
import type {DialogDrawList} from './dialog-draw.js';
import type {SpriteDraw} from '../../../../../graphics/draw-list.js';
import {drawMenuText} from './menu-text-draw.js';
import {romByte, romWord} from './text-rom.js';
import {checkRange} from '../../../../../core/binary.js';

/** 14002b1a0: categories, list labels, selection, headings and description. */
export function drawTips(vm: Sc3Runtime): DialogDrawList {
  const s = vm.state,
    g = (a: number) => s.get(a) >>> 0,
    v = (a: number) => s.variable(a / 4),
    out: DialogDrawList = {sprites: [], commands: [], regions: []};
  const alpha = (v(0x218c) & 0xffffff) << 3,
    category = g(0x20bb94),
    selected = g(0x20bbb4),
    scroll = g(0x5b0974);
  const count = (c: number) => g(0x5af9d0 + c * 4),
    entry = (id: number, off: number) => g(0x5a7700 + id * 28 + off);
  const table = Number(s.view(0x5afa20, 8).getBigUint64(0, true)) - 0x140000000;
  const field = (c: number, i: number) => Math.fround(romWord(table + c * 40 + i * 4) | 0);
  const push = (d: SpriteDraw) => {
    Object.assign(d, nativeSampler(s));
    out.sprites.push(d);
    out.commands!.push(d);
  };
  const sprite = (x: number, y: number, width: number, height: number, dx: number, dy: number) =>
    push({
      texture: 155,
      source: {x, y, width, height},
      destination: {x: dx, y: dy, width, height},
      color: 0xffffff,
      alpha,
    });
  const region = (
    group: number,
    index: number,
    x: number,
    y: number,
    width: number,
    height: number,
  ) => out.regions.push({group, index, x, y, width, height});
  sprite(0, 0, 1920, 1080, 0, 0);
  region(22, 0, 88, 264, 664, 696);
  region(22, 1, 784, 232, 1008, 756);
  sprite(
    field(category, 0),
    field(category, 1),
    field(category, 2),
    field(category, 3),
    field(category, 4),
    field(category, 5),
  );
  for (let i = 0; i < g(0x5a9aa8); i++)
    region(20, i, field(i, 4), field(i, 5), field(i, 2), field(i, 3));
  const dim = (c: number) =>
    out.commands!.push({
      kind: 'solid',
      destination: {x: field(c, 6), y: field(c, 7), width: field(c, 8), height: field(c, 9)},
      color: 0,
      alpha: (v(0x218c) & 0xffffff) << 2,
    });
  if (g(0x5afa2c) === 255) dim(g(0x5b04b4));
  for (const a of [0x5b0a48, 0x5afaa8]) if (!count(g(a))) dim(g(a));
  if (g(0x5a97d8) !== 255 && !count(g(0x5a97d8))) dim(g(0x5a97d8));
  if (count(category)) {
    sprite(0, 1086, 665, 50, 86, Math.fround((g(0x5b046c) * 50 + 265) | 0));
    const y =
      count(category) < 15
        ? 256
        : (Math.floor((Math.imul(scroll, 598) >>> 0) / (count(category) - 14)) + 256) | 0;
    sprite(1247, 1086, 23, 122, 752, y);
    region(23, 0, 752, y, 23, 122);
    if (selected !== 99999 && entry(selected, 16) & 1) {
      const y =
        g(0x5a710c) <= 460
          ? 215
          : (Math.floor((Math.imul(g(0x5a9aa4), 639) >>> 0) / (g(0x5a710c) - 460)) + 215) | 0;
      sprite(1247, 1086, 23, 122, 1799, y);
      region(23, 1, 1799, y, 23, 122);
    }
  }
  // Native stack-local encoded strings. Expressions use the same evaluator and
  // state writes whether they originate in MES data or a copied header.
  const scratch = new Uint8Array(560),
    base = 0x700000000;
  const byte = (a: number) => {
    if (a >= base && a < base + scratch.length) return scratch[a - base]!;
    return vm.dataByte(a);
  };
  const expression = (a: number) => vm.textExpression(a, byte),
    host = {byte, expression};
  const word = (a: number) =>
    (byte(a) | (byte(a + 1) << 8) | (byte(a + 2) << 16) | (byte(a + 3) << 24)) >>> 0;
  const system = (offset: number) =>
    vm.messageAddress(
      g(0x17adc64),
      word(Number(s.view(0x17ac328, 8).getBigUint64(0, true)) + offset),
    );
  const text = (
    address: number,
    x: number,
    y: number,
    width: number,
    color: number,
    size: number,
  ) => {
    for (const d of drawMenuText(s, host, address, x, y, width, color, size, alpha, 93)) push(d);
  };
  const copy = (source: number, dest = 0) => {
    while (byte(source) !== 255) {
      const b = byte(source);
      let next = source + 2;
      if (b === 4) next = expression(source + 1).next;
      else if (b < 128)
        throw new Error(`Native encoded-string copy cannot advance on control ${b}`);
      checkRange(scratch.length, dest, next - source);
      while (source < next) scratch[dest++] = byte(source++);
    }
    checkRange(scratch.length, dest, 1);
    scratch[dest] = 255;
  };
  const end = () => {
    let a = base;
    while (byte(a) !== 255) {
      const b = byte(a);
      if (b >= 128) a += 2;
      else if (b === 0) a++;
      else if (b === 4) a = expression(a + 1).next;
      else throw new Error(`Native header scan cannot advance on control ${b}`);
    }
    return a - base;
  };
  const measure = (address: number, size: number, alternate: boolean) => {
    let width = 0,
      n = 0;
    while (byte(address) !== 255 && n < 256) {
      const b = byte(address);
      if (b >= 128) {
        const id = (b & 127) * 256 + byte(address + 1);
        address += 2;
        n++;
        width =
          (width +
            (id < 351
              ? Math.imul(romByte((alternate ? 0x1da120 : 0x1da350) + id), size) >>> 5
              : id < 0x2800
                ? size
                : Math.imul(17, size) >>> 5)) |
          0;
      } else if (b === 4) address = expression(address + 1).next;
      else throw new Error(`Native menu measurement cannot advance on control ${b}`);
    }
    return width;
  };
  const number = (id: number) => {
    const number = String(Math.min(entry(id, 20), 141) + 1).padStart(3, '0');
    let i = 0;
    for (const ch of number) {
      let glyph = 0;
      while (romByte(0x1da080 + glyph) && romByte(0x1da080 + glyph) !== ch.charCodeAt(0)) glyph++;
      if (!romByte(0x1da080 + glyph)) glyph = 0;
      scratch[i++] = (glyph >>> 8) | 128;
      scratch[i++] = glyph & 255;
    }
    scratch[i] = 255;
  };
  let y = 265;
  for (let row = 0; row < 14 && (scroll + row) >>> 0 < count(category); row++) {
    const id = g(0x5a9b50 + (category * 300 + ((scroll + row) >>> 0)) * 4),
      ty = Math.trunc(((y + 9) * 2) / 3);
    if (id < 10000) {
      const flags = entry(id, 16);
      if (category === g(0x5b04b4) && !(flags & 1)) continue;
      number(id);
      text(base, 76, ty, 49, 0, 20);
      text(system(0x28), 127, ty, 49, 0, 20);
      text(
        flags & 1 ? vm.messageAddress(g(0x5a9838), (entry(id, 4) + 100) >>> 0) : system(0x1c),
        143,
        ty,
        354,
        flags & 1 && !(flags & 2) ? 0x9000 : 0,
        20,
      );
      region(21, row, 215, y + 9, 532, 30);
    } else {
      copy(system(0x2c));
      if (id < 20000) {
        const a = system(0x3c) + (id - 10000) * 2;
        scratch[2] = byte(a);
        scratch[3] = byte(a + 1);
        scratch[4] = 255;
      } else copy(system((Math.imul(id, 4) - 0x13838) >>> 0), end());
      copy(system(0x2c), end());
      const width = measure(base, 30, true) >>> 0;
      text(base, Math.trunc((((446 - (width >>> 1)) | 0) * 2) / 3), ty, 354, 0, 20);
    }
    y += 50;
  }
  if (selected !== 99999 && entry(selected, 16) & 1) {
    number(selected);
    text(base, 1159, 96, 356, 0x606060, 24);
    if (g(0x5a9aac)) {
      const a = vm.messageAddress(g(0x5a9838), (entry(selected, 4) + 200) >>> 0);
      measure(a, 20, false);
      text(a, 449, 62, 673, 0x606060, 16);
    }
    const a = vm.messageAddress(g(0x5a9838), (entry(selected, 4) + 100) >>> 0);
    measure(a, 32, false);
    text(a, 449, 96, 673, 0x606060, 24);
    for (const d of drawTipsDescription(
      s,
      Math.trunc(Math.fround(Math.fround(166.66667) - Math.fround(g(0x5a9aa4)))),
      alpha,
    ))
      push(d);
  }
  const marker = g(0x5b04b8);
  s.put(0x5b09b8 + marker * 4, 7);
  s.put(0x5b04b8, marker + 1);
  s.put(0x5afad0, (g(0x5afad0) + 1) & 31);
  return out;
}

/** 140046ad0 / 140024440: shadow pass then ink, using sh040ttlv_ps. */
export function drawTipsDescription(
  s: Sc3Runtime['state'],
  offset: number,
  alpha: number,
): SpriteDraw[] {
  const out: SpriteDraw[] = [],
    location = fixedTextLocation(s, 'tips-description'),
    layouts = tipsLayouts(s);
  for (const shadow of [1, 0])
    for (let i = 0; i < s.get(0x732a98) >>> 0; i++) {
      const m = 0x661710 + i * 16,
        x = (s.get(0x7fc940 + i * 8) + 540) | 0,
        y = (s.get(0x7fc944 + i * 8) + offset) | 0,
        w = s.get(m + 8),
        h = s.get(m + 12);
      const id = s.view(0x801440 + i * 2, 2).getUint16(0, true),
        destination = {
          x: Math.fround(Math.fround((x + shadow) | 0) * 1.5),
          y: Math.fround(Math.fround((y + shadow) | 0) * 1.5),
          width: Math.fround(
            Math.fround(Math.fround((x + w + shadow) | 0) * 1.5) -
              Math.fround(Math.fround((x + shadow) | 0) * 1.5),
          ),
          height: Math.fround(
            Math.fround(Math.fround((y + h + shadow) | 0) * 1.5) -
              Math.fround(Math.fround((y + shadow) | 0) * 1.5),
          ),
        };
      if (((h + y) | 0) <= 134 || y >= 656) {
        const layout = layouts[i];
        if (!shadow && layout)
          extraGlyph(
            s,
            location,
            i,
            id,
            layout,
            destination,
            0xffffff,
            alpha,
            {x: 810, y: 201, width: 1110, height: 783},
            {
              texture: 91,
              source: {
                x: ((id % 64) * 32 + 1) * 1.5,
                y: ((id >>> 6) * 32 + 1) * 1.5,
                width: (s.get(m) - 2) * 1.5,
                height: (s.get(m + 4) - 2) * 1.5,
              },
              alphaOnly: true,
            },
          );
        continue;
      }
      out.push({
        ...nativeSampler(s),
        texture: 91,
        source: {
          x: ((id % 64) * 32 + 1) * 1.5,
          y: ((id >>> 6) * 32 + 1) * 1.5,
          width: (s.get(m) - 2) * 1.5,
          height: (s.get(m + 4) - 2) * 1.5,
        },
        destination,
        color: shadow ? 0 : 0xffffff,
        alpha,
        mask: {
          texture: 156,
          source: {...destination},
          scale: 1,
          bias: 0,
          channel: 'red',
          alphaOnly: true,
        },
      });
      const draw = out.at(-1)!,
        layout = layouts[i];
      if (layout)
        tagGlyph(draw, location, i, id, layout, destination, draw.color, alpha, !!shadow, {
          x: 810,
          y: 201,
          width: 1110,
          height: 783,
        });
    }
  return out;
}
