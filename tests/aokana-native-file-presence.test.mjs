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
import {AokanaResourceFilePresence} from '../dist/engines/buriko/games/aokana/native/resource-file-presence.js';
import {createGroup80FilePresence} from '../dist/engines/buriko/games/aokana/native/group-80-file-presence.js';
import {AokanaLocalizedMessages} from '../dist/engines/buriko/games/aokana/native/localized-messages.js';
import {AokanaImportedTextMaps} from '../dist/engines/buriko/games/aokana/native/imported-text-maps.js';
import {AokanaNativeLanguage} from '../dist/engines/buriko/games/aokana/native/group-81-language.js';
import {
  AokanaDistributedAllocator,
  AokanaDistributedProcessing,
} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {AokanaEngineErrors} from '../dist/engines/buriko/games/aokana/native/engine-errors.js';
import {AokanaEngineDialogs} from '../dist/engines/buriko/games/aokana/native/engine-dialogs.js';

test('80:3c sees an ordinary empty file under the shared wide resource root without consuming unused modal pointers', async () => {
  const fs = new StoredFileSystem(new MemoryStore(), (path) => path.toLowerCase());
  await fs.commit([{kind: 'write', path: '/native/資料.bin', data: new Uint8Array()}]);
  const text = new AokanaNativeText(),
    media = new AokanaProgramMedia();
  media.setDriveType(2, 3);
  const files = new AokanaProgramFiles(
      fs,
      text,
      media,
      new AokanaMountedProgramPaths([{native: 'C:\\', mounted: '/'}], 'C:\\'),
    ),
    dialogs = new AokanaEngineDialogs(),
    errors = new AokanaEngineErrors(files, dialogs, Uint8Array.of(0), Uint8Array.of(0)),
    processing = new AokanaDistributedProcessing(new AokanaDistributedAllocator(1), 1);
  const resources = new AokanaProgramResources(
    files,
    {
      nativeFileRoot: 'C:\\native\\',
      primaryRoot: text.encodeWide('C:\\other\\', 1),
      secondaryRoot: Uint8Array.of(0),
      secondaryMediaPath: '',
      searchDirectoriesEnabled: 1,
      searchDirectories: [text.encodeWide('irrelevant', 1)],
      retryTitle: Uint8Array.of(0),
      retryMessage: Uint8Array.of(0),
      quitConfirmation: Uint8Array.of(0),
    },
    dialogs,
    errors,
    processing,
  );
  const messages = new AokanaLocalizedMessages(
      text,
      new AokanaNativeLanguage(() => 0x411),
      new AokanaImportedTextMaps(text),
    ),
    presence = new AokanaResourceFilePresence(resources, messages),
    [slot] = createGroup80FilePresence(presence),
    bytes = new Uint8Array(128),
    memory = new AokanaBpMemory(bytes),
    thread = new AokanaBpThread({id: 1, operandCapacity: 8, moduleCapacity: 0, frameCapacity: 0});
  bytes.set(text.encodeWide('資料.bin', 0), 16);
  // Actual engine/localized owners are composed; this existing-file branch never opens UI.
  push32(thread, 16);
  push32(thread, 0);
  push32(thread, 0);
  assert.equal(await slot.execute({thread, memory}), 0);
  assert.equal(pop32(thread), 1);
  assert.equal(thread.stackIndex, 0);
  assert.equal((await fs.stat('/native/資料.bin')).size, 0);
  assert.equal(resources.configuration.nativeFileRoot, 'C:\\native\\');
  processing.dispose();
});
