import {test} from 'node:test';
import assert from 'node:assert/strict';
import {NoahState} from '../dist/engines/mages/games/chaos-head-noah/sc3/noah-state.js';
import {NoahTextures} from '../dist/engines/mages/games/chaos-head-noah/sc3/textures.js';
import {compileNativeRectangles} from '../dist/engines/mages/games/chaos-head-noah/sc3/rectangle-submit.js';
import {drawDirectMovie} from '../dist/engines/mages/games/chaos-head-noah/sc3/movie-draw.js';
import {drawShaderRectangle} from '../dist/engines/mages/games/chaos-head-noah/sc3/shader-draw.js';
import {
  nativeVideoShaders,
  nativeVideoProfiles,
} from '../dist/engines/mages/games/chaos-head-noah/sc3/native-video-shaders.js';
import {allocateFrame} from '../dist/video/frame.js';
const full = {x: 0, y: 0, width: 1920, height: 1080},
  sprite = {
    texture: 1,
    source: {x: 0, y: 0, width: 16, height: 16},
    destination: full,
    color: 0xffffff,
    alpha: 255,
  };
test('submitted draws retain readiness and UV metadata across allocation replacement', () => {
  const s = new NoahState(() => 0),
    t = new NoahTextures(s);
  t.createRgba(1, 16, 16);
  s.put(0x1d1b200 + 0x1b0 + 0x32, 1, 1);
  const first = compileNativeRectangles(s, [sprite], t.resources);
  assert.equal(first.length, 1);
  assert.equal(first[0].vertices[25], 1);
  t.createRgba(1, 32, 32);
  const pending = compileNativeRectangles(s, [...first, sprite], t.resources);
  assert.deepEqual(pending, first);
  s.put(0x1d1b200 + 0x1b0 + 0x32, 1, 1);
  const next = compileNativeRectangles(s, [...first, sprite], t.resources);
  assert.equal(next.length, 2);
  assert.equal(next[0], first[0]);
  assert.equal(next[1].vertices[25], 0.5);
});
test('movies retain allocated plane extents, source pitch and explicit shader bindings', () => {
  for (const dual of [false, true])
    for (const alpha of [false, true])
      for (let profile = 1; profile <= 4; profile++) {
        const s = new NoahState(() => 0),
          textures = new NoahTextures(s),
          frame = allocateFrame(10, 10),
          a = 0x1d2e1c0,
          b = 0x1d8be20;
        frame.y.fill(249);
        frame.cb.fill(245);
        frame.cr.fill(241);
        if (alpha) frame.alpha = new Uint8Array(frame.y.length).fill(177);
        for (let y = 0; y < 10; y++)
          for (let x = 0; x < 10; x++) frame.y[y * frame.stride + x] = y * 10 + x;
        textures.createRgba(180, 12, 12);
        s.put(a + 0x32, 1, 1);
        s.put(a + 0x48, profile);
        s.put(a + 0x72, 10, 2);
        s.put(a + 0x74, dual ? 5 : 10, 2);
        s.put(b + 8, 1, 1);
        s.put(a + 0x34, alpha ? 1 : 0, 1);
        s.put(a + 0x35, dual ? 1 : 0, 1);
        s.view(b + 0xcf0, 8).setBigUint64(0, 0x141d2e1c0n, true);
        const movie = drawDirectMovie({state: s, textures, movies: {frame: () => frame}}, 0, 255),
          draw = compileNativeRectangles(s, [movie], textures.resources)[0],
          image = textures.resources.get(180).image;
        assert.equal(image.width, 12);
        assert.equal(image.height, 12);
        assert.equal(image.pixels[(9 * 12 + 9) * 4], 99);
        assert.equal(image.pixels[10 * 4], 0);
        assert.equal(image.pixels[10 * 12 * 4], 0);
        assert.equal(draw.fragment, nativeVideoShaders[alpha ? 4 : dual ? 1 : 0]);
        assert.deepEqual(draw.parameters, new Float32Array(nativeVideoProfiles[profile - 1]));
        assert.equal(draw.additionalTextures.length, alpha ? 3 : 2);
        assert.equal(draw.vertices[25], Math.fround(10 / 12));
        assert.equal(draw.vertices[17], Math.fround((dual ? 5 : 10) / 12));
        assert.equal(compileNativeRectangles(s, [draw], textures.resources)[0], draw);
        textures.createRgba(205, 12, 12);
        s.put(0x1d1b200 + 205 * 0x1b0 + 0x32, 1, 1);
        const custom = drawShaderRectangle(s, 9, [205, 180], [full, full]),
          bound = compileNativeRectangles(s, [custom], textures.resources)[0];
        assert.equal(bound.fragment, custom.fragment);
        assert.deepEqual(
          [bound.texture, ...bound.additionalTextures.map((t) => t.texture)],
          [205, 180, ...textures.resources.get(180).movie.planes.slice(1)],
        );
      }
});
