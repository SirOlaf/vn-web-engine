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
import {BurikoMovieFileStream} from '../dist/engines/buriko/native/movie-file-stream.js';

function arc(entries) {
  const base = 16 + entries.length * 128,
    bytes = new Uint8Array(base + entries.reduce((sum, entry) => sum + entry.data.length, 0)),
    view = new DataView(bytes.buffer),
    encode = new TextEncoder();
  bytes.set(encode.encode('BURIKO ARC20'));
  view.setUint32(12, entries.length, true);
  let offset = 0;
  entries.forEach((entry, index) => {
    const record = 16 + index * 128;
    bytes.set(encode.encode(entry.name), record);
    view.setUint32(record + 96, offset, true);
    view.setUint32(record + 100, entry.data.length, true);
    view.setBigUint64(record + 104, entry.metadata, true);
    bytes.set(entry.data, base + offset);
    offset += entry.data.length;
  });
  return bytes;
}

test('movie sources retain loose search precedence and resolve real complex-archive regions', async () => {
  const fs = new StoredFileSystem(new MemoryStore(), (path) => path.toLowerCase());
  await fs.commit([
    {kind: 'write', path: '/game/video/loose.bin', data: Uint8Array.of(9, 8, 7)},
    {kind: 'write', path: '/media/secondary.bin', data: Uint8Array.of(6, 5)},
    {
      kind: 'write',
      path: '/game/first.arc',
      data: arc([{name: 'shared.bin', data: Uint8Array.of(1, 2), metadata: 0n}]),
    },
    {
      kind: 'write',
      path: '/game/second.arc',
      data: arc([
        {name: 'other.bin', data: Uint8Array.of(3, 4), metadata: 0n},
        {name: 'movie.bin', data: Uint8Array.of(11, 12, 13, 14), metadata: 5n},
      ]),
    },
  ]);
  const text = new BurikoNativeText(),
    encode = (s) => text.encodeWide(s, 1),
    pointer = (s) => ({bytes: encode(s), offset: 0}),
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
    processing = new BurikoDistributedProcessing(new BurikoDistributedAllocator(1), 1),
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
      processing,
    ),
    sources = new BurikoMovieSources(resources);
  assert.equal(
    await resources.archives.registerComplex(pointer('combined'), [
      pointer('first.arc'),
      pointer('second.arc'),
    ]),
    1,
  );
  const loose = await sources.locate(pointer('combined'), pointer('loose.bin'));
  assert.equal(files.path(loose.path), 'C:\\game\\video\\loose.bin');
  assert.deepEqual([loose.offset, loose.length], [0, 0]);
  const opened = await files.open(loose.path);
  assert.deepEqual(Array.from(await files.read(opened.source, 0, 3)), [9, 8, 7]);
  const secondary = await sources.locate(pointer('combined'), pointer('secondary.bin'));
  assert.equal(files.path(secondary.path), 'C:\\media\\secondary.bin');
  const location = await sources.locate(pointer('combined'), pointer('movie.bin'));
  assert.equal(files.path(location.path), 'c:\\game\\second.arc');
  assert.deepEqual([location.offset, location.length], [274, 4]);
  const stream = new BurikoMovieFileStream(files, () => 0);
  assert.equal(
    await stream.initialize(files.path(location.path), location.length, location.offset),
    0,
  );
  const output = new Uint8Array(4);
  assert.deepEqual(await stream.read(output, 0, 4, {}), {status: 0, count: 4});
  assert.deepEqual(Array.from(output), [11, 12, 13, 14]);
  stream.dispose();
});
