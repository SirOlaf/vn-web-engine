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
import {
  AokanaDistributedAllocator,
  AokanaDistributedProcessing,
} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {AokanaFileChecksum} from '../dist/engines/buriko/games/aokana/native/file-checksum.js';
import {createGroup80FileChecksum} from '../dist/engines/buriko/games/aokana/native/group-80-file-checksum.js';

test('80:E9 streams an actual file beyond64KiB through primary-root and qualified paths into the shared checksum', async () => {
  const fs = new StoredFileSystem(new MemoryStore(), (p) => p.toLowerCase()),
    payload = Uint8Array.from({length: 65536 + 137}, (_, i) => (i * 17 + (i >>> 8)) & 255),
    text = new AokanaNativeText(),
    encode = (s) => text.encodeWide(s, 1),
    media = new AokanaProgramMedia();
  await fs.commit([{kind: 'write', path: '/assets/content.bin', data: payload}]);
  media.setDriveType(2, 3);
  const files = new AokanaProgramFiles(
      fs,
      text,
      media,
      new AokanaMountedProgramPaths([{native: 'C:\\', mounted: '/'}], 'C:\\'),
    ),
    dialogs = new AokanaEngineDialogs(),
    errors = new AokanaEngineErrors(files, dialogs, encode('C:\\save\\'), encode('C:\\')),
    processing = new AokanaDistributedProcessing(new AokanaDistributedAllocator(1), 1),
    resources = new AokanaProgramResources(
      files,
      {
        nativeFileRoot: 'C:\\other\\',
        primaryRoot: encode('C:\\assets\\'),
        secondaryRoot: Uint8Array.of(0),
        secondaryMediaPath: '',
        searchDirectoriesEnabled: 0,
        searchDirectories: [],
        retryTitle: Uint8Array.of(0),
        retryMessage: Uint8Array.of(0),
        quitConfirmation: Uint8Array.of(0),
      },
      dialogs,
      errors,
      processing,
    ),
    [slot] = createGroup80FileChecksum(new AokanaFileChecksum(resources)),
    memory = new AokanaBpMemory(new Uint8Array(0x1000)),
    thread = new AokanaBpThread({
      id: 1,
      operandCapacity: 8,
      moduleCapacity: 4096,
      frameCapacity: 0,
    });
  let rolling = 0n,
    sumRolling = 0,
    xorRolling = 0,
    sumBytes = 0,
    xorBytes = 0;
  for (const value of payload) {
    rolling = (rolling * 233n + BigInt(value)) & 0xffffffffn;
    const low = Number(rolling & 255n);
    sumRolling = (sumRolling + low) & 255;
    xorRolling ^= low;
    sumBytes = (sumBytes + value) & 255;
    xorBytes ^= value;
  }
  const expected = new Uint8Array(8);
  new DataView(expected.buffer).setUint32(0, Number(rolling), true);
  expected.set([sumRolling, xorRolling, sumBytes, xorBytes], 4);
  try {
    for (const name of ['content.bin', 'C:\\assets\\content.bin']) {
      thread.moduleMemory.set(encode(name), 16);
      thread.moduleMemory.fill(0xa5, 255, 265);
      push32(thread, 0x10000100);
      push32(thread, 0x10000010);
      assert.equal(await slot.execute({thread, memory}), 0);
      assert.equal(pop32(thread), 1);
      assert.equal(thread.stackIndex, 0);
      assert.deepEqual(thread.moduleMemory.subarray(256, 264), expected);
      assert.equal(thread.moduleMemory[255], 0xa5);
      assert.equal(thread.moduleMemory[264], 0xa5);
    }
  } finally {
    await processing.dispose();
  }
});
