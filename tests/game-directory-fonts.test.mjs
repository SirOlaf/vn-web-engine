import assert from 'node:assert/strict';
import test from 'node:test';
import {BlobSource} from '../dist/core/source.js';
import {SourceFileSystem} from '../dist/platform/filesystem.js';
import {findGameDirectoryFonts} from '../dist/text/game-directory-fonts.js';
import {BurikoBrowserFonts} from '../dist/engines/buriko/native/font-browser.js';
import {noahTextClasses} from '../dist/engines/mages/games/chaos-head-noah/sc3/dom-text-data.js';
import {
  defaultDomTextStyle,
  domTextFamily,
  normalizeDomTextStyle,
} from '../dist/text/dom-text-style.js';

const tag = (value) =>
  [...value].reduce((number, character) => number * 256 + character.charCodeAt(0), 0);

function namingTable(family) {
  const values = [family, `${family} Regular`, `${family.replaceAll(' ', '')}-Regular`, 'en'];
  const bytes = new Uint8Array(48 + values.reduce((sum, value) => sum + value.length * 2, 0));
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 1);
  view.setUint16(2, 3);
  view.setUint16(4, 48);
  view.setUint16(42, 1);
  let offset = 0;
  values.forEach((value, index) => {
    if (index < 3) {
      const record = 6 + index * 12;
      view.setUint16(record, 3);
      view.setUint16(record + 2, 1);
      view.setUint16(record + 4, 0x409);
      view.setUint16(record + 6, [1, 4, 6][index]);
      view.setUint16(record + 8, value.length * 2);
      view.setUint16(record + 10, offset);
    } else {
      view.setUint16(44, value.length * 2);
      view.setUint16(46, offset);
    }
    for (let index = 0; index < value.length; index++)
      view.setUint16(48 + offset + index * 2, value.charCodeAt(index));
    offset += value.length * 2;
  });
  return bytes;
}

/** A sparse font whose glyph table may be much larger than the allocated fixture. */
function fixture({collection = false, glyphLength = 16} = {}) {
  const bytes = new Uint8Array(4096);
  const view = new DataView(bytes.buffer);
  const names = [namingTable('Synthetic Font'), namingTable('Second Font')];
  view.setUint32(512, 0x00010000);
  view.setUint32(524, 0x5f0f3cf5);
  view.setUint16(530, 2048);
  view.setInt16(550, -300);
  view.setInt16(554, 1500);
  view.setUint32(576, 0x00010000);
  view.setUint16(640, 1);
  view.setInt16(642, 800);
  view.setUint16(644, 700);
  view.setUint16(702, 1);
  view.setUint16(714, 1900);
  view.setUint16(716, 500);
  view.setUint32(718, 1 << 17);
  view.setUint32(722, 1 << 5);
  view.setUint32(1036, 1);
  bytes.set(names[0], 768);
  bytes.set(names[1], 1280);
  const directories = collection ? [64, 192] : [0];
  if (collection) {
    view.setUint32(0, tag('ttcf'));
    view.setUint32(4, 0x00020000);
    view.setUint32(8, directories.length);
    directories.forEach((offset, index) => view.setUint32(12 + index * 4, offset));
  }
  directories.forEach((directory, index) => {
    view.setUint32(directory, index ? tag('OTTO') : 0x00010000);
    view.setUint16(directory + 4, 6);
    const tables = [
      ['head', 512, 54],
      ['hhea', 576, 36],
      ['OS/2', 640, 96],
      ['name', index ? 1280 : 768, names[index].length],
      ['post', 1024, 32],
      [index ? 'CFF ' : 'glyf', 4096, glyphLength],
    ];
    tables.forEach(([name, offset, length], index) => {
      const record = directory + 12 + index * 16;
      view.setUint32(record, tag(name));
      view.setUint32(record + 8, offset);
      view.setUint32(record + 12, length);
    });
  });
  const reads = [];
  return {
    bytes,
    view,
    directories,
    reads,
    size: bytes.length + glyphLength,
    async read(offset, length) {
      assert.ok(offset >= 0 && offset + length <= bytes.length, 'must not read glyph tables');
      reads.push([offset, length]);
      return bytes.subarray(offset, offset + length);
    },
  };
}

function materialize(source) {
  const bytes = new Uint8Array(source.size);
  bytes.set(source.bytes);
  return bytes;
}

