import type {OpcodeExecution} from './types.js';
/** Entire 00/43 switch, including the second channel and MES/string variants. */
export function messageBox(h: OpcodeExecution): void {
  h.skip(2);
  const selector = h.byte(),
    mode = selector & 127,
    channel = mode > 9 ? 1 : 0,
    operation = mode > 9 ? mode - 10 : mode;
  const boxes = h.messageBoxes;
  switch (operation) {
    case 0:
    case 1:
      boxes.clear(channel, operation);
      break;
    case 2:
    case 9:
      boxes.open(channel, h.expression(), operation === 9 ? 1 : 0);
      break;
    case 3:
    case 4: {
      const slot = h.context.getUint32(0x74, true);
      let address: number;
      if (selector & 128) address = h.messageAddress(slot, h.expression());
      else {
        const pc = Number(h.context.getBigUint64(0x158, true));
        address = h.stringAddress(slot, h.scriptByte(pc) | (h.scriptByte(pc + 1) << 8));
        h.skip(2);
      }
      boxes.append(channel, address, operation === 4);
      break;
    }
    case 5:
      if (!boxes.interact(channel) && !(h.state.flags[0xe1]! & 32)) h.retry();
      break;
    case 6: {
      const index = channel + 0xcfe,
        value = h.state.variable(index) >>> 0;
      if (value < 32) {
        h.state.setVariable(index, value + 1);
        h.retry();
      }
      break;
    }
    case 7: {
      const index = channel + 0xcfe,
        value = h.state.variable(index);
      if (value !== 0) {
        h.state.setVariable(index, value - 1);
        h.retry();
      }
      break;
    }
    // Native selector 8 and values outside the switch consume only the selector.
  }
}
