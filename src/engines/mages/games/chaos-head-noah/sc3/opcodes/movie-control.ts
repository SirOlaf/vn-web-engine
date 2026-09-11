import type {OpcodeExecution} from './types.js';

/** 140050ca0: complete movie wait/query/stop command for both native devices. */
export function movieControl(h: OpcodeExecution): void {
  const s = h.state,
    c = h.context;
  h.skip(2);
  const selector = h.byte();
  const input = (channel: number) =>
    s.get(0x179cce0 + channel * 4) !== 0 &&
    s.bytes(0x543836, 1)[0] === 0 &&
    ((s.get(0x5a70d4) & s.get(0x872df8)) !== 0 || (s.bytes(0x17add90, 1)[0]! & 1) !== 0);
  const clearIds = (channel: number) => {
    s.setVariable((channel === 0 ? 0x62f4 : 0x6350) / 4, 65535);
    s.setVariable((channel === 0 ? 0x6300 : 0x6344) / 4, 65535);
  };
  switch (selector) {
    case 0: {
      // Native keeps the pre-clear flag in R9D throughout this invocation.
      const active = s.flags[0xe7]! & 8;
      let counter = s.bytes(0x179ccf0, 1)[0]!;
      if (counter !== 0 && active) {
        counter = (counter + 1) & 255;
        s.put(0x179ccf0, counter, 1);
        h.yield();
        if (counter < 8) {
          h.retry();
          return;
        }
        s.flags[0xe7] = s.flags[0xe7]! & ~8;
        s.flags[0xe8] = s.flags[0xe8]! | 1;
      }
      if (input(0)) {
        s.put(0x179ccf0, (counter + 1) & 255, 1);
        s.put(0x179cce0, 0);
        h.retry();
        return;
      }
      if (active) {
        h.retry();
        return;
      }
      h.movies.stop(0);
      s.flags[0x136] = s.flags[0x136]! & ~64;
      s.flags[0x9a] = s.flags[0x9a]! & ~16;
      clearIds(0);
      return;
    }
    case 1:
      c.setUint32(0x1c, (s.flags[0xe7]! >>> 3) & 1, true);
      return;
    case 2:
      s.flags[0xe7] = s.flags[0xe7]! & ~8;
      h.movies.stop(0);
      s.flags[0x136] = s.flags[0x136]! & ~64;
      s.flags[0x9a] = s.flags[0x9a]! & ~16;
      clearIds(0);
      return;
    case 3:
      if (input(0)) {
        h.yield();
        s.flags[0xe7] = s.flags[0xe7]! & ~8;
        s.flags[0xe8] = s.flags[0xe8]! | 1;
      }
      if (!(s.flags[0xe7]! & 8)) {
        h.movies.stop(0);
        s.flags[0x136] = s.flags[0x136]! & ~64;
        clearIds(0);
      }
      return;
    case 20:
    case 23:
      if (input(1)) {
        h.yield();
        s.flags[0xe7] = s.flags[0xe7]! & ~16;
        s.flags[0xe8] = s.flags[0xe8]! | 2;
      }
      if (s.flags[0xe7]! & 16) {
        if (selector === 20) h.retry();
        return;
      }
      h.movies.stop(1);
      clearIds(1);
      return;
    case 21:
      c.setUint32(0x1c, (s.flags[0xe7]! >>> 4) & 1, true);
      return;
    // Native selector 22 clears channel 1's flag/IDs but stops device 0.
    case 22:
      s.flags[0xe7] = s.flags[0xe7]! & ~16;
      h.movies.stop(0);
      s.flags[0x9a] = s.flags[0x9a]! & ~32;
      clearIds(1);
      return;
  }
}
