import type {OpcodeExecution} from './types.js';
import {romWord} from '../text-rom.js';
import {checkRange} from '../../../../../../core/binary.js';
import {updateSceneInput} from '../scene-input.js';
import {captureCheckpoint} from './checkpoint.js';
/** 1400454b0: scan all 360 catalog dwords, including its trailing sentinel/data. */
export function messageRead(h: OpcodeExecution, asset: number, index: number): number {
  if (asset === 65535) return 0;
  let row = 0;
  while (row < 360 && (romWord(0x20d5a0 + row * 4) | 0) !== asset) row++;
  const bit = (Math.imul(row, 1024) + index) >>> 0;
  checkRange(h.state.readFlags.length * 8, bit, 1);
  return (h.state.readFlags[bit >>> 3]! >>> (bit & 7)) & 1;
}
function nameTag(h: OpcodeExecution): number {
  const s = h.state,
    count = s.get(0x76871c) >>> 0,
    address = Number(s.view(0x80cfe8, 8).getBigUint64(0, true));
  if (!count || !address) return 65535;
  for (let i = 0; i < count; i++) {
    let a = address,
      b = h.messageAddress(s.get(0x66d8d8), s.get(0x799da0 + i * 4));
    while (
      h.scriptByte(a) !== 2 &&
      h.scriptByte(b) !== 255 &&
      h.scriptByte(a) === h.scriptByte(b) &&
      h.scriptByte(a + 1) === h.scriptByte(b + 1)
    ) {
      a += 2;
      b += 2;
    }
    if (h.scriptByte(a) === 2 && h.scriptByte(b) === 255) return s.get(0x6e7eb0 + i * 4);
  }
  return 0;
}
/** Entire 01/0c (14004d740): preparation, voice retries and per-slot text layout. */
export function message(h: OpcodeExecution): void {
  const s = h.state,
    c = h.context,
    original = c.getBigUint64(0x158, true),
    slot = c.getUint32(0x13c, true),
    signedSlot = slot | 0,
    b = slot * 0x11984;
  const g = (a: number) => s.get(a),
    p = (a: number, v: number, w = 4) => s.put(a, v, w),
    v = (a: number) => s.variable(a / 4),
    vp = (a: number, n: number) => s.setVariable(a / 4, n);
  h.skip(2);
  const mode = h.byte(),
    voice = mode & 1 ? h.expression() : -1,
    speaker = h.expression() >>> 0,
    alternate = mode & 2 ? h.expression() >>> 0 : 32;
  let scriptSlot = c.getUint32(0x74, true),
    operand = c.getBigUint64(0x158, true),
    asset = g(0x20ddf0 + scriptSlot * 4);
  let index = h.scriptByte(Number(operand)) | (h.scriptByte(Number(operand) + 1) << 8);
  if (mode & 128) {
    const id = h.expression();
    c.setBigUint64(0x158, operand, true);
    index = h.messageIndex(scriptSlot, id);
  }
  const properties = 0x4428 + Math.imul(slot, 40);
  if (!(v(properties) & 64)) {
    p(0x17ac22c, messageRead(h, asset, index));
    p(0x17ac1fc, messageRead(h, asset, (index + 1) | 0));
    updateSceneInput(h);
  }
  vp(0x24a4 + Math.imul(slot, 8), index);
  vp(0x24a8 + Math.imul(slot, 8), asset);
  let channel = s.bytes(0x5b10b5 + c.getInt32(0x13c, true) * 0x11984, 1)[0]!,
    audio = 0x5a7110 + channel * 0x98;
  let speakerIndex: number;
  if (!(mode & 2)) {
    vp(0x20d0 + signedSlot * 4, speaker === 32 ? 0 : speaker);
    speakerIndex = speaker > 50 ? 49 : speaker;
  } else speakerIndex = Math.min(alternate, 49);
  const enabled = (i: number) => g(0x17abdc0 + (s.variable((i + 0x814) >>> 0) >>> 0) * 4),
    skip = () => g(0x17ac258 + signedSlot * 4);
  const stop = () => {
    p(audio + 4, 0, 8);
    p(audio + 12, 0);
    p(audio, -1);
    h.retry();
  };
  let ready = 0;
  if (
    (g(0x17abca0 + signedSlot * 4) >>> 0 < 50 && enabled(g(0x17abca0 + signedSlot * 4)) === 0) ||
    skip() === 1
  ) {
    p(0x17ac230 + signedSlot * 4, 0);
    p(0x17abca0 + signedSlot * 4, 50);
    if (g(audio + 0x38) !== 0) {
      stop();
      return;
    }
  }
  if (g(0x17abc04) === 1 || mode & 1 || enabled(speakerIndex) === 0) {
    s.variables.setBigUint64(0x3a90, 0n, true);
    if (skip() === 0) {
      if (voice === -1 || enabled(speakerIndex) !== 1) {
        if (g(0x17abc04) === 1 && g(audio + 0x38) !== 0) {
          stop();
          return;
        }
      } else {
        vp(0x3a90, 1);
        if (g(0x179cd30 + signedSlot * 4) !== 0) {
          p(0x179cd30 + signedSlot * 4, 0);
          p(audio, voice);
          p(audio + 4, 0, 8);
          p(audio + 12, 1);
          p(audio + 16, 1);
        }
        if (g(audio + 0x14) !== voice || g(audio + 0x24) === 0) {
          h.retry();
          return;
        }
        ready = 1;
      }
    }
    p(audio + 12, 0);
  }
  p(0x17ac2f0 + signedSlot * 4, ready);
  vp(0x20d0 + signedSlot * 4, speaker);
  const selected = mode & 2 ? Math.min(alternate, 49) : speaker > 49 ? 50 : speaker;
  p(0x17ac378 + signedSlot * 4, selected);
  if (mode & 1 && skip() === 0 && voice !== -1 && enabled(speakerIndex) === 1) {
    p(0x17abca0 + signedSlot * 4, selected);
    p(0x17ac230 + signedSlot * 4, ready);
  }
  scriptSlot = c.getUint32(0x74, true);
  const address =
      mode & 128
        ? h.messageAddress(scriptSlot, h.expression())
        : h.stringAddress(scriptSlot, h.word()),
    next = c.getBigUint64(0x158, true);
  const empty = Number(h.scriptByte(address) === 255);
  c.setBigUint64(0x158, original, true);
  p(0x176e52c, empty);
  if (!s.flag((slot + 0x771) >>> 0)) {
    p(0x5b10a0 + b, 0, 8);
    p(0x5b10b0 + b, 0);
  } else {
    if (!s.flag((slot + 0x508) >>> 0)) {
      if (!(s.flags[0xbe]! & 1)) {
        if (!(s.flags[0xe7]! & 8) && v(0x62f4) !== 65535) vp(0x62f4, 65535);
        if (!(v(properties) & 4) && v(0x4330) !== 65535 && !(s.flags[0xa0]! & 4) && !empty) {
          captureCheckpoint(h);
          s.flags[0x96] = s.flags[0x96]! | 64;
          s.flags[0xa0] = s.flags[0xa0]! | 32;
        }
      }
    } else s.setFlag((slot + 0x508) >>> 0, 0);
    s.resetText(slot);
    s.setFlag((slot + 0x771) >>> 0, 0);
    p(0x179e6d0 + signedSlot * 4, 0);
  }
  c.setBigUint64(0x158, next, true);
  const selectedNow = g(0x17ac378 + signedSlot * 4);
  p(0x20ddc0 + signedSlot * 4, 65535);
  const font = v(properties + 4);
  p(0x179cae8 + signedSlot * 4, voice);
  p(0x179cd58 + signedSlot * 4, selectedNow);
  p(0x179e680 + signedSlot * 8, address, 8);
  p(0x17ac2b0 + signedSlot * 4, 0xb400);
  if (
    voice === -1 ||
    g(0x17ac1d0 + signedSlot * 4) !== 0 ||
    g(0x17add34) !== 1 ||
    enabled(selectedNow) !== 1
  ) {
    const weight = h.sceneText.prepare(address, slot, font, 0, v(0x4384 + signedSlot * 4));
    p(0x17ac2b0 + signedSlot * 4, weight < 31 ? 0x1a400 : Math.imul(weight, 0xe00));
  } else {
    channel = s.bytes(0x5b10b5 + signedSlot * 0x11984, 1)[0]!;
    audio = 0x5a7110 + channel * 0x98;
    const table = Number(s.view(0x17ac1b0, 8).getBigUint64(0, true)),
      a = table + ((g(audio + 0x2c) << 2) >>> 0) + 6;
    const duration = (h.scriptByte(a) * 256 + h.scriptByte(a + 1)) * 10 + 9;
    h.sceneText.prepare(
      address,
      slot,
      font,
      Math.min(duration, g(audio + 0x58) >>> 0),
      v(0x4384 + signedSlot * 4),
    );
  }
  vp(0x24bc + signedSlot * 4, nameTag(h));
  p(0x5b10d8 + b, 0);
  if (!(mode & 8)) {
    if (voice !== -1 && skip() === 0) {
      channel = s.bytes(0x5b10b5 + signedSlot * 0x11984, 1)[0]!;
      if (g(0x5a70d8 + channel * 4) === 0) {
        h.resumeAudio(channel);
        p(0x5a70d8 + channel * 4, 1);
        channel = s.bytes(0x5b10b5 + signedSlot * 0x11984, 1)[0]!;
      }
      audio = 0x5a7110 + channel * 0x98;
      p(audio + 0x40, 0);
      p(audio + 0x48, 0, 8);
    }
    p(0x17ac1f8, 1);
    s.setFlag((slot + 0x4bd) >>> 0, 1);
    p(0x5b10b4 + b, 0, 1);
  } else p(0x5b10d8 + b, 1);
}
