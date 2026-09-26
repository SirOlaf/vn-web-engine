import test from 'node:test';
import assert from 'node:assert/strict';
import {StoredFileSystem} from '../dist/platform/filesystem.js';
import {MemoryStore} from '../dist/platform/store.js';
import {
  BurikoProgramFiles,
  BurikoProgramMedia,
} from '../dist/engines/buriko/native/program-files.js';
import {BurikoMountedProgramPaths} from '../dist/engines/buriko/native/program-paths.js';
import {BurikoProgramResources} from '../dist/engines/buriko/native/program-resources.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';
import {
  BurikoDistributedAllocator,
  BurikoDistributedProcessing,
} from '../dist/engines/buriko/native/distributed-processing.js';
import {BurikoEngineErrors} from '../dist/engines/buriko/native/engine-errors.js';
import {BurikoEngineDialogs} from '../dist/engines/buriko/native/engine-dialogs.js';
import {BurikoMovieSources} from '../dist/engines/buriko/native/movie-sources.js';
import {BurikoMovieSourceDocument} from '../dist/engines/buriko/native/movie-source-document.js';
import {burikoIsoSampleBytes} from '../dist/engines/buriko/native/movie-iso-samples.js';

function join(...parts) {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    result.set(part, at);
    at += part.length;
  }
  return result;
}
function u32(...values) {
  const bytes = new Uint8Array(values.length * 4),
    view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setUint32(index * 4, value));
  return bytes;
}
const four = (value) => Uint8Array.from(value, (char) => char.charCodeAt(0));
function box(type, ...parts) {
  const body = join(...parts);
  return join(u32(body.length + 8), four(type), body);
}
const full = (type, flags, ...parts) => box(type, u32(flags), ...parts);
const table = (type, rows, stride) => full(type, 0, u32(rows.length / stride), u32(...rows));

function iso(sample) {
  const tkhd = new Uint8Array(80),
    header = new DataView(tkhd.buffer);
  header.setUint32(8, 1);
  header.setUint32(16, 40);
  header.setUint32(36, 0x10000);
  header.setUint32(52, 0x10000);
  header.setUint32(68, 0x40000000);
  header.setUint32(72, 2 * 65536);
  header.setUint32(76, 2 * 65536);
  const description = box('avc1', new Uint8Array(6), new Uint8Array([0, 1]), new Uint8Array(70));
  const tables = join(
    table('stts', [1, 40], 2),
    table('stsc', [1, 1, 1], 3),
    full('stsz', 0, u32(0, 1, sample.length)),
    table('stco', [8], 1),
    table('stss', [1], 1),
  );
  const track = box(
    'trak',
    full('tkhd', 1, tkhd),
    box(
      'mdia',
      full('mdhd', 0, u32(0, 0, 1000, 40)),
      full('hdlr', 0, u32(0), four('vide')),
      box(
        'minf',
        box('dinf', full('dref', 0, u32(1), full('url ', 1))),
        box('stbl', full('stsd', 0, u32(1), description), tables),
      ),
    ),
  );
  return join(box('mdat', sample), box('moov', full('mvhd', 0, u32(0, 0, 1000, 40)), track));
}

function arc(entries) {
  const base = 16 + entries.length * 128;
  const bytes = new Uint8Array(base + entries.reduce((sum, entry) => sum + entry.data.length, 0));
  const view = new DataView(bytes.buffer),
    encode = new TextEncoder();
  bytes.set(encode.encode('BURIKO ARC20'));
  view.setUint32(12, entries.length, true);
  let offset = 0;
  entries.forEach((entry, index) => {
    const record = 16 + index * 128;
    bytes.set(encode.encode(entry.name), record);
    view.setUint32(record + 96, offset, true);
    view.setUint32(record + 100, entry.data.length, true);
    bytes.set(entry.data, base + offset);
    offset += entry.data.length;
  });
  return bytes;
}

