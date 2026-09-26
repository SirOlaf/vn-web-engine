import assert from 'node:assert/strict';
import test from 'node:test';
import {BlobSource, HttpSource} from '../dist/core/source.js';
import {subscribeSourceActivity} from '../dist/core/source-activity.js';
import {BrowserInstallationCache} from '../dist/platform/installation-cache.js';

const absent = () => new DOMException('Missing entry', 'NotFoundError');
class MemoryFile {
  kind = 'file';
  contents = new Blob();
  constructor(name, storage) {
    this.name = name;
    this.storage = storage;
  }
  async getFile() {
    return this.contents;
  }
  async createWritable() {
    const parts = [];
    return {
      write: async (bytes) => {
        parts.push(typeof bytes === 'string' ? bytes : bytes.slice());
      },
      close: async () => {
        await this.storage.beforeClose?.(this.name);
        this.contents = new Blob(parts);
      },
      abort: async () => {},
    };
  }
}
class MemoryDirectory {
  kind = 'directory';
  children = new Map();
  constructor(name, storage) {
    this.name = name;
    this.storage = storage;
  }
  async getDirectoryHandle(name, {create = false} = {}) {
    if (!this.children.has(name)) {
      if (!create) throw absent();
      this.children.set(name, new MemoryDirectory(name, this.storage));
    }
    const child = this.children.get(name);
    assert.equal(child.kind, 'directory');
    return child;
  }
  async getFileHandle(name, {create = false} = {}) {
    if (!this.children.has(name)) {
      if (!create) throw absent();
      this.children.set(name, new MemoryFile(name, this.storage));
    }
    const child = this.children.get(name);
    assert.equal(child.kind, 'file');
    return child;
  }
  async removeEntry(name) {
    if (!this.children.delete(name)) throw absent();
  }
  async *entries() {
    yield* this.children.entries();
  }
}
function storage() {
  const result = {
    getDirectory: async () => root,
    estimate: async () => ({quota: 1e9, usage: 0}),
    persist: async () => true,
  };
  const root = new MemoryDirectory('', result);
  return {...result, root};
}
function installation(text) {
  return {
    files: [
      {path: 'data/archive.bin', source: new BlobSource(new Blob([text])), lastModifiedMs: 1234},
    ],
    metadata: {edition: 'synthetic'},
    attachments: {cursor: new Blob(['cursor'], {type: 'application/octet-stream'})},
  };
}
async function contents(cache) {
  const cached = await cache.open('game');
  return new TextDecoder().decode(
    await cached.files[0].source.read(0, cached.files[0].source.size),
  );
}
async function generations(backing) {
  const directory = await (
    await backing.root.getDirectoryHandle('vn-web-engine-installations')
  ).getDirectoryHandle('installation-game');
  return [...directory.children.values()].filter((entry) => entry.kind === 'directory');
}

test('installation cache streams bounded ranges and reopens worker-compatible local files', async () => {
  const backing = storage(),
    cache = new BrowserInstallationCache(backing),
    ranges = [],
    progress = [],
    input = installation(''),
    size = 9 * 1024 * 1024 + 17;
  input.files[0].source = {
    size,
    async read(offset, length) {
      assert.ok(length <= 4 * 1024 * 1024);
      ranges.push([offset, length]);
      return Uint8Array.from({length}, (_, index) => (offset + index) % 251);
    },
  };
  const unrelated = await backing.root.getDirectoryHandle('saves-and-registry', {create: true});
  assert.equal(cache.available(), true);
  assert.equal(await cache.open('game'), null);
  assert.deepEqual(await cache.save('game', input, {progress: (value) => progress.push(value)}), {
    persistent: true,
  });
  const cached = await new BrowserInstallationCache(backing).open('game');
  assert.equal(ranges.length, 3);
  assert.equal(
    ranges.reduce((total, [, length]) => total + length, 0),
    size,
  );
  assert.ok(cached.files[0].source instanceof BlobSource);
  assert.deepEqual(
    [...(await cached.files[0].source.read(size - 3, 3))],
    [size - 3, size - 2, size - 1].map((n) => n % 251),
  );
  assert.equal(cached.files[0].lastModifiedMs, 1234);
  assert.deepEqual(cached.metadata, input.metadata);
  assert.equal(await cached.attachments.cursor.text(), 'cursor');
  assert.equal(cached.attachments.cursor.type, 'application/octet-stream');
  assert.equal(progress.at(-1).completedBytes, size + 6);
  assert.equal(progress.at(-1).totalBytes, size + 6);
  await cache.remove('game');
  assert.equal(await cache.open('game'), null);
  assert.equal(await backing.root.getDirectoryHandle('saves-and-registry'), unrelated);
});

