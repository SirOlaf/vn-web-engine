import type {Sc3Runtime} from './runtime.js';
import {drawSceneShader, drawShaderRectangle} from './shader-draw.js';
import {nativeBlend} from './render-state.js';
import type {DrawCommand, SpriteDraw} from '../../../../../graphics/draw-list.js';
import {nativeVideoProfiles} from './native-video-shaders.js';
import type {TextureImage} from './textures.js';
import type {YuvFrame} from '../../../../../video/frame.js';
const images = new WeakMap<YuvFrame, Map<string, TextureImage[]>>();
/** 14006dc00 / 1400738e0: upload into the surface's allocated planes. Decoder
 * macroblock stride is a source pitch, never the GPU image width or height. */
function moviePlanes(frame: YuvFrame, width: number, height: number): TextureImage[] {
  let sizes = images.get(frame);
  if (!sizes) {
    sizes = new Map();
    images.set(frame, sizes);
  }
  const key = `${width}/${height}`;
  let result = sizes.get(key);
  if (result) return result;
  const plane = (
    bytes: Uint8Array,
    w: number,
    h: number,
    sourceWidth: number,
    sourceHeight: number,
    stride: number,
  ) => {
    const pixels = new Uint8Array(w * h * 4);
    for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
    for (let y = 0; y < Math.min(h, sourceHeight); y++)
      for (let x = 0; x < Math.min(w, sourceWidth); x++)
        pixels[(y * w + x) * 4] = bytes[y * stride + x]!;
    return {width: w, height: h, pixels};
  };
  result = [
    plane(frame.y, width, height, frame.width, frame.height, frame.stride),
    plane(
      frame.cb,
      width >>> 1,
      height >>> 1,
      Math.ceil(frame.width / 2),
      Math.ceil(frame.height / 2),
      frame.stride / 2,
    ),
    plane(
      frame.cr,
      width >>> 1,
      height >>> 1,
      Math.ceil(frame.width / 2),
      Math.ceil(frame.height / 2),
      frame.stride / 2,
    ),
  ];
  if (frame.alpha)
    result.push(plane(frame.alpha, width, height, frame.width, frame.height, frame.stride));
  sizes.set(key, result);
  return result;
}

/** 140024b60 / 140024c20: both submit the selected valid movie surface.
 * Their only ordering difference is whether opacity is tested before 140025f50;
 * that helper only reads retained surface state. */
export function drawDirectMovie(
  vm: Sc3Runtime,
  ch: number,
  opacity: number,
): SpriteDraw | undefined {
  const s = vm.state,
    b = 0x1d8be20 + ch * 0x1258;
  if (opacity <= 0 || !s.bytes(b + 8, 1)[0]) return;
  const index =
      s.view(b + 0xce2, 2).getUint16(0, true) * 4 + s.view(b + 0xce4, 2).getUint16(0, true),
    pointer = Number(s.view(b + 0xcf0 + index * 8, 8).getBigUint64(0, true));
  if (pointer === 0) return;
  if (
    pointer < 0x141d1b200 ||
    pointer >= 0x141d1b200 + 512 * 0x1b0 ||
    (pointer - 0x141d1b200) % 0x1b0 !== 0
  )
    throw new Error(`Invalid native movie surface pointer: 0x${pointer.toString(16)}`);
  const at = pointer - 0x140000000;
  if (!s.bytes(at + 0x32, 1)[0]) return;
  const frame = vm.movies.frame(ch);
  if (!frame) return;
  const planes = moviePlanes(
      frame,
      s.view(at + 0x68, 2).getUint16(0, true),
      s.view(at + 0x6a, 2).getUint16(0, true),
    ),
    texture = (pointer - 0x141d1b200) / 0x1b0,
    hasAlpha = s.bytes(at + 0x34, 1)[0] !== 0,
    dual = s.bytes(at + 0x35, 1)[0] !== 0,
    ids = planes.map((_, i) => (i === 0 ? texture : -1000 - texture * 4 - i)),
    profile = s.get(at + 0x48);
  if (hasAlpha && planes.length !== 4)
    throw new Error('Decoded alpha-bearing movie has no alpha plane');
  if (profile < 1 || profile > 4)
    throw new Error(`Invalid native movie color-conversion profile: ${profile}`);
  const shader = hasAlpha ? 4 : dual ? 1 : 0,
    parameters = new Float32Array(nativeVideoProfiles[profile - 1]!);
  for (let i = 0; i < planes.length; i++)
    vm.textures.resources.set(ids[i]!, {
      id: ids[i]!,
      format: 0,
      image: planes[i]!,
      pending: undefined,
      ...(i === 0 ? {movie: {planes: ids, shader, parameters}} : {}),
    });
  const v = s.view(at, 0x80),
    extent = (a: number, b: number, c: number) =>
      Math.fround(Math.fround(v.getUint16(a, true) * v.getUint16(b, true)) / v.getUint16(c, true));
  return {
    texture,
    source: {x: 0, y: 0, width: extent(0x72, 0x76, 0x68), height: extent(0x74, 0x78, 0x6a)},
    destination: {x: 0, y: 0, width: 1920, height: 1080},
    color: 0xffffff,
    alpha: Math.min(255, opacity | 0),
    blendState: nativeBlend(0),
  };
}

