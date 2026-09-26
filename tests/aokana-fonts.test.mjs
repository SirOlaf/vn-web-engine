import assert from 'node:assert/strict';
import test from 'node:test';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';
import {BurikoNativeFonts} from '../dist/engines/buriko/native/fonts.js';
import {BurikoFontResources} from '../dist/engines/buriko/native/font-resources.js';
import {BurikoBrowserFonts} from '../dist/engines/buriko/native/font-browser.js';
import {createGroupB0Fonts} from '../dist/engines/buriko/native/group-b0-fonts.js';
import {BurikoBpThread, pop32, push32} from '../dist/engines/buriko/bp/state.js';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BURIKO_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/native/inventory.js';
import {
  BurikoFontRaster,
  BurikoFontRasterSettings,
  burikoFontGeometry,
  burikoGlyphText,
} from '../dist/engines/buriko/native/font-raster.js';
import {BurikoSelectionDialog} from '../dist/engines/buriko/native/selection-dialog.js';
import {BurikoEngineDialogs} from '../dist/engines/buriko/native/engine-dialogs.js';
import {
  burikoCrtWideLower,
  burikoCrtWidePrefixEqual,
} from '../dist/engines/buriko/native/crt-case.js';

const bytes = (value) => new TextEncoder().encode(value + '\0');
const pointer = (value) => ({bytes: bytes(value), offset: 0});
const mainProcessing = () => ({
  allocator: {
    currentActor: 0,
    withActor(_actor, operation) {
      return operation();
    },
  },
});

test('reachable native CRT case handling folds only ASCII UTF-16 units', () => {
  assert.equal(burikoCrtWideLower('FONTÄİΣＡ\ud800'), 'fontÄİΣＡ\ud800');
  assert.equal(burikoCrtWidePrefixEqual('ms GOTHIC Extra', 'MS Gothic'), true);
  assert.equal(burikoCrtWidePrefixEqual('Äfont', 'ä'), false);
  assert.equal(burikoCrtWidePrefixEqual('MS Goth', 'MS Gothic'), false);
});

test('font pitch callback keeps character-set precedence, family names and ASCII-only case folding', async () => {
  const browser = new BurikoBrowserFonts();
  const face = (family, bit, fixedPitch) => ({
    family,
    fullName: family + ' Bold',
    names: [family],
    data: {fixedPitch, codePageRanges: [1 << bit, 0], names: []},
  });
  browser.installed = Promise.resolve([
    face('Shared', 0, true),
    face('Shared', 20, false),
    face('ÄName', 17, true),
  ]);
  assert.equal(await browser.queryPitch('SHARED'), 2);
  assert.equal(await browser.queryPitch('ÄNAME'), 1);
  assert.equal(await browser.queryPitch('äName'), null);
  assert.equal(await browser.queryPitch('Shared Bold'), null);
  assert.equal(await browser.queryPitch('Absent'), null);
  await assert.rejects(browser.queryPitch('x'.repeat(32)), /LOGFONT/);
});

