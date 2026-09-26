import assert from 'node:assert/strict';
import test from 'node:test';
import {BlobSource} from '../dist/core/source.js';
import {SourceFileSystem} from '../dist/platform/filesystem.js';
import {WindowsFileSystem, windowsFileKey} from '../dist/platform/windows-filesystem.js';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, push32} from '../dist/engines/buriko/bp/state.js';
import {
  BurikoDistributedAllocator,
  BurikoDistributedProcessing,
} from '../dist/engines/buriko/native/distributed-processing.js';
import {
  BurikoEngineDialogs,
  BurikoNativeCursor,
} from '../dist/engines/buriko/native/engine-dialogs.js';
import {BurikoEngineErrors} from '../dist/engines/buriko/native/engine-errors.js';
import {BurikoNativeDisplayState} from '../dist/engines/buriko/native/display-state.js';
import {createGroup80ResourceSettings} from '../dist/engines/buriko/native/group-80-resource-settings.js';
import {BurikoNativeInput} from '../dist/engines/buriko/native/input.js';
import {BurikoNativeClock} from '../dist/engines/buriko/native/clock.js';
import {
  BurikoProgramFiles,
  BurikoProgramMedia,
} from '../dist/engines/buriko/native/program-files.js';
import {BurikoProgramResources} from '../dist/engines/buriko/native/program-resources.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';

const bytes = (value) => new TextEncoder().encode(value);

test('ECB90 resource search reset uses the same BC240/BC170 owner as Bank 80 and loose lookup', async () => {
  const sources = new SourceFileSystem(windowsFileKey),
    fs = new WindowsFileSystem(sources, {
      cwd: 'C:\\game',
      mounts: [{windows: 'C:\\', virtual: '/'}],
    }),
    text = new BurikoNativeText(),
    media = new BurikoProgramMedia(),
    files = new BurikoProgramFiles(fs, text, media),
    clock = new BurikoNativeClock(() => 100),
    display = new BurikoNativeDisplayState(800, 600),
    input = new BurikoNativeInput(display, clock),
    dialogs = new BurikoEngineDialogs(
      {show: async () => 1},
      text,
      clock,
      input,
      new BurikoNativeCursor({style: {}}),
      {isPresent: () => false},
      display,
      null,
      bytes('Game'),
    ),
    errors = new BurikoEngineErrors(files, dialogs, bytes('C:\\game\\'), bytes('C:\\game\\')),
    allocator = new BurikoDistributedAllocator(1),
    processing = new BurikoDistributedProcessing(allocator, 1),
    configuration = {
      nativeFileRoot: 'C:\\game\\',
      primaryRoot: bytes('C:\\game\\'),
      secondaryRoot: Uint8Array.of(0),
      secondaryMediaPath: '',
      searchDirectoriesEnabled: 0,
      searchDirectories: [],
      retryTitle: Uint8Array.of(0),
      retryMessage: Uint8Array.of(0),
      quitConfirmation: Uint8Array.of(0),
    },
    resources = new BurikoProgramResources(files, configuration, dialogs, errors, processing),
    definitions = createGroup80ResourceSettings(resources, null),
    memory = new BurikoBpMemory(new Uint8Array(128)),
    thread = new BurikoBpThread({id: 1, operandCapacity: 16, moduleCapacity: 0, frameCapacity: 0}),
    context = {memory, thread},
    execute = (secondary, value) => {
      push32(thread, value);
      assert.equal(definitions.find((entry) => entry.secondary === secondary).execute(context), 0);
    };
  try {
    media.setDriveType(2, 3);
    sources.attach('/game/sub/only', new BlobSource(new Blob([Uint8Array.of(7)])));
    memory.globalMemory.set(bytes('sub\0'), 32);
    execute(0x37, 32);
    execute(0x36, 1);
    assert.equal(
      text.decodeAuto({
        bytes: await resources.findRelativeFile('C:\\game\\', {bytes: bytes('only\0'), offset: 0}),
        offset: 0,
      }),
      'C:\\game\\sub\\only',
    );
    const searchList = configuration.searchDirectories;
    execute(0x36, 0);
    resources.resetDirectorySearchForProgram();
    assert.equal(configuration.searchDirectoriesEnabled, 1);
    assert.equal(configuration.searchDirectories, searchList);
    assert.deepEqual(configuration.searchDirectories, []);
    assert.equal(
      await resources.findRelativeFile('C:\\game\\', {bytes: bytes('only\0'), offset: 0}),
      null,
    );
  } finally {
    processing.dispose();
    allocator.dispose();
  }
});
