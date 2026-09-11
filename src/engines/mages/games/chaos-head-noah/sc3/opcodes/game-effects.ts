import type {OpcodeExecution} from './types.js';
import {cameraSelector} from '../effects-camera.js';
import {choiceSelector} from '../effects-choice.js';
import {delusionSelector} from '../effects-delusion.js';
import {effectBackgroundIds, endingScripts} from '../effects-data.js';

/** 140006810: shift two 14-entry histories, preserving native saturation/wrap. */
function remember(
  h: OpcodeExecution,
  slot: number,
  label: number,
  value: number,
  mode: number,
): void {
  const s = h.state,
    w = (a: number, n: number) => s.setVariable(a / 4, n),
    v = (a: number) => s.variable(a / 4);
  w(0x6d1c, slot);
  w(0x6d10, mode);
  for (let i = 13; i >= 1; i--) {
    w(0x6cd4 + i * 4, v(0x6cd4 + (i - 1) * 4));
    w(0x6c9c + i * 4, v(0x6c9c + (i - 1) * 4));
  }
  w(0x6d0c, Math.min((v(0x6d0c) + 1) >>> 0, 14));
  w(0x6cd4, value);
  w(0x6c9c, label);
}
/** Complete 14005bd10 selector dispatch. Registration follows native comparisons
 * of all active families, including history parsing rather than just boot's 6e. */
export function gameEffects(h: OpcodeExecution): void {
  h.skip(2);
  const selector = h.byte(),
    s = h.state;
  if (
    cameraSelector(h, selector) ||
    choiceSelector(h, selector) ||
    delusionSelector(h, selector, (id) => h.achievement(id))
  )
    return;
  const slot = () => h.context.getUint32(0x74, true),
    pc = () => h.context.getBigUint64(0x158, true),
    seek = (address: bigint) => h.context.setBigUint64(0x158, address, true);
  switch (selector) {
    case 0: {
      const value = h.expression(),
        label = h.word(),
        address = h.stringAddress(slot(), label);
      if (!(s.flags[0x160]! & 32)) h.backlog.append(address);
      remember(h, slot(), label, value, 0);
      return;
    }
    case 1: {
      const value = h.expression(),
        start = pc(),
        label = h.expression();
      seek(start);
      const sourceSlot = slot(),
        address = h.messageAddress(sourceSlot, h.expression());
      if (!(s.flags[0x160]! & 32)) h.backlog.append(address);
      remember(h, slot(), label, value, 1);
      return;
    }
    case 0x36:
    case 0x37: {
      let label: number, address: number;
      if (selector === 0x36) {
        label = h.word();
        address = h.stringAddress(slot(), label);
      } else {
        const start = pc();
        label = h.expression();
        seek(start);
        const sourceSlot = slot();
        address = h.messageAddress(sourceSlot, h.expression());
      }
      h.backlog.append(address);
      // Selector 36 writes the mode after appending the label; 37 writes it before.
      if (selector === 0x37) s.put(0x531fb0, 1);
      const index = s.get(0x531fac) >>> 0;
      s.put(0x5320b0 + index * 4, label);
      s.put(0x531fac, index + 1);
      s.put(0x535878, slot());
      if (selector === 0x36) s.put(0x531fb0, 0);
      return;
    }
    case 0x64: {
      const id = h.expression() >>> 0;
      s.flags[0xc0] = effectBackgroundIds.has(id) ? s.flags[0xc0]! | 32 : s.flags[0xc0]! & ~32;
      return;
    }
    case 0x6e:
      s.refreshEndingFlags();
      return;
    case 0x78: {
      const script = s.get(0x20ddf0 + slot() * 4),
        index = (endingScripts as readonly number[]).indexOf(script);
      if (index >= 0) s.setVariable(0x1f64 / 4, s.variable(0x1f64 / 4) | (1 << index));
      return;
    }
    default:
      return; // Every other byte targets the native switch's empty/default arm.
  }
}