test('font B0 bindings preserve NULL enumeration queries, outputs and cached archive pointer laziness', async () => {
  const calls = [],
    browser = {
      async loadResource() {
        return 1;
      },
      unloadResource() {},
      async enumerate(charset) {
        calls.push(charset);
        return [];
      },
      async queryPitch(name) {
        return name === 'Found' ? 2 : null;
      },
    };
  const text = new BurikoNativeText(),
    fonts = new BurikoNativeFonts(text, browser);
  const resources = new BurikoFontResources(fonts, {
    mainProcessing: mainProcessing(),
    configuration: {nativeFileRoot: ''},
    files: {
      async openWide() {
        return {
          source: {
            size: 1,
            async read() {
              return Uint8Array.of(1);
            },
          },
        };
      },
    },
  });
  const definitions = createGroupB0Fonts(resources, {value: 0x409});
  assert.equal(definitions.length, 10);
  for (const slot of definitions)
    assert.equal(slot.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[0xb0][slot.secondary]);
  const slots = new Map(definitions.map((slot) => [slot.secondary, slot]));
  const thread = new BurikoBpThread({
    id: 1,
    operandCapacity: 32,
    moduleCapacity: 128,
    frameCapacity: 128,
  });
  const memory = new BurikoBpMemory(new Uint8Array(512)),
    h = {thread, memory};
  const run = async (id, values) => {
    for (const value of values) push32(thread, value);
    assert.equal(await slots.get(id).execute(h), 0);
    return pop32(thread);
  };
  const source = (offset, value) => memory.globalMemory.set(bytes(value), offset);
  const view = new DataView(memory.globalMemory.buffer);
  assert.equal(await run(0xc4, [0]), 20);
  assert.equal(await run(0xc4, [128]), 2);
  assert.equal(text.decodeAuto({bytes: memory.globalMemory, offset: 128}), 'MS Gothic');
  assert.equal(text.decodeAuto({bytes: memory.globalMemory, offset: 138}), 'MS Mincho');
  assert.equal(await run(0xc5, [0, 384]), 0);
  source(1, 'Missing');
  view.setUint32(64, 0xdeadbeef, true);
  assert.equal(await run(0xc6, [64, 1]), 0);
  assert.equal(view.getUint32(64, true), 0xdeadbeef);
  source(1, 'Found');
  assert.equal(await run(0xc6, [64, 1]), 1);
  assert.equal(view.getUint32(64, true), 2);
  source(1, 'cache.ttf');
  assert.equal(await run(0xc2, [1]), 1);
  // Address 0x10000 resolves but cannot be read. A cache hit must never scan it.
  assert.equal(await run(0xc3, [0x10000, 1]), 1);
  source(1, 'next.ttf');
  await assert.rejects(run(0xc3, [0x10000, 1]), /outside backing/);
});

test('font file cache excludes archive identity and preserves wide-root path identity', async () => {
  const calls = [];
  const browser = {
    async loadResource(input, enumerable) {
      calls.push(['add', [...input], enumerable]);
      return calls.length;
    },
    unloadResource(token) {
      calls.push(['remove', token]);
    },
  };
  const fonts = new BurikoNativeFonts(new BurikoNativeText(), browser);
  const native = {
    mainProcessing: mainProcessing(),
    configuration: {nativeFileRoot: 'root\ud800/'},
    files: {
      async openWide(path) {
        calls.push(['open', path]);
        return {
          source: {
            size: 2,
            async read() {
              return Uint8Array.of(4, 5);
            },
          },
          error: 0,
        };
      },
    },
    async size() {
      calls.push(['size']);
      return 2;
    },
    async load() {
      calls.push(['load']);
      return {result: 2, bytes: Uint8Array.of(6, 7)};
    },
  };
  const resources = new BurikoFontResources(fonts, native);
  assert.equal(await resources.load(null, bytes('AbC.ttf')), 0);
  assert.equal(await resources.load(bytes('other.arc'), bytes('ABC.TTF')), 0);
  assert.deepEqual(calls, [
    ['open', 'root\ud800/abc.ttf'],
    ['add', [4, 5], true],
  ]);
  assert.equal(await resources.load(bytes('other.arc'), bytes('Next.ttf')), 0);
  assert.deepEqual(calls.slice(2), [['size'], ['load'], ['add', [6, 7], false]]);
  fonts.registerName(bytes('Example'), 0);
  resources.clear();
  assert.equal(fonts.registeredNames.length, 0);
  assert.deepEqual(calls.slice(-2), [
    ['remove', 2],
    ['remove', 5],
  ]);
});

