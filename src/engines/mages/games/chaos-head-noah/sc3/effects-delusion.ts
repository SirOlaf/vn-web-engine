import type {OpcodeExecution} from './opcodes/types.js';
function stepRotation(h: Pick<OpcodeExecution, 'state'>): void {
  const s = h.state;
  let depth = (s.get(0x5358b0) + s.get(0x532088)) | 0;
  if (depth <= 10000) depth += Math.floor((10000 - depth) / 10000 + 1) * 10000;
  if (depth >= 30000) depth -= Math.floor(((depth - 20000) >>> 0) / 10000) * 10000;
  s.put(0x5358b0, depth);
  s.put(0x53589c, (s.get(0x53589c) + s.get(0x535834)) & 65535);
}
function channel(h: Pick<OpcodeExecution, 'state'>, id: number): void {
  const s = h.state;
  if (s.get(0x5a71d4) === id) return;
  for (const [a, n] of [
    [0x5a71a8, id],
    [0x5a71ac, 1],
    [0x5a71b0, 1],
    [0x5a71b4, 1],
    [0x5a71e4, 0],
  ])
    s.put(a!, n!);
  s.put(0x5a71f0, 0, 8);
  s.put(0x5a71f8, 0, 8);
}
function stopChannel(h: Pick<OpcodeExecution, 'state'>, second = false): void {
  const s = h.state,
    base = second ? 0x5a7240 : 0x5a71a8;
  s.put(base, -1);
  s.put(base + 12, 0);
  s.put(base + 80, 1);
  s.put(base + 84, (s.get(0x5a7178 + (s.get(0x20dde8) >>> 0) * 76) & 65535) << 11);
}
/** 140007a50: opening animation, including all intermediate phase boundaries. */
export function openDelusion(h: OpcodeExecution): void {
  const s = h.state,
    g = (a: number) => s.get(a),
    p = (a: number, n: number) => s.put(a, n),
    phase = g(0x5320a0),
    tick = () => {
      p(0x5358a0, g(0x5358a0) + 1);
      return g(0x5358a0);
    };
  stepRotation(h);
  switch (phase) {
    case 0: {
      p(0x535834, g(0x535834) - 24);
      p(0x20a690, g(0x20a690) - 736);
      s.setVariable(0x4368 / 4, 50);
      if (g(0x532178) >>> 0 < 256) p(0x532178, g(0x532178) + 16);
      const index = g(0x535874) >>> 0;
      if (s.variable(index) >>> 0 < 256) s.setVariable(index, s.variable(index) + 16);
      if (g(0x535834) === 0) {
        p(0x5320a0, 1);
        p(0x535834, -1024);
        p(0x5358a0, 0);
      }
      return;
    }
    case 1:
    case 3:
    case 5:
      if (tick() === 5) {
        p(0x535834, 0);
        p(0x5320a0, phase + 1);
        p(0x5358a0, 0);
      }
      return;
    case 2:
    case 4:
      if (tick() === 15) {
        p(0x5320a0, phase + 1);
        p(0x535834, phase === 2 ? 1024 : -1024);
        p(0x5358a0, 0);
      }
      return;
    case 6:
      if (tick() === 20) {
        p(0x5320a0, 7);
        p(0x535834, 5);
        p(0x5358a0, 0);
      }
      return;
    case 7:
      p(0x20a690, g(0x20a690) - 1536);
      if (tick() === 10) {
        p(0x5320a0, 8);
        p(0x5358a0, 0);
      }
      return;
    case 8:
      p(0x20a690, g(0x20a690) + 3072);
      p(0x535854, g(0x535854) + 16);
      if (g(0x535854) >>> 0 > 256) p(0x535854, 256);
      if (g(0x20a690) > 79999) {
        s.setVariable(0x4370 / 4, 50);
        channel(h, 0x151);
        p(0x5320a0, 0);
        p(0x535830, 1);
        p(0x5358a0, 0);
        s.flags[0x161] = (s.flags[0x161]! | 3) ^ 2;
      }
      return;
  }
}
/** 140008cb0: closing animation. Achievement hooks are supplied by the engine host. */
export function closeDelusion(h: OpcodeExecution, achievement: (id: number) => void): void {
  const s = h.state,
    g = (a: number) => s.get(a),
    p = (a: number, n: number) => s.put(a, n),
    phase = g(0x5358d8),
    tick = () => {
      p(0x5358a0, g(0x5358a0) + 1);
      return g(0x5358a0) >>> 0;
    };
  stepRotation(h);
  if (phase >= 0 && phase <= 7) {
    if (phase === 0 || phase === 4) {
      stopChannel(h);
      stopChannel(h, true);
      p(0x20a690, g(0x20a690) - 1760);
    } else if (phase === 2 || phase === 6) p(0x20a690, g(0x20a690) + 1760);
    if (tick() === 5) {
      p(0x5358a0, 0);
      p(0x5358d8, phase + 1);
    }
    return;
  }
  if (phase === 8) {
    p(0x20a690, g(0x20a690) - 3072);
    if (tick() === 14) {
      p(0x5358d8, 9);
      p(0x5358a0, 0);
    }
    return;
  }
  if (phase === 9) {
    if (tick() === 30) {
      const mode = s.variable(0x6c48 / 4);
      p(0x5358d8, mode === 1 ? 11 : mode === 2 ? 12 : 10);
      p(0x5358a0, 0);
    }
    return;
  }
  if (phase < 10 || phase > 12) return;
  if (phase !== 10) p(0x535834, g(0x535834) + (phase === 11 ? 24 : -24));
  p(0x20a690, g(0x20a690) + (phase === 10 ? 3072 : 1536));
  const elapsed = tick();
  if (elapsed > (phase === 10 ? 17 : 67)) {
    const index = g(0x535874) >>> 0;
    if (s.variable(index) !== 0) s.setVariable(index, s.variable(index) - 8);
    for (const a of [0x535854, 0x532178]) if (g(a) !== 0) p(a, g(a) - 8);
  }
  if (elapsed !== (phase === 10 ? 50 : 100)) return;
  p(0x5358d8, 0);
  p(0x5358a0, 0);
  p(0x531fa4, 0);
  s.flags[0x161] = s.flags[0x161]! & ~2;
  s.setVariable(0x4368 / 4, 100);
  s.setVariable(0x4370 / 4, 100);
  const mode = s.variable(0x6c48 / 4),
    index = (mode + Math.imul(s.variable(0x7544 / 4), 2)) | 0;
  if (mode !== 0 && index !== 65536) {
    const offset = (index + 99) >>> 0;
    if (offset >= s.auxiliary.length)
      throw new Error('Delusion counter outside native auxiliary bank');
    if (s.auxiliary[offset] !== 255) s.auxiliary[offset] = s.auxiliary[offset]! + 1;
  }
  // 140009000 counts the two alternating columns, 45 entries each, equality to 44.
  for (let side = 0; side < 2; side++) {
    let count = 0;
    for (let i = 0; i < 45; i++) if (s.auxiliary[100 + i * 2 + side]) count++;
    if (count === 44) achievement(29 + side);
  }
}
/** 140007d50: interactive rotation and its entry/exit acceleration. */
export function updateDelusion(h: Pick<OpcodeExecution, 'state' | 'input' | 'sound'>): void {
  const s = h.state,
    g = (a: number) => s.get(a),
    p = (a: number, n: number) => s.put(a, n);
  if (!g(0x535830) || !g(0x531fa4)) return;
  stepRotation(h);
  let busy = false;
  if (g(0x5358c4) !== 0) {
    p(0x5358c4, g(0x5358c4) - 1);
    busy = true;
    const n = [0, -16, 0, 18, 0, -20][g(0x5358c4)];
    if (n !== undefined) p(0x53587c, n);
  }
  if (((g(0x5320a4) - 1) & 0xfffffffd) === 0) {
    if (g(0x531fb4) >>> 0 < 272) p(0x531fb4, g(0x531fb4) + 4);
    else {
      s.setVariable(0x4370 / 4, 100);
      channel(h, g(0x5320a4) === 1 ? 0x152 : 0x153);
    }
  } else if (g(0x531fb4) !== 0) p(0x531fb4, g(0x531fb4) - 4);
  p(0x5358c8, 0);
  p(0x5358cc, 0);
  if (g(0x531fb4) === 0 || g(0x531fb4) === 272) {
    if (!(s.flags[0x9b]! & 16)) {
      for (let i = 0; i < 2; i++)
        if (h.input.hit(30, i, true)) {
          p(0x5358c8 + i * 4, 1);
          if (g(0x17add90) & 1) p(0x5a70d4, g(0x5a70d4) | g(0x872e50 + i * 4));
        }
      const right = !!(g(0x5a70d4) & g(0x872e54)),
        left = !!(g(0x5a70d4) & g(0x872e50)),
        mode = g(0x5320a4);
      const sound = (id: number) => {
        const volume =
          Math.trunc(Math.fround(Math.fround(Math.fround(g(0x17ac2e8) >>> 0) * 70) / 100)) >>> 0;
        p(0x5a7100, volume);
        h.sound(id, volume);
      };
      if (right || left) {
        if (mode === 0) {
          sound(13);
          channel(h, 0x154);
          p(0x5358c4, 6);
          p(0x5320a4, right ? 3 : 1);
          p(0x5358d0, right ? 2 : 1);
        } else if (mode === (right ? 1 : 3)) {
          p(0x5320a4, 0);
          s.setVariable(0x4370 / 4, 50);
          sound(14);
          stopChannel(h);
        }
      }
    }
  } else busy = true;
  const mode = g(0x5320a4),
    rotation = g(0x535834),
    speed = g(0x532088);
  if (mode === 0 || mode === 2) {
    s.setVariable(0x6c48 / 4, 0);
    if (rotation < -5) {
      p(0x535834, rotation + 2);
      busy = true;
    } else if (rotation > 5) {
      p(0x535834, rotation - 2);
      busy = true;
    }
    if (speed < -400) {
      p(0x532088, speed + 100);
      busy = true;
    } else if (speed > 400) {
      p(0x532088, speed - 100);
      busy = true;
    }
  } else if (mode === 1) {
    s.setVariable(0x6c48 / 4, 1);
    if (rotation < 40) {
      p(0x535834, rotation + 2);
      busy = true;
    }
    if (speed < 2400) {
      p(0x532088, speed + 100);
      busy = true;
    }
  } else if (mode === 3) {
    s.setVariable(0x6c48 / 4, 2);
    if (rotation > -40) {
      p(0x535834, rotation - 2);
      busy = true;
    }
    if (speed > -2400) {
      p(0x532088, speed - 100);
      busy = true;
    }
  }
  s.flags[0x161] = busy ? s.flags[0x161]! | 6 : s.flags[0x161]! & ~6;
}
/** Complete delusion-animation selector family inside 10/37. */
export function delusionSelector(
  h: OpcodeExecution,
  selector: number,
  achievement: (id: number) => void,
): boolean {
  const s = h.state,
    g = (a: number) => s.get(a),
    p = (a: number, n: number) => s.put(a, n);
  const backgroundIndex = () => {
    const mask = s.variable(0x62b0 / 4) >>> 0;
    return mask > 0 && mask <= 32768 && (mask & (mask - 1)) === 0 ? Math.log2(mask) + 1 : 0;
  };
  if (selector === 0x15) {
    updateDelusion(h);
    return true;
  }
  if (selector === 0x16) {
    openDelusion(h);
    if (s.flags[0x161]! & 2) h.retry();
    return true;
  }
  if (selector === 0x18) {
    closeDelusion(h, achievement);
    if (s.flags[0x161]! & 2) h.retry();
    return true;
  }
  if (selector === 0x14) {
    if (s.view(0x17acba0, 8).getBigUint64(0, true) !== 0n) p(0x17ac2ec, g(0x17ac2ec) & 4);
    for (const [a, n] of [
      [0x53589c, 0],
      [0x531fa4, 1],
      [0x20a690, 0x20000],
      [0x535834, 0xc00],
      [0x5358b0, 20000],
      [0x532088, 400],
    ])
      p(a!, n!);
    for (const a of [
      0x5320a0, 0x5358d8, 0x535854, 0x5358d0, 0x531fb4, 0x5358a0, 0x532178, 0x5358c0, 0x5320a4,
      0x53587c, 0x5358c4,
    ])
      p(a, 0);
    s.put(0x5358b8, 0, 8);
    s.setVariable(0x6c48 / 4, 0);
    s.flags[0x161] = (s.flags[0x161]! | 6) ^ 4;
    p(0x535874, backgroundIndex() * 40 + 0x1176);
    return true;
  }
  if (selector === 0x17) {
    for (const a of [
      0x5358d8, 0x535830, 0x5320a4, 0x53587c, 0x5358c4, 0x5358a0, 0x5a71b4, 0x5a724c,
    ])
      p(a, 0);
    s.flags[0x161] = ((s.flags[0x161]! & ~1) | 6) ^ 4;
    p(0x5a71a8, -1);
    s.put(0x5a71f8, 0, 8);
    p(0x5a7240, -1);
    s.put(0x5a7290, 0, 8);
    return true;
  }
  if (selector === 0x19) {
    p(0x20a690, 65536);
    for (const a of [
      0x535830, 0x531fa4, 0x53589c, 0x535834, 0x5358b0, 0x532088, 0x5358d8, 0x5358c0, 0x532178,
    ])
      p(a, 0);
    s.put(0x5358b8, 0, 8);
    s.put(0x5358c8, 0, 8);
    return true;
  }
  if (selector === 0x1a) {
    for (const [a, n] of [
      [0x53589c, 0],
      [0x535830, 1],
      [0x531fa4, 1],
      [0x20a690, 0x14400],
      [0x535834, 5],
      [0x5358b0, 20000],
      [0x53587c, 0],
      [0x5358c4, 0],
      [0x5320a0, 0],
      [0x5358d8, 0],
      [0x532178, 256],
      [0x5358a0, 0],
      [0x535854, 256],
    ])
      p(a!, n!);
    const mode = s.variable(0x6c48 / 4);
    if (mode >= 0 && mode <= 2) {
      p(0x5320a4, [0, 1, 3][mode]!);
      p(0x532088, [400, 2400, -2400][mode]!);
      p(0x5358d0, mode);
      p(0x531fb4, mode ? 272 : 0);
    }
    p(0x535874, (backgroundIndex() - 1) * 40 + 0x119e);
    s.setVariable(g(0x535874) >>> 0, 256);
    return true;
  }
  return false;
}
