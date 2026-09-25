import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {
  AokanaDistributedAllocator,
  AokanaDistributedProcessing,
} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {AokanaExternalProcesses} from '../dist/engines/buriko/games/aokana/native/external-process.js';
import {AokanaExternalMutexName} from '../dist/engines/buriko/games/aokana/native/external-mutex-name.js';
import {createGroup81ExternalProcess} from '../dist/engines/buriko/games/aokana/native/group-81-external-process.js';
import {
  AokanaProgramFiles,
  AokanaProgramMedia,
} from '../dist/engines/buriko/games/aokana/native/program-files.js';
import {AokanaProgramResources} from '../dist/engines/buriko/games/aokana/native/program-resources.js';
import {AokanaSystemProfile} from '../dist/engines/buriko/games/aokana/native/system-profile.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';

const bytes = (value) => new TextEncoder().encode(value);

function wideText(value) {
  const end = value.indexOf(0);
  return String.fromCharCode(...value.subarray(0, end < 0 ? value.length : end));
}

function requestView(request) {
  return {
    applicationName: request.applicationName,
    commandLine: wideText(request.commandLine),
    processAttributes: request.processAttributes,
    threadAttributes: request.threadAttributes,
    inheritHandles: request.inheritHandles,
    creationFlags: request.creationFlags,
    environment: request.environment,
    currentDirectory: request.currentDirectory,
    startup: {...request.startup},
  };
}