test('installation cache preserves empty directories and reads older manifests without them', async () => {
  const backing = storage(),
    cache = new BrowserInstallationCache(backing),
    input = installation('directory payload');
  input.directories = ['/UserData', '/Nested/Empty'];
  await cache.save('game', input);
  const cached = await cache.open('game');
  assert.deepEqual(cached.directories, input.directories);
  cached.directories.push('/caller-owned');
  assert.deepEqual((await cache.open('game')).directories, input.directories);

  const [generation] = await generations(backing),
    manifestFile = await generation.getFileHandle('manifest.json'),
    savedManifest = JSON.parse(await manifestFile.contents.text());
  delete savedManifest.directories;
  manifestFile.contents = new Blob([JSON.stringify(savedManifest)]);
  const older = await cache.open('game');
  assert.equal(older.directories, undefined);
  assert.equal(
    await older.files[0].source
      .read(0, older.files[0].source.size)
      .then((b) => new TextDecoder().decode(b)),
    'directory payload',
  );
});

test('installation cache rejects unsafe, duplicate, and file-conflicting directories', async () => {
  for (const directories of [
    ['relative'],
    ['/outside/../path'],
    ['/duplicate', '/duplicate'],
    ['/data/archive.bin/child'],
  ]) {
    const backing = storage(),
      cache = new BrowserInstallationCache(backing),
      input = installation('payload');
    input.files = [
      {path: '/data/archive.bin', source: new BlobSource(new Blob(['payload'])), lastModifiedMs: 1},
    ];
    input.directories = directories;
    await assert.rejects(
      cache.save('game', input),
      /Invalid browser installation cache directory|Conflicting browser installation cache paths/,
    );
    assert.equal(await cache.open('game'), null);
  }
});

test('cancelled or failed replacement retains the previous installation and removes partial data', async () => {
  const backing = storage(),
    cache = new BrowserInstallationCache(backing);
  await cache.save('game', installation('old'));
  const controller = new AbortController();
  await assert.rejects(
    cache.save('game', installation('cancelled'), {
      signal: controller.signal,
      progress: ({completedBytes}) => {
        if (completedBytes > 0) controller.abort();
      },
    }),
    {name: 'AbortError'},
  );
  assert.equal(await contents(cache), 'old');
  assert.equal((await generations(backing)).length, 1);

  // The last publication fails after all staged file data and its manifest were written.
  const rootStorage = backing.root.storage;
  rootStorage.beforeClose = async (name) => {
    if (name === 'current.json') throw new DOMException('Disk full', 'QuotaExceededError');
  };
  await assert.rejects(cache.save('game', installation('failed')), {name: 'QuotaExceededError'});
  assert.equal(await contents(cache), 'old');
  assert.equal((await generations(backing)).length, 1);
  rootStorage.beforeClose = undefined;
  await cache.save('game', installation('new'));
  assert.equal(await contents(cache), 'new');
  assert.equal((await generations(backing)).length, 1);
});

test('quota admission is optional while an incomplete committed cache is rejected', async () => {
  const backing = storage(),
    cache = new BrowserInstallationCache(backing);
  backing.estimate = async () => ({quota: 1, usage: 0});
  await assert.rejects(cache.save('game', installation('payload')), /Not enough browser storage/);
  assert.equal(await cache.open('game'), null);
  backing.estimate = async () => {
    throw new Error('Estimates unavailable');
  };
  backing.persist = async () => {
    throw new Error('Persistence unavailable');
  };
  assert.deepEqual(await cache.save('game', installation('payload')), {persistent: false});
  const [generation] = await generations(backing);
  (await generation.getFileHandle('file-0')).contents = new Blob(['truncated']);
  await assert.rejects(cache.open('game'), /Incomplete browser installation cache/);
});

test('concurrent callers serialize replacement until its source has finished streaming', async () => {
  const backing = storage(),
    first = new BrowserInstallationCache(backing),
    second = new BrowserInstallationCache(backing),
    input = installation('first'),
    source = input.files[0].source;
  let release, started;
  const waiting = new Promise((resolve) => {
      release = resolve;
    }),
    reading = new Promise((resolve) => {
      started = resolve;
    });
  input.files[0].source = {
    size: source.size,
    async read(offset, length) {
      started();
      await waiting;
      return source.read(offset, length);
    },
  };
  const firstSave = first.save('game', input);
  await reading;
  const secondSave = second.save('game', installation('second'));
  release();
  await Promise.all([firstSave, secondSave]);
  assert.equal(await contents(first), 'second');
  assert.equal((await generations(backing)).length, 1);
});

test('cancelling a server installation interrupts the pending range and retains the saved copy', async (t) => {
  const backing = storage(),
    cache = new BrowserInstallationCache(backing),
    input = installation(''),
    controller = new AbortController(),
    activity = [];
  await cache.save('game', installation('old'));
  input.files[0].source = new HttpSource('https://synthetic.invalid/archive', 100);
  const unsubscribe = subscribeSourceActivity((value) => activity.push(value));
  t.after(unsubscribe);
  let reading;
  const started = new Promise((resolve) => {
    reading = resolve;
  });
  t.mock.method(globalThis, 'fetch', async (_url, {headers, signal}) => {
    assert.equal(headers.Range, 'bytes=0-99');
    assert.equal(signal, controller.signal);
    reading();
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), {once: true});
    });
  });
  const saving = cache.save('game', input, {signal: controller.signal});
  await started;
  assert.equal(activity.at(-1).pending, 1);
  controller.abort();
  await assert.rejects(saving, {name: 'AbortError'});
  assert.equal(activity.at(-1).pending, 0);
  assert.equal(await contents(cache), 'old');
});
