import {transferTextDraw} from './dom-text-data.js';
import {nativeVideoShaders} from './native-video-shaders.js';
import type {TextureResource} from './textures.js';
import type {NoahState} from './noah-state.js';
import type {DrawCommand, SpriteDraw, SolidDraw} from '../../../../../graphics/draw-list.js';
import type {TriangleDraw} from '../../../../../graphics/triangle-draw.js';
import {f, add, sub, mul, div} from './render-math.js';
import {nativeBlend} from './render-state.js';
const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
/** 14006b300 / 14006b6c0 / 14006c6f0. Native rectangle submission divides
 * each coordinate before doubling it and normalizes UV endpoints separately.
 * These operations belong to MAGES; the graphics backend receives explicit vertices. */
export function submitNativeRectangle(
  s: NoahState,
  draw: SpriteDraw | SolidDraw,
  width = 1920,
  height = 1080,
): TriangleDraw {
  const solid = 'kind' in draw,
    d = draw.destination,
    texture = solid ? -1 : draw.texture;
  const uv = (id: number, source: {x: number; y: number; width: number; height: number}) => {
    const a = 0x1d1b200 + id * 0x1b0,
      v = s.view(a, 0x80),
      tw = v.getUint16(0x76, true),
      th = v.getUint16(0x78, true);
    const w =
        source.width === 0
          ? div(mul(v.getUint16(0x72, true), tw), v.getUint16(0x68, true))
          : f(source.width),
      h =
        source.height === 0
          ? div(mul(v.getUint16(0x74, true), th), v.getUint16(0x6a, true))
          : f(source.height);
    return [
      div(f(source.x), tw),
      div(f(source.y), th),
      div(add(w, f(source.x)), tw),
      div(add(h, f(source.y)), th),
    ];
  };
  const tex = solid ? [0, 0, 1, 1] : uv(texture, draw.source),
    mask = solid ? undefined : draw.mask,
    maskUV = mask ? uv(mask.texture, mask.source) : undefined,
    coordinates = mask ? new Float32Array(12) : undefined,
    vertices = new Float32Array(54),
    color = [
      div((draw.color >>> 16) & 255, 255),
      div((draw.color >>> 8) & 255, 255),
      div(draw.color & 255, 255),
      div(Math.max(0, Math.min(255, draw.alpha | 0)), 255),
    ];
  const xs = [f(d.x), add(f(d.x), f(d.width))],
    ys = [f(d.y), add(f(d.y), f(d.height))];
  for (const [i, [x, y]] of [
    [0, 0],
    [0, 1],
    [1, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ].entries()) {
    const px = div(add(0, xs[x!]!), f(width)),
      py = div(add(0, ys[y!]!), f(height));
    vertices.set(
      [sub(add(px, px), 1), -sub(add(py, py), 1), -1, ...color, tex[x! * 2]!, tex[y! * 2 + 1]!],
      i * 9,
    );
    if (coordinates) coordinates.set([maskUV![x! * 2]!, maskUV![y! * 2 + 1]!], i * 2);
  }
  return {
    kind: 'triangles',
    depthClip: false,
    texture,
    vertices,
    normalizedUV: true,
    transform: identity,
    blendState: draw.blendState ?? nativeBlend(!solid && draw.blend === 'add' ? 2 : 0),
    ...(!solid
      ? {filter: draw.filter, fragment: draw.fragment, wrapS: draw.wrapS, wrapT: draw.wrapT}
      : {}),
    ...(mask
      ? {
          mask: {
            ...(!solid ? {filter: draw.filter, wrapS: draw.wrapS, wrapT: draw.wrapT} : {}),
            ...mask,
            uv: coordinates!,
          },
        }
      : {}),
  };
}
// A submitted command retains the readiness, UV metadata and movie-plane bindings
// observed at submission, even when a later command replaces its texture slot.
const submittedDraws = new WeakSet<TriangleDraw>();
export function compileNativeRectangles(
  s: NoahState,
  commands: DrawCommand[],
  resources?: ReadonlyMap<number, TextureResource>,
): DrawCommand[] {
  let width = 1920,
    height = 1080;
  const result: DrawCommand[] = [];
  const ready = (texture: number) =>
    texture < 0 || s.bytes(0x1d1b200 + texture * 0x1b0 + 0x32, 1)[0] !== 0;
  for (const command of commands) {
    if ('kind' in command && command.kind === 'target') {
      width = command.width;
      height = command.height;
    }
    if ('kind' in command && command.kind !== 'triangles' && command.kind !== 'solid') {
      result.push(command);
      continue;
    }
    if ('kind' in command && command.kind === 'triangles' && submittedDraws.has(command)) {
      result.push(command);
      continue;
    }
    if (
      !('kind' in command && command.kind === 'solid') &&
      (!ready(command.texture) ||
        (command.mask && !ready(command.mask.texture)) ||
        ('kind' in command &&
          command.kind === 'triangles' &&
          (command.additionalTextures ?? []).some((t) => !ready(t.texture))))
    )
      continue;
    let draw =
      'kind' in command && command.kind === 'triangles'
        ? command
        : submitNativeRectangle(s, command, width, height);
    if (resources) draw = bindMoviePlanes(s, draw, resources);
    transferTextDraw(command, draw);
    submittedDraws.add(draw);
    result.push(draw);
  }
  return result;
}
const boundMovieDraws = new WeakSet<TriangleDraw>();
/** 14006a570 / 140071ca0 expand logical movie surfaces into physical plane SRVs. */
function bindMoviePlanes(
  s: NoahState,
  draw: TriangleDraw,
  resources: ReadonlyMap<number, TextureResource>,
): TriangleDraw {
  if (boundMovieDraws.has(draw)) return draw;
  const movie = resources.get(draw.texture)?.movie;
  let result = draw;
  const extras = [];
  const remap = (texture: number, uv: Float32Array) => {
    const image = resources.get(texture)!.image,
      a = 0x1d1b200 + texture * 0x1b0,
      rx = div(s.view(a + 0x68, 2).getUint16(0, true), image.width),
      ry = div(s.view(a + 0x6a, 2).getUint16(0, true), image.height),
      mapped = uv.slice();
    for (let i = 0; i < mapped.length; i += 2) {
      mapped[i] = mul(mapped[i]!, rx);
      mapped[i + 1] = mul(mapped[i + 1]!, ry);
    }
    return mapped;
  };
  const primaryUV = new Float32Array((draw.vertices.length / 9) * 2);
  for (let i = 0; i < primaryUV.length / 2; i++)
    primaryUV.set(draw.vertices.subarray(i * 9 + 7, i * 9 + 9), i * 2);
  if (movie) {
    const mapped = remap(draw.texture, primaryUV),
      vertices = draw.vertices.slice();
    primaryUV.set(mapped);
    for (let i = 0; i < primaryUV.length / 2; i++)
      vertices.set(primaryUV.subarray(i * 2, i * 2 + 2), i * 9 + 7);
    result = {...draw, vertices};
    if (!draw.fragment && !draw.mask)
      result = {
        ...result,
        fragment: nativeVideoShaders[movie.shader],
        parameters: movie.parameters,
        discardTransparent: false,
      };
    for (const texture of movie.planes.slice(1))
      extras.push({
        texture,
        uv: primaryUV,
        filter: draw.filter,
        wrapS: draw.wrapS,
        wrapT: draw.wrapT,
      });
  }
  for (const extra of draw.additionalTextures ?? []) {
    const m = resources.get(extra.texture)?.movie,
      e = m ? {...extra, uv: remap(extra.texture, extra.uv)} : extra;
    extras.push(e);
    for (const texture of m?.planes.slice(1) ?? []) extras.push({...e, texture});
  }
  if (extras.length) result = {...result, additionalTextures: extras};
  boundMovieDraws.add(result);
  return result;
}
