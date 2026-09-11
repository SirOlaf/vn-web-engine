import type {OpcodeExecution} from './types.js';
import {
  packSystem,
  unpackSystem,
  stampSaveSlot,
  checksumSaveSlot,
  encodeThumbnail,
  decodeThumbnail,
  validateSaveSlot,
  saveSlotAddress,
  SLOT_BANK_SIZE,
} from '../save-codec.js';
/** Entire 140054610 selector switch, with blocking CONFIG writes retaining the VM pass. */
export function saveCommand(h: OpcodeExecution): void | Promise<void> {
  const original = h.context.getBigUint64(0x158, true),
    rewind = () => h.context.setBigUint64(0x158, original, true);
  h.skip(2);
  const selector = h.byte(),
    s = h.state,
    storage = h.storage,
    result = (value: number) => s.setVariable(0x3414 / 4, value),
    clear = () => {
      s.flags[0x99] = s.flags[0x99]! & ~4;
    };
  const poll = (kind: 'write' | 'read' | 'check') => {
    if (s.variable(0x3414 / 4) !== 1) return;
    const value = storage.poll(kind);
    result(value);
    if (value === 1) h.retry();
    else clear();
  };
  switch (selector) {
    case 0:
      packSystem(s);
      return;
    case 1:
    case 7:
      if (s.get(0x872f54) === 3) rewind();
      else result(0);
      return;
    case 3:
    case 10:
      if (s.get(0x872f54) === 4) rewind();
      else result(s.get(0x872f54) === 5 ? (s.get(0x872f50) === 1 ? 3 : 1) : 0);
      return;
    case 4:
      result(unpackSystem(s) ? 0 : 2);
      return;
    case 11:
    case 12: {
      const bank = selector === 11 ? 1 : 2;
      for (let i = 0; i < 48; i++) {
        const status = validateSaveSlot(s, bank, i);
        if (status === 1 || status === 129)
          h.uploadThumbnail(209 + (bank === 2 ? 48 : 0) + i, decodeThumbnail(s, bank, i));
      }
      return;
    }
    case 16: {
      const now = h.localTime();
      for (const [address, value] of [
        [0x17adc94, now.getFullYear()],
        [0x17acb88, now.getMonth() + 1],
        [0x17adc98, now.getDate()],
        [0x17acb98, now.getHours()],
        [0x17acba4, now.getMinutes()],
        [0x17acb9c, now.getSeconds()],
        [0x17acb8c, now.getDay()],
      ])
        s.put(address!, value!);
      const bank = s.variable(0x3a30 / 4),
        index = s.variable(0x3a2c / 4);
      if (bank === 1 || bank === 2)
        s.writeSpan(saveSlotAddress(bank, index), s.readSpan(0xc491e0, 0x4a2c));
      stampSaveSlot(s, bank, index);
      checksumSaveSlot(s, bank, index, 0);
      encodeThumbnail(s, bank, index);
      h.uploadThumbnail(
        209 + (bank === 2 ? 48 : 0) + (index >>> 0),
        decodeThumbnail(s, bank, index),
      );
      return;
    }
    case 19:
      s.zero(0x873290, SLOT_BANK_SIZE);
      s.zero(0xc4dc10, SLOT_BANK_SIZE);
      for (let i = 0; i < 48; i++) s.put(0x179cc20 + i * 4, i);
      return;
    case 30:
      result(storage.begin('write'));
      return;
    case 31:
    case 61:
      poll('write');
      return;
    case 40:
      packSystem(s);
      s.flags[0xab] = s.flags[0xab]! | 4;
      return;
    case 41:
    case 47:
    case 52:
      result(0);
      return;
    case 45:
      s.flags[0xab] = s.flags[0xab]! | 8;
      return;
    case 46:
      s.flags[0xab] = s.flags[0xab]! | 16;
      return;
    case 50:
      result(1);
      return;
    case 51:
      if (s.variable(0x3414 / 4) === 1) h.retry();
      return;
    case 53:
      if (s.variable(0x3414 / 4) === 1) {
        result(0);
        clear();
      }
      return;
    case 60:
      return storage.writeConfiguration().then(() => {
        result(storage.begin('write'));
      });
    case 70:
      result(storage.begin('read'));
      return;
    case 71:
      poll('read');
      return;
    case 80:
      result(storage.begin('check'));
      return;
    case 81:
      poll('check');
      return;
  }
}
