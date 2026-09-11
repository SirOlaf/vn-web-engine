import {nativeSampler, nativeBlend} from './render-state.js';
import {textLocation, type TextRun} from './dom-text-data.js';
import type {Sc3Runtime} from './runtime.js';
import type {DialogDrawList} from './dialog-draw.js';
import type {SpriteDraw} from '../../../../../graphics/draw-list.js';
import {drawMenuText} from './menu-text-draw.js';
import {measureNativeText} from './message-boxes.js';
import {copyMenuText, encodeMenuAscii, nativeDecimal} from './menu-encoded-text.js';
import {musicRoomTracks} from './opcodes/music-room.js';
import {appendMenuMarker} from './game-menu-draw.js';
import {f, add, mul} from './render-math.js';
/** 14000ea00 and 14000f6c0: music list, scrolling title and fade target. */
export function drawMusicRoom(vm: Sc3Runtime): DialogDrawList {
  const s = vm.state,
    out: DialogDrawList = {sprites: [], commands: [], regions: []},
    alpha = s.variable(0x218c / 4) << 3,
    scratch = 0x700000000;
  let encoded: Uint8Array = new Uint8Array();
  const byte = (a: number) =>
      a >= scratch && a < scratch + encoded.length
        ? encoded[a - scratch]!
        : a >= 0x5425b0 && a < 0x542d80
          ? s.bytes(a, 1)[0]!
          : vm.dataByte(a),
    host = {byte, expression: (a: number) => vm.textExpression(a, byte)},
    word = (a: number) =>
      (byte(a) | (byte(a + 1) << 8) | (byte(a + 2) << 16) | (byte(a + 3) << 24)) >>> 0;
  const field = (pointer: number, offset: number) =>
      word(Number(s.view(pointer, 8).getBigUint64(0, true)) + offset),
    message = (pointer: number, slot: number, offset: number) =>
      vm.messageAddress(s.get(slot), field(pointer, offset));
  const sprite = (
    sx: number,
    sy: number,
    width: number,
    height: number,
    x: number,
    y: number,
    a = 256,
    texture = 157,
  ) => {
    if ((width === 0) !== (height === 0)) return;
    const d: SpriteDraw = {
      ...nativeSampler(s),
      texture,
      source: {x: sx, y: sy, width, height},
      destination: {x, y, width, height},
      color: 0xffffff,
      alpha: Math.max(0, Math.min(255, a | 0)),
    };
    out.sprites.push(d);
    out.commands!.push(d);
  };
  const text = (a: number, x: number, y: number, width: number, opacity = 256, run?: TextRun) => {
    const ds = drawMenuText(
      s,
      host,
      a,
      x,
      y,
      width,
      0x5c3ab4,
      20,
      Math.max(0, Math.min(255, opacity)),
      91,
      run,
    );
    out.sprites.push(...ds);
    out.commands!.push(...ds);
  };
  // 14000f6c0 draws foreground first, then the same string offset by (1,1).
  const pairedText = (a: number, x: number, y: number, width: number) => {
    const slot = textLocation(s, 'music-text');
    text(a, x, y, width, 256, {slot});
    text(a, (x + 1) | 0, (y + 1) | 0, width, 128, {slot, shadow: true});
  };
  if (alpha !== 256) out.commands!.push({kind: 'target', texture: 206, width: 1920, height: 1080});
  sprite(442, 1206, 830, 60, 407, 129);
  const selected = s.get(0x20bb90) >>> 0;
  if (s.get(0x20a694) >>> 0 === selected) {
    let clock = (s.get(0x5451d0) + 1) >>> 0;
    if (s.get(0x5451e8) >>> 0 <= clock) clock = 0;
    s.put(0x5451d0, clock);
  } else {
    s.put(0x20a694, selected);
    let title: Uint8Array;
    if (selected < 47) {
      const number = encodeMenuAscii(nativeDecimal(selected + 1, 2).replace(/^ /, '0') + ':'),
        name = copyMenuText(host, message(0x17ac340, 0x17adc70, (selected * 8 + 40) >>> 0));
      title = new Uint8Array(number.length + name.length - 1);
      title.set(number.subarray(0, -1));
      title.set(name, number.length - 1);
    } else title = copyMenuText(host, message(0x17ac340, 0x17adc70, 36));
    s.bytes(0x5425b0, title.length).set(title);
    s.put(0x5451d0, 0);
    s.put(0x5451e8, (measureNativeText(host, 0x5425b0, 20, 0) + 286) | 0);
    s.put(0x5451c0, 286);
  }
  if (s.bytes(0x5425b0, 1)[0]) {
    let x: number,
      y = 96;
    const clock = s.get(0x5451d0) >>> 0;
    if (clock < s.get(0x5451c0) >>> 0) {
      x = 404;
      if (clock < 30) y = clock + 66;
    } else x = (681 - clock) | 0;
    pairedText(0x5425b0, x, y, 1280);
  }
  sprite(0, 0, 1920, 1080, 0, 0);
  const duration = s.get(0x543044) >>> 0;
  if (duration)
    sprite(
      1336,
      1206,
      f(Math.floor((Math.imul(s.get(0x543030), 424) >>> 0) / duration) | 0),
      12,
      604,
      181,
    );
  if (s.get(0x17acb7c))
    sprite(1336, 1224, f(Math.imul(s.get(0x17acb7c), 191) >>> 7), 12, 1245, 180);
  out.regions.push({group: 22, index: 0, x: 1221, y: 180, width: 239, height: 12});
  sprite(0, f((Math.imul(s.get(0x5425a4), 60) + 1026) | 0), 372, 60, 167, 130);
  out.regions.push({group: 22, index: 2, x: 167, y: 130, width: 372, height: 60});
  const scroll = s.get(0x545220) >>> 0,
    dy = f((Math.floor((Math.imul(scroll, 459) >>> 0) / 35) + 240) | 0);
  sprite(416, 1146, 20, 160, 1466, dy);
  out.regions.push({group: 22, index: 1, x: 1466, y: dy, width: 20, height: 160});
  for (let i = 0; i < 12; i++) {
    const y = 242 + i * 51;
    if (i & 1) sprite(442, 1086, 1330, 52, 151, y);
    if (i === s.get(0x543040) >>> 0) sprite(442, 1146, 1330, 52, 151, y);
    if ((scroll + i) >>> 0 === s.get(0x20b5dc) >>> 0) sprite(442, 1272, 42, 48, 215, y + 2);
  }
  for (let i = 0; i < 12; i++) {
    const index = (scroll + i) >>> 0,
      y = Math.trunc((506 + i * 102) / 3);
    encoded = encodeMenuAscii(nativeDecimal(index + 1, 2).replace(/^ /, '0') + ':');
    text(scratch, 104, y, 1280);
    out.regions.push({group: 21, index: i, x: 156, y: mul(f(y), 1.5), width: 1280, height: 32});
    const track = musicRoomTracks[index];
    if (track === undefined) throw new Error(`Native music index outside mapped table: ${index}`);
    if (!s.bytes(0x17acbd0 + track, 1)[0]) {
      const a = message(0x17ac320, 0x17adc60, 60);
      pairedText(a, 194, y, 1280);
    } else {
      const a = message(0x17ac340, 0x17adc70, (index * 8 + 40) >>> 0),
        b = message(0x17ac340, 0x17adc70, (index * 8 + 44) >>> 0);
      pairedText(a, 194, y, 530);
      pairedText(b, 693, y, 270);
    }
  }
  if (alpha !== 256) {
    out.commands!.push({kind: 'target', texture: null, width: 1920, height: 1080});
    sprite(0, 0, 1920, 1080, 0, 0, alpha, 206);
  }
  appendMenuMarker(s, 10);
  return out;
}
