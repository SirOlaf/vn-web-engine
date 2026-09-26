import test from 'node:test';
import assert from 'node:assert/strict';
import {StoredFileSystem} from '../dist/platform/filesystem.js';
import {MemoryStore} from '../dist/platform/store.js';
import {AokanaMountedProgramPaths} from '../dist/engines/buriko/games/aokana/native/program-paths.js';
import {
  AokanaProgramFiles,
  AokanaProgramMedia,
} from '../dist/engines/buriko/games/aokana/native/program-files.js';
import {AokanaProgramResources} from '../dist/engines/buriko/games/aokana/native/program-resources.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {
  AokanaDistributedAllocator,
  AokanaDistributedProcessing,
} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {AokanaEngineErrors} from '../dist/engines/buriko/games/aokana/native/engine-errors.js';
import {AokanaEngineDialogs} from '../dist/engines/buriko/games/aokana/native/engine-dialogs.js';
import {AokanaMovieSources} from '../dist/engines/buriko/games/aokana/native/movie-sources.js';
import {AokanaMovieSourceDocument} from '../dist/engines/buriko/games/aokana/native/movie-source-document.js';
import {AokanaMovieSourceTracks} from '../dist/engines/buriko/games/aokana/native/movie-source-tracks.js';

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
const descriptor = (tag, body) => join(Uint8Array.of(tag, body.length), body);

function sampleTrack(id, handler, description, offset, length) {
  const tkhd = new Uint8Array(80),
    header = new DataView(tkhd.buffer);
  header.setUint32(8, id);
  header.setUint32(16, 40);
  header.setUint32(36, 0x10000);
  header.setUint32(52, 0x10000);
  header.setUint32(68, 0x40000000);
  header.setUint32(72, 2 * 65536);
  header.setUint32(76, 2 * 65536);
  return box(
    'trak',
    full('tkhd', 1, tkhd),
    box(
      'mdia',
      full('mdhd', 0, u32(0, 0, 1000, 40)),
      full('hdlr', 0, u32(0), four(handler)),
      box(
        'minf',
        box('dinf', full('dref', 0, u32(1), full('url ', 1))),
        box(
          'stbl',
          full('stsd', 0, u32(1), description),
          table('stts', [1, 40], 2),
          table('stsc', [1, 1, 1], 3),
          full('stsz', 0, u32(0, 1, length)),
          table('stco', [offset], 1),
          ...(handler === 'vide' ? [table('stss', [1], 1)] : []),
        ),
      ),
    ),
  );
}

function iso(video, audio, other) {
  const avcHeader = new Uint8Array(78),
    avcView = new DataView(avcHeader.buffer);
  avcView.setUint16(6, 1);
  avcView.setUint16(24, 2);
  avcView.setUint16(26, 2);
  const avc = box('avc1', avcHeader, box('avcC', Uint8Array.of(1, 100, 0, 31, 255, 224, 0)));
  const audioHeader = new Uint8Array(28),
    audioView = new DataView(audioHeader.buffer);
  audioView.setUint16(6, 1);
  audioView.setUint16(16, 2);
  audioView.setUint32(24, 48000 * 65536);
  const decoder = descriptor(
    4,
    join(Uint8Array.of(0x40, 0x15), new Uint8Array(11), descriptor(5, Uint8Array.of(0x11, 0x90))),
  );
  const stream = descriptor(3, join(Uint8Array.of(0, 1, 0), decoder));
  const aac = box('mp4a', audioHeader, full('esds', 0, stream));
  return join(
    box('mdat', video, audio, other),
    box(
      'moov',
      full('mvhd', 0, u32(0, 0, 1000, 40)),
      sampleTrack(7, 'vide', avc, 8, video.length),
      sampleTrack(9, 'soun', aac, 8 + video.length, audio.length),
      sampleTrack(11, 'vide', avc, 8 + video.length + audio.length, other.length),
    ),
  );
}

function arc(data) {
  const bytes = new Uint8Array(16 + 2 * 128 + 3 + data.length),
    view = new DataView(bytes.buffer),
    encode = new TextEncoder();
  bytes.set(encode.encode('BURIKO ARC20'));
  view.setUint32(12, 2, true);
  bytes.set(encode.encode('padding.bin'), 16);
  view.setUint32(16 + 100, 3, true);
  bytes.set(encode.encode('selected.iso'), 16 + 128);
  view.setUint32(16 + 128 + 96, 3, true);
  view.setUint32(16 + 128 + 100, data.length, true);
  bytes.set(Uint8Array.of(91, 92, 93), 16 + 2 * 128);
  bytes.set(data, 16 + 2 * 128 + 3);
  return bytes;
}

