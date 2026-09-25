import assert from 'node:assert/strict';
import test from 'node:test';
import {BlobSource} from '../dist/core/source.js';
import {SourceFileSystem} from '../dist/platform/filesystem.js';
import {WindowsFileSystem, windowsFileKey} from '../dist/platform/windows-filesystem.js';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {
  AokanaDistributedAllocator,
  AokanaDistributedProcessing,
} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {
  AokanaEngineDialogs,
  AokanaNativeCursor,
} from '../dist/engines/buriko/games/aokana/native/engine-dialogs.js';
import {AokanaEngineErrors} from '../dist/engines/buriko/games/aokana/native/engine-errors.js';
import {AokanaNativeDisplayState} from '../dist/engines/buriko/games/aokana/native/display-state.js';
import {createGroup80ResourceSettings} from '../dist/engines/buriko/games/aokana/native/group-80-resource-settings.js';
import {AokanaNativeInput} from '../dist/engines/buriko/games/aokana/native/input.js';
import {AokanaNativeClock} from '../dist/engines/buriko/games/aokana/native/clock.js';
import {
  AokanaProgramFiles,
  AokanaProgramMedia,
} from '../dist/engines/buriko/games/aokana/native/program-files.js';
import {AokanaProgramResources} from '../dist/engines/buriko/games/aokana/native/program-resources.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';

const bytes = (value) => new TextEncoder().encode(value);

test('ECB90 resource search reset uses the same BC240/BC170 owner as Bank 80 and loose lookup', async () => {
  const sources = new SourceFileSystem(windowsFileKey),
    fs = new WindowsFileSystem(sources, {
      cwd: 'C:\\game',
      mounts: [{windows: 'C:\\', virtual: '/'}],
    }),
    text = new AokanaNativeText(),
    media = new AokanaProgramMedia(),
    files = new AokanaProgramFiles(fs, text, media),
    clock = new AokanaNativeClock(() => 100),
    display = new AokanaNativeDisplayState(800, 600),
    input = new AokanaNativeInput(display, clock),
    dialogs = new AokanaEngineDialogs(
      {show: async () => 1},
      text,
      clock,
      input,
      new AokanaNativeCursor({style: {}}),
      {isPresent: () => false},
      display,
      null,
      bytes('Game'),
    ),
    errors = new AokanaEngineErrors(files, dialogs, bytes('C:\\game\\'), bytes('C:\\game\\')),
    allocator = new AokanaDistributedAllocator(1),
    processing = new AokanaDistributedProcessing(allocator, 1),
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
    resources = new AokanaProgramResources(files, configuration, dialogs, errors, processing),
    definitions = createGroup80ResourceSettings(resources, null),
    memory = new AokanaBpMemory(new Uint8Array(128)),
    thread = new AokanaBpThread({id: 1, operandCapacity: 16, moduleCapacity: 0, frameCapacity: 0}),
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