function installation(files) {
  const fs = new SourceFileSystem();
  for (const [path, bytes] of Object.entries(files))
    fs.attach(path, new BlobSource(new Blob([bytes])));
  return fs;
}

test('game directory scan finds sfnt files and collections, skipping other and invalid files', async () => {
  const fs = installation({
    '/font.ttf': materialize(fixture()),
    '/data/fonts/Pair.TTC': materialize(fixture({collection: true})),
    '/data/broken.otf': new Uint8Array(12),
    '/data01.arc': new Uint8Array(64),
    '/a/b/c/d/deep.ttf': materialize(fixture()),
  });
  const fonts = await findGameDirectoryFonts(fs);
  assert.deepEqual(
    fonts.map(({path, faces}) => [path, faces.length]),
    [
      ['/data/fonts/Pair.TTC', 2],
      ['/font.ttf', 1],
    ],
  );
  assert.equal((await findGameDirectoryFonts(fs, '/', 4)).length, 3);
  assert.deepEqual(await findGameDirectoryFonts(fs, '/missing'), []);
});

test('game directory faces act as installed families before host fonts', async () => {
  const fs = installation({'/fonts/pair.ttc': materialize(fixture({collection: true}))});
  let scans = 0;
  const browser = new BurikoBrowserFonts({
    directoryFonts: () => {
      scans++;
      return findGameDirectoryFonts(fs);
    },
  });
  // A host font of the same name without the Japanese code page loses to the game's face.
  browser.installed = Promise.resolve([
    {
      family: 'Synthetic Font',
      fullName: 'Synthetic Font',
      names: ['Synthetic Font'],
      data: {fixedPitch: false, codePageRanges: [1, 0], names: []},
    },
  ]);
  assert.equal(await browser.queryCharset('synthetic font'), 128);
  assert.equal(await browser.queryCharset('Second Font'), 128);
  assert.equal(await browser.queryPitch('Second Font'), 1);
  assert.deepEqual(await browser.enumerate(128, false), ['Synthetic Font', 'Second Font']);
  const inspected = await browser.inspect('SecondFont-Regular');
  assert.equal(inspected?.family, 'Second Font');
  assert.equal(scans, 1);
});

test('a failed game directory scan leaves host fonts available', async () => {
  const browser = new BurikoBrowserFonts({
    directoryFonts: () => Promise.reject(new Error('unreadable')),
  });
  browser.installed = Promise.resolve([]);
  assert.equal(await browser.queryCharset('Anything'), 1);
  assert.deepEqual(await browser.enumerate(1, false), []);
});

test('DOM text styles are bounded and keep the game family as a fallback', () => {
  assert.deepEqual(normalizeDomTextStyle(null), defaultDomTextStyle);
  assert.deepEqual(
    normalizeDomTextStyle({
      enabled: true,
      family: '  Noto Sans JP ',
      scale: 9,
      weight: 650.4,
      color: 0x1ff8800,
      effects: 'no',
      layout: 'wrap',
      css: 'letter-spacing: 1px',
    }),
    {
      enabled: true,
      family: 'Noto Sans JP',
      scale: 3,
      weight: 650,
      effects: true,
      layout: 'fit',
      css: 'letter-spacing: 1px',
    },
  );
  const custom = normalizeDomTextStyle({enabled: true, family: '"Noto Sans JP", sans-serif'});
  assert.equal(
    domTextFamily(custom, 'BurikoResourceFont1'),
    '"Noto Sans JP", sans-serif, BurikoResourceFont1, serif',
  );
  assert.equal(domTextFamily(normalizeDomTextStyle({enabled: true}), 'Game'), 'Game');
  assert.equal(domTextFamily(normalizeDomTextStyle({enabled: true}), undefined), 'serif');
});

test('NOAH slot ids give role and source classes without instance numbers', () => {
  assert.deepEqual(noahTextClasses('main/scene-2/name'), [
    'game-text-name',
    'game-text-source-scene',
  ]);
  assert.deepEqual(noahTextClasses('main/backlog-17/ruby-3'), [
    'game-text-ruby',
    'game-text-source-backlog',
  ]);
  assert.deepEqual(noahTextClasses('menu/tips-description/4/body'), [
    'game-text-body',
    'game-text-source-tips-description',
  ]);
});
