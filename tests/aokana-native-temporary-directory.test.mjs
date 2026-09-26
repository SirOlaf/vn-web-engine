import test from 'node:test';
import assert from 'node:assert/strict';
import {StoredFileSystem} from '../dist/platform/filesystem.js';
import {MemoryStore} from '../dist/platform/store.js';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaBpDiagnostics} from '../dist/engines/buriko/games/aokana/native/diagnostics.js';
import {AokanaMountedFileMetadata} from '../dist/engines/buriko/games/aokana/native/file-metadata.js';
import {createGroup81TemporaryDirectory} from '../dist/engines/buriko/games/aokana/native/group-81-temporary-directory.js';
import {
  AokanaProgramFiles,
  AokanaProgramMedia,
} from '../dist/engines/buriko/games/aokana/native/program-files.js';
import {AokanaMountedProgramPaths} from '../dist/engines/buriko/games/aokana/native/program-paths.js';
import {
  AokanaTemporaryDirectoryProbe,
  AokanaTemporaryFileProfile,
} from '../dist/engines/buriko/games/aokana/native/temporary-directory-probe.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';

const bytes = (value) => new TextEncoder().encode(value);

class RecordingMetadata extends AokanaMountedFileMetadata {
  constructor(backing, profile, events) {
    super(backing, profile);
    this.events = events;
  }
  async createDirectory(path) {
    this.events.push(['mkdir', this.canonical(path)]);
    return super.createDirectory(path);
  }
  async removeDirectory(path) {
    this.events.push(['rmdir', this.canonical(path)]);
    return super.removeDirectory(path);
  }
  async commit(changes) {
    for (const change of changes) this.events.push([change.kind, this.canonical(change.path)]);
    return super.commit(changes);
  }
  async open(path) {
    this.events.push(['open', this.canonical(path)]);
    return super.open(path);
  }
}

test('81 2F creates nested directories, round-trips one real BGI file and rolls back', async () => {
  const events = [];
  const canonical = (path) => path.toLowerCase();
  const backing = new StoredFileSystem(new MemoryStore(), canonical);
  const metadata = new RecordingMetadata(
    backing,
    {
      canonical,
      volumes: [{path: '/', identity: {}, writable: true}],
      records: [
        {
          path: '/',
          kind: 'directory',
          attributes: 0x10,
          creationTime: 1n,
          accessTime: 1n,
          writeTime: 1n,
        },
        {
          path: '/existing',
          kind: 'directory',
          attributes: 0x10,
          creationTime: 1n,
          accessTime: 1n,
          writeTime: 1n,
        },
      ],
      currentFileTime: () => 2n,
      accessTimePolicy: 'disabled',
    },
    events,
  );
  const paths = new AokanaMountedProgramPaths([{native: 'C:\\', mounted: '/'}], 'C:\\');
  const files = new AokanaProgramFiles(
    metadata,
    new AokanaNativeText(),
    new AokanaProgramMedia(),
    paths,
  );
  const profile = new AokanaTemporaryFileProfile(['BGI0001.tmp']);
  const host = {
    async createTemporaryFile(owner, directory, prefix) {
      events.push(['temp', directory, prefix]);
      return profile.createTemporaryFile(owner, directory, prefix);
    },
    async deleteTemporaryFile(owner, path) {
      events.push(['unlink', path]);
      return profile.deleteTemporaryFile(owner, path);
    },
  };
  const probe = new AokanaTemporaryDirectoryProbe(files, host);
  const [definition] = createGroup81TemporaryDirectory(probe);
  const memoryBytes = new Uint8Array(128);
  memoryBytes.set(bytes('C:\\existing\\new\\child\0'), 16);
  const memory = new AokanaBpMemory(memoryBytes);
  const thread = new AokanaBpThread({
    id: 1,
    operandCapacity: 16,
    moduleCapacity: 16,
    frameCapacity: 16,
  });
  const context = {thread, memory, diagnostics: new AokanaBpDiagnostics(() => {})};

  push32(thread, 16);
  assert.equal(await definition.execute(context), 0);
  assert.equal(pop32(thread), 1);
  assert.equal(thread.stackIndex, 0);
  assert.deepEqual(events, [
    ['mkdir', '/existing/new'],
    ['mkdir', '/existing/new/child'],
    ['temp', 'C:\\existing\\new\\child', 'BGI'],
    ['write', '/existing/new/child/bgi0001.tmp'],
    ['write', '/existing/new/child/bgi0001.tmp'],
    ['open', '/existing/new/child/bgi0001.tmp'],
    ['unlink', 'C:\\existing\\new\\child\\BGI0001.tmp'],
    ['delete', '/existing/new/child/bgi0001.tmp'],
    ['rmdir', '/existing/new/child'],
    ['rmdir', '/existing/new'],
  ]);
  assert.equal((await metadata.stat('/existing')).kind, 'directory');
  assert.deepEqual(await metadata.list('/existing'), []);
  assert.deepEqual(
    metadata.snapshot().map((record) => record.path),
    ['/', '/existing'],
  );
});
