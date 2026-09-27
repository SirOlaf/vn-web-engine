import assert from 'node:assert/strict';
import test from 'node:test';
import {readSfntFontData, readSfntFontMetadata} from '../dist/formats/sfnt.js';
import {readBurikoFontData} from '../dist/engines/buriko/native/font-data.js';
import {readBrowserLocalFontMetadata} from '../dist/text/browser-local-fonts.js';
import {setRuntimeProfile} from '../dist/platform/runtime-profile.js';

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

function withoutBytes(data) {
  return data.map(({bytes, ...metadata}) => metadata);
}

test('metadata enumeration skips multi-gigabyte glyph data and retains only owned names', async () => {
  const source = fixture({glyphLength: 2 ** 31});
  const read = source.read.bind(source);
  source.read = async (offset, length) => {
    const bytes = await read(offset, length);
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  };
  const metadata = await readSfntFontMetadata(source);
  const complete = materialize(fixture());
  assert.deepEqual(metadata, withoutBytes(readSfntFontData(complete)));
  assert.deepEqual(readBurikoFontData(complete), readSfntFontData(complete));
  assert.equal(metadata[0].names[0].unicode, 'Synthetic Font');
  assert.deepEqual(
    [metadata[0].winAscent, metadata[0].winDescent, metadata[0].weight, metadata[0].italic],
    [1900, 500, 700, true],
  );
  assert.ok(source.reads.reduce((sum, [, length]) => sum + length, 0) < 512);
  for (const name of metadata[0].names) {
    assert.equal(name.bytes.buffer.byteLength, name.bytes.byteLength);
    assert.notEqual(name.bytes.buffer, source.bytes.buffer);
  }
  const retainedName = metadata[0].names[0].bytes.slice();
  source.bytes.fill(0);
  assert.deepEqual(metadata[0].names[0].bytes, retainedName);
});

test('TTC/OTC metadata uses shared file-relative tables and matches reconstructed faces', async () => {
  const source = fixture({collection: true});
  const metadata = await readSfntFontMetadata(source);
  const complete = readSfntFontData(materialize(source));
  assert.deepEqual(metadata, withoutBytes(complete));
  assert.deepEqual(
    metadata.map((face) => face.names[0].unicode),
    ['Synthetic Font', 'Second Font'],
  );
  for (let index = 0; index < complete.length; index++)
    assert.deepEqual(withoutBytes(readSfntFontData(complete[index].bytes)), [metadata[index]]);
});

test('metadata validates skipped table boundaries, duplicates, and collection directories', async () => {
  const outside = fixture();
  outside.view.setUint32(12 + 5 * 16 + 12, 17);
  await assert.rejects(readSfntFontMetadata(outside), /exceeds supplied resource/);
  const duplicate = fixture();
  duplicate.view.setUint32(12 + 5 * 16, tag('head'));
  await assert.rejects(readSfntFontMetadata(duplicate), /duplicate tables/);
  const collection = fixture({collection: true});
  collection.view.setUint32(16, collection.size - 8);
  await assert.rejects(readSfntFontMetadata(collection), /exceeds supplied resource/);
  const truncated = fixture();
  truncated.read = async (_offset, length) => new Uint8Array(length - 1);
  await assert.rejects(readSfntFontMetadata(truncated), /truncated range/);
});

test('browser font catalog uses blob slices and isolates denied or invalid font records', async () => {
  const source = fixture({glyphLength: 2 ** 31});
  let wholeReads = 0;
  const record = {
    family: 'Synthetic Font',
    fullName: 'Synthetic Font Regular',
    postscriptName: 'SyntheticFont-Regular',
    async blob() {
      return {
        size: source.size,
        async arrayBuffer() {
          wholeReads++;
          throw new Error('Whole-font allocation is forbidden');
        },
        slice(start, end) {
          return {
            async arrayBuffer() {
              return (await source.read(start, end - start)).slice().buffer;
            },
          };
        },
      };
    },
  };
  const records = [
    {
      ...record,
      async blob() {
        throw new Error('Font permission denied');
      },
    },
    {
      ...record,
      async blob() {
        return new Blob([new Uint8Array(12)]);
      },
    },
    record,
  ];
  const catalog = await readBrowserLocalFontMetadata({
    async queryLocalFonts() {
      return records;
    },
  });
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].family, record.family);
  assert.equal(catalog[0].data.names[0].unicode, record.family);
  assert.equal(Object.hasOwn(catalog[0].data, 'bytes'), false);
  assert.equal(wholeReads, 0);
  assert.deepEqual(await readBrowserLocalFontMetadata({}), []);
  assert.deepEqual(
    await readBrowserLocalFontMetadata({
      async queryLocalFonts() {
        throw new Error('Denied');
      },
    }),
    [],
  );
});

test('font catalog bounds concurrent metadata jobs and preserves query and collection order', async () => {
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  for (const profile of ['native', 'browser-optimized']) {
    const capacity = profile === 'native' ? 1 : 4;
    const started = [],
      gates = Array.from({length: 7}, () => Promise.withResolvers());
    const records = gates.map((gate, index) => ({
      family: `Family ${index}`,
      fullName: `Full ${index}`,
      postscriptName: `Postscript${index}`,
      async blob() {
        started.push(index);
        if (index === 5) throw new Error('Denied');
        if (index === 4) return new Blob([new Uint8Array(12)]);
        const source = fixture({collection: index === 0, glyphLength: 2 ** 31});
        return {
          size: source.size,
          slice(start, end) {
            return {
              async arrayBuffer() {
                await gate.promise;
                return (await source.read(start, end - start)).slice().buffer;
              },
            };
          },
        };
      },
    }));
    try {
      setRuntimeProfile(profile);
      const pending = readBrowserLocalFontMetadata({
        async queryLocalFonts() {
          // Changing policy while the query is pending affects the next catalog.
          setRuntimeProfile(profile === 'native' ? 'browser-optimized' : 'native');
          return records;
        },
      });
      await flush();
      assert.deepEqual(
        started,
        Array.from({length: capacity}, (_, index) => index),
      );
      // Finish the last admitted metadata read first, leaving earlier reads pending.
      gates[capacity - 1].resolve();
      await flush();
      assert.deepEqual(started, capacity === 1 ? [0, 1] : [0, 1, 2, 3, 4, 5, 6]);
      for (const gate of gates) gate.resolve();
      const catalog = await pending;
      assert.deepEqual(
        catalog.map(({family, fullName, postscriptName, data}) => [
          family,
          fullName,
          postscriptName,
          data.names[0].unicode,
        ]),
        [
          [0, 'Synthetic Font'],
          [0, 'Second Font'],
          [1, 'Synthetic Font'],
          [2, 'Synthetic Font'],
          [3, 'Synthetic Font'],
          [6, 'Synthetic Font'],
        ].map(([index, name]) => [`Family ${index}`, `Full ${index}`, `Postscript${index}`, name]),
      );
      assert.ok(catalog.every(({data}) => !Object.hasOwn(data, 'bytes')));
    } finally {
      for (const gate of gates) gate.resolve();
      setRuntimeProfile('native');
    }
  }
});
