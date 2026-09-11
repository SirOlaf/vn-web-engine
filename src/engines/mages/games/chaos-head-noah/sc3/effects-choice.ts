import type {OpcodeExecution} from './opcodes/types.js';
/** Native effect-channel request 14000a8c0/10/37. Fields overlap by design. */
function request(h: OpcodeExecution, id: number): void {
  const s = h.state;
  if (s.get(0x5a726c) === id) return;
  s.put(0x5a7240, id, 8);
  s.put(0x5a7248, 0x100000001, 8);
  s.put(0x5a727c, 0);
  s.put(0x5a7288, 0);
  s.put(0x5a7290, 0, 8);
}
/** 14000a8c0: two-option input, shared by selectors 21, 2b and 8f. */
export function binaryEffectChoice(h: OpcodeExecution): boolean {
  const s = h.state;
  for (let i = 0; i < 2; i++)
    if (h.input.hit(30, i, true)) {
      s.setVariable(0x6d68 / 4, i);
      if (s.get(0x17add90) & 1) s.put(0x5a70d4, s.get(0x5a70d4) | s.get(0x872dd4));
      break;
    }
  const pressed = s.get(0x5a70d4);
  if (pressed & 0x40000) s.setVariable(0x6d68 / 4, 0);
  if (pressed & 0x80000) s.setVariable(0x6d68 / 4, 1);
  if (pressed & 0x1000 && s.variable(0x6d68 / 4) !== 255) {
    s.setVariable(0x6d38 / 4, s.variable(0x6d68 / 4));
    request(h, 0x7c);
    return false;
  }
  return true;
}
/** 14000af80: scrollable check-list and confirmation sum. */
export function checklistEffectChoice(h: OpcodeExecution): boolean {
  const s = h.state,
    g = (a: number) => s.get(a),
    p = (a: number, n: number) => s.put(a, n),
    count = () => g(0x531fac) >>> 0;
  const finish = () => {
    s.setVariable(0x1f60 / 4, 0);
    s.flags[0x1e4] = s.flags[0x1e4]! | 32;
    let sum = 0;
    for (let i = 0; i < count(); i++) sum = (sum + g(0x531fc0 + i * 4)) | 0;
    s.setVariable(0x1f60 / 4, sum);
    return false;
  };
  if (g(0x17addd0) > 0) {
    if (g(0x5358a4) === 7) {
      p(0x5358a4, 6);
      p(0x5358b4, 0);
    } else if (g(0x5320ac) !== 0) {
      p(0x5320ac, g(0x5320ac) - 1);
      p(0x5358b4, 0);
    }
  } else if (g(0x17addd0) < 0 && (g(0x531fac) - 7) >>> 0 > g(0x5320ac) >>> 0) {
    p(0x5320ac, g(0x5320ac) + 1);
    p(0x5358b4, 0);
  }
  for (let i = 0; i < count(); i++)
    if (h.input.hit(30, i, true)) {
      p(0x5358b4, 0);
      p(0x5358a4, i - g(0x5320ac));
      if (g(0x17add90) & 1) p(0x531fc0 + i * 4, g(0x531fc0 + i * 4) ^ 1);
    }
  if (h.input.hit(31, 0, true)) {
    p(0x5358a4, count() - g(0x5320ac));
    p(0x5358b4, 1);
    if (g(0x17add90) & 1) return finish();
  }
  // The native cancel mask is cached before navigation/confirmation.
  const pressed = g(0x5a70d4),
    n = count();
  if (g(0x5a6f74) & 0x10000) {
    p(0x5358b4, 0);
    if (g(0x5358a4) < 1) {
      if (g(0x5320ac) !== 0 && ((g(0x5320ac) + g(0x5358a4)) | 0) !== 0)
        p(0x5320ac, g(0x5320ac) - 1);
    } else p(0x5358a4, g(0x5358a4) - 1);
  }
  if (g(0x5a6f74) & 0x20000) {
    p(0x5358b4, 0);
    if (g(0x5358a4) < 6) p(0x5358a4, g(0x5358a4) + 1);
    else if (g(0x5320ac) >>> 0 < (g(0x531fac) - 7) >>> 0) {
      if (((g(0x5320ac) + g(0x5358a4)) | 0) === ((g(0x531fac) - 1) | 0)) {
        p(0x5320ac, n - 7);
        p(0x5358a4, 7);
        p(0x5358b4, 1);
      } else p(0x5320ac, g(0x5320ac) + 1);
    } else {
      p(0x5358a4, 7);
      p(0x5358b4, 1);
    }
  }
  if (g(0x5a70d4) & 0x1000) {
    if (g(0x5358b4) !== 0) return finish();
    const address = 0x531fc0 + ((g(0x5320ac) + g(0x5358a4)) | 0) * 4;
    p(address, g(address) ^ 1);
  }
  if (pressed & 0x2000) {
    p(0x5320ac, n - 7);
    p(0x5358b4, 1);
  }
  return true;
}
/** Complete timed choice selector families within 10/37. */
export function choiceSelector(h: OpcodeExecution, selector: number): boolean {
  const s = h.state,
    v = (a: number) => s.variable(a / 4),
    w = (a: number, n: number) => s.setVariable(a / 4, n);
  const phase = () => v(0x6d64),
    timer = () => v(0x6d60) >>> 0,
    increment = () => w(0x6d60, timer() + 1);
  if ([0x1e, 0x28, 0x8c].includes(selector)) {
    w(0x6d68, 255);
    const byte = selector === 0x1e ? 0x161 : 0x162,
      mask = selector === 0x1e ? 128 : 3;
    s.flags[byte] = s.flags[byte]! & ~mask;
    s.variables.setBigUint64(0x6d60, 0n, true);
    return true;
  }
  if ([0x1f, 0x29, 0x8d].includes(selector)) {
    const byte = selector === 0x1f ? 0x161 : 0x162;
    s.flags[byte] = s.flags[byte]! | (selector === 0x1f ? 128 : selector === 0x29 ? 1 : 2);
    increment();
    if (timer() < (selector === 0x8d ? 32 : 64)) h.retry();
    else {
      w(0x6d64, 1);
      if (selector === 0x8d) s.flags[0x162] = s.flags[0x162]! & ~4;
    }
    return true;
  }
  if ([0x20, 0x2a, 0x8e].includes(selector)) {
    if (phase() === 1) {
      w(0x6d64, 2);
      w(0x6d60, 0);
      request(h, 0x155);
    }
    increment();
    if (timer() > 31) {
      w(0x62e8, v(0x6d3c) + (selector === 0x20 ? -1 : 1));
      w(0x6308, selector === 0x20 ? 128 : selector === 0x2a ? 64 : timer() * 2 - 64);
    }
    if (timer() < 64) h.retry();
    else w(0x6d64, 3);
    return true;
  }
  if ([0x21, 0x2b, 0x8f].includes(selector)) {
    if (binaryEffectChoice(h)) h.retry();
    return true;
  }
  if ([0x22, 0x2c, 0x90].includes(selector)) {
    if (phase() === 3) {
      w(0x6d64, 4);
      w(0x6d60, 0);
    } else if (phase() !== 4) {
      if (selector !== 0x90) {
        increment();
        if (timer() < 48) h.retry();
      }
      return true;
    }
    increment();
    if (timer() >= (selector === 0x22 ? 32 : selector === 0x2c ? 80 : 96)) {
      w(0x62e8, 400);
      w(0x6308, 0);
      w(0x6d60, 0);
      w(0x6d64, 5);
    }
    h.retry();
    return true;
  }
  if (selector === 0x32) {
    s.zero(0x531fc0, 0xc4);
    for (const address of [0x5358d4, 0x53208c, 0x5320ac, 0x5358a4, 0x531fac, 0x5358b4])
      s.put(address, 0);
    return true;
  }
  if (selector === 0x33) {
    if (checklistEffectChoice(h)) h.retry();
    return true;
  }
  if (selector === 0x34) {
    s.put(0x53208c, 1);
    if (s.get(0x5358d4) >>> 0 < 256) {
      s.put(0x5358d4, s.get(0x5358d4) + 8);
      h.retry();
    }
    return true;
  }
  if (selector === 0x35) {
    if (s.get(0x5358d4) === 0) s.put(0x53208c, 0);
    else {
      s.put(0x5358d4, s.get(0x5358d4) - 8);
      h.retry();
    }
    return true;
  }
  return false;
}
