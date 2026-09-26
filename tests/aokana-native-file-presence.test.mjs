import test from 'node:test';
import assert from 'node:assert/strict';
import {StoredFileSystem} from '../dist/platform/filesystem.js';
import {MemoryStore} from '../dist/platform/store.js';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, pop32, push32} from '../dist/engines/buriko/bp/state.js';
import {
  BurikoProgramFiles,
  BurikoProgramMedia,
} from '../dist/engines/buriko/native/program-files.js';
import {BurikoMountedProgramPaths} from '../dist/engines/buriko/native/program-paths.js';
import {BurikoProgramResources} from '../dist/engines/buriko/native/program-resources.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';
import {BurikoResourceFilePresence} from '../dist/engines/buriko/native/resource-file-presence.js';
import {createGroup80FilePresence} from '../dist/engines/buriko/native/group-80-file-presence.js';
import {BurikoLocalizedMessages} from '../dist/engines/buriko/native/localized-messages.js';
import {BurikoImportedTextMaps} from '../dist/engines/buriko/native/imported-text-maps.js';
import {BurikoNativeLanguage} from '../dist/engines/buriko/native/group-81-language.js';
import {
  BurikoDistributedAllocator,
  BurikoDistributedProcessing,
} from '../dist/engines/buriko/native/distributed-processing.js';
import {BurikoEngineErrors} from '../dist/engines/buriko/native/engine-errors.js';
import {BurikoEngineDialogs} from '../dist/engines/buriko/native/engine-dialogs.js';

test('80:3c sees an ordinary empty file under the shared wide resource root without consuming unused modal pointers', async () => {
  const fs = new StoredFileSystem(new MemoryStore(), (path) => path.toLowerCase());
  await fs.commit([{kind: 'write', path: '/native/資料.bin', data: new Uint8Array()}]);
  const text = new BurikoNativeText(),
    media = new BurikoProgramMedia();
  media.setDriveType(2, 3);
  const files = new BurikoProgramFiles(
      fs,
      text,
      media,
      new BurikoMountedProgramPaths([{native: 'C:\\', mounted: '/'}], 'C:\\'),
    ),
    dialogs = new BurikoEngineDialogs(),
    errors = new BurikoEngineErrors(files, dialogs, Uint8Array.of(0), Uint8Array.of(0)),
    processing = new BurikoDistributedProcessing(new BurikoDistributedAllocator(1), 1);
  const resources = new BurikoProgramResources(
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
  const messages = new BurikoLocalizedMessages(
      text,
      new BurikoNativeLanguage(() => 0x411),
      new BurikoImportedTextMaps(text),
    ),
    presence = new BurikoResourceFilePresence(resources, messages),
    [slot] = createGroup80FilePresence(presence),
    bytes = new Uint8Array(128),
    memory = new BurikoBpMemory(bytes),
    thread = new BurikoBpThread({id: 1, operandCapacity: 8, moduleCapacity: 0, frameCapacity: 0});
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
