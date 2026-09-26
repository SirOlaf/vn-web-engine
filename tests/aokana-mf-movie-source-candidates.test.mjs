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
import {BurikoMfMovieSourceCandidates} from '../dist/engines/buriko/native/movie-mf-source-candidates.js';
import {BurikoMfMovieDocuments} from '../dist/engines/buriko/native/movie-mf-document.js';
import {BlobSource, SliceSource} from '../dist/core/source.js';

function arc(name, data) {
  const bytes = new Uint8Array(16 + 128 + data.length);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('BURIKO ARC20'));
  view.setUint32(12, 1, true);
  bytes.set(new TextEncoder().encode(name), 16);
  view.setUint32(16 + 100, data.length, true);
  bytes.set(data, 144);
  return bytes;
}

test('MF movie candidates keep qualified/direct/search order and physical archive identity', async () => {
  const fs = new StoredFileSystem(new MemoryStore(), (path) => path.toLowerCase());
  await fs.commit([
    {kind: 'write', path: '/game/primary.bin', data: Uint8Array.of(1)},
    {kind: 'write', path: '/game/video/secondary.bin', data: Uint8Array.of(2)},
    {kind: 'write', path: '/media/secondary.bin', data: Uint8Array.of(3)},
    {kind: 'write', path: '/game/video/search.bin', data: Uint8Array.of(4)},
    {kind: 'write', path: '/game/movie.arc', data: arc('member.bin', Uint8Array.of(5, 6, 7))},
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
    new BurikoEngineErrors(files, dialogs, Uint8Array.of(0), Uint8Array.of(0)),
    new BurikoDistributedProcessing(new BurikoDistributedAllocator(1), 1),
  );
  const candidates = new BurikoMfMovieSourceCandidates(resources);

  assert.equal(
    files.path((await candidates.direct(pointer('primary.bin'))).path),
    'C:\\game\\primary.bin',
  );
  // BB2A0's secondary direct check precedes BB3C0's primary search-directory check.
  assert.equal(
    files.path((await candidates.direct(pointer('secondary.bin'))).path),
    'C:\\media\\secondary.bin',
  );
  assert.equal(
    files.path((await candidates.direct(pointer('search.bin'))).path),
    'C:\\game\\video\\search.bin',
  );
  assert.equal(files.path((await candidates.direct(pointer('video'))).path), 'C:\\game\\video');

  // A failed direct 10FC70 attempt may request this separate, lazy BA330 candidate.
  const archive = await candidates.archive(pointer('movie.arc'), pointer('member.bin'));
  assert.equal(archive.kind, 'archive');
  assert.equal(files.path(archive.path), 'c:\\game\\movie.arc');
  assert.equal(files.path(archive.member), 'member.bin');
  assert.deepEqual([archive.offset, archive.length], [144, 3]);
  const opened = await files.open(archive.path);
  assert.deepEqual(
    Array.from(await files.read(opened.source, archive.offset, archive.length)),
    [5, 6, 7],
  );
  const documents = new BurikoMfMovieDocuments(candidates, files, 1024);
  const materialized = await documents.read(archive, new AbortController().signal);
  assert.equal(materialized.kind, 'archive');
  assert.deepEqual([...new Uint8Array(await materialized.blob.arrayBuffer())], [5, 6, 7]);
});

test('browser movies use exact local file regions without reading them into JavaScript', async () => {
  const blob = new Blob([Uint8Array.of(91, 92, 10, 11, 12, 13, 14, 93)]);
  const source = new SliceSource(new SliceSource(new BlobSource(blob), 1, 7), 1, 5);
  const files = {
    open: async () => ({source}),
    read: () => {
      throw new Error('Local movie preparation must retain file backing');
    },
  };
  const documents = new BurikoMfMovieDocuments({resources: {files}}, files, 5);
  const signal = new AbortController().signal;
  const path = new Uint8Array();
  const direct = await documents.read({kind: 'direct', path}, signal);
  const archived = await documents.read({kind: 'archive', path, offset: 1, length: 3}, signal);
  assert.deepEqual([...new Uint8Array(await direct.blob.arrayBuffer())], [10, 11, 12, 13, 14]);
  assert.deepEqual([...new Uint8Array(await archived.blob.arrayBuffer())], [11, 12, 13]);
  await assert.rejects(
    documents.read({kind: 'archive', path, offset: 4, length: 2}, signal),
    /physical region/,
  );
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(documents.read({kind: 'direct', path}, abort.signal), {name: 'AbortError'});
});
