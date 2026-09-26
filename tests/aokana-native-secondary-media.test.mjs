import test from 'node:test';
import assert from 'node:assert/strict';
import {StoredFileSystem} from '../dist/platform/filesystem.js';
import {MemoryStore} from '../dist/platform/store.js';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {
  AokanaProgramFiles,
  AokanaProgramMedia,
} from '../dist/engines/buriko/games/aokana/native/program-files.js';
import {AokanaMountedProgramPaths} from '../dist/engines/buriko/games/aokana/native/program-paths.js';
import {AokanaProgramResources} from '../dist/engines/buriko/games/aokana/native/program-resources.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {AokanaEngineDialogs} from '../dist/engines/buriko/games/aokana/native/engine-dialogs.js';
import {AokanaEngineErrors} from '../dist/engines/buriko/games/aokana/native/engine-errors.js';
import {AokanaLocalizedMessages} from '../dist/engines/buriko/games/aokana/native/localized-messages.js';
import {AokanaNativeLanguage} from '../dist/engines/buriko/games/aokana/native/group-81-language.js';
import {AokanaImportedTextMaps} from '../dist/engines/buriko/games/aokana/native/imported-text-maps.js';
import {
  AokanaDistributedAllocator,
  AokanaDistributedProcessing,
} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {AokanaSecondaryMediaDiscovery} from '../dist/engines/buriko/games/aokana/native/secondary-media.js';
import {createGroup80SecondaryMedia} from '../dist/engines/buriko/games/aokana/native/group-80-secondary-media.js';

test('80:3F discovers the first eligible mounted marker and publishes the actual secondary resource path', async () => {
  const fs = new StoredFileSystem(new MemoryStore(), (p) => p.toLowerCase()),
    text = new AokanaNativeText(),
    encode = (s) => text.encodeWide(s, 1),
    events = [],
    payload = Uint8Array.of(11, 22, 33, 44, 55);
  await fs.commit([
    {kind: 'write', path: '/c/data/marker', data: Uint8Array.of(1)},
    {kind: 'write', path: '/e/data/marker', data: Uint8Array.of(1)},
    {kind: 'write', path: '/f/data/marker', data: Uint8Array.of(1)},
    {kind: 'write', path: '/e/data/hello.bin', data: payload},
  ]);
  const media = new AokanaProgramMedia();
  media.setDriveType(2, 3);
  for (const index of [3, 4, 5]) {
    media.setDriveType(index, 2);
    media.mediaPresent[index] = 1;
  }
  const available = media.isAvailable.bind(media);
  media.isAvailable = (path) => {
    events.push(['media', path]);
    return available(path);
  };
  const files = new AokanaProgramFiles(
      fs,
      text,
      media,
      new AokanaMountedProgramPaths(
        ['C', 'D', 'E', 'F'].map((letter) => ({
          native: letter + ':\\',
          mounted: '/' + letter.toLowerCase(),
        })),
        'C:\\',
      ),
    ),
    stat = files.hasPathWide.bind(files);
  files.hasPathWide = async (path) => {
    events.push(['stat', path]);
    return stat(path);
  };
  const dialogs = new AokanaEngineDialogs(),
    errors = new AokanaEngineErrors(files, dialogs, encode('C:\\save\\'), encode('C:\\')),
    processing = new AokanaDistributedProcessing(new AokanaDistributedAllocator(1), 1),
    config = {
      nativeFileRoot: 'C:\\assets\\',
      primaryRoot: encode('C:\\assets\\'),
      secondaryRoot: Uint8Array.of(0),
      secondaryMediaPath: '',
      searchDirectoriesEnabled: 0,
      searchDirectories: [],
      retryTitle: Uint8Array.of(0),
      retryMessage: Uint8Array.of(0),
      quitConfirmation: Uint8Array.of(0),
    },
    resources = new AokanaProgramResources(files, config, dialogs, errors, processing),
    localized = new AokanaLocalizedMessages(
      text,
      new AokanaNativeLanguage(() => 0x409),
      new AokanaImportedTextMaps(text),
    ),
    drives = {
      readLogicalDriveStrings() {
        events.push(['enumerate']);
        return ['C:\\', 'D:\\', 'E:\\', 'F:\\'];
      },
      readDriveType(root) {
        events.push(['type', root]);
        return root === 'C:\\' ? 3 : root === 'E:\\' ? 5 : 2;
      },
    },
    timing = {
      async sleep(milliseconds) {
        events.push(['sleep', milliseconds]);
        await new Promise((resolve) => setTimeout(resolve, milliseconds));
      },
    },
    window = {
      pumpMessages() {
        events.push(['pump']);
        return 0;
      },
    },
    discovery = new AokanaSecondaryMediaDiscovery(resources, localized, drives, timing, window),
    [slot] = createGroup80SecondaryMedia(discovery),
    memory = new AokanaBpMemory(new Uint8Array(0x1000)),
    thread = new AokanaBpThread({
      id: 1,
      operandCapacity: 16,
      moduleCapacity: 4096,
      frameCapacity: 0,
    });
  const put = (offset, s) => {
    thread.moduleMemory.set(encode(s), offset);
    return 0x10000000 + offset;
  };
  try {
    for (const value of [
      put(16, 'data\\marker'),
      put(80, 'Resource media'),
      put(160, 'Insert resource media'),
      1,
    ])
      push32(thread, value);
    assert.equal(await slot.execute({thread, memory}), 0);
    assert.equal(pop32(thread), 1);
    assert.equal(thread.stackIndex, 0);
    assert.deepEqual(events, [
      ['enumerate'],
      ['type', 'C:\\'],
      ['type', 'D:\\'],
      ['type', 'E:\\'],
      ['type', 'F:\\'],
      ['media', 'D:\\'],
      ['stat', 'D:\\data\\marker'],
      ['media', 'E:\\'],
      ['stat', 'E:\\data\\marker'],
    ]);
    assert.equal(config.secondaryMediaPath, 'E:\\data\\');
    assert.deepEqual(config.secondaryRoot, encode('E:\\data\\'));
    assert.deepEqual(config.retryTitle, encode('Resource media'));
    assert.deepEqual(config.retryMessage, encode('Insert resource media'));
    assert.deepEqual(config.primaryRoot, encode('C:\\assets\\'));
    thread.moduleMemory.fill(0, 80, 240);
    assert.deepEqual(config.retryTitle, encode('Resource media'));
    assert.deepEqual(config.retryMessage, encode('Insert resource media'));
    const result = await resources.load(null, encode('hello.bin'), false);
    assert.equal(result.result, payload.length);
    assert.deepEqual(result.bytes, payload);
    assert.deepEqual(Array.from(media.driveTypes).slice(2, 6), [3, 2, 2, 2]);
  } finally {
    await processing.dispose();
  }
});