test('explicit movie tracks retain direct and archive document identity through encoded samples and timelines', async () => {
  const directPayload = [Uint8Array.of(10, 11), Uint8Array.of(20, 21, 22), Uint8Array.of(30)],
    archivePayload = [Uint8Array.of(40, 41, 42), Uint8Array.of(50, 51), Uint8Array.of(60)],
    directBytes = iso(...directPayload),
    archiveBytes = iso(...archivePayload);
  const fs = new StoredFileSystem(new MemoryStore(), (path) => path.toLowerCase());
  await fs.commit([
    {kind: 'write', path: '/game/video/direct.iso', data: directBytes},
    {kind: 'write', path: '/game/physical.arc', data: arc(archiveBytes)},
  ]);
  const text = new AokanaNativeText(),
    encode = (value) => text.encodeWide(value, 1),
    pointer = (value) => ({bytes: encode(value), offset: 0}),
    media = new AokanaProgramMedia();
  media.setDriveType(2, 3);
  const files = new AokanaProgramFiles(
      fs,
      text,
      media,
      new AokanaMountedProgramPaths([{native: 'C:\\', mounted: '/'}], 'C:\\game'),
    ),
    dialogs = new AokanaEngineDialogs(),
    errors = new AokanaEngineErrors(files, dialogs, Uint8Array.of(0), Uint8Array.of(0)),
    resources = new AokanaProgramResources(
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
      new AokanaDistributedProcessing(new AokanaDistributedAllocator(1), 1),
    );
  assert.equal(
    await resources.archives.registerComplex(pointer('virtual'), [pointer('physical.arc')]),
    1,
  );
  const sources = new AokanaMovieSources(resources),
    actors = {currentActor: {}};

  for (const {archive, name, bytes, payload, expectedOffset} of [
    {
      archive: null,
      name: 'direct.iso',
      bytes: directBytes,
      payload: directPayload,
      expectedOffset: 0,
    },
    {
      archive: pointer('virtual'),
      name: 'selected.iso',
      bytes: archiveBytes,
      payload: archivePayload,
      expectedOffset: 275,
    },
  ]) {
    const document = await AokanaMovieSourceDocument.open(
      sources,
      archive,
      pointer(name),
      actors,
      () => 0,
      bytes.length,
    );
    assert.ok(document);
    assert.equal(document.source.offset, expectedOffset);
    const selected = AokanaMovieSourceTracks.prepare(document, 7, 9);
    assert.strictEqual(selected.document, document);
    assert.strictEqual(selected.movie, document.movie);
    assert.strictEqual(selected.video.track, document.movie.tracks[0]);
    assert.strictEqual(selected.audio.track, document.movie.tracks[1]);
    assert.deepEqual([...selected.video.sampleBytes(0)], [...payload[0]]);
    assert.deepEqual([...selected.audio.sampleBytes(0)], [...payload[1]]);
    assert.equal(selected.video.timeline.presentations[0].start, 0n);
    assert.equal(selected.video.timeline.presentations[0].end, 400000n);
    assert.equal(selected.audio.timeline.presentations[0].end, 400000n);
    assert.equal(selected.video.configurations.get(1).codec, 'avc1.64001f');
    assert.deepEqual(
      [...selected.video.configurations.get(1).description],
      [1, 100, 0, 31, 255, 224, 0],
    );
    assert.equal(selected.audio.configurations.get(1).codec, 'mp4a.40.2');
    assert.equal(selected.audio.configurations.get(1).sampleRate, 48000);
    assert.deepEqual([...selected.audio.configurations.get(1).description], [0x11, 0x90]);
    const other = AokanaMovieSourceTracks.prepare(document, 11, null);
    assert.deepEqual([...other.video.sampleBytes(0)], [...payload[2]]);
    assert.equal(other.audio, null);
    assert.throws(() => AokanaMovieSourceTracks.prepare(document, 9, null), /vide track/);
    assert.throws(() => AokanaMovieSourceTracks.prepare(document, 7, 11), /soun track/);
    assert.throws(() => selected.video.sampleBytes(1), RangeError);
  }
});
