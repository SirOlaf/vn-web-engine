import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {StoredFileSystem} from '../dist/platform/filesystem.js';
import {MemoryStore} from '../dist/platform/store.js';
import {BurikoMountedProgramPaths} from '../dist/engines/buriko/native/program-paths.js';
import {
  BurikoProgramFiles,
  BurikoProgramMedia,
} from '../dist/engines/buriko/native/program-files.js';
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
import {BurikoMovieSourceTracks} from '../dist/engines/buriko/native/movie-source-tracks.js';
import {BurikoMovieReferenceClock} from '../dist/engines/buriko/native/movie-render-events.js';
import {BurikoMovieVideoOnlyTimeline} from '../dist/engines/buriko/native/movie-video-only-timeline.js';

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

function videoOnlyIso() {
  const payload = Uint8Array.of(10, 11, 12),
    avcHeader = new Uint8Array(78),
    avcView = new DataView(avcHeader.buffer),
    tkhd = new Uint8Array(80),
    tkhdView = new DataView(tkhd.buffer);
  avcView.setUint16(6, 1);
  avcView.setUint16(24, 2);
  avcView.setUint16(26, 2);
  tkhdView.setUint32(8, 7);
  tkhdView.setUint32(16, 40);
  tkhdView.setUint32(36, 0x10000);
  tkhdView.setUint32(52, 0x10000);
  tkhdView.setUint32(68, 0x40000000);
  tkhdView.setUint32(72, 2 * 65536);
  tkhdView.setUint32(76, 2 * 65536);
  const avc = box('avc1', avcHeader, box('avcC', Uint8Array.of(1, 100, 0, 31, 255, 224, 0)));
  return join(
    box('mdat', payload),
    box(
      'moov',
      full('mvhd', 0, u32(0, 0, 1000, 40)),
      box(
        'trak',
        full('tkhd', 1, tkhd),
        box(
          'mdia',
          full('mdhd', 0, u32(0, 0, 1000, 40)),
          full('hdlr', 0, u32(0), four('vide')),
          box(
            'minf',
            box('dinf', full('dref', 0, u32(1), full('url ', 1))),
            box(
              'stbl',
              full('stsd', 0, u32(1), avc),
              table('stts', [1, 40], 2),
              table('stsc', [1, 1, 1], 3),
              full('stsz', 0, u32(0, 1, payload.length)),
              table('stco', [8], 1),
              table('stss', [1], 1),
            ),
          ),
        ),
      ),
    ),
  );
}

test('selected mounted video-only timeline anchors real reference time without decoding', async () => {
  const bytes = videoOnlyIso(),
    fs = new StoredFileSystem(new MemoryStore(), (path) => path.toLowerCase());
  await fs.commit([{kind: 'write', path: '/game/video/clip.iso', data: bytes}]);
  const text = new BurikoNativeText(),
    encode = (value) => text.encodeWide(value, 1),
    pointer = (value) => ({bytes: encode(value), offset: 0}),
    media = new BurikoProgramMedia();
  media.setDriveType(2, 3);
  const files = new BurikoProgramFiles(
      fs,
      text,
      media,
      new BurikoMountedProgramPaths([{native: 'C:\\', mounted: '/'}], 'C:\\game'),
    ),
    dialogs = new BurikoEngineDialogs(),
    errors = new BurikoEngineErrors(files, dialogs, Uint8Array.of(0), Uint8Array.of(0)),
    resources = new BurikoProgramResources(
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
      new BurikoDistributedProcessing(new BurikoDistributedAllocator(1), 1),
    ),
    sources = new BurikoMovieSources(resources),
    document = await BurikoMovieSourceDocument.open(
      sources,
      null,
      pointer('clip.iso'),
      {currentActor: {}},
      () => performance.now(),
      bytes.length,
    );
  assert.ok(document);
  const tracks = BurikoMovieSourceTracks.prepare(document, 7, null),
    clock = new BurikoMovieReferenceClock(),
    timeline = new BurikoMovieVideoOnlyTimeline(tracks, clock);
  assert.strictEqual(timeline.tracks, tracks);
  assert.strictEqual(timeline.clock, clock);
  assert.strictEqual(timeline.tracks.document, document);
  assert.equal(timeline.stopTime, 400000n);
  assert.equal(timeline.state, 'paused');
  assert.equal(timeline.currentTime, 0n);

  const start = timeline.run(),
    first = timeline.currentTime;
  assert.strictEqual(timeline.run(), start);
  assert.equal(timeline.state, 'running');
  await delay(5);
  const later = timeline.currentTime;
  assert.ok(later >= first);
  assert.ok(later > 0n);
  const paused = timeline.pause();
  await delay(5);
  assert.equal(timeline.currentTime, paused);
  assert.equal(timeline.state, 'paused');

  assert.equal(timeline.seek({numerator: 1n, denominator: 300n}), 33333n);
  assert.deepEqual(timeline.position, {numerator: 1n, denominator: 300n});
  assert.equal(timeline.seek({numerator: 1n, denominator: 100n}), 100000n);
  assert.equal(timeline.generation, 2);
  assert.deepEqual(timeline.position, {numerator: 1n, denominator: 100n});
  const resumed = timeline.run();
  assert.ok(clock.now() - resumed >= 100000n);
  assert.ok(timeline.currentTime >= 100000n);
  timeline.pause();
  timeline.dispose();
  timeline.dispose();
  assert.equal(timeline.state, 'closed');
});
