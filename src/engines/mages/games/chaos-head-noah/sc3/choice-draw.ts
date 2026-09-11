import type {NoahState} from './noah-state.js';
import type {DialogDrawList} from './dialog-draw.js';
import type {SpriteDraw} from '../../../../../graphics/draw-list.js';
import {
  choicePositions,
  alternateChoicePositions,
  alternateChoiceFrames,
} from './choice-render-data.js';
import {f, add, sub, mul, div} from './render-math.js';
import {nativeBlend, nativeSampler} from './render-state.js';
import {shaderThreshold} from './shader-draw.js';
const opacity = (a: number) => Math.max(0, Math.min(255, a | 0));
const list = (): DialogDrawList => ({sprites: [], commands: [], regions: []});
function push(out: DialogDrawList, d: SpriteDraw): void {
  out.sprites.push(d);
  out.commands!.push(d);
}
function atlas(
  s: NoahState,
  out: DialogDrawList,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  x = 0,
  y = 0,
  right = 1920,
  bottom = 1080,
  alpha = 256,
  color = 0xffffff,
): SpriteDraw {
  const d: SpriteDraw = {
    texture: 179,
    source: {x: sx, y: sy, width: sw, height: sh},
    destination: {x, y, width: sub(right, x), height: sub(bottom, y)},
    color: color & 0xffffff,
    alpha: opacity(alpha),
    ...nativeSampler(s),
    blendState: nativeBlend(s.get(0x587344) & 65535),
  };
  push(out, d);
  return d;
}
function fill(out: DialogDrawList, alpha: number, color = 0xffffff): void {
  out.commands!.push({
    kind: 'solid',
    destination: {x: 0, y: 0, width: 1920, height: 1080},
    color: color & 0xffffff,
    alpha: opacity(alpha),
    blendState: nativeBlend(0),
  });
}
function transition(
  s: NoahState,
  out: DialogDrawList,
  alternate: boolean,
  progress: number,
  color = 0xffffff,
): void {
  const d = alternate
      ? atlas(s, out, 1546, 1768, 480, 270, 0, 0, 1920, 1080, 256, color)
      : atlas(s, out, 0, 1222, 230, 130),
    p = shaderThreshold(progress, 16);
  d.mask = {
    texture: 179,
    source: alternate
      ? {x: 1546, y: 1492, width: 480, height: 270}
      : {x: 0, y: 1420, width: 640, height: 360},
    scale: p[0]!,
    bias: p[1]!,
  };
}
/** 1400091d0 / 140009c80 each use their own native atlas and motion table. */
export function drawChoiceElement(
  s: NoahState,
  out: DialogDrawList,
  alternate: boolean,
  id: number,
  frame: number,
  from: number,
  to: number,
  startAlpha: number,
  endAlpha: number,
  time: number,
  duration: number,
): void {
  const table = alternate ? alternateChoicePositions : choicePositions,
    bank = alternate ? id * 6 : (id >>> 1) * 4,
    a = (bank + from) * 4,
    b = (bank + to) * 4,
    t = f(alternate ? time : time >>> 0),
    d = f(alternate ? duration : duration >>> 0),
    coordinate = (i: number) =>
      add(div(mul(sub(table[b + i]!, table[a + i]!), t), d), table[a + i]!),
    x = coordinate(0),
    y = coordinate(1),
    right = add(coordinate(2), x),
    bottom = add(coordinate(3), y),
    alpha = (Math.trunc(Math.imul((endAlpha - startAlpha) | 0, time) / duration) + startAlpha) | 0;
  if (alternate) {
    const cell = alternateChoiceFrames[id * 13 + frame]!,
      row = f(Math.trunc(cell / 9));
    atlas(
      s,
      out,
      mul(sub(f(cell), mul(row, 9)), 220),
      add(mul(row, 452), 582),
      220,
      452,
      x,
      y,
      right,
      bottom,
      alpha,
    );
  } else
    atlas(s, out, f((Math.imul(id, 222) + 472) >>> 0), 1086, 222, 328, x, y, right, bottom, alpha);
  const index = alternate ? id : s.get(0x5320a8);
  if (index < 65535)
    out.regions.push({group: 30, index, x, y, width: sub(right, x), height: sub(bottom, y)});
  if (!alternate) s.put(0x5320a8, (index + 1) | 0);
}
/** 140009ee0; all six varying atlas/destination dimensions use integer division first. */
function special(
  s: NoahState,
  out: DialogDrawList,
  endAlpha: number,
  time: number,
  duration: number,
): void {
  const q = (n: number) => Math.trunc(Math.imul(time, n) / duration),
    x = f((600 - q(938)) | 0),
    y = f((240 - q(1651)) | 0);
  atlas(
    s,
    out,
    f((199 - q(9)) | 0),
    f((60 - q(58)) | 0),
    f((210 + q(82)) | 0),
    f((320 + q(125)) | 0),
    x,
    y,
    add(f(q(2328)), add(x, 315)),
    add(f(q(3409)), add(y, 479)),
    (Math.trunc(Math.imul((endAlpha - 256) | 0, time) / duration) + 256) | 0,
  );
}
/** Complete 1400093e0, 14000a030 and 14000a9c0 branches. */
export function drawChoiceLayer(s: NoahState, kind: 0 | 1 | 2): DialogDrawList {
  const out = list();
  if (!(s.flags[kind === 0 ? 0x161 : 0x162]! & (kind === 0 ? 128 : kind === 1 ? 1 : 2))) return out;
  const mode = s.variable(0x6d64 / 4),
    time = s.variable(0x6d60 / 4) >>> 0,
    selected = s.variable(0x6d68 / 4),
    color = s.variable(0x6d58 / 4),
    alternate = kind !== 0;
  if (kind !== 2) s.put(0x5320a8, 0);
  const el = (
    id: number,
    frame: number,
    from: number,
    to: number,
    aa: number,
    ab: number,
    t: number,
    d: number,
  ) => drawChoiceElement(s, out, alternate, id, frame, from, to, aa, ab, t, d);
  const basic = (alpha = 128) => atlas(s, out, 0, 0, 1024, 576, 0, 0, 1920, 1080, alpha),
    additive = () => {
      s.put(0x587344, 2);
      atlas(s, out, 1024, 0, 1024, 576, 0, 0, 1920, 1080, 128);
      s.put(0x587344, 0);
    };
  const originalBase = () => atlas(s, out, 0, 0, 1920, 1080),
    originalCrop = () => atlas(s, out, 236, 1086, 230, 130);
  const fadeProgress = (delay: number) => (272 - ((Math.imul(time, 272) - delay) >>> 5)) | 0;
  if (kind === 0) {
    if (mode === 0 && time <= 32) {
      fill(out, Math.imul(time, 8));
      return out;
    }
    if (mode === 0 && time <= 64) {
      originalBase();
      originalCrop();
      el(0, 0, 0, 0, 0, 128, (time - 32) | 0, 32);
      el(2, 0, 0, 0, 0, 128, (time - 32) | 0, 32);
      transition(s, out, false, fadeProgress(8704));
      return out;
    }
    if (mode === 1) {
      originalBase();
      originalCrop();
      el(0, 0, 0, 0, 128, 128, 0, 1);
      el(2, 0, 0, 0, 128, 128, 0, 1);
    }
    if (mode === 2) {
      if (time <= 32) {
        originalBase();
        originalCrop();
        fill(out, time << 3);
      } else if (time <= 64) {
        originalCrop();
        fill(out, (64 - time) << 3);
      }
      el(0, 0, 0, 1, 128, 256, time, 64);
      el(2, 0, 0, 1, 128, 256, time, 64);
      return out;
    }
    if (mode === 3) {
      originalCrop();
      if (selected === 0) {
        el(1, 0, 1, 1, 256, 256, 0, 1);
        el(2, 0, 1, 1, 256, 256, 0, 1);
      } else if (selected === 1) {
        el(0, 0, 1, 1, 256, 256, 0, 1);
        el(3, 0, 1, 1, 256, 256, 0, 1);
      } else if (selected === 255) {
        el(0, 0, 1, 1, 256, 256, 0, 1);
        el(2, 0, 1, 1, 256, 256, 0, 1);
      }
    }
    if (mode === 4) {
      originalCrop();
      fill(out, time << 3);
      if (selected === 0 || selected === 1) {
        el(0, 0, 1, selected === 0 ? 2 : 3, 256, 0, time, 32);
        el(2, 0, 1, selected === 0 ? 2 : 3, 256, 0, time, 32);
      }
    }
    if (mode === 5) {
      if (time <= 16) fill(out, 256);
      else transition(s, out, false, fadeProgress(4352));
    }
    return out;
  }
  if (kind === 1) {
    if (mode === 0 && time <= 32) {
      fill(out, Math.imul(time, 8));
      return out;
    }
    if (mode === 0 && time <= 64) {
      basic();
      el(0, 0, 0, 0, 0, 128, (time - 32) | 0, 32);
      el(1, 0, 0, 0, 0, 128, (time - 32) | 0, 32);
      transition(s, out, true, fadeProgress(8704));
      return out;
    }
    if (mode === 1) {
      basic();
      el(0, 0, 0, 0, 128, 128, 0, 1);
      el(1, 0, 0, 0, 128, 128, 0, 1);
    }
    if (mode === 2) {
      if (time <= 32) {
        basic();
        fill(out, time << 3);
      } else if (time <= 64) additive();
      el(0, 0, 0, 1, 128, 256, time, 64);
      el(1, 0, 0, 1, 128, 256, time, 64);
      return out;
    }
    if (mode === 3) {
      additive();
      el(0, selected === 0 ? 1 : 0, 1, 1, 256, 256, 0, 1);
      el(1, selected === 1 ? 1 : 0, 1, 1, 256, 256, 0, 1);
    }
    if (mode === 4) {
      additive();
      if (time >= 48) {
        const t = (time - 48) | 0;
        fill(out, Math.imul(t, 8));
        if (selected === 0 || selected === 1) {
          el(0, selected === 0 ? 12 : 0, 1, selected === 0 ? 2 : 3, 256, 0, t, 32);
          el(1, selected === 1 ? 12 : 0, 1, selected === 0 ? 2 : 3, 256, 0, t, 32);
        }
      } else if (time >>> 2 === 0) {
        el(0, 0, 1, 1, 256, 256, 0, 1);
        el(1, 0, 1, 1, 256, 256, 0, 1);
      } else if (selected === 0 || selected === 1) {
        el(0, selected === 0 ? (time >>> 2) + 1 : 0, 1, 1, 256, 256, 0, 1);
        el(1, selected === 1 ? (time >>> 2) + 1 : 0, 1, 1, 256, 256, 0, 1);
      }
    }
    if (mode === 5) {
      if (time <= 16) fill(out, 256);
      else transition(s, out, true, fadeProgress(4352));
    }
    return out;
  }
  if (mode === 0 && !(s.flags[0x162]! & 4) && time <= 32) {
    transition(s, out, true, fadeProgress(0), color);
    return out;
  }
  if (mode === 2) {
    el(0, 0, 0, 1, 128, 256, time, 64);
    el(1, 0, 0, 1, 128, 256, time, 64);
    return out;
  }
  if (mode === 3) {
    el(0, selected === 0 ? 1 : 0, 1, 1, 256, 256, 0, 1);
    el(1, selected === 1 ? 1 : 0, 1, 1, 256, 256, 0, 1);
  }
  if (mode === 4) {
    const isSpecial = !!(s.flags[0x161]! & 64);
    if (time <= 16) {
      s.setVariable(0x6308 / 4, Math.imul(16 - time, 4));
      el(0, 0, 1, 1, 256, 256, 0, 1);
      el(1, 0, 1, 1, 256, 256, 0, 1);
    } else if (time >= 64) {
      const t = (time - 64) | 0;
      if (selected === 0) {
        if (isSpecial) {
          special(s, out, 0, t, 32);
          fill(out, Math.imul(t, 8));
        } else el(0, 12, 1, 4, 256, 256, t, 32);
        el(1, 0, 1, 4, 256, 0, t, 32);
      } else if (selected === 1) {
        el(0, 0, 1, 5, 256, 0, t, 32);
        el(1, 12, 1, 5, 256, 256, t, 32);
      }
    } else {
      if (selected === 0 && isSpecial) special(s, out, 256, 0, 1);
      const frame = (time - 16) >>> 2;
      if (frame === 0) {
        el(0, 0, 1, 1, 256, 256, 0, 1);
        el(1, 0, 1, 1, 256, 256, 0, 1);
      } else if (selected === 0) {
        if (frame !== 11 || !isSpecial) el(0, frame + 1, 1, 1, 256, 256, 0, 1);
        el(1, 0, 1, 1, 256, 256, 0, 1);
      } else if (selected === 1) {
        el(0, 0, 1, 1, 256, 256, 0, 1);
        el(1, frame + 1, 1, 1, 256, 256, 0, 1);
      }
    }
  }
  if (mode === 5) {
    if (time <= 16) fill(out, 256, color);
    else transition(s, out, true, fadeProgress(4352), color);
  }
  return out;
}
/** The earlier 6d54 priority phase of 140011260 is independent of the main layer. */
export function drawEarlyChoiceLayer(s: NoahState): DialogDrawList {
  const out = list(),
    mode = s.variable(0x6d64 / 4),
    time = s.variable(0x6d60 / 4) >>> 0;
  if (!(s.flags[0x162]! & 2)) return out;
  if (mode === 0 && time <= 32)
    for (let i = 0; i < 2; i++) drawChoiceElement(s, out, true, i, 0, 0, 0, 0, 128, time, 32);
  else if (mode === 1)
    for (let i = 0; i < 2; i++) drawChoiceElement(s, out, true, i, 0, 0, 0, 128, 128, 0, 1);
  return out;
}
