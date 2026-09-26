import test from 'node:test';
import assert from 'node:assert/strict';
import {StoredFileSystem} from '../dist/platform/filesystem.js';
import {MemoryStore} from '../dist/platform/store.js';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaNativeClock} from '../dist/engines/buriko/games/aokana/native/clock.js';
import {
  AokanaDistributedAllocator,
  AokanaDistributedProcessing,
} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {AokanaEngineDialogs} from '../dist/engines/buriko/games/aokana/native/engine-dialogs.js';
import {AokanaEngineErrors} from '../dist/engines/buriko/games/aokana/native/engine-errors.js';
import {createGroup80InstallerQueries} from '../dist/engines/buriko/games/aokana/native/group-80-installer-queries.js';
import {AokanaNativeLanguage} from '../dist/engines/buriko/games/aokana/native/group-81-language.js';
import {AokanaImportedTextMaps} from '../dist/engines/buriko/games/aokana/native/imported-text-maps.js';
import {AokanaInstallationService} from '../dist/engines/buriko/games/aokana/native/installation.js';
import {AokanaInstallerQueries} from '../dist/engines/buriko/games/aokana/native/installer-queries.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';
import {AokanaLocalizedMessages} from '../dist/engines/buriko/games/aokana/native/localized-messages.js';
import {AokanaNativeNotifications} from '../dist/engines/buriko/games/aokana/native/notification-queue.js';
import {
  AokanaProgramFiles,
  AokanaProgramMedia,
} from '../dist/engines/buriko/games/aokana/native/program-files.js';
import {AokanaMountedProgramPaths} from '../dist/engines/buriko/games/aokana/native/program-paths.js';
import {AokanaProgramResources} from '../dist/engines/buriko/games/aokana/native/program-resources.js';
import {AokanaProcedureState} from '../dist/engines/buriko/games/aokana/native/procedure.js';
import {AokanaResourceLoadingState} from '../dist/engines/buriko/games/aokana/native/resource-loading.js';
import {AokanaSpecialFolders} from '../dist/engines/buriko/games/aokana/native/special-folders.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {AokanaNativeRegistry} from '../dist/engines/buriko/games/aokana/native/windows-registry.js';

test('installer queries share installation registry and mounted Windows marker paths with real file consumers', async () => {
  const text = new AokanaNativeText(),
    encode = (s) => text.encodeWide(s, 1),
    backing = new StoredFileSystem(new MemoryStore(), (s) => s.toLowerCase()),
    registry = new AokanaNativeRegistry(new MemoryStore()),
    files = new AokanaProgramFiles(
      backing,
      text,
      new AokanaProgramMedia(),
      new AokanaMountedProgramPaths([{native: 'C:\\', mounted: '/'}], 'C:\\'),
    ),
    dialogs = new AokanaEngineDialogs(),
    errors = new AokanaEngineErrors(files, dialogs, encode('C:\\save\\'), encode('C:\\')),
    processing = new AokanaDistributedProcessing(new AokanaDistributedAllocator(1), 1),
    roots = {
      nativeFileRoot: 'C:\\',
      primaryRoot: encode('C:\\'),
      secondaryRoot: Uint8Array.of(0),
      secondaryMediaPath: '',
      searchDirectoriesEnabled: 0,
      searchDirectories: [],
      retryTitle: encode('Media'),
      retryMessage: encode('Insert'),
      quitConfirmation: encode('Quit?'),
    },
    resources = new AokanaProgramResources(files, roots, dialogs, errors, processing),
    folders = new AokanaSpecialFolders(text, registry, roots, {
      shellAllocatorAvailable: true,
      windows: 'C:\\Windows',
      programFiles: 'C:\\Programs',
      currentUser: {desktop: null, programs: null, documents: null, profile: null},
      shellUser: {desktop: null, programs: null, documents: null, profile: null},
      elevated: false,
      shellTokenAvailable: false,
      debugPrivilegeAvailable: false,
      shellAccountName: null,
    }),
    installation = new AokanaInstallationService(
      resources,
      new AokanaResourceLoadingState(resources),
      new AokanaProcedureState(),
      new AokanaNativeClock(() => 100),
      new AokanaNativeNotifications(),
      new AokanaLocalizedMessages(
        text,
        new AokanaNativeLanguage(() => 0x409),
        new AokanaImportedTextMaps(text),
      ),
      registry,
    ),
    memory = new AokanaBpMemory(new Uint8Array(2048)),
    thread = new AokanaBpThread({id: 1, operandCapacity: 8, moduleCapacity: 0, frameCapacity: 0}),
    slots = createGroup80InstallerQueries(new AokanaInstallerQueries(registry, folders, files)),
    pointer = (offset) => ({bytes: memory.globalMemory, offset}),
    call = async (secondary, args, result = 1) => {
      const slot = slots.find((s) => s.secondary === secondary);
      assert.equal(slot.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[0x80][secondary]);
      args.forEach((arg) => push32(thread, arg));
      assert.equal(await slot.execute({thread, memory, diagnostics: {}}), 0);
      if (result !== null) assert.equal(pop32(thread), result);
      assert.equal(thread.stackIndex, 0);
    };
  await backing.commit([
    {kind: 'write', path: '/Windows/aokana.path', data: encode('C:\\installed\\')},
    {kind: 'write', path: '/installed/content.txt', data: encode('installed data')},
  ]);
  memory.globalMemory.set(encode('Sprite'), 32);
  memory.globalMemory.set(encode('Aokana'), 64);
  memory.globalMemory.set(encode('aokana.path'), 96);
  try {
    await installation.writeRegistry({
      publisher: encode('Sprite'),
      product: encode('Aokana'),
      destinationRoot: encode('C:\\installed'),
    });
    await call(0xf8, [256, 32, 64]);
    assert.equal(text.decodeAuto(pointer(256)), 'C:\\installed');
    await call(0xf9, [32, 64]);
    assert.equal(
      await registry.storage.hasKey({hive: 'HKLM', view: '64', path: 'Software\\Sprite\\Aokana'}),
      false,
    );
    await call(0xfb, [512], null);
    assert.equal(text.decodeAuto(pointer(512)), 'C:\\Windows');
    await call(0xfa, [768, 96]);
    assert.equal(text.decodeAuto(pointer(768)), 'C:\\installed');
    folders.combine(pointer(1024), pointer(768), 1, {bytes: encode('content.txt'), offset: 0});
    const opened = await files.open(memory.globalMemory.subarray(1024));
    assert.notEqual(opened.source, null);
    assert.deepEqual(
      await files.read(opened.source, 0, opened.source.size),
      encode('installed data'),
    );
    await call(0xfe, []);
  } finally {
    processing.dispose();
  }
});
