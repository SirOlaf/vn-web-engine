import assert from 'node:assert/strict';
import test from 'node:test';
import {adler32} from '../dist/core/inflate.js';
import {KirikiriCore} from '../dist/engines/kirikiri/core/kirikiri-core.js';
import {TvpComplexRect, TvpRect} from '../dist/engines/kirikiri/core/visual/complex-rect.js';
import * as gl from '../dist/engines/kirikiri/core/visual/tvpgl.js';
import {KIRIKIRI_CORE_REVISIONS} from '../dist/engines/kirikiri/revision.js';
import {NativeFunction} from '../dist/engines/kirikiri/tjs2/runtime/native.js';
import * as V from '../dist/engines/kirikiri/tjs2/runtime/variant.js';
import {
  WindowsTopLevelWindow,
  adjustWindowRectEx,
  WS_OVERLAPPEDWINDOW,
} from '../dist/platform/windows-top-level-window.js';
import {buildXp3} from './kirikiri-xp3-fixtures.mjs';

// --- complex rectangles ------------------------------------------------------------------------

/** A seeded generator, so failures reproduce. */
function rng(seed) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}

const SIZE = 48;

function raster(cr) {
  const cells = new Uint8Array(SIZE * SIZE);
  for (const r of cr) {
    for (let y = r.top; y < r.bottom; y++)
      for (let x = r.left; x < r.right; x++) {
        assert.ok(x >= 0 && y >= 0 && x < SIZE && y < SIZE, 'inside the test area');
        cells[y * SIZE + x]++;
      }
  }
  return cells;
}

test('complex rectangles: or/sub/and keep disjoint, sorted rectangles covering the set', () => {
  const random = rng(7);
  const randRect = () => {
    const l = Math.floor(random() * 40),
      t = Math.floor(random() * 40);
    return new TvpRect(l, t, l + 1 + Math.floor(random() * 8), t + 1 + Math.floor(random() * 8));
  };
  for (let round = 0; round < 60; round++) {
    const cr = new TvpComplexRect();
    const expect = new Uint8Array(SIZE * SIZE);
    for (let op = 0; op < 25; op++) {
      const r = randRect();
      const kind = random();
      if (kind < 0.55) cr.or(r);
      else if (kind < 0.9) cr.sub(r);
      else cr.and(r);
      for (let y = 0; y < SIZE; y++)
        for (let x = 0; x < SIZE; x++) {
          const inside = x >= r.left && x < r.right && y >= r.top && y < r.bottom;
          const i = y * SIZE + x;
          if (kind < 0.55) expect[i] = expect[i] || +inside;
          else if (kind < 0.9) expect[i] = expect[i] && +!inside;
          else expect[i] = expect[i] && +inside;
        }
      const got = raster(cr);
      assert.deepEqual(got, expect, `round ${round} op ${op}`);
      const rects = cr.rects();
      for (let i = 1; i < rects.length; i++)
        assert.ok(!rects[i].lessThan(rects[i - 1]), 'sorted by top, then left');
      if (cr.count) {
        const b = new TvpRect(SIZE, SIZE, 0, 0);
        for (const q of rects) {
          b.left = Math.min(b.left, q.left);
          b.top = Math.min(b.top, q.top);
          b.right = Math.max(b.right, q.right);
          b.bottom = Math.max(b.bottom, q.bottom);
        }
        assert.ok(cr.bound.equals(b), 'bound');
      }
    }
  }
});

test('complex rectangles: adjacent rectangles of one band unite on insertion', () => {
  const cr = new TvpComplexRect();
  cr.or(new TvpRect(0, 0, 10, 10));
  cr.or(new TvpRect(10, 0, 20, 10));
  assert.deepEqual(
    cr.rects().map((r) => [r.left, r.top, r.right, r.bottom]),
    [[0, 0, 20, 10]],
  );
  cr.sub(new TvpRect(5, 2, 8, 4));
  assert.deepEqual(
    cr.rects().map((r) => [r.left, r.top, r.right, r.bottom]),
    [
      [0, 0, 20, 2],
      [0, 2, 5, 4],
      [8, 2, 20, 4],
      [0, 4, 20, 10],
    ],
  );
});

// --- kernels -----------------------------------------------------------------------------------

