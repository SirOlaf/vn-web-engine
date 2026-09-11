import {nativeBlend} from './render-state.js';
import type {NoahState} from './noah-state.js';
import type {TriangleDraw} from '../../../../../graphics/triangle-draw.js';
import {compositionResource} from './composition-resources.js';
import {f, add, mul, div, matrixProduct, rotation, clipMatrix} from './render-math.js';
import {submitTriangles} from './triangle-submit.js';
import {backgroundShaders} from './background-shaders.js';

const mouthFrames = [1, 2, 1, 2, 1, 2, 1, 2, 1, 0, 1, 2, 1, 0, 1, 2, 1, 2, 1, 2];
const mouthDuration = [10, 5, 10, 4, 7, 6, 9, 8, 15, 2, 9, 3, 7, 2, 10, 5, 7, 5, 7, 3];
/** 1400171b0: sixteen blink clocks and three independent dialogue mouth clocks. */
export function advanceCharacterAnimation(s: NoahState): void {
  for (let i = 0; i < 16; i++) {
    const clock = 0x5591c0 + i * 4,
      frame = 0x56cdc0 + i * 4;
    if (s.get(clock) === 0) {
      s.put(frame, s.get(frame) + 1);
      s.put(clock, 4);
      if (s.get(frame) === 3) {
        s.put(frame, 0);
        if ((((s.random15() & 32767) * 100) & 0xffff8000) >>> 0 < 0x2f8000)
          s.put(clock, (((s.random15() & 32767) * 230) >>> 15) + 200);
      }
    } else s.put(clock, s.get(clock) - 1);
  }
  for (let i = 0; i < 3; i++) {
    const clock = 0x586a48 + i * 4,
      frame = 0x20bba8 + i * 4;
    if (!(s.flags[0x97]! & (32 << i))) {
      s.put(clock, 0);
      s.put(frame, 19);
    } else if (!(s.variable(0x2104 / 4) & 4)) {
      if (s.get(clock) === 0) {
        const next = s.get(frame) === 19 ? 0 : s.get(frame) + 1;
        s.put(frame, next);
        s.put(clock, mouthDuration[next]!);
      } else s.put(clock, s.get(clock) - 1);
    }
  }
}
/** 140017390. The voice analysis archive uses native little-endian ushort fields. */
export function voiceMouth(
  s: NoahState,
  channel: number,
  byte: (address: number) => number,
): number {
  if ((channel - 3) >>> 0 > 3) return 0;
  const a = 0x5a7110 + channel * 0x98;
  if (s.get(a + 0x38) === 0 || s.get(a + 0x3c) === 1) return 0;
  const pointer = Number(s.view(0x17ac1b0, 8).getBigUint64(0, true)),
    u16 = (a: number) => byte(a) | (byte(a + 1) << 8),
    count = u16(pointer),
    index = s.get(a + 0x2c) >>> 0 <= count ? s.get(a + 0x2c) : 0;
  const position = s.get(a + 0x64) >>> 0,
    total = s.get(a + 0x60) >>> 0;
  if (!position || position >= 0x80000000 || !total || total >= 0x80000000 || position > total)
    return 0;
  const duration = u16(pointer + ((index << 2) >>> 0) + 6),
    rate = s.get(a + 0x5c),
    tick = Math.trunc(position / 10) >>> 2;
  if (rate === 0) throw new Error('Native voice mouth division by zero');
  if (Math.trunc(Math.imul(position, 60) / rate) >>> 0 > duration * 10 + 9 || tick > duration)
    return 0;
  return (
    (byte(pointer + count * 4 + 4 + u16(pointer + ((index << 2) >>> 0) + 4) * 4 + tick) >>>
      ((Math.trunc(position / 10) & 3) * 2)) &
    3
  );
}
/** 1400174c0: selectors are resolved even by draw modes that submit no geometry. */
export function characterParts(s: NoahState): void {
  const index = s.get(0x5869ec) >>> 0,
    mask = 1 << (index & 31),
    eye = s.get(0x586a14),
    mouth = s.get(0x586a18);
  s.put(0x586a0c, eye === 255 ? s.get(0x56cdc0 + index * 4) : eye);
  if (mouth !== 255) {
    s.put(0x586a10, mouth);
    return;
  }
  s.put(0x586a10, 0);
  for (let i = 0; i < 3; i++) {
    if (
      !(s.flags[0x97]! & (32 << i)) ||
      !(s.variable(0x20d0 / 4 + i) & mask) ||
      s.get(0x17ac284) !== 0
    )
      continue;
    const mode = s.get(0x17ac2f0 + i * 4),
      envelope = s.get(0x545648 + i * 4);
    if (mode === 0) s.put(0x586a10, mouthFrames[s.get(0x20bba8 + i * 4)]!);
    else if (mode === 1) {
      if (s.get(0x179cae8 + i * 4) === -1) s.put(0x586a10, envelope);
      else if (s.get(0x5a7110 + s.bytes(0x5b10b5 + i * 0x11984, 1)[0]! * 0x98) !== -1)
        s.put(0x586a10, envelope === 0 ? 0 : mouthFrames[s.get(0x20bba8 + i * 4)]!);
    }
    return;
  }
}
/** 140016f00: all twenty verified character table entries at 1401d6da0. */
export function drawCharacter(s: NoahState, index: number): TriangleDraw[] {
  const b = 0x13ec + index * 40,
    o = 0x9c4 + index * 10,
    v = (i: number) => s.variable(b + i),
    sum = (i: number, j: number) => (v(i) + s.variable(o + j)) | 0,
    p = (o: number, v: number) => s.put(0x5869b0 + o, v),
    g = (o: number) => s.get(0x5869b0 + o);
  p(0x58, s.flag(0x9ce + index));
  p(0x3c, index);
  p(0x40, 1 << index);
  p(0x5c, 0);
  p(0, v(0));
  p(4, v(1));
  p(0x30, s.variable(o));
  p(0x34, s.variable(o + 1));
  for (let i = 2; i <= 6; i++) p(i * 4, sum(i, i));
  p(0x1c, s.variable(0xd7a + index));
  p(0x20, v(14));
  p(0x24, v(15));
  p(0x28, sum(7, 7));
  p(0x2c, v(8));
  p(0x38, v(9));
  for (const [off, i] of [
    [0x44, 11],
    [0x48, 12],
    [0x4c, 13],
    [0x50, 16],
    [0x54, 17],
    [0x64, 18],
    [0x68, 19],
  ])
    p(off!, v(i!));
  const unscaled = g(0x14) === 1000 && g(0x18) === 1000;
  if (unscaled) s.put(0x586a54, 0);
  const mode = g(0x24) >>> 0,
    out: TriangleDraw[] = [];
  if (mode < 20) {
    if (mode === 2 || [3, 4, 5, 8, 9].includes(mode)) {
      if (mode === 2 || g(0x20) !== 0) characterParts(s);
    } else if (mode === 7 || mode === 10 || mode === 11) {
      if (g(0x20) !== 0) {
        const alpha = Math.trunc(Math.imul(g(0x28), g(0x20)) / 256);
        characterParts(s);
        const shader = backgroundShaders[mode === 7 ? 22 : mode === 10 ? 25 : 26];
        const submit = () => {
          for (const a of [0x578b8c, 0x56ca88])
            if (s.get(a) !== 0) out.push(submitTriangles(s, g(0x1c), s.get(a), shader));
        };
        for (let bank = 0; bank < 2; bank++)
          if (s.variable(bank * 30 + 0x1810) === g(0x40))
            for (let i = 7; i >= 0; i--)
              if (Math.imul(alpha, s.variable(bank * 30 + (i + 0x807) * 3)) >>> 0 > 255) submit();
        submit();
      }
    } else {
      const m = characterMatrix(s);
      characterParts(s);
      out.push(
        ...characterMeshes(
          s,
          g(0x1c) - 8,
          g(0x1c),
          g(0x48),
          s.get(0x586a10),
          s.get(0x586a0c),
          m,
          g(0x2c),
          g(0x28),
        ),
      );
    }
  }
  if (unscaled) s.put(0x586a54, 0);
  return out;
}
/** Matrix passed by 1400176a0 before the compositor converts to clip coordinates. */
export function characterMatrix(s: NoahState): Float32Array {
  const g = (o: number) => s.get(0x5869b0 + o);
  const scale = new Float32Array([
      div(f(g(0x14)), 1000),
      0,
      0,
      0,
      0,
      div(f(g(0x18)), 1000),
      0,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      0,
      1,
    ]),
    m = matrixProduct(rotation(g(8), g(12), g(16)), scale);
  m[2] = 0;
  m[6] = 0;
  m[8] = 0;
  m[9] = 0;
  m[10] = 1;
  m[11] = 0;
  m[3] = add(add(m[3]!, mul(f((g(0) + g(0x30)) | 0), 1.5)), 0);
  m[7] = add(add(m[7]!, mul(f((g(4) + g(0x34)) | 0), 1.5)), 0);
  return m;
}
/** 140025860 / 140067f10 / 140067b60, using the loader's mutable descriptor copy. */
export function characterMeshes(
  s: NoahState,
  index: number,
  texture: number,
  base: number,
  mouth: number,
  eye: number,
  matrix: Float32Array,
  color: number,
  opacity: number,
): TriangleDraw[] {
  const resource = compositionResource(s, index),
    a = 0x1d51200 + index * 0xe0;
  s.put(a + 0xd8, 0x1d1b200 + texture * 0x1b0, 8);
  if (!resource || base >>> 0 >= s.get(a + 0x50)) return [];
  const table = new DataView(
      resource.meshes.buffer,
      resource.meshes.byteOffset,
      resource.meshes.byteLength,
    ),
    name = (i: number) => {
      let n = '';
      for (let p = i * 64 + 32; p < resource.meshes.length && resource.meshes[p] !== 0; p++)
        n += String.fromCharCode(resource.meshes[p]!);
      return n;
    },
    ids = [base],
    baseName = name(base);
  for (const [letter, part] of [
    ['L', mouth],
    ['E', eye],
  ] as const)
    if (part >= 0) {
      const target = baseName + (part < 5 ? letter + (part + 1) : 'XX');
      let id = -1;
      for (let i = 0; i < s.get(a + 0x50); i++)
        if (name(i) === target) {
          id = i;
          break;
        }
      if (id < 0) return [];
      ids.push(id);
    }
  const geometry = resource.geometry;
  if (!geometry) return [];
  const data = new DataView(geometry.buffer, geometry.byteOffset, geometry.byteLength),
    out: TriangleDraw[] = [],
    transform = clipMatrix(matrix),
    alpha = div(Math.max(0, Math.min(255, opacity)), 255),
    r = div((color >>> 16) & 255, 255),
    g = div((color >>> 8) & 255, 255),
    b = div(color & 255, 255);
  // 140072500 binds R16_UINT regardless of the source header's index-width field.
  // 140067b60 binds the first selected mesh's topology and vertex descriptor once.
  const type = table.getUint8(base * 64 + 8),
    topology = (
      {0: 'points', 1: 'lines', 3: 'line-strip', 4: 'triangles', 5: 'triangle-strip'} as const
    )[type as 0 | 1 | 3 | 4 | 5];
  if (!topology) return []; // 1400722b0 maps all other values to D3D topology UNDEFINED.
  const indexed = s.bytes(a + 0x90, 1)[0] !== 0,
    vc = table.getUint32(base * 64 + 16, true),
    vo = table.getUint32(base * 64 + 20, true);
  for (const id of indexed ? ids : [base]) {
    const off = id * 64,
      ic = indexed ? table.getUint32(off + 24, true) : vc,
      io = table.getUint32(off + 28, true),
      vertices = new Float32Array(ic * 9);
    for (let i = 0; i < ic; i++) {
      const n = indexed ? data.getUint16(io + i * 2, true) : i,
        p = vo + n * 20;
      vertices.set(
        [
          data.getFloat32(p, true),
          data.getFloat32(p + 4, true),
          data.getFloat32(p + 8, true),
          r,
          g,
          b,
          alpha,
          data.getFloat32(p + 12, true),
          data.getFloat32(p + 16, true),
        ],
        i * 9,
      );
    }
    out.push({
      kind: 'triangles',
      texture,
      vertices,
      transform,
      normalizedUV: true,
      topology,
      blendState: nativeBlend(),
    });
  }
  return out;
}
