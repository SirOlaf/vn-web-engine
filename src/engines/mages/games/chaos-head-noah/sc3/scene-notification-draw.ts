import {tagGlyph, fixedTextLocation, textLocation, type TextRun} from './dom-text-data.js';
import type {Sc3Runtime} from './runtime.js';
import type {SpriteDraw} from '../../../../../graphics/draw-list.js';
import {f, mul, sub, add} from './render-math.js';
import {romByte} from './text-rom.js';
import {nativeBlend, nativeSampler} from './render-state.js';
/** 140045630: fixed-size notification glyphs. Native reads raw pairs, without parsing controls. */
export function drawNotificationText(
  vm: Sc3Runtime,
  address: number,
  x: number,
  y: number,
  color: number,
  alpha: number,
  run?: TextRun,
): SpriteDraw[] {
  const out: SpriteDraw[] = [],
    location = run?.slot ?? textLocation(vm.state, 'notification');
  for (let count = 0; count <= 65535 && vm.dataByte(address) !== 255; count++, address += 2) {
    const id = (vm.dataByte(address) & 127) * 256 + vm.dataByte(address + 1),
      raw = id < 351 ? romByte(0x1da350 + id) : id < 0x2800 ? 32 : 17,
      advance = id < 351 ? (raw * 5) >>> 3 : id < 0x2800 ? 20 : 10;
    const offset = id < 384 ? Math.imul((romByte(0x1d9f00 + id) << 24) >> 24, 20) >>> 5 : 0,
      next = (x + advance) | 0,
      dy = (y + offset) | 0,
      dx = mul(f(x), 1.5),
      top = mul(f(dy), 1.5);
    out.push({
      texture: 91,
      source: {
        x: mul(f((id % 64) * 32 + 1), 1.5),
        y: mul(f(Math.floor(id / 64) * 32 + 1), 1.5),
        width: mul(raw - 2, 1.5),
        height: 45,
      },
      destination: {
        x: dx,
        y: top,
        width: sub(mul(f(next), 1.5), dx),
        height: sub(mul(f((dy + 20) | 0), 1.5), top),
      },
      color,
      alpha: Math.max(0, Math.min(255, alpha | 0)),
      blendState: nativeBlend(0),
    });
    const draw = out.at(-1)!;
    tagGlyph(
      draw,
      location,
      (run?.index ?? 0) + count,
      id,
      {role: 'body', line: 0},
      draw.destination,
      color,
      draw.alpha,
      run?.shadow,
    );
    x = next;
  }
  return out;
}
/** 14002c2a0: three MES strings, independently measured and drawn in two passes. */
export function drawSceneNotification(vm: Sc3Runtime): SpriteDraw[] {
  const s = vm.state,
    out: SpriteDraw[] = [];
  if (!s.get(0x5afabc) || s.flags[0x9b]! & 16 || s.flags[0x137]! & 4) return out;
  let fade = s.get(0x5afa80) >>> 0;
  if (s.get(0x5afae4) >>> 0 < 1140) {
    if (fade < 256) fade = (fade + 16) >>> 0;
  } else if (s.get(0x5afabc) === 1 && fade) fade = (fade - 16) >>> 0;
  s.put(0x5afa80, fade);
  const pos = ((Math.imul(fade, 96) >>> 8) - 56) | 0,
    alpha = Math.imul(fade, 3) >>> 2,
    shadow = Math.floor(fade / 3);
  out.push({
    texture: 80,
    source: {x: 1459, y: 1, width: 817, height: 120},
    destination: {x: 571, y: add(f(pos), 1), width: 817, height: 120},
    color: 0xffffff,
    alpha: Math.max(0, Math.min(255, alpha | 0)),
    ...nativeSampler(s),
    blendState: nativeBlend(s.view(0x587344, 2).getUint16(0, true)),
  });
  const pointer = Number(s.view(0x17ac320, 8).getBigUint64(0, true)),
    word = (a: number) =>
      (vm.dataByte(a) |
        (vm.dataByte(a + 1) << 8) |
        (vm.dataByte(a + 2) << 16) |
        (vm.dataByte(a + 3) << 24)) >>>
      0;
  const addresses = [
    vm.messageAddress(s.get(0x17adc60), word(pointer + 0x54)),
    vm.messageAddress(
      s.get(0x5a9838),
      (s.get(0x5a7704 + (s.get(0x5afae0) >>> 0) * 28) + 100) >>> 0,
    ),
    vm.messageAddress(s.get(0x17adc60), word(pointer + 0x58)),
  ];
  const y = Math.trunc(((Math.imul(pos, 2) + 128) | 0) / 3);
  let x = 402;
  for (let i = 0; i < 3; i++) {
    const a = addresses[i]!;
    out.push(
      ...drawNotificationText(
        vm,
        a,
        (x + 1) | 0,
        (y + 1) | 0,
        i === 1 ? 0x83c2ff : 0xffffff,
        shadow,
        {slot: fixedTextLocation(s, 'notification'), index: i * 65536, shadow: true},
      ),
      ...drawNotificationText(vm, a, x, y, i === 1 ? 0x6a4ff : 0x80808, alpha, {
        slot: fixedTextLocation(s, 'notification'),
        index: i * 65536,
      }),
    );
    if (i !== 2) x = (x + vm.messageBoxes.measure(a, 20, 255)) | 0;
  }
  return out;
}
/** Global wait marker in context zero, distinct from per-window markers.
 * 14005f376 clears a qword at 732a10; 14005f37d clears only a dword at
 * 732a18. The adjacent 732a1c is the history metadata insertion cursor. */
export function drawGlobalWaitMarker(vm: Sc3Runtime): SpriteDraw[] {
  const s = vm.state;
  if (s.variable(0x2104 / 4) & 4) {
    s.put(0x7cb03c, 0);
    s.zero(0x732a10, 8);
    s.put(0x732a18, 0);
    return [];
  }
  if (!(s.flags[0x96]! & 32) || s.flags[0x9b]! & 16) return [];
  let frame = (s.get(0x7cb03c) + 1) >>> 0;
  if (frame > 83) frame = 0;
  s.put(0x7cb03c, frame);
  return [
    {
      texture: 80,
      source: {
        x: ((frame >>> 2) - Math.floor(frame / 28) * 7) * 42 + 200,
        y: Math.floor(frame / 28) * 42,
        width: 42,
        height: 42,
      },
      destination: {x: 1651, y: 988, width: 42, height: 42},
      color: 0xffffff,
      alpha: Math.max(0, Math.min(255, s.get(0x17adc88))),
      ...nativeSampler(s),
      blendState: nativeBlend(s.view(0x587344, 2).getUint16(0, true)),
    },
  ];
}
