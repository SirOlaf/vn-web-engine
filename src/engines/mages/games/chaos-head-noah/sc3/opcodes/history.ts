import type {OpcodeExecution} from './types.js';
import {markMessageRead} from './message-wait.js';

/** 140051110: direct history insertion, including the native raw-operand read bit. */
export function history(h: OpcodeExecution): void {
  h.skip(2);
  const mode = h.byte(),
    selector = mode & 15;
  if (selector > 3) return;
  let voice = -1,
    bank = 0;
  if (selector === 1) {
    voice = h.expression();
    bank = h.expression();
  }
  const slot = h.context.getUint32(0x74, true),
    asset = h.state.get(0x20ddf0 + slot * 4),
    pc = Number(h.context.getBigUint64(0x158, true));
  // Even MES-ID expressions mark the index formed from their first two raw bytes.
  const index = h.scriptByte(pc) | (h.scriptByte(pc + 1) << 8);
  const address =
    mode & 128 ? h.messageAddress(slot, h.expression()) : h.stringAddress(slot, h.word());
  if (selector === 2) {
    h.backlog.appendQuoted(address);
    h.state.put(0x20d394, 65535);
    markMessageRead(h, asset, index);
    return;
  }
  markMessageRead(h, asset, index);
  if (selector === 3) {
    const color = h.expression(),
      nameColor = h.expression(),
      center = h.expression();
    h.backlog.appendStyled(address, color, nameColor, center);
  } else h.backlog.append(address, voice, bank, 65535);
}
