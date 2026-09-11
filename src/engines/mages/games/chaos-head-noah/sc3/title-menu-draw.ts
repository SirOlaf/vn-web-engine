import {nativeSampler, nativeBlend} from './render-state.js';
import type {NoahState} from './noah-state.js';
import type {DialogDrawList} from './dialog-draw.js';
import type {SpriteDraw} from '../../../../../graphics/draw-list.js';

/** 14002eda0 / 14002f480, including the periodic 14002f240 additive sweep. */
export function drawTitleMenu(s: NoahState): DialogDrawList {
  const out: DialogDrawList = {sprites: [], commands: [], regions: []},
    phase = s.variable(0x210c / 4),
    frame = s.variable(0x211c / 4) >>> 0;
  const sprite = (
    x: number,
    y: number,
    width: number,
    height: number,
    dx: number,
    dy: number,
    alpha = 256,
  ) => {
    const d: SpriteDraw = {
      ...nativeSampler(s),
      texture: 3,
      source: {x, y, width, height},
      destination: {x: dx, y: dy, width, height},
      color: 0xffffff,
      alpha,
    };
    out.sprites.push(d);
    out.commands!.push(d);
    return d;
  };
  const mask = (
    d: SpriteDraw,
    x: number,
    y: number,
    width: number,
    height: number,
    progress: number,
  ) => {
    d.mask = {
      ...nativeSampler(s),
      texture: 3,
      source: {x, y, width, height},
      scale: 16,
      bias: Math.fround(Math.fround((255 - Math.max(0, Math.min(272, progress | 0))) * 16) / 255),
      invert: true,
    };
  };
  const region = (
    group: number,
    index: number,
    x: number,
    y: number,
    width: number,
    height: number,
  ) => out.regions.push({group, index, x, y, width, height});
  const marker = () => {
    const i = s.get(0x5b04b8) >>> 0;
    s.put(0x5b09b8 + i * 4, 2);
    s.put(0x5b04b8, i + 1);
  };
  sprite(0, 0, 1920, 1080, 0, 0);
  const background = sprite(0, 1086, 1920, 1080, 0, 0);
  if (phase === 2) {
    if (frame < 64) mask(background, 646, 2509, 640, 360, Math.imul(frame, 272) >>> 6);
    sprite(0, 3817, 1920, 24, 0, 986);
    sprite(0, 2172, 942, 331, 747, 465);
    if (frame > 48) {
      const a = Math.min(16, frame - 48) << 4;
      sprite(0, 3197, 732, 136, 0, 80, a);
      sprite(948, 2242, 196, 32, 586, 218, a);
      sprite(0, 2875, 206, 322, 534, 0, a);
      sprite(948, 2306, 196, 32, 586, 290, a);
    }
    if (s.flags[0xf1]! & 4 && frame > 64)
      mask(
        sprite(824, 2875, 254, 184, 516, 0),
        824,
        3243,
        254,
        184,
        (Math.imul(frame, 272) - 17408) >>> 4,
      );
    marker();
    return out;
  }
  if (phase !== 3 && phase !== 10 && phase !== 12)
    throw new Error(`Invalid title menu leaf rendering state ${phase}`);
  drawTitleSweep(s, sprite);
  sprite(0, 3817, 1920, 24, 0, 986);
  sprite(0, 2172, 942, 331, 747, 465);
  if (s.flags[0xf1]! & 4) {
    sprite(824, 2875, 254, 184, 516, 0);
    region(10, 0, 608, 328, 112, 24);
  }
  sprite(0, 3197, 732, 136, 0, 80);
  sprite(948, 2242, 196, 32, 586, 218);
  sprite(0, 2875, 206, 322, 534, 0);
  sprite(412, 2875, 206, 322, 534, 0);
  [112, 168, 126, 116].forEach((width, i) => region(10, i + 1, 608, 184 + i * 36, width, 24));
  const selected = s.get(0x5afa9c) >>> 0,
    transition = s.get(0x5b0a40) >>> 0;
  if (selected === 0) sprite(824, 3059, 254, 184, 516, 0);
  else if (selected === 1) sprite(0, 3333, 732, 136, 0, 80);
  else if (selected === 2 && transition < 64) sprite(948, 2274, 196, 32, 586, 218);
  else if (selected === 3) sprite(206, 2875, 206, 322, 534, 0);
  else if (selected === 4) sprite(618, 2875, 206, 322, 534, 0);
  if (selected <= 4 && (selected !== 2 || transition === 0)) {
    let pulse = (s.get(0x5afa8c) + 1) >>> 0;
    if (pulse > 35) pulse = 0;
    s.put(0x5afa8c, pulse);
    sprite(
      [0, 172, 301, 485, 627][selected]!,
      3475 + (pulse >>> 2) * 38,
      [166, 123, 178, 136, 126][selected]!,
      36,
      603,
      144 + selected * 36,
    );
  }
  if ((selected === 2 || selected === 4) && transition !== 0) {
    const y = selected === 2 ? 97 : 169;
    if (transition < 64)
      mask(
        sprite(1078, 3031, 502, 156, 93, y),
        1078,
        3187,
        502,
        156,
        Math.imul(transition, 272) >>> 6,
      );
    else {
      sprite(1078, 2875, 502, 156, 93, y);
      const ys =
        selected === 4 ? [184, 226, 268] : s.flags[0x6f]! & 32 ? [112, 154, 196] : [127, 184];
      const row = s.get(0x5af910 + selected * 4) >>> 0;
      ys.forEach((dy, i) => {
        sprite(
          1586,
          (selected === 2 ? 2875 : 3235) + i * 120 + (row === i ? 40 : 0),
          350,
          40,
          109,
          dy,
        );
        region(11, i, 109, dy, 350, 40);
      });
    }
  }
  marker();
  const fade = s.get(0x5b0a50);
  if (fade)
    out.commands!.push({
      kind: 'solid',
      destination: {x: 0, y: 0, width: 1920, height: 1080},
      color: 0,
      alpha: Math.imul(fade, 4),
    });
  return out;
}

/** 14002f240: the same counter is shared by the menu and its exit underlay. */
export function drawTitleSweep(
  s: NoahState,
  sprite: (x: number, y: number, w: number, h: number, dx: number, dy: number) => SpriteDraw,
): void {
  const old = s.get(0x5b0994) >>> 0,
    next = (old + 1) >>> 0;
  s.put(0x5b0994, next > 600 ? 0 : next);
  if (next > 569 && next <= 600) {
    const x = Math.fround(Math.fround(Math.fround((old - 569) >>> 0) * 320) / 30),
      y = Math.fround(Math.fround(Math.fround(Math.fround((old - 569) >>> 0) * 180) / 30) + 2509);
    const sweep = sprite(0, 1086, 1920, 1080, 0, 0);
    sweep.mask = {
      ...nativeSampler(s),
      texture: 3,
      source: {x, y, width: 320, height: 180},
      scale: 1,
      bias: 0,
      channel: 'red',
    };
    sweep.blend = 'add';
    s.put(0x587344, 0, 2);
  }
}
