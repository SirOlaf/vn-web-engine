import assert from 'node:assert/strict';
import test from 'node:test';
import {StoredFileSystem} from '../dist/platform/filesystem.js';
import {MemoryStore} from '../dist/platform/store.js';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpScheduler} from '../dist/engines/buriko/games/aokana/bp/scheduler.js';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaNativeClock} from '../dist/engines/buriko/games/aokana/native/clock.js';
import {
  AokanaDistributedAllocator,
  AokanaDistributedProcessing,
} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {AokanaMountedFileMetadata} from '../dist/engines/buriko/games/aokana/native/file-metadata.js';
import {createGroup81Installation} from '../dist/engines/buriko/games/aokana/native/group-81-installation.js';
import {AokanaNativeLanguage} from '../dist/engines/buriko/games/aokana/native/group-81-language.js';
import {AokanaImportedTextMaps} from '../dist/engines/buriko/games/aokana/native/imported-text-maps.js';
import {AokanaInstallationService} from '../dist/engines/buriko/games/aokana/native/installation.js';
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
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {AokanaNativeRegistry} from '../dist/engines/buriko/games/aokana/native/windows-registry.js';

const bytes = (value) => new TextEncoder().encode(value);
const ticks = (iso) => BigInt(Date.parse(iso)) * 10000n + 116444736000000000n;

async function contents(files, path) {
  const source = await files.open(path);
  return new Uint8Array(await source.read(0, source.size));
}

function wideValue(value) {
  return new TextDecoder('utf-16le').decode(value.data).replace(/\0.*$/s, '');
}