test('81 E0 uses native command, token fallback, wait/window and output order on success', async () => {
  const events = [],
    handle = (name) => ({aokanaExternalProcessHandle: true, name}),
    shellProcess = handle('shell-process'),
    sourceToken = handle('source-token'),
    primaryToken = handle('primary-token'),
    childProcess = handle('child-process'),
    childThread = handle('child-thread');
  const waits = [0x102, 0];
  const host = {
    async isUserAdministrator() {
      events.push(['administrator']);
      return true;
    },
    async readShellWindowProcessId() {
      events.push(['shell-pid']);
      return 321;
    },
    async openProcess(desiredAccess, inheritHandle, processId) {
      events.push(['open-process', desiredAccess, inheritHandle, processId]);
      return shellProcess;
    },
    async openProcessToken(process, desiredAccess) {
      events.push(['open-token', process.name, desiredAccess]);
      return sourceToken;
    },
    async duplicateTokenEx(
      token,
      desiredAccess,
      securityAttributes,
      impersonationLevel,
      tokenType,
    ) {
      events.push([
        'duplicate-token',
        token.name,
        desiredAccess,
        securityAttributes,
        impersonationLevel,
        tokenType,
      ]);
      return primaryToken;
    },
    async createProcessWithTokenW(token, logonFlags, request) {
      events.push(['create-token', token.name, logonFlags, requestView(request)]);
      return null;
    },
    async createProcessW(request) {
      events.push(['create', requestView(request)]);
      return {process: childProcess, thread: childThread};
    },
    async waitForInputIdle(process, milliseconds) {
      events.push(['input-idle', process.name, milliseconds]);
      return 0;
    },
    async waitForSingleObject(process, milliseconds) {
      events.push(['wait', process.name, milliseconds]);
      return waits.shift();
    },
    async readExitCodeProcess(process) {
      events.push(['exit-code', process.name]);
      return 0x89abcdef;
    },
    async openMutexA() {
      assert.fail('81 E0 must not use the common lower mutex wait');
    },
    async sleep() {
      assert.fail('81 E0 must not sleep for the common lower mutex wait');
    },
    closeHandle(value) {
      events.push(['close', value.name]);
    },
  };
  const window = {
    readShowState() {
      events.push(['show-read']);
      return 7;
    },
    setShowState(value) {
      events.push(['show-set', value]);
    },
    pumpMessages() {
      events.push(['pump']);
      return 0;
    },
  };
  const text = new AokanaNativeText(),
    media = new AokanaProgramMedia(),
    files = new AokanaProgramFiles({}, text, media),
    unavailable = () => assert.fail('Successful external launch opened a modal'),
    resources = new AokanaProgramResources(
      files,
      {
        nativeFileRoot: 'C:\\game\\',
        primaryRoot: bytes('C:\\game\\\0'),
        secondaryRoot: bytes('C:\\disc\\\0'),
        secondaryMediaPath: 'C:\\disc\\',
        searchDirectoriesEnabled: 0,
        searchDirectories: [],
        retryTitle: bytes('Media\0'),
        retryMessage: bytes('Insert\0'),
        quitConfirmation: bytes('Quit?\0'),
      },
      {show: unavailable},
      {fatal: unavailable, threadFatal: unavailable},
      new AokanaDistributedProcessing(new AokanaDistributedAllocator(1), 1),
    ),
    system = new AokanaSystemProfile({
      readUserName: () => null,
      readComputerName: () => null,
      readVersion: () => ({
        major: 10,
        minor: 0,
        build: 19045,
        platform: 2,
        servicePack: new Uint8Array(),
      }),
      readLegacyPhysicalMemory: () => null,
      readPhysicalMemory: () => null,
    }),
    processes = new AokanaExternalProcesses(
      resources,
      system,
      {lookup: unavailable},
      host,
      window,
      new AokanaExternalMutexName(),
    ),
    [definition] = createGroup81ExternalProcess(processes),
    memoryBytes = new Uint8Array(320).fill(0xa5),
    memory = new AokanaBpMemory(memoryBytes),
    thread = new AokanaBpThread({
      id: 1,
      operandCapacity: 16,
      moduleCapacity: 0,
      frameCapacity: 0,
    }),
    context = {thread, memory, diagnostics: {}};
  memoryBytes.set(bytes('D:\\Tools\0'), 16);
  memoryBytes.set(bytes('helper.exe --flag\0'), 48);
  memoryBytes.set(bytes('E:\\Current\0'), 80);
  memoryBytes.set(bytes('Launch failed\0'), 112);
  for (const value of [224, 16, 48, 80, 1, 112, 1]) push32(thread, value);

  assert.equal(definition.primary, 0x81);
  assert.equal(definition.secondary, 0xe0);
  assert.equal(definition.nativeAddress, 0x1400ea8e0);
  assert.equal(await definition.execute(context), 0);
  assert.equal(pop32(thread), 1);
  assert.equal(thread.stackIndex, 0);
  assert.equal(new DataView(memoryBytes.buffer).getUint32(224, true), 0x89abcdef);

  const request = {
    applicationName: null,
    commandLine: '"D:\\Tools\\helper.exe" --flag',
    processAttributes: null,
    threadAttributes: null,
    inheritHandles: false,
    creationFlags: 0,
    environment: null,
    currentDirectory: 'E:\\Current',
    startup: {
      cb: 0x68,
      reserved: null,
      desktop: null,
      title: null,
      x: 0,
      y: 0,
      xSize: 0,
      ySize: 0,
      xCountChars: 0,
      yCountChars: 0,
      fillAttribute: 0,
      flags: 1,
      showWindow: 5,
      reserved2Size: 0,
      reserved2: null,
      standardInput: null,
      standardOutput: null,
      standardError: null,
    },
  };
  assert.deepEqual(events, [
    ['administrator'],
    ['shell-pid'],
    ['open-process', 0x02000000, false, 321],
    ['open-token', 'shell-process', 0x02000000],
    ['close', 'shell-process'],
    ['duplicate-token', 'source-token', 0x02000000, null, 3, 1],
    ['close', 'source-token'],
    ['create-token', 'primary-token', 0, request],
    ['create', request],
    ['show-read'],
    ['show-set', 0],
    ['input-idle', 'child-process', 0xffffffff],
    ['wait', 'child-process', 8],
    ['pump'],
    ['wait', 'child-process', 8],
    ['pump'],
    ['exit-code', 'child-process'],
    ['close', 'child-thread'],
    ['close', 'child-process'],
    ['show-set', 1],
    ['close', 'primary-token'],
  ]);
});
