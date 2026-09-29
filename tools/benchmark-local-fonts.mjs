import {resolve} from 'node:path';
import {
  parseSyntheticBrowserOptions,
  runSyntheticBrowserProbe,
} from './lib/synthetic-browser-probe.mjs';

// Generated SFNT metadata and real Blob slice reads only. No installed fonts,
// glyph data, game resources, canvas, or font rendering are accessed.
const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--'))
    throw new Error(name + ' requires a value');
  return args.splice(index, 2)[1];
}
const runtimeRoot = resolve(option('--runtime-root', 'dist'));
const profile = option('--profile', 'browser-optimized');
if (!['native', 'browser-optimized'].includes(profile)) throw new Error('Invalid --profile');
const options = parseSyntheticBrowserOptions(args);

async function pageMain({profile}, options) {
  const {readBrowserLocalFontMetadata} = await import('/runtime/text/browser-local-fonts.js');
  const {setRuntimeProfile} = await import('/runtime/platform/runtime-profile.js');
  setRuntimeProfile(profile);
  const tag = (value) =>
    [...value].reduce((number, character) => number * 256 + character.charCodeAt(0), 0);
  function namingTable(family) {
    const values = [family, family + ' Regular', family.replaceAll(' ', '') + '-Regular'];
    const bytes = new Uint8Array(42 + values.reduce((sum, value) => sum + value.length * 2, 0));
    const view = new DataView(bytes.buffer);
    view.setUint16(2, values.length);
    view.setUint16(4, 42);
    let offset = 0;
    values.forEach((value, index) => {
      const record = 6 + index * 12;
      view.setUint16(record, 3);
      view.setUint16(record + 2, 1);
      view.setUint16(record + 4, 0x409);
      view.setUint16(record + 6, [1, 4, 6][index]);
      view.setUint16(record + 8, value.length * 2);
      view.setUint16(record + 10, offset);
      for (let index = 0; index < value.length; index++)
        view.setUint16(42 + offset + index * 2, value.charCodeAt(index));
      offset += value.length * 2;
    });
    return bytes;
  }
  const padding = new Blob([new Uint8Array(1024 * 1024)]);
  function makeFont(index) {
    const bytes = new Uint8Array(4096),
      view = new DataView(bytes.buffer),
      collection = index % 17 === 0,
      names = [namingTable('Synthetic ' + index), namingTable('Second ' + index)],
      directories = collection ? [64, 192] : [0];
    view.setUint32(512, 0x00010000);
    view.setUint32(524, 0x5f0f3cf5);
    view.setUint16(530, 2048);
    view.setInt16(550, -300);
    view.setInt16(554, 1500);
    view.setUint32(576, 0x00010000);
    view.setUint16(640, 1);
    view.setInt16(642, 800 + (index % 100));
    view.setUint16(644, index % 2 ? 700 : 400);
    view.setUint16(702, index % 3 === 0 ? 1 : 0);
    view.setUint16(714, 1900);
    view.setUint16(716, 500);
    view.setUint32(718, 1 << 17);
    view.setUint32(722, 1 << 5);
    view.setUint32(1036, index % 2);
    bytes.set(names[0], 768);
    bytes.set(names[1], 1280);
    if (collection) {
      view.setUint32(0, tag('ttcf'));
      view.setUint32(4, 0x00020000);
      view.setUint32(8, directories.length);
      directories.forEach((offset, index) => view.setUint32(12 + index * 4, offset));
    }
    directories.forEach((directory, face) => {
      view.setUint32(directory, face ? tag('OTTO') : 0x00010000);
      view.setUint16(directory + 4, 6);
      const tables = [
        ['head', 512, 54],
        ['hhea', 576, 36],
        ['OS/2', 640, 96],
        ['name', face ? 1280 : 768, names[face].length],
        ['post', 1024, 32],
        [face ? 'CFF ' : 'glyf', 4096, padding.size],
      ];
      tables.forEach(([name, offset, length], table) => {
        const record = directory + 12 + table * 16;
        view.setUint32(record, tag(name));
        view.setUint32(record + 8, offset);
        view.setUint32(record + 12, length);
      });
    });
    return new Blob([bytes, padding]);
  }
  let sliceReads = 0,
    readBytes = 0,
    blobCalls = 0;
  const count = options.smoke ? 31 : 653;
  const failures = [],
    records = Array.from({length: count}, (_, index) => {
      const denied = index % 101 === 100,
        invalid = index % 97 === 96,
        blob = invalid ? new Blob([new Uint8Array(12)]) : makeFont(index);
      if (denied || invalid) failures.push(index);
      return {
        family: 'Family ' + index,
        fullName: 'Full name ' + index,
        postscriptName: 'Postscript' + index,
        async blob() {
          blobCalls++;
          if (denied) throw new Error('Synthetic permission failure');
          return {
            size: blob.size,
            slice(start, end) {
              if (end > 4096) throw new Error('Glyph data must not be read');
              sliceReads++;
              readBytes += end - start;
              return blob.slice(start, end);
            },
            arrayBuffer() {
              throw new Error('Whole-font read is forbidden');
            },
          };
        },
      };
    });
  const hash = (value) => {
    const bytes = new TextEncoder().encode(
      JSON.stringify(value, (_key, item) => (item instanceof Uint8Array ? [...item] : item)),
    );
    let output = 2166136261;
    for (const byte of bytes) output = Math.imul(output ^ byte, 16777619);
    return (output >>> 0).toString(16).padStart(8, '0');
  };
  const samples = [];
  let coldMs, expected, outputHash;
  for (let pass = 0; pass < options.iterations + 2; pass++) {
    blobCalls = sliceReads = readBytes = 0;
    const start = performance.now();
    // The installed-font cache would turn later passes into cache hits; measure reads only.
    const catalog = await readBrowserLocalFontMetadata(
      {queryLocalFonts: async () => records},
      {getMany: async () => new Map(), putMany: async () => {}},
    );
    const elapsed = performance.now() - start;
    const found = new Set(catalog.map(({family}) => family));
    const missing = records.flatMap(({family}, index) => (found.has(family) ? [] : [index]));
    if (JSON.stringify(missing) !== JSON.stringify(failures))
      throw new Error('Unexpected catalog failures');
    const observation = {
      outputHash: hash(catalog),
      faces: catalog.length,
      failedRecords: missing,
      blobCalls,
      sliceReads,
      readBytes,
    };
    const signature = JSON.stringify(observation);
    if (pass === 0) {
      coldMs = elapsed;
      expected = signature;
      outputHash = observation;
    } else if (signature !== expected) throw new Error('Catalog output changed between samples');
    if (pass >= 2) samples.push(elapsed);
  }
  const round = (value) => Math.round(value * 100) / 100;
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    available: true,
    synthetic: true,
    profile,
    recordCount: count,
    coldMs: round(coldMs),
    medianMs: round(sorted[sorted.length >> 1]),
    samplesMs: samples.map(round),
    ...outputHash,
    caveat:
      'In-memory generated Blobs measure real range-read scheduling, not installed-font IPC or disk throughput.',
  };
}

const result = await runSyntheticBrowserProbe({
  options,
  pageMain,
  runtimeRoot,
  fixture: {profile},
  name: 'vn-local-fonts',
});
console.log(JSON.stringify(result, null, 2));
