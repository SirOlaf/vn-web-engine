import type {OpcodeExecution} from './types.js';

/** 00/19, 1400531d0: unsigned group index, then signed selector. */
export function controlContextGroup(h: OpcodeExecution): void {
  h.skip(2);
  const index = h.expression() >>> 0,
    selector = h.expression();
  // Unknown selectors still evaluate both operands, but never access the array.
  if (selector < 0 || selector > 4) return;
  const address = 0x17ab880 + index * 4,
    value = h.state.get(address);
  switch (selector) {
    case 0:
      h.state.put(address, value | 0x08000000);
      break;
    case 1:
      h.state.put(address, value | 0x40000000);
      break;
    case 2:
      h.state.put(address, value & ~0x40000000);
      break;
    case 3:
      h.state.put(address, value & ~0x20000000);
      break;
    case 4:
      h.state.put(address, value | 0x20000000);
      break;
  }
}
