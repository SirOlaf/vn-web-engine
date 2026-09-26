import test from 'node:test';
import assert from 'node:assert/strict';
import {StoredFileSystem} from '../dist/platform/filesystem.js';
import {MemoryStore} from '../dist/platform/store.js';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, pop32, push32} from '../dist/engines/buriko/bp/state.js';
import {BurikoBpDiagnostics} from '../dist/engines/buriko/native/diagnostics.js';
import {BurikoMountedFileMetadata} from '../dist/engines/buriko/native/file-metadata.js';
import {createGroup81ShellShortcuts} from '../dist/engines/buriko/native/group-81-shell-shortcuts.js';
import {
  BurikoProgramFiles,
  BurikoProgramMedia,
} from '../dist/engines/buriko/native/program-files.js';
import {BurikoMountedProgramPaths} from '../dist/engines/buriko/native/program-paths.js';
import {BurikoShellShortcuts} from '../dist/engines/buriko/native/shell-shortcuts.js';
import {BurikoSpecialFolders} from '../dist/engines/buriko/native/special-folders.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';
import {BurikoNativeRegistry} from '../dist/engines/buriko/native/windows-registry.js';

const bytes = (value) => new TextEncoder().encode(value);

test('81 F7 creates and retains a Programs shortcut through the exact ShellLink host sequence', async () => {
  const canonical = (path) => path.toLowerCase();
  const metadata = new BurikoMountedFileMetadata(
    new StoredFileSystem(new MemoryStore(), canonical),
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
          path: '/programs',
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
  );
  const text = new BurikoNativeText();
  const files = new BurikoProgramFiles(
    metadata,
    text,
    new BurikoProgramMedia(),
    new BurikoMountedProgramPaths([{native: 'C:\\', mounted: '/'}], 'C:\\'),
  );
  const userFolders = {
    desktop: 'C:\\Desktop',
    programs: 'C:\\Programs',
    documents: 'C:\\Documents',
    profile: 'C:\\Users\\Current',
  };
  const folders = new BurikoSpecialFolders(
    text,
    new BurikoNativeRegistry(new MemoryStore()),
    {primaryRoot: bytes('C:\\Game\\\0'), secondaryRoot: Uint8Array.of(0)},
    {
      shellAllocatorAvailable: true,
      windows: 'C:\\Windows',
      programFiles: 'C:\\Program Files',
      currentUser: userFolders,
      shellUser: userFolders,
      elevated: false,
      shellTokenAvailable: false,
      debugPrivilegeAvailable: false,
      shellAccountName: null,
    },
  );
  files.specialFolders = folders;

  const calls = [];
  const host = {
    createShellLink() {
      calls.push(['create']);
      return {
        hresult: 0,
        link: {
          setPath(target) {
            calls.push(['path', target]);
            return 0;
          },
          setArguments(arguments_) {
            calls.push(['arguments', arguments_]);
            return 0;
          },
          setWorkingDirectory(directory) {
            calls.push(['working-directory', directory]);
            return 0;
          },
          queryPersistFile() {
            calls.push(['query-persist']);
            return {
              hresult: 0,
              persist: {
                save(destination, remember) {
                  calls.push(['save', destination, remember]);
                  return 0;
                },
                release() {
                  calls.push(['release-persist']);
                },
              },
            };
          },
          release() {
            calls.push(['release-link']);
          },
        },
      };
    },
  };
  const [definition] = createGroup81ShellShortcuts(new BurikoShellShortcuts(files, folders, host));
  const memoryBytes = new Uint8Array(512);
  const values = [
    [32, 'Buriko\\Tools\0'],
    [96, 'Buriko.lnk\0'],
    [160, 'C:\\Game\\Buriko.exe\0'],
    [224, '--route misaki\0'],
  ];
  for (const [offset, value] of values) memoryBytes.set(bytes(value), offset);
  const memory = new BurikoBpMemory(memoryBytes);
  const thread = new BurikoBpThread({
    id: 1,
    operandCapacity: 16,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const context = {thread, memory, diagnostics: new BurikoBpDiagnostics(() => {})};

  for (const address of [32, 96, 160, 224]) push32(thread, address);
  assert.equal(await definition.execute(context), 0);
  assert.equal(pop32(thread), 1);
  assert.equal(thread.stackIndex, 0);
  assert.equal(definition.primary, 0x81);
  assert.equal(definition.secondary, 0xf7);
  assert.equal(definition.nativeAddress, 0x1400ea400);
  assert.deepEqual(calls, [
    ['create'],
    ['path', 'C:\\Game\\Buriko.exe'],
    ['arguments', '--route misaki'],
    ['working-directory', ''],
    ['query-persist'],
    ['save', 'C:\\Programs\\Buriko\\Tools\\Buriko.lnk', true],
    ['release-persist'],
    ['release-link'],
  ]);
  assert.deepEqual(
    metadata.snapshot().map((record) => record.path),
    ['/', '/programs', '/programs/aokana', '/programs/aokana/tools'],
  );
});