/** 1400120d0's direct movie surfaces, at their native scene priority. */
export function movieAtPriority(vm: Sc3Runtime, priority: number): DrawCommand[] {
  const s = vm.state,
    out: DrawCommand[] = [];
  for (let ch = 0; ch < 2; ch++) {
    if (!(s.flags[0xe7]! & (8 << ch))) continue;
    const b = 0x1d8be20 + ch * 0x1258,
      v = (a: number) => s.variable((a + ch * 0x50) / 4);
    const frameCount = (at: number) =>
      Math.trunc(
        Math.fround(
          Math.fround(Math.fround(Number(s.view(at, 8).getBigInt64(0, true))) * 30) / 1000,
        ),
      ) | 0;
    s.setVariable((0x631c + ch * 0x50) / 4, frameCount(b + 0x48));
    s.setVariable((0x6324 + ch * 0x50) / 4, frameCount(b + 0x50));
    const pairs =
      ch === 0
        ? [
            [0x62e8, 0x6308],
            [0x630c, 0x6310],
            [0x62ec, 0x62f0],
            [0x6314, 0x6318],
          ]
        : [
            [0x62e8, 0x6308],
            [0x630c, 0x6310],
          ];
    const pair = pairs.find(([at, alpha]) => v(at!) === priority && v(alpha!) !== 0);
    if (!pair) continue;
    const shader = v(0x6320);
    if (shader !== 0 && s.flags[0x9a]! & (16 << ch)) continue;
    const movie = drawDirectMovie(vm, ch, shader !== 0 ? 256 : v(pair[1]!));
    if (shader === 0) {
      if (movie) out.push(movie);
    } else if (ch === 0) {
      out.push(
        {kind: 'target', texture: 205, width: 1920, height: 1080},
        {
          kind: 'solid',
          destination: {x: 0, y: 0, width: 1920, height: 1080},
          color: 0,
          alpha: 255,
          blendState: nativeBlend(0x201),
        },
      );
      if (movie) out.push(movie);
      out.push({kind: 'target', texture: null, width: 1920, height: 1080});
      const full = {x: 0, y: 0, width: 1920, height: 1080};
      out.push(
        {kind: 'target', texture: null, width: 1920, height: 1080},
        drawShaderRectangle(s, shader, [204, 205], [full, full]),
      );
    } else out.push(...drawSceneShader(s, shader, 181, v(pair[1]!)));
  }
  return out;
}

/** 14001147e–1400114dc, before the scene priority loop. */
export function movieSceneReady(vm: Pick<Sc3Runtime, 'state'>): void {
  const s = vm.state;
  for (let ch = 0; ch < 2; ch++) {
    const active = !!(s.flags[0xe7]! & (8 << ch));
    if (!active) s.setVariable((0x631c + ch * 0x50) / 4, 65535);
    if (!active || s.bytes(0x1d8be2d + ch * 0x1258, 1)[0])
      s.flags[0x9a] = s.flags[0x9a]! & ~(16 << ch);
  }
}
