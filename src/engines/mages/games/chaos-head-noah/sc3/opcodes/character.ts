import type {OpcodeExecution} from './types.js';
import {backgroundIndex} from './background.js';
import {characterRemap} from '../character-remap.js';
import {loadCompositionResource} from '../composition-resources.js';

/** 10/05, 140059450. Both expressions are evaluated anew on every phase. */
export function loadCharacter(h: OpcodeExecution): void {
  const s = h.state;
  if (s.get(0x81007c) !== 0) {
    h.yield();
    return;
  }
  h.skip(2);
  const selector = h.byte(),
    index = backgroundIndex(h.expression()),
    original = h.expression() >>> 0;
  const mapped =
    s.get(0x17abe94) !== 0 && s.get(0x17a0cdc) !== 0
      ? (characterRemap.get(original) ?? original)
      : original;
  const asset = mapped & 0xffff,
    loader = h.backgroundTextures,
    companion = h.characterAssets;
  const count = (delta: number) => s.setVariable(0x3404 / 4, s.variable(0x3404 / 4) + delta);
  switch (s.get(0x17a0cc0)) {
    case 0:
      if (s.variable(0x3394 / 4) === 0) {
        loader.textures.unload(s.variable(0xd7a + index));
        s.put(0x17a0cc0, 1);
      }
      break;
    case 1: {
      const target = s.variable(0xd7a + index),
        record = 0x13f5 + index * 40;
      s.setVariable(record + 3, mapped >> 16);
      if (!(s.flags[0xc1]! & 1)) {
        const difference = asset ^ s.variable(record);
        if (selector === 0) {
          if ((difference & 0xffff) === 0) {
            h.skip(2);
            return;
          }
        } else if ((difference & 0xffffff) === 0) return;
      }
      loader.textures.release(target);
      if (s.flags[0xe7]! & 4) return;
      s.setVariable(record, selector === 0 ? original : original | 0x10000000);
      loader.start(1, asset);
      s.put(0x17a0cc0, 2);
      s.put(0x17a0cc4, target);
      count(1);
      s.setVariable(0x3394 / 4, 1);
      break;
    }
    case 2:
      companion.start(1, asset + 1);
      s.put(0x17a0cc0, 7);
      count(1);
      break;
    case 7:
      if (s.get(0x587270) === 0) {
        const pointer = Number(s.view(0x5872c0, 8).getBigUint64(0, true)),
          size = s.get(0x587230);
        s.put(0x17a0c98, pointer, 8);
        s.put(0x17a0cbc, size);
        s.put(0x5872c0, 0, 8);
        s.put(0x587230, 0);
        s.put(0x587270, 0);
        loader.upload(s.get(0x17a0cc4), pointer, size);
        s.put(0x17a0cc0, 6);
      } else if (s.flags[0xe7]! & 4) s.put(0x17a0cc0, 4);
      break;
    case 6:
      s.put(0x17a0cc0, 3);
      count(-1);
      break;
    case 3:
      if (s.get(0x587274) === 0) {
        const size = s.get(0x587234) >>> 0,
          pointer = Number(s.view(0x5872c8, 8).getBigUint64(0, true));
        s.put(0x17a0c94, size);
        s.put(0x17a0cb0, pointer, 8);
        s.setVariable(0x3394 / 4, 0);
        s.put(0x5872c8, 0, 8);
        s.put(0x587234, 0);
        s.flags[0x98] = s.flags[0x98]! & ~0x40;
        count(-1);
        s.put(0x587274, 0);
        s.put(0x17a0cc0, 0);
        const index = s.get(0x57aad0 + ((s.get(0x17a0cc4) - 8) >>> 0) * 4);
        loadCompositionResource(s, index, companion.read(pointer, size));
        companion.release(pointer);
        return;
      }
      if (s.flags[0xe7]! & 4) s.put(0x17a0cc0, 4);
      break;
    case 4:
      count(-1);
    // Native fallthrough deliberately decrements once, regardless of outstanding jobs.
    case 5:
      s.setVariable(0x3394 / 4, 0);
      s.put(0x17a0cc0, 0);
      return;
    default:
      if (s.get(0x17a0cc0) === 0) return;
  }
  h.retry();
}