test('selected direct and archive movie regions retain source identity and real ISO samples', async () => {
  const directSample = Uint8Array.of(10, 11, 12, 13);
  const archivedSample = Uint8Array.of(21, 22, 23, 24, 25);
  const directBytes = iso(directSample),
    archivedBytes = iso(archivedSample);
  const fs = new StoredFileSystem(new MemoryStore(), (path) => path.toLowerCase());
  await fs.commit([
    {kind: 'write', path: '/game/video/direct.iso', data: directBytes},
    {
      kind: 'write',
      path: '/game/physical.arc',
      data: arc([
        {name: 'padding.bin', data: Uint8Array.of(1, 2, 3)},
        {name: 'archived.iso', data: archivedBytes},
      ]),
    },
  ]);
  const text = new BurikoNativeText();
  const encode = (value) => text.encodeWide(value, 1);
  const pointer = (value) => ({bytes: encode(value), offset: 0});
  const media = new BurikoProgramMedia();
  media.setDriveType(2, 3);
  const files = new BurikoProgramFiles(
    fs,
    text,
    media,
    new BurikoMountedProgramPaths([{native: 'C:\\', mounted: '/'}], 'C:\\game'),
  );
  const dialogs = new BurikoEngineDialogs();
  const errors = new BurikoEngineErrors(files, dialogs, Uint8Array.of(0), Uint8Array.of(0));
  const processing = new BurikoDistributedProcessing(new BurikoDistributedAllocator(1), 1);
  const resources = new BurikoProgramResources(
    files,
    {
      nativeFileRoot: 'C:\\game\\',
      primaryRoot: encode('C:\\game\\'),
      secondaryRoot: encode('C:\\media\\'),
      secondaryMediaPath: 'C:\\media\\',
      searchDirectoriesEnabled: 1,
      searchDirectories: [encode('video')],
      retryTitle: Uint8Array.of(0),
      retryMessage: Uint8Array.of(0),
      quitConfirmation: Uint8Array.of(0),
    },
    dialogs,
    errors,
    processing,
  );
  assert.equal(
    await resources.archives.registerComplex(pointer('virtual'), [pointer('physical.arc')]),
    1,
  );
  const sources = new BurikoMovieSources(resources);
  const actor = {},
    nextActor = {},
    actors = {currentActor: actor};

  const directPending = BurikoMovieSourceDocument.open(
    sources,
    null,
    pointer('direct.iso'),
    actors,
    () => 0,
    directBytes.length,
  );
  actors.currentActor = nextActor;
  const direct = await directPending;
  assert.equal(direct.actor, actor);
  assert.equal(direct.source.widePath, 'C:\\game\\video\\direct.iso');
  assert.deepEqual([direct.source.offset, direct.source.length], [0, 0]);
  assert.equal(direct.movie.tracks.length, 1);
  assert.equal(direct.movie.tracks[0].handler, 'vide');
  assert.deepEqual(
    [
      ...burikoIsoSampleBytes(
        direct.movie,
        direct.movie.tracks[0],
        direct.movie.tracks[0].samples[0],
      ),
    ],
    [...directSample],
  );

  const archive = await BurikoMovieSourceDocument.open(
    sources,
    pointer('virtual'),
    pointer('archived.iso'),
    actors,
    () => 0,
    archivedBytes.length,
  );
  assert.equal(archive.actor, nextActor);
  assert.equal(archive.source.widePath, 'c:\\game\\physical.arc');
  assert.deepEqual([archive.source.offset, archive.source.length], [275, archivedBytes.length]);
  assert.equal(archive.movie.tracks.length, 1);
  assert.equal(archive.movie.tracks[0].samples[0].offset, 8n);
  assert.deepEqual(
    [
      ...burikoIsoSampleBytes(
        archive.movie,
        archive.movie.tracks[0],
        archive.movie.tracks[0].samples[0],
      ),
    ],
    [...archivedSample],
  );
});