test('tvpgl: tables and the reference build kernels at their fixed points', () => {
  const {opacityOnOpacity, negativeMul, div} = gl.tvpglTables();
  for (let d = 0; d < 256; d++) {
    assert.equal(opacityOnOpacity[255 * 256 + d], 255, 'an opaque source covers');
    assert.equal(negativeMul[255 * 256 + d], 255);
    assert.equal(negativeMul[d], d, 'a transparent source keeps the destination alpha');
  }
  assert.equal(div[(255 << 8) + 77], 77);
  const m = new Uint32Array(8);
  // The MMX alpha blend copies an opaque single pixel, and blends all four bytes otherwise.
  m.set([0x80123456, 0xff00ff00, 0x00000000, 0x800000ff]);
  gl.TVPAlphaBlend(m, 0, 1, 1, 255);
  assert.equal(m[0], 0xff00ff00);
  gl.TVPAlphaBlend(m, 2, 3, 1, 255);
  assert.equal(m[2], 0x4000007f, 'alpha blended as a colour channel');
  // The C blend of the HDA variants keeps the destination alpha.
  m.set([0x80123456, 0x00ffffff]);
  gl.TVPAlphaBlend_HDA_o(m, 0, 1, 1, 255);
  assert.equal(m[0], 0x80123456, 'transparent source');
  // The premultiplied constant fill at full opacity leaves alpha 0 (o + (o >> 7) = 256).
  m[0] = 0xff445566;
  gl.constColorAlphaBlendA(m, 0, 1, 0x112233, 255);
  assert.equal(m[0], 0x00112233);
  m[2] = 0x80808080;
  gl.convertAlphaToAddAlpha(m, 2, 1);
  assert.equal(m[2], 0x80404040);
});

// --- windows -----------------------------------------------------------------------------------

test('Win32 window frames: client size, minimum tracking size', () => {
  const r = adjustWindowRectEx(
    {left: 0, top: 0, right: 640, bottom: 480},
    WS_OVERLAPPEDWINDOW,
    false,
    0,
  );
  assert.deepEqual(r, {left: -4, top: -27, right: 644, bottom: 484});
  const w = new WindowsTopLevelWindow('t', 10, 10, WS_OVERLAPPEDWINDOW, 0);
  assert.deepEqual(w.windowRect, {left: 0, top: 0, right: 136, bottom: 41}, 'clamped to 136 wide');
  w.setClientSize(800, 600);
  assert.deepEqual(w.clientRect, {left: 0, top: 0, right: 800, bottom: 600});
});

// --- the core ----------------------------------------------------------------------------------

class MemoryFiles {
  constructor(entries) {
    this.files = new Map(Object.entries(entries).map(([k, v]) => [k.toLowerCase(), v]));
  }
  exists(local) {
    return this.files.has(local.toLowerCase());
  }
  list(dir) {
    const d = dir.toLowerCase();
    return [...this.files.keys()]
      .filter((k) => k.startsWith(d) && !k.slice(d.length).includes('\\'))
      .map((k) => k.slice(d.length));
  }
  async open(local) {
    const bytes = this.files.get(local.toLowerCase());
    return {size: bytes.length, read: async (o, n) => bytes.slice(o, o + n)};
  }
}

class ManualLoop {
  posts = [];
  timers = new Set();
  now = 0;
  post(task) {
    this.posts.push(task);
  }
  idle() {}
  every(interval, tick) {
    const t = {due: this.now + interval, interval, tick};
    this.timers.add(t);
    return () => this.timers.delete(t);
  }
  after(delay, task) {
    const t = {due: this.now + delay, interval: 0, tick: task};
    this.timers.add(t);
    return () => this.timers.delete(t);
  }
  async flush(core) {
    for (let i = 0; i < 100; i++) {
      await core.events.runTopLevel(() => 0);
      const tasks = this.posts.splice(0);
      if (!tasks.length) return;
      for (const t of tasks) t();
    }
  }
}

/** A window host whose client areas present into in-memory textures. */
function memoryWindowHost() {
  const surfaces = [];
  return {
    surfaces,
    createWindow: (caption, w, h, style, exStyle) =>
      new WindowsTopLevelWindow(caption, w, h, style, exStyle),
    surfaceOf: () => {
      const s = {
        texture: null,
        width: 0,
        presents: 0,
        resizeTexture(w, h) {
          this.width = w;
          this.texture = new Uint8Array(w * h * 4);
          return this.texture;
        },
        present() {
          this.presents++;
        },
        pixel(x, y) {
          const i = (y * this.width + x) * 4;
          const t = this.texture;
          return ((t[i + 3] << 24) | (t[i + 2] << 16) | (t[i + 1] << 8) | t[i]) >>> 0;
        },
      };
      surfaces.push(s);
      return s;
    },
    cursorPos: () => ({x: 0, y: 0}),
  };
}

