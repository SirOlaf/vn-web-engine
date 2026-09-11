import type {OpcodeExecution} from './opcodes/types.js';
import {advancePlayTime, advanceTextWindows} from './play-time.js';
import {updateSceneInput} from './scene-input.js';
import {updateDelusion} from './effects-delusion.js';

/** 14005df40, called once before 14005ef10, including its input-consuming order. */
export function updateFrame(h: Pick<OpcodeExecution, 'state' | 'input' | 'sound'>): void {
  const s = h.state,
    g = (a: number) => s.get(a),
    p = (a: number, n: number) => s.put(a, n),
    v = (a: number) => s.variable(a / 4),
    put = (a: number, n: number) => s.setVariable(a / 4, n);
  p(0x5b04b8, 0);
  put(0x2170, g(0x17adcac));
  put(0x2418, 0);
  put(0x34b4, 100);
  p(0x872f58, 100);
  s.setFlag(0x72d, g(0x810074) === 0 ? 1 : 0);
  advancePlayTime(s);
  put(0x2104, s.flag(0x9c5) ? v(0x2104) | 2 : v(0x2104) & 0xfffd);
  if (g(0x17addd0) > 0 && g(0x53208c) === 0)
    for (let i = 0; i < 8; i++) {
      const key = g(0x8727c0 + i * 4) >>> 0;
      if (key) {
        const edge = s.bytes(0x1bae6e0 + key, 1);
        edge[0] = edge[0]! | 128;
      }
    }
  if ((v(0x2104) & 0x105) === 1 && !(s.flags[0x98]! & 32) && !(s.flags[0xa0]! & 64)) {
    const canHide = () => s.flag(0x9c6) !== 0 && g(0x17ac1f8) === 1 && (s.flags[0x9c]! & 56) !== 0;
    const stop = () => {
      p(0x17ac2ec, 0);
      p(0x17abcc8, 0);
      p(0x17abd9c, 0);
    };
    if (g(0x872dec) === 0) {
      if (g(0x5a70d4) & g(0x872dd8) || h.input.keyEdge(0x40)) {
        // Native queries twice: the first successful query consumes the edge.
        if (h.input.keyEdge(0x40)) stop();
        if (canHide()) {
          s.flags[0x9b] = s.flags[0x9b]! ^ 16;
          stop();
        }
      }
    } else if (g(0x17ac2ec) === 0 && canHide()) s.flags[0x9b] = s.flags[0x9b]! ^ 16;
  }
  updateSceneInput(h);
  const opacity = g(0x17adc88) >>> 0;
  if (s.flags[0x9b]! & 16) {
    if (opacity !== 0) p(0x17adc88, opacity - 16);
  } else if (opacity < 256) p(0x17adc88, opacity + 16);
  // Keep these writes between scene input and the text opacity ramps.
  if (v(0x6590) === 0) {
    if (v(0x6594) === 0) put(0x6598, 0);
    else put(0x6594, v(0x6594) - 1);
  } else {
    put(0x6598, v(0x6590));
    if (v(0x6594) >>> 0 < 32) put(0x6594, v(0x6594) + 1);
  }
  if (g(0x17adc90) === 1 && !(s.flags[0x98]! & 128) && g(0x17a0ccc) === 0) {
    p(0x17a0cd4, v(0x3444));
    p(0x17a0cd0, v(0x3448));
    p(0x5a70b0, v(0x3444));
    p(0x5a70b4, v(0x3448));
  } else for (const a of [0x17a0cd4, 0x17a0cd0, 0x5a70b0, 0x5a70b4, 0x17adc8c, 0x17add40]) p(a, 0);
  advanceTextWindows(s);
  updateDelusion(h);
}