test('font resource status distinguishes absent, changed, and invalid native resources', async () => {
  const fonts = new BurikoNativeFonts(new BurikoNativeText(), {
    async loadResource() {
      return null;
    },
  });
  let measured = 0,
    count = 2;
  const native = {
    mainProcessing: mainProcessing(),
    configuration: {nativeFileRoot: ''},
    files: {
      async openWide() {
        return {source: null, error: 2};
      },
    },
    async size() {
      return measured;
    },
    async load() {
      return {result: count, bytes: Uint8Array.of(1, 2)};
    },
  };
  const resources = new BurikoFontResources(fonts, native);
  assert.equal(await resources.load(null, bytes('font')), 0x8000001a);
  assert.equal(await resources.load(bytes('arc'), bytes('font')), 0x80000019);
  measured = 3;
  assert.equal(await resources.load(bytes('arc'), bytes('font')), 0x8000001b);
  measured = count;
  assert.equal(await resources.load(bytes('arc'), bytes('font')), 0x8000001a);
});

test('enumeration uses prefix matching and appends raw defaults only for exact charset 128', async () => {
  const text = new BurikoNativeText();
  const faces = ['ms gothic Extra'];
  const fonts = new BurikoNativeFonts(text, {
    async enumerate() {
      return faces;
    },
  });
  const resources = new BurikoFontResources(fonts, {});
  const result = await resources.enumerate(128, false);
  assert.deepEqual(
    result.names.map((value) => text.decodeAuto({bytes: value, offset: 0})),
    ['ms gothic Extra', 'MS Mincho'],
  );
  assert.equal(
    result.byteCount,
    result.names.reduce((sum, value) => sum + value.length, 0),
  );
  assert.equal((await resources.enumerate(384, false)).names.length, 1);
  faces.length = 0;
  text.selectMode(1);
  const japanese = await resources.enumerate(128, true);
  assert.equal(japanese.names[0][0], 0x82);
  assert.deepEqual(
    japanese.names.map((value) => text.decodeAuto({bytes: value, offset: 0})),
    ['ＭＳ ゴシック', 'ＭＳ 明朝'],
  );
});

test('font geometry preserves automatic-fit, independent sample settings, and UTF-16 substitutions', () => {
  const settings = new BurikoFontRasterSettings();
  const native = burikoFontGeometry(20, 100, null, settings);
  assert.deepEqual(
    [
      native.width,
      native.height,
      native.dibWidth,
      native.dibHeight,
      native.fontHeight,
      native.fontWidth,
    ],
    [40, 30, 160, 120, 80, 40],
  );
  const auto = burikoFontGeometry(20, 100, [0, 0, 0, 0, 0], settings);
  assert.deepEqual([auto.dibHeight, auto.fontHeight, auto.fontWidth], [240, -80, 0]);
  settings.useOutline();
  assert.deepEqual([settings.quality, settings.sampleScale, settings.sampleShift], [1, 1, 0]);
  assert.equal(settings.setQuality(-5), true);
  assert.equal(settings.setQuality(4), false);
  assert.equal(burikoGlyphText(0x7f).text, '\x7f');
  assert.equal(burikoGlyphText(0xef40).text, '——');
  assert.equal(burikoGlyphText(0xd800).text, null);
});

test('cache eviction reuses native coverage storage and keeps glyph descriptors separate', () => {
  const settings = new BurikoFontRasterSettings();
  settings.setQuality(-1);
  const geometry = burikoFontGeometry(4, 100, null, settings);
  const face = {
    ascent: 4,
    abc() {
      return [0, 2, 0];
    },
    extent() {
      return 2;
    },
    rasterText(text, width, height) {
      return {stride: width, bytes: new Uint8Array(width * height).fill(text.charCodeAt(0))};
    },
  };
  const raster = new BurikoFontRaster(geometry, face, settings, 2);
  const a = raster.glyph(65),
    b = raster.glyph(66);
  assert.equal(raster.glyph(65), a);
  const c = raster.glyph(67);
  assert.equal(c.pixels, b.pixels);
  assert.equal(b.character, 66);
  assert.equal(b.pixels[0], 67);
  assert.notEqual(a.pixels, c.pixels);
});

