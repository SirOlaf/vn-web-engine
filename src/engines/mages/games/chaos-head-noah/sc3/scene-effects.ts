import {sceneShadersAtPriority} from './shader-draw.js';
import type {NoahState} from './noah-state.js';
import type {DrawCommand, SpriteDraw} from '../../../../../graphics/draw-list.js';
import {f, add, sub, mul, div, trunc} from './render-math.js';
import {nativeBlend, nativeSampler} from './render-state.js';
const opaque = 'vec4 shade(vec4 sampleColor,vec4 tint){return vec4(sampleColor.rgb,1.)*tint;}';
const rect = (
  texture: number,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
  color = 0xffffff,
  alpha = 256,
): SpriteDraw => ({
  texture,
  source: {x: sx, y: sy, width: sw, height: sh},
  destination: {x: dx, y: dy, width: dw, height: dh},
  color,
  alpha: Math.max(0, Math.min(255, alpha)),
});
const target = (texture: number | null): DrawCommand => ({
  kind: 'target',
  texture,
  width: 1920,
  height: 1080,
});
/** 140024ce0: successive half-size downsampling/full-size upsampling, using global sampling. */
export function drawSceneBlur(s: NoahState, amount: number): DrawCommand[] {
  const out: DrawCommand[] = [
    {kind: 'capture', texture: 203, width: 1920, height: 1080},
    target(205),
    rect(203, 0, 0, 1920, 1080, 0, 0, 960, 540),
  ];
  for (let i = 1; i < Math.min(amount >>> 0, 32); i++)
    out.push(
      target(206),
      rect(205, 0, 0, 960, 540, 0, 0, 1920, 1080),
      target(205),
      rect(206, 0, 0, 1920, 1080, 0, 0, 960, 540),
    );
  out.push(target(null), rect(205, 0, 0, 960, 540, 0, 0, 1920, 1080));
  return out.map((d) =>
    'kind' in d ? d : {...d, ...nativeSampler(s), blendState: nativeBlend(s.get(0x587344) & 65535)},
  );
}
/** Tail of 140012470: shader 8 supplies opaque sampled RGB, nearest sampling. */
export function drawSceneMosaic(s: NoahState, amount: number): DrawCommand[] {
  const n = Math.min(amount >>> 0, 20),
    w = Math.trunc(1920 / n),
    h = Math.trunc(1080 / n);
  s.put(0x586a54, 0);
  return [
    {kind: 'capture', texture: 203, width: 1920, height: 1080},
    target(204),
    {
      ...rect(203, 0, 0, 1920, 1080, 0, 0, w, h),
      filter: 'nearest',
      wrapS: 'clamp',
      wrapT: 'clamp',
      blendState: nativeBlend(s.get(0x587344) & 65535),
      fragment: opaque,
    },
    target(null),
    {
      ...rect(204, 0, 0, w, h, 0, 0, 1920, 1080),
      filter: 'nearest',
      wrapS: 'clamp',
      wrapT: 'clamp',
      blendState: nativeBlend(s.get(0x587344) & 65535),
      fragment: opaque,
    },
  ];
}
/** 14000be90: two independently scrolling strips of texture 96. */
export function drawSceneScrolling(s: NoahState, color: number, alpha: number): SpriteDraw[] {
  const out: SpriteDraw[] = [];
  for (const [clock, origin] of [
    [0x5378e0, 20],
    [0x5425a0, 2020],
  ] as const) {
    const x = f((1920 - s.get(clock)) | 0);
    if (x < 1920)
      out.push(
        rect(96, add(x, origin), 1548, sub(1920, x), 500, 0, 580, sub(1920, x), 500, color, alpha),
      );
    if (x !== 0 || x >= 1920)
      out.push(rect(96, origin, 1548, x, 500, sub(1920, x), 580, x, 500, color, alpha));
  }
  return out.map((d) => ({
    ...d,
    ...nativeSampler(s),
    blendState: nativeBlend(s.get(0x587344) & 65535),
  }));
}
/** Eight priority attachments in 140011260, through the centered 140025450 path. */
export function drawSceneAttachments(s: NoahState, priority: number): SpriteDraw[] {
  const out: SpriteDraw[] = [];
  for (let i = 0; i < 8; i++) {
    const a = 0x5bf4 + i * 40,
      v = (off: number) => s.variable((a + off) / 4),
      sum = (off: number) => (v(off) + v(off - 0x31b0)) | 0,
      alpha = sum(0);
    if (v(8) !== priority || alpha === 0) continue;
    const index = v(4),
      row = Math.trunc(index / 8),
      sx = mul(sub(f(index), mul(f(row), 8)), 64),
      sy = mul(f(row), 64),
      scale = (off: number) =>
        sum(off) === 0 ? 256 : trunc(div(mul(f(sum(off) >>> 0), 256), 1000));
    const w = mul(mul(f(scale(-8)), 64), 1 / 256),
      h = mul(mul(f(scale(-4)), 64), 1 / 256),
      cx = add(mul(sub(f(sum(-20) >>> 0), 32), 1.5), 32),
      cy = add(mul(sub(f(sum(-16) >>> 0), 32), 1.5), 32);
    out.push({
      ...rect(
        82,
        sx,
        sy,
        64,
        64,
        sub(cx, mul(w, 0.5)),
        sub(cy, mul(h, 0.5)),
        w,
        h,
        0xffffff,
        alpha,
      ),
      ...nativeSampler(s),
      blendState: nativeBlend(s.get(0x587344) & 65535),
    });
  }
  return out;
}
export function sceneFilterEffects(s: NoahState, priority: number): DrawCommand[] {
  const out: DrawCommand[] = [];
  if (s.variable(0x5f6c / 4) === priority && s.variable(0x5f68 / 4) !== 0)
    out.push(...drawSceneGlow(s));
  for (let bank = 0; bank < 2; bank++) {
    const a = 0x5f10 + bank * 40;
    if (
      s.variable(a / 4) !== 0 &&
      s.variable(a / 4 + 2) === priority &&
      s.variable(a / 4 + 1) !== 0
    )
      out.push(...drawSceneFlares(s, bank));
  }
  if (s.variable(0x62b4 / 4) === priority && s.variable(0x62d0 / 4) !== 0 && s.flags[0x131]! & 32)
    out.push(...drawSceneWaveOverlay(s));
  if (s.variable(0x5f88 / 4) === priority && s.variable(0x5f8c / 4) !== 0)
    out.push(...drawSceneLens(s));
  for (const a of [0x64d8, 0x64e4])
    if (s.variable(a / 4) === priority && s.variable(0x64e0 / 4) !== 0)
      out.push(...drawSceneScrolling(s, s.variable(0x64dc / 4), s.variable(0x64e0 / 4)));
  out.push(...sceneShadersAtPriority(s, priority));
  for (const a of [0x6278, 0x6280])
    if (s.variable(a / 4 + 1) === priority && s.variable(a / 4) !== 0)
      out.push(...drawSceneBlur(s, s.variable(a / 4)));
  if (s.variable(0x6274 / 4) === priority && s.variable(0x6270 / 4) >>> 0 > 1)
    out.push(...drawSceneMosaic(s, s.variable(0x6270 / 4)));
  return out;
}
/** 140007810: thirty atlas frames, two draw passes per frame, attached to a background. */
export function drawBackgroundAnimation(s: NoahState, index: number): SpriteDraw[] {
  if (s.variable(0x6d44 / 4) === 65535) return [];
  const bits = s.variable(0x6d50 / 4) >>> 0,
    slot = bits !== 0 && (bits & (bits - 1)) === 0 ? 31 - Math.clz32(bits) : -1;
  if (slot !== index) return [];
  let clock = (s.get(0x532094) + 1) >>> 0;
  if (clock >= 60) clock = 0;
  s.put(0x532094, clock);
  const texture = s.variable(0xd48 + index * 40),
    a = 0x1d1b200 + texture * 0x1b0,
    u = (off: number) => s.view(a + off, 2).getUint16(0, true),
    w = trunc(div(mul(u(0x72), u(0x76)), u(0x68))),
    h = trunc(div(mul(u(0x74), u(0x78)), u(0x6a))),
    x = (s.variable(0x1194 + index * 40) + s.variable(0x960 + index * 10)) | 0,
    y = (s.variable(0x1195 + index * 40) + s.variable(0x961 + index * 10)) | 0;
  const dx = add(
      f((Math.trunc(Math.imul(s.variable(0x6d48 / 4), 3) / 2) - 364 + Math.trunc(w / 2)) | 0),
      f(Math.trunc(Math.imul(x, -3) / 2)),
    ),
    dy = add(
      f((Math.trunc(Math.imul(s.variable(0x6d4c / 4), 3) / 2) - 540 + Math.trunc(h / 2)) | 0),
      f(Math.trunc(Math.imul(y, -3) / 2)),
    ),
    frame = clock >>> 1;
  return [
    {
      ...nativeSampler(s),
      blendState: nativeBlend(s.get(0x587344) & 65535),
      ...rect(
        167,
        (frame % 10) * 364,
        Math.trunc(frame / 10) * 540,
        364,
        540,
        dx,
        dy,
        sub(add(dx, 728), dx),
        sub(add(dy, 1080), dy),
        0xffffff,
        s.variable(0x11a1 + index * 40),
      ),
    },
  ];
}
/** 14000c050: the two banks of expanding horizontal flare particles. */
export function drawSceneFlares(s: NoahState, bank: number): SpriteDraw[] {
  if (s.get(0x542598 + bank * 4) === 0) return [];
  const v = (i: number) => s.variable(0x17c0 + bank * 10 + i),
    angle = mul(mul(f(v(2)), f(Math.PI)), 1 / 32768),
    c = f(Math.cos(angle)),
    sn = f(Math.sin(angle)),
    m = new Float32Array([c, -sn, 0, 0, sn, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  s.bytes(0x1d7d1d0, 64).set(new Uint8Array(m.buffer));
  const out: SpriteDraw[] = [],
    yscale = Math.trunc(((v(7) << 8) >>> 0) / 612);
  for (let i = 0; i < Math.min(v(5) >>> 0, 20); i++) {
    const a = 0x5421d0 + bank * 0x1e0 + i * 24,
      life = s.get(a);
    if (life === 0) continue;
    const alpha = Math.trunc(Math.imul(life, v(4)) / 256);
    if (alpha < 0) continue;
    const distance = f(Math.trunc(Math.imul(v(8), s.get(a + 16)) / 400)),
      x = f((v(0) + 30 + trunc(add(add(mul(distance, c), mul(-sn, 0)), 0))) | 0),
      y = f((v(1) + 306 + trunc(add(add(mul(distance, sn), mul(c, 0)), 0))) | 0),
      xs = Math.trunc((s.get(a + 12) << 8) / 61),
      w = mul(mul(f(xs), 61), 1 / 256),
      h = mul(mul(f(yscale), 612), 1 / 256);
    out.push({
      ...rect(
        80,
        658,
        141,
        61,
        612,
        sub(add(mul(61, 0.5), x), mul(w, 0.5)),
        sub(add(mul(612, 0.5), y), mul(h, 0.5)),
        w,
        h,
        v(3),
        alpha,
      ),
      ...nativeSampler(s),
      blendState: nativeBlend(s.get(0x587344) & 65535),
    });
  }
  return out;
}
/** 140019e50, including the asymmetric second glow rectangle. */
export function drawSceneGlow(s: NoahState): DrawCommand[] {
  const v = (a: number) => s.variable(a / 4),
    x = v(0x5f50),
    y = v(0x5f54),
    ex = v(0x5f58),
    ey = v(0x5f5c),
    alpha = v(0x5f68),
    product = Math.imul(alpha, v(0x5f60)) >>> 0,
    color = v(0x5f64),
    out: DrawCommand[] = [
      {
        kind: 'solid',
        destination: {x: 0, y: 0, width: 1920, height: 1080},
        color: 0xffffff,
        alpha: Math.min(255, Math.trunc(product / 1000)),
        blendState: nativeBlend(0),
      },
    ];
  const sprite = (
    sx: number,
    cx: number,
    cy: number,
    left: number,
    right: number,
    tint: number,
    opacity: number,
  ) => {
    const dx = sub(f(cx), left),
      dy = sub(f(cy), left);
    out.push({
      ...rect(
        82,
        sx,
        192,
        64,
        64,
        dx,
        dy,
        sub(add(f(cx), right), dx),
        sub(add(f(cy), right), dy),
        tint,
        opacity,
      ),
      ...nativeSampler(s),
      blendState: nativeBlend(s.get(0x587344) & 65535),
    });
  };
  sprite(64, x, y, 400, 400, 0xffffff, Math.min(256, Math.trunc(product / 700)));
  sprite(64, x, y, 90, 100, 0xffffff, alpha);
  sprite(128, x, y, 100, 100, 0xffffff, alpha);
  for (const [percent, radius] of [
    [15, 40],
    [35, 30],
    [70, 35],
    [92, 60],
  ])
    sprite(
      192,
      (x + Math.trunc(Math.imul((ex - x) | 0, percent!) / 100)) | 0,
      (y + Math.trunc(Math.imul((ey - y) | 0, percent!) / 100)) | 0,
      radius!,
      radius!,
      color,
      alpha >>> 1,
    );
  sprite(128, ex, ey, 90, 90, color, alpha);
  return out;
}
// Read from the pinned executable's 1401d6b68 / 1401d6c30 tables.
const lensPositions = [-971, -858, -419, 0, 145, 257, 499, 593, 782, 962];
const lensRects = [
  [1536, 0, 256, 256],
  [0, 0, 512, 512],
  [1536, 256, 256, 256],
  [0, 512, 512, 512],
  [1280, 256, 256, 256],
  [1280, 0, 256, 256],
  [1024, 256, 256, 256],
  [512, 512, 512, 512],
  [1024, 0, 256, 256],
  [512, 0, 512, 512],
];
/** 14000c3f0 through 140022d00: the latter scales the already scaled atlas rectangles. */
export function drawSceneLens(s: NoahState): DrawCommand[] {
  const v = (a: number) => s.variable(a / 4),
    x = v(0x5f80),
    y = v(0x5f84),
    ox = v(0x5f78),
    oy = v(0x5f7c),
    alpha = v(0x5f8c),
    out: DrawCommand[] = [];
  s.put(0x587344, 2);
  for (let i = 0; i < 10; i++) {
    const [sx, sy, sw, sh] = lensRects[i]!,
      distance = lensPositions[i]!,
      dx = mul(
        f((Math.trunc(Math.imul(distance, (x - ox) | 0) / 858) + x - Math.trunc(sw! / 2)) | 0),
        1.5,
      ),
      dy = mul(
        f((Math.trunc(Math.imul(distance, (y - oy) | 0) / 858) + y - Math.trunc(sh! / 2)) | 0),
        1.5,
      ),
      w = mul(f(sw!), 1.5),
      h = mul(f(sh!), 1.5),
      dw = mul(w, 1.5),
      dh = mul(h, 1.5);
    out.push({
      ...rect(
        99,
        mul(f(sx!), 1.5),
        mul(f(sy!), 1.5),
        w,
        h,
        sub(add(mul(w, 0.5), dx), mul(dw, 0.5)),
        sub(add(mul(h, 0.5), dy), mul(dh, 0.5)),
        dw,
        dh,
        0xffffff,
        alpha,
      ),
      ...nativeSampler(s),
      blendState: nativeBlend(2),
    });
  }
  s.put(0x587344, 0);
  const product = Math.imul(v(0x5f90), alpha) >>> 0;
  if (product >= 1000)
    out.push({
      kind: 'solid',
      destination: {x: 0, y: 0, width: 1920, height: 1080},
      color: 0xffffff,
      alpha: Math.min(255, Math.trunc(product / 1000)),
      blendState: nativeBlend(0),
    });
  const glow = Math.min(256, Math.trunc(product / 700));
  if (glow !== 0) {
    const dx = mul(f((ox - 400) | 0), 1.5),
      dy = mul(f((oy - 400) | 0), 1.5);
    out.push({
      ...rect(
        82,
        96,
        288,
        96,
        96,
        dx,
        dy,
        sub(mul(f((ox + 400) | 0), 1.5), dx),
        sub(mul(f((oy + 400) | 0), 1.5), dy),
        0xffffff,
        glow,
      ),
      ...nativeSampler(s),
      blendState: nativeBlend(0),
    });
  }
  return out;
}

/** 140012470's 62b4 branch advances the wave records, then copies and submits surface 200.
 * The actual submission has a null shader; the cleared shader-38 constants are not bound. */
export function drawSceneWaveOverlay(s: NoahState): DrawCommand[] {
  for (let i = 0; i < s.get(0x545224); i++) {
    const a = 0x5494ec + i * 20;
    s.put(a, (s.get(a) + s.get(a - 4)) | 0);
  }
  return [
    {kind: 'capture', texture: 200, width: 1920, height: 1080},
    {
      ...rect(200, 0, 0, 1920, 1080, 0, 0, 1920, 1080),
      ...nativeSampler(s),
      blendState: nativeBlend(s.get(0x587344) & 65535),
    },
  ];
}
