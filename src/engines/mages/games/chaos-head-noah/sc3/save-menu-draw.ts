import {tagGlyph, textLocation} from './dom-text-data.js';
import type {Sc3Runtime} from './runtime.js';
import type {DialogDrawList} from './dialog-draw.js';
import type {SpriteDraw} from '../../../../../graphics/draw-list.js';
import {nativeSine, f, add, sub, mul, div, trunc} from './render-math.js';
import {nativeBlend, nativeSampler} from './render-state.js';
import {drawMenuText} from './menu-text-draw.js';
import {drawWrappedText} from './wrapped-text-draw.js';
import {nativeDecimal, encodeMenuAscii} from './menu-encoded-text.js';
import {appendMenuMarker} from './game-menu-draw.js';
/** 14003ba50: column-major save cards, quick-save indirection and per-language text. */
export function drawSavePage(
  vm: Sc3Runtime,
  texture: number,
  page: number,
  progress: number,
  opacity: number,
): DialogDrawList {
  const s = vm.state,
    out: DialogDrawList = {sprites: [], commands: [], regions: []},
    product = Math.imul(progress, opacity) >>> 0,
    alpha = product >>> 4,
    offset = Math.trunc(
      Math.imul(nativeSine((((progress & 0x3ffff) << 10) + 0x4000) | 0), 50) / 65536,
    ),
    bank = s.get(0x5afa84),
    scratch = 0x700000000;
  let encoded: Uint8Array = new Uint8Array();
  const byte = (a: number) =>
      a >= scratch && a < scratch + encoded.length ? encoded[a - scratch]! : vm.dataByte(a),
    host = {byte, expression: (a: number) => vm.textExpression(a, byte)},
    word = (a: number) =>
      (byte(a) | (byte(a + 1) << 8) | (byte(a + 2) << 16) | (byte(a + 3) << 24)) >>> 0;
  const message = (header: number, slot: number, offset: number) =>
    vm.messageAddress(s.get(slot), word(Number(s.view(header, 8).getBigUint64(0, true)) + offset));
  const push = (ds: SpriteDraw[]) => {
    out.sprites.push(...ds);
    out.commands!.push(...ds);
  };
  const emit = (
    sx: number,
    sy: number,
    width: number,
    height: number,
    x: number,
    y: number,
    a = alpha,
    id = texture,
    dw = width,
    dh = height,
  ) =>
    push([
      {
        texture: id,
        source: {x: sx, y: sy, width, height},
        destination: {x, y, width: dw, height: dh},
        color: 0xffffff,
        alpha: Math.max(0, Math.min(255, a | 0)),
        ...nativeSampler(s),
        blendState: nativeBlend(s.view(0x587344, 2).getUint16(0, true)),
      },
    ]);
  s.put(0x5afaac, (s.get(0x5afaac) + 1) & 31);
  const clock = s.get(0x5afaac),
    pulse = (Math.imul(clock < 16 ? clock : 32 - clock, alpha) & 0xfffffff) >>> 4;
  const slot = (i: number) =>
    bank === 2
      ? s.get(0x179cc20 + Math.imul((Math.imul(page, 8) + i) | 0, 4))
      : (Math.imul(page, 8) + i) | 0;
  if (bank < 0 || bank > 2)
    throw new Error(`Native save renderer would dereference an invalid bank: ${bank}`);
  const record = (i: number) =>
    bank === 0
      ? 0xc491e0
      : bank === 1
        ? 0xc4dc10 + slot(i) * 0x1474c
        : bank === 2
          ? 0x873290 + slot(i) * 0x1474c
          : 0;
  for (let i = 0; i < 8; i++) {
    const x = f(offset + 198 + Math.floor(i / 4) * 796),
      y = f(96 + (i % 4) * 194),
      at = record(i),
      kind = s.view(at, 2).getInt16(0, true),
      number = (Math.imul(page, 8) + i + 1) | 0,
      tens = Math.trunc(number / 10);
    emit(1030, 1080, 792, 192, x, y);
    out.regions.push({group: 20, index: i, x, y, width: 792, height: 192});
    const numberLocation = textLocation(s, 'save-number');
    for (const [j, digit] of [0, tens, (number - Math.imul(tens, 10)) | 0].entries()) {
      emit(f(Math.imul(digit, 18)), 1276, 18, 24, add(add(x, 705), j * 18), add(y, 139));
      const d = out.sprites.at(-1)!;
      tagGlyph(
        d,
        numberLocation,
        j,
        digit >= 0 && digit < 10 ? digit + 1 : -1,
        {role: 'body', line: 0},
        d.destination,
        d.color,
        d.alpha,
      );
    }
    emit(
      786,
      1226,
      100,
      74,
      add(x, 656),
      add(y, 0),
      s.bytes(at + 0x1c, 1)[0]! & 1 ? alpha : product >>> 5,
    );
    out.regions.push({
      group: 21,
      index: i,
      x: f(offset + 198 + Math.floor(i / 4) * 796 + 656),
      y,
      width: 100,
      height: 74,
    });
    if (s.flags[0xe6]! & 64 && kind === 1)
      emit(
        0,
        0,
        240,
        135,
        add(x, 26),
        add(y, 24),
        alpha,
        209 + slot(i) + (bank === 2 ? 48 : 0),
        238,
        134,
      );
    else emit(786, 1086, 238, 134, add(x, 26), add(y, 24));
    if (s.get(0x5b0970) === i && pulse) emit(0, 1086, 782, 184, x, y, pulse);
  }
  if (bank === 0) throw new Error('Native save text renderer would dereference a null bank');
  for (let i = 0; i < 8; i++) {
    const at = record(i),
      kind = s.view(at, 2).getInt16(0, true),
      x = f(offset + 198 + Math.floor(i / 4) * 796),
      y = f(96 + (i % 4) * 194),
      tx = div(add(add(add(x, 276), x), 276), 3);
    const baseline = (dy: number) => div(add(add(add(y, dy), y), dy), 3);
    const text = (address: number, ty: number) => {
      const location = textLocation(s, 'save-label');
      for (const [delta, color] of [
        [1, 0x808080],
        [-1, 0x808080],
        [0, 0],
      ])
        push(
          drawMenuText(
            s,
            host,
            address,
            trunc(add(tx, delta!)),
            trunc(add(ty, delta!)),
            356,
            color!,
            21,
            Math.max(0, Math.min(255, alpha)),
            93,
            {slot: location, shadow: delta !== 0},
          ),
        );
    };
    if (kind === 1) {
      const chapter = s.get(at + 0x14) >>> 0,
        ch = chapter > 17 ? 0 : chapter;
      text(message(0x17ac330, 0x17adc68, ch * 8), baseline(21));
      const description = message(0x17ac330, 0x17adc68, ch * 8 + 4);
      if (s.get(0x1badfbc) === 1) {
        const ty = div(add(add(y, 63), add(y, 63)), 3),
          location = textLocation(s, 'save-summary');
        for (const [delta, color] of [
          [1, 0x808080],
          [-1, 0x808080],
          [0, 0],
        ])
          push(
            drawWrappedText(
              s,
              host,
              description,
              add(tx, delta!),
              add(ty, delta!),
              356,
              0,
              color!,
              18,
              f(21.33333396911621),
              alpha,
              {slot: location, shadow: delta !== 0},
            ).sprites,
          );
      } else text(description, baseline(63));
      const v = s.view(at, 0x20);
      let date =
        nativeDecimal(v.getInt16(8, true), 4) +
        '/' +
        nativeDecimal(v.getUint8(11), 2) +
        '/' +
        nativeDecimal(v.getInt8(10), 2) +
        ' ' +
        nativeDecimal(v.getInt8(14), 2) +
        ':' +
        nativeDecimal(v.getUint8(13), 2) +
        ':' +
        nativeDecimal(v.getInt8(12), 2);
      if (date[14] === ' ') date = date.slice(0, 14) + '0' + date.slice(15);
      if (date[17] === ' ') date = date.slice(0, 17) + '0' + date.slice(18);
      encoded = encodeMenuAscii(date);
      text(scratch, baseline(129));
    }
    if (kind === 0 || kind === 2)
      text(message(0x17ac320, 0x17adc60, kind === 0 ? 4 : 0), div(add(add(y, 63), add(y, 63)), 3));
  }
  return out;
}
/** 14003cb60 invokes both page passes during a transition, advancing pulse twice. */
export function drawSaveMenu(vm: Sc3Runtime, fallbackTexture: number): DialogDrawList {
  const s = vm.state,
    type = s.get(0x5afab0),
    texture = type === 0 ? 159 : type === 1 ? 158 : type === 2 ? 160 : fallbackTexture,
    alpha = (s.variable(0x218c / 4) & 0xffffff) << 3,
    d: SpriteDraw = {
      texture,
      source: {x: 0, y: 0, width: 1920, height: 1080},
      destination: {x: 0, y: 0, width: 1920, height: 1080},
      color: 0xffffff,
      alpha: Math.max(0, Math.min(255, alpha | 0)),
      ...nativeSampler(s),
      blendState: nativeBlend(s.view(0x587344, 2).getUint16(0, true)),
    },
    out: DialogDrawList = {sprites: [d], commands: [d], regions: []};
  const addPage = (page: number, progress: number) => {
    const p = drawSavePage(vm, texture, page, progress, alpha);
    out.sprites.push(...p.sprites);
    out.commands!.push(...p.commands!);
    out.regions.push(...p.regions);
  };
  addPage(s.get(0x5b0a44), (16 - s.get(0x5afacc)) | 0);
  if (s.get(0x5afacc) !== 0) addPage(s.get(0x5afad4), s.get(0x5afacc));
  appendMenuMarker(s, 6);
  return out;
}