test('81 F2 installs one ordinary mounted file and completes through the real wait process', async () => {
  const store = new MemoryStore(),
    canonical = (path) => path.toLowerCase(),
    backing = new StoredFileSystem(store, canonical),
    payload = Uint8Array.of(2, 3, 5, 7, 11, 13),
    uninstaller = bytes('mounted uninstaller');
  await backing.commit([
    {kind: 'write', path: '/media/disc.id', data: bytes('disc')},
    {kind: 'write', path: '/media/data.bin', data: payload},
    {kind: 'write', path: '/media/uninstall.exe', data: uninstaller},
  ]);
  const base = ticks('2026-09-13T00:00:00.000Z'),
    sourceTimes = {
      creationTime: base,
      accessTime: base + 10_000n,
      writeTime: base + 20_000n,
    },
    fileRecord = (path) => ({
      path,
      kind: 'file',
      attributes: 0x20,
      ...sourceTimes,
    }),
    metadata = new AokanaMountedFileMetadata(backing, {
      records: [
        {
          path: '/',
          kind: 'directory',
          attributes: 0x10,
          creationTime: base,
          accessTime: base,
          writeTime: base,
        },
        {
          path: '/media',
          kind: 'directory',
          attributes: 0x10,
          creationTime: base,
          accessTime: base,
          writeTime: base,
        },
        fileRecord('/media/disc.id'),
        fileRecord('/media/data.bin'),
        fileRecord('/media/uninstall.exe'),
      ],
      volumes: [{path: '/', identity: {}, writable: true}],
      canonical,
      currentFileTime: () => base + 30_000n,
      accessTimePolicy: 'disabled',
    }),
    text = new AokanaNativeText(),
    media = new AokanaProgramMedia(),
    paths = new AokanaMountedProgramPaths([{native: 'C:\\', mounted: '/'}], 'C:\\'),
    files = new AokanaProgramFiles(metadata, text, media, paths),
    noDialog = () => assert.fail('Ordinary installation opened a diagnostic'),
    resources = new AokanaProgramResources(
      files,
      {
        nativeFileRoot: 'C:\\media\\',
        primaryRoot: bytes('C:\\media\\\0'),
        secondaryRoot: Uint8Array.of(0),
        secondaryMediaPath: '',
        searchDirectoriesEnabled: 0,
        searchDirectories: [],
        retryTitle: bytes('Media\0'),
        retryMessage: bytes('Insert\0'),
        quitConfirmation: bytes('Quit?\0'),
      },
      {show: noDialog},
      {fatal: noDialog, threadFatal: noDialog},
      new AokanaDistributedProcessing(new AokanaDistributedAllocator(1), 1),
    ),
    loading = new AokanaResourceLoadingState(resources),
    notifications = new AokanaNativeNotifications(),
    localized = new AokanaLocalizedMessages(
      text,
      new AokanaNativeLanguage(() => 0x409),
      new AokanaImportedTextMaps(text),
    ),
    registry = new AokanaNativeRegistry(new MemoryStore()),
    progress = [],
    thread = new AokanaBpThread({
      id: 1,
      operandCapacity: 32,
      moduleCapacity: 0,
      frameCapacity: 0,
    }),
    memory = new AokanaBpMemory(new Uint8Array(0x400)),
    scheduler = new AokanaBpScheduler(thread, () => 1),
    service = new AokanaInstallationService(
      resources,
      loading,
      new AokanaProcedureState(),
      new AokanaNativeClock(() => 100),
      notifications,
      localized,
      registry,
      {
        update(archives, completed, total) {
          assert.equal(archives, resources.archives);
          progress.push([completed, total]);
        },
      },
      () => assert.fail('Immediately mounted installation source slept'),
    ),
    [definition] = createGroup81Installation(service, scheduler),
    addresses = {
      destination: 0x40,
      fileName: 0x80,
      fileNames: 0xa0,
      groupCounts: 0xb0,
      probeName: 0xc0,
      probeNames: 0xe0,
      retryMessage: 0x100,
      retryMessages: 0x120,
      format: 0x140,
      publisher: 0x180,
      product: 0x1c0,
      uninstaller: 0x200,
      uninstallerRetry: 0x240,
    },
    writeString = (address, value) => memory.globalMemory.set(bytes(value + '\0'), address),
    writeDword = (address, value) =>
      new DataView(memory.globalMemory.buffer).setUint32(address, value >>> 0, true);
  media.setDriveType(2, 3);
  writeString(addresses.destination, 'C:\\install');
  writeString(addresses.fileName, 'data.bin');
  writeDword(addresses.fileNames, addresses.fileName);
  writeDword(addresses.fileNames + 4, 0);
  writeDword(addresses.groupCounts, 1);
  writeString(addresses.probeName, 'disc.id');
  writeDword(addresses.probeNames, addresses.probeName);
  writeString(addresses.retryMessage, 'Insert disc');
  writeDword(addresses.retryMessages, addresses.retryMessage);
  writeString(addresses.format, 'Component%.4d.CAD');
  writeString(addresses.publisher, 'Sprite');
  writeString(addresses.product, 'Aokana');
  writeString(addresses.uninstaller, 'uninstall.exe');
  writeString(addresses.uninstallerRetry, 'Insert uninstaller media');

  for (const value of [
    addresses.destination,
    0,
    addresses.fileNames,
    1,
    addresses.groupCounts,
    addresses.probeNames,
    addresses.retryMessages,
    1,
    addresses.format,
    addresses.publisher,
    addresses.product,
    addresses.uninstaller,
    addresses.uninstallerRetry,
  ])
    push32(thread, value);

  assert.equal(definition.primary, 0x81);
  assert.equal(definition.secondary, 0xf2);
  assert.equal(definition.nativeAddress, 0x1400ea480);
  assert.equal(await definition.execute({thread, memory, diagnostics: {}}), 2);
  assert.equal(thread.stackIndex, 0);
  assert.notEqual(scheduler.root.process, null);
  assert.equal(loading.activeProcedures, 1);
  memory.globalMemory.fill(0, addresses.destination, addresses.uninstallerRetry + 32);

  let pollResult = 0;
  for (let count = 0; pollResult === 0; count++) {
    assert.ok(count < 32, 'ordinary installation did not finish');
    pollResult = await scheduler.root.pollProcess(false);
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(pollResult, 1);
  assert.equal(scheduler.root.process, null);
  assert.equal(loading.activeProcedures, 0);
  assert.equal(pop32(thread), 0);
  assert.equal(thread.stackIndex, 0);

  assert.deepEqual(await contents(metadata, '/install/data.bin'), payload);
  assert.deepEqual(await metadata.getTimes('/install/data.bin'), sourceTimes);
  assert.deepEqual(await contents(metadata, '/install/uninstall.exe'), uninstaller);
  assert.equal(
    new TextDecoder().decode(await contents(metadata, '/install/uninst.lst')),
    'uninstall.exe\nuninst.lst\n@bgierror.txt\n@bgi.gdb\n@component0000.cad\ndata.bin\n\0',
  );
  assert.deepEqual(progress, [[1, 1]]);

  const events = [];
  for (let event; (event = notifications.take()) !== null;) events.push(event);
  assert.deepEqual(events, [
    {type: 0xf0000000, value1: 0, value2: 1},
    {type: 0xf0000002, value1: 1, value2: 1},
    {type: 0xf0000001, value1: 0, value2: 1},
    {type: 0xf0000003, value1: 1, value2: 0},
  ]);

  const uninstallKey = {
      hive: 'HKLM',
      view: '64',
      path: 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Aokana',
    },
    titleKey = {hive: 'HKLM', view: '64', path: 'Software\\Sprite\\Aokana'};
  assert.equal(wideValue(await registry.storage.getValue(uninstallKey, 'DisplayName')), 'Aokana');
  assert.equal(wideValue(await registry.storage.getValue(uninstallKey, 'Publisher')), 'Sprite');
  assert.equal(
    wideValue(await registry.storage.getValue(uninstallKey, 'UninstallString')),
    '"C:\\install\\uninstall.exe"',
  );
  assert.equal(
    wideValue(await registry.storage.getValue(uninstallKey, 'DisplayIcon')),
    '"C:\\install\\uninstall.exe"',
  );
  assert.equal(
    wideValue(await registry.storage.getValue(titleKey, 'InstalledFolder')),
    '"C:\\install"',
  );
});