async function boot(startup) {
  const plain = new TextEncoder().encode('\ufeff' + startup);
  const data = buildXp3([
    {name: 'startup.tjs', adler: adler32(plain), segments: [{bytes: plain, compress: true}]},
  ]);
  const loop = new ManualLoop();
  const lines = [];
  const boxes = [];
  const host = memoryWindowHost();
  const core = await KirikiriCore.create({
    revision: [...KIRIKIRI_CORE_REVISIONS.values()][0],
    executablePath: 'c:\\game\\game.exe',
    uiLanguage: 0x0409,
    files: new MemoryFiles({'c:\\game\\game.exe': new Uint8Array(0), 'c:\\game\\data.xp3': data}),
    libraries: [],
    clock: {
      tickCount: () => loop.now,
      time: () => 0,
      localTime: () => ({hours: 1, minutes: 2, seconds: 3}),
    },
    loop,
    output: (line) => lines.push(line.slice(9)),
    showError: async (text) => void boxes.push(`error: ${text}`),
    windowHost: host,
    bitmapMemory: 64 * 1024 * 1024,
  });
  const logs = [];
  core.engine.global.propSet(
    0x200,
    'log',
    {
      type: 1,
      object: new NativeFunction(
        (_r, args) => (logs.push(args.map((a) => V.asString(a)).join(' ')), 0),
      ),
      objthis: null,
    },
    core.engine.global,
  );
  await core.start();
  await loop.flush(core);
  return {core, loop, logs, lines, boxes, host};
}

test('Window and Layer: tree, geometry and composition onto the draw device', async () => {
  const {core, loop, logs, boxes, host} = await boot(`
    var w = new Window();
    w.setInnerSize(64, 48);
    var p = new Layer(w, null);
    p.setSize(64, 48);
    p.fillRect(0, 0, 64, 48, 0xff102030);
    var c = new Layer(w, p);
    c.setPos(8, 4, 16, 8);
    c.fillRect(0, 0, 16, 8, 0xffff0000);
    c.visible = true;
    var d = new Layer(w, p);
    d.name = 'd';
    d.setPos(40, 20, 10, 10);
    d.fillRect(0, 0, 10, 10, 0xff0000ff);
    d.opacity = 128;
    d.visible = true;
    w.visible = true;
    global.w = w; global.p = p; global.c = c; global.d = d;
    log('primary', p.isPrimary, w.primaryLayer === p, p.window === w, p.type, p.width, p.height);
    log('children', p.children.count, p.children[0] === c, c.order, d.order);
    d.bringToBack();
    log('reorder', d.order, c.order, p.children[0] === d);
    log('inner', w.innerWidth, w.innerHeight, w.width, w.height, w.borderStyle);
    log('image', c.imageWidth, c.imageHeight, c.mainImageBufferPitch, c.mainImageBuffer > 0);
    try { c.imageLeft = 1; } catch(e) { log('imageLeft', e.message); }
    try { p.left = 3; } catch(e) { log('primary move', e.message); }
    log('pixel', '%08x'.sprintf(c.getMainPixel(1, 1)), c.getMaskPixel(1, 1));
    log('hit', p.getLayerAt(9, 5) === c, p.getLayerAt(1, 1) === p);
  `);
  assert.deepEqual(boxes, []);
  await loop.flush(core);
  assert.deepEqual(logs, [
    'primary 1 1 1 1 64 48',
    'children 2 1 0 1',
    'reorder 0 1 1',
    'inner 128 48 136 79 2',
    // Shrinking a layer keeps its (default 32×32) image; the pitch is negative (bottom-up).
    'image 32 32 -128 1',
    'imageLeft Invalid Image position',
    'primary move Cannot move primary layer',
    'pixel 00ff0000 255',
    'hit 1 1',
  ]);
  const s = host.surfaces[0];
  assert.ok(s && s.texture, 'the window presented a texture');
  assert.ok(s.presents > 0);
  assert.equal(s.pixel(0, 0), 0xff102030, 'primary colour');
  assert.equal(s.pixel(9, 5), 0xffff0000, 'child on top');
  // d (now behind c, still over the primary) is blended at opacity 128 by TVPAlphaBlend_o:
  // in pairs a = 255·128 >> 8 = 127 and each byte is d + ((s − d)·127 mod 65536) / 256, wrapping.
  assert.equal(s.pixel(45, 25), 0xff081096, 'constant opacity over the primary');
});

test('Rect, Bitmap and Font objects', async () => {
  const {logs, boxes} = await boot(`
    var r = new Rect(1, 2, 11, 22);
    log('rect', r.width, r.height, r.isEmpty(), r.includedPos(1, 2), r.includedPos(11, 2));
    var q = new Rect(5, 5, 30, 30);
    log('clip', r.clip(q), r.left, r.top, r.right, r.bottom);
    log('array', r.nativeArray > 0);
    var b = new Bitmap(4, 3);
    b.setPixel(1, 1, 0x123456);
    b.setMaskPixel(1, 1, 0x80);
    log('bitmap', b.width, b.height, '%06x'.sprintf(b.getPixel(1, 1)), b.getMaskPixel(1, 1), b.bufferPitch);
    var f = new Font();
    f.height = -20; f.bold = true; f.angle = -10;
    log('font', f.height, f.bold, f.angle);
  `);
  assert.deepEqual(boxes, []);
  assert.deepEqual(logs, [
    'rect 10 20 0 1 0',
    'clip 1 5 5 11 22',
    'array 1',
    'bitmap 4 3 123456 128 -16',
    'font 20 1 3590',
  ]);
});