test('list selection omits empty lines, retains CR, and leaves cancellation output untouched', async () => {
  const text = new BurikoNativeText();
  const requests = [];
  let accepted = false;
  const dialogs = {
    async withNativeModal(operation) {
      return operation();
    },
    async chooseList(title, prompt, faces) {
      requests.push({title, prompt, faces});
      return {accepted, index: 1};
    },
  };
  const selection = new BurikoSelectionDialog(dialogs, text);
  const output = {bytes: new Uint8Array(30).fill(0xa5), offset: 2};
  assert.equal(await selection.select(output, null, null, pointer('\nFirst\r\n\nSecond\n')), 0);
  assert.equal(output.bytes[2], 0xa5);
  assert.deepEqual(requests[0].faces, ['First\r', 'Second']);
  accepted = true;
  assert.equal(
    await selection.select(output, pointer('Title'), pointer('Prompt'), pointer('First\nSecond')),
    1,
  );
  assert.equal(text.decodeAuto(output), 'Second');
  assert.equal(output.bytes[1], 0xa5);
  accepted = false;
  assert.equal(await selection.select(null, null, null, pointer('')), 0);
});

test('native modal restoration occurs after operation, in cursor/input/clock/display order', async () => {
  const events = [];
  const dialogs = new BurikoEngineDialogs(
    {},
    new BurikoNativeText(),
    {
      beginSuspension(value) {
        events.push(['clock+', value]);
      },
      endSuspension() {
        events.push(['clock-']);
      },
    },
    {
      clearTransientKeys() {
        events.push(['input']);
      },
    },
    {
      setVisible(value) {
        events.push(['cursor', value]);
        return 0;
      },
    },
    {
      isPresent() {
        return true;
      },
      refresh() {
        events.push(['display']);
      },
    },
    {fullscreen: 1, displayFlag: 0, modalDepth: 0},
    null,
    bytes('Title'),
  );
  assert.equal(
    await dialogs.withNativeModal(async () => {
      events.push(['operation']);
      return 42;
    }),
    42,
  );
  assert.deepEqual(events, [
    ['display'],
    ['clock+', true],
    ['cursor', 1],
    ['operation'],
    ['cursor', 0],
    ['input'],
    ['clock-'],
    ['display'],
  ]);
});

test('native fallback rechecks aliases recursively and clears the transform on recursive attempts', async () => {
  const selected = [];
  const browser = {
    async queryCharset() {
      return 1;
    },
    async create(parameters) {
      selected.push(parameters);
      return {
        faceName: parameters.face === 'C' ? 'C' : 'Host fallback',
        familyName: 'Host family',
        averageWidth: 20,
        ascent: 20,
      };
    },
  };
  const fonts = new BurikoNativeFonts(new BurikoNativeText(), browser);
  fonts.setAlias(bytes('A'), bytes('Expected A'));
  fonts.setFallback(bytes('A'), bytes('B'));
  fonts.setAlias(bytes('B'), bytes('Expected B'));
  fonts.setFallback(bytes('B'), bytes('C'));
  await fonts.setTransform(bytes('A'), [131072, 131072, 0, 0, 0]);
  assert.deepEqual(await fonts.get(bytes('A'), 20, 100, 0), {result: 0, id: 1});
  assert.deepEqual(
    selected.map((value) => [value.face, value.height]),
    [
      ['A', 160],
      ['B', 80],
      ['C', 80],
    ],
  );
  assert.equal(fonts.find(1).averageWidthThreshold, 3);
  fonts.setFallback(bytes('B'), bytes('A'));
  fonts.resetManager();
  await assert.rejects(fonts.get(bytes('A'), 20, 100, 0), /recurses indefinitely/);
});

test('null font names follow native empty-table validation and populated-table strcmp faults', async () => {
  const fonts = new BurikoNativeFonts(new BurikoNativeText(), {});
  assert.deepEqual(await fonts.get(null, 20, 100, 0), {result: 0x80000004, id: 0});
  fonts.setCacheCapacity(null, 0, 0, 0, 1);
  assert.deepEqual(await fonts.get(null, 20, 100, 0), {result: 0x80000001, id: 0});
  fonts.setCacheCapacity(bytes('Other'), 20, 100, 0, 4);
  await assert.rejects(fonts.get(null, 20, 100, 0), /compares a null/);
});
