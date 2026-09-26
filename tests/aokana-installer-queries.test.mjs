import test from 'node:test';
import assert from 'node:assert/strict';
import {StoredFileSystem} from '../dist/platform/filesystem.js';
import {MemoryStore} from '../dist/platform/store.js';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, pop32, push32} from '../dist/engines/buriko/bp/state.js';
import {BurikoNativeClock} from '../dist/engines/buriko/native/clock.js';
import {
  BurikoDistributedAllocator,
  BurikoDistributedProcessing,
} from '../dist/engines/buriko/native/distributed-processing.js';
import {BurikoEngineDialogs} from '../dist/engines/buriko/native/engine-dialogs.js';
import {BurikoEngineErrors} from '../dist/engines/buriko/native/engine-errors.js';
import {createGroup80InstallerQueries} from '../dist/engines/buriko/native/group-80-installer-queries.js';
import {BurikoNativeLanguage} from '../dist/engines/buriko/native/group-81-language.js';
import {BurikoImportedTextMaps} from '../dist/engines/buriko/native/imported-text-maps.js';
import {BurikoInstallationService} from '../dist/engines/buriko/native/installation.js';
import {BurikoInstallerQueries} from '../dist/engines/buriko/native/installer-queries.js';
import {BURIKO_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/native/inventory.js';
import {BurikoLocalizedMessages} from '../dist/engines/buriko/native/localized-messages.js';
import {BurikoNativeNotifications} from '../dist/engines/buriko/native/notification-queue.js';
import {
  BurikoProgramFiles,
  BurikoProgramMedia,
} from '../dist/engines/buriko/native/program-files.js';
import {BurikoMountedProgramPaths} from '../dist/engines/buriko/native/program-paths.js';
import {BurikoProgramResources} from '../dist/engines/buriko/native/program-resources.js';
import {BurikoProcedureState} from '../dist/engines/buriko/native/procedure.js';
import {BurikoResourceLoadingState} from '../dist/engines/buriko/native/resource-loading.js';
import {BurikoSpecialFolders} from '../dist/engines/buriko/native/special-folders.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';
import {BurikoNativeRegistry} from '../dist/engines/buriko/native/windows-registry.js';

test('installer queries share installation registry and mounted Windows marker paths with real file consumers', async () => {
  const text = new BurikoNativeText(),
    encode = (s) => text.encodeWide(s, 1),
    backing = new StoredFileSystem(new MemoryStore(), (s) => s.toLowerCase()),
    registry = new BurikoNativeRegistry(new MemoryStore()),
    files = new BurikoProgramFiles(
      backing,
      text,
      new BurikoProgramMedia(),
      new BurikoMountedProgramPaths([{native: 'C:\\', mounted: '/'}], 'C:\\'),
    ),
    dialogs = new BurikoEngineDialogs(),
    errors = new BurikoEngineErrors(files, dialogs, encode('C:\\save\\'), encode('C:\\')),
    processing = new BurikoDistributedProcessing(new BurikoDistributedAllocator(1), 1),
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
    resources = new BurikoProgramResources(files, roots, dialogs, errors, processing),
    folders = new BurikoSpecialFolders(text, registry, roots, {
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
    installation = new BurikoInstallationService(
      resources,
      new BurikoResourceLoadingState(resources),
      new BurikoProcedureState(),
      new BurikoNativeClock(() => 100),
      new BurikoNativeNotifications(),
      new BurikoLocalizedMessages(
        text,
        new BurikoNativeLanguage(() => 0x409),
        new BurikoImportedTextMaps(text),
      ),
      registry,
    ),
    memory = new BurikoBpMemory(new Uint8Array(2048)),
    thread = new BurikoBpThread({id: 1, operandCapacity: 8, moduleCapacity: 0, frameCapacity: 0}),
    slots = createGroup80InstallerQueries(new BurikoInstallerQueries(registry, folders, files)),
    pointer = (offset) => ({bytes: memory.globalMemory, offset}),
    call = async (secondary, args, result = 1) => {
      const slot = slots.find((s) => s.secondary === secondary);
      assert.equal(slot.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[0x80][secondary]);
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
  memory.globalMemory.set(encode('Buriko'), 64);
  memory.globalMemory.set(encode('aokana.path'), 96);
  try {
    await installation.writeRegistry({
      publisher: encode('Sprite'),
      product: encode('Buriko'),
      destinationRoot: encode('C:\\installed'),
    });
    await call(0xf8, [256, 32, 64]);
    assert.equal(text.decodeAuto(pointer(256)), 'C:\\installed');
    await call(0xf9, [32, 64]);
    assert.equal(
      await registry.storage.hasKey({hive: 'HKLM', view: '64', path: 'Software\\Sprite\\Buriko'}),
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
