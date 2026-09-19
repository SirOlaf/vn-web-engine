import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpScheduler} from '../dist/engines/buriko/games/aokana/bp/scheduler.js';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaNativeClock} from '../dist/engines/buriko/games/aokana/native/clock.js';
import {
  AokanaDistributedAllocator,
  AokanaDistributedProcessing,
} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {createGroup81InternetRead} from '../dist/engines/buriko/games/aokana/native/group-81-internet-read.js';
import {AokanaVmControlState} from '../dist/engines/buriko/games/aokana/native/group-80-threads.js';
import {
  AOKANA_INTERNET_USER_AGENT,
  AokanaInternetReads,
} from '../dist/engines/buriko/games/aokana/native/internet-reads.js';
import {
  AokanaProgramFiles,
  AokanaProgramMedia,
} from '../dist/engines/buriko/games/aokana/native/program-files.js';
import {AokanaProgramResources} from '../dist/engines/buriko/games/aokana/native/program-resources.js';
import {AokanaProcedureState} from '../dist/engines/buriko/games/aokana/native/procedure.js';
import {AokanaResourceLoadingState} from '../dist/engines/buriko/games/aokana/native/resource-loading.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';

const bytes = (value) => new TextEncoder().encode(value);

function setup(host) {
  const text = new AokanaNativeText(),
    files = new AokanaProgramFiles({}, text, new AokanaProgramMedia()),
    unavailable = () => assert.fail('Successful internet read opened a diagnostic'),
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
    loading = new AokanaResourceLoadingState(resources),
    reads = new AokanaInternetReads(files, host),
    thread = new AokanaBpThread({
      id: 1,
      operandCapacity: 16,
      moduleCapacity: 0,
      frameCapacity: 0,
    }),
    memory = new AokanaBpMemory(new Uint8Array(768)),
    scheduler = new AokanaBpScheduler(thread, () => 1),
    control = new AokanaVmControlState(),
    [definition] = createGroup81InternetRead(
      reads,
      loading,
      scheduler,
      new AokanaProcedureState(),
      new AokanaNativeClock(() => 100),
      control,
    ),
    context = {thread, memory, diagnostics: {}};
  memory.globalMemory.set(bytes('https://example.test/data.bin\0'), 32);
  return {
    definition,
    loading,
    memory,
    scheduler,
    control,
    thread,
    call(offset, length) {
      for (const value of [512, 32, offset, length]) push32(thread, value);
      return definition.execute(context);
    },
  };
}

function checkRequest(request, state, offset, length) {
  assert.equal(request.url, 'https://example.test/data.bin');
  assert.equal(request.userAgent, AOKANA_INTERNET_USER_AGENT);
  assert.equal(request.reload, true);
  assert.equal(request.destination.bytes, state.memory.globalMemory);
  assert.equal(request.destination.offset, 512);
  assert.equal(request.offset, offset);
  assert.equal(request.length, length);
}

test('81 31 synchronous read forwards one range, writes it, and pushes native success', async () => {
  const requests = [],
    host = {
      async read(request) {
        requests.push(request);
        return {kind: 'opened', body: Uint8Array.of(2, 3, 5, 7, 11, 13)};
      },
      start() {
        assert.fail('Synchronous internet read started a worker operation');
      },
    },
    state = setup(host);

  assert.equal(state.definition.primary, 0x81);
  assert.equal(state.definition.secondary, 0x31);
  assert.equal(state.definition.nativeAddress, 0x1400ebc00);
  assert.equal(await state.call(2, 3), 0);
  assert.equal(pop32(state.thread), 0);
  assert.deepEqual(state.memory.globalMemory.slice(512, 515), Uint8Array.of(5, 7, 11));
  assert.equal(state.scheduler.root.process, null);
  assert.equal(state.loading.activeProcedures, 0);
  assert.equal(requests.length, 1);
  checkRequest(requests[0], state, 2, 3);
});

test('81 31 asynchronous read installs and polls the real process before its result push', async () => {
  const requests = [];
  let complete;
  const completion = new Promise((resolve) => {
      complete = resolve;
    }),
    host = {
      read() {
        assert.fail('Asynchronous internet read used the blocking-shaped host entry');
      },
      start(request) {
        requests.push(request);
        return {
          completion,
          cancelSession() {},
          dispose() {},
        };
      },
    },
    state = setup(host);
  state.control.asynchronousResourceLoads = 1;

  assert.equal(await state.call(1, 3), 2);
  assert.equal(state.control.asynchronousResourceLoads, 0);
  assert.equal(state.thread.stackIndex, 0);
  assert.notEqual(state.scheduler.root.process, null);
  assert.equal(state.loading.activeProcedures, 1);
  assert.equal(await state.scheduler.root.pollProcess(false), 0);
  assert.equal(requests.length, 1);
  checkRequest(requests[0], state, 1, 3);

  complete({kind: 'opened', body: Uint8Array.of(13, 17, 19, 23, 29)});
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(await state.scheduler.root.pollProcess(false), 1);
  assert.equal(state.scheduler.root.process, null);
  assert.equal(state.loading.activeProcedures, 0);
  assert.equal(pop32(state.thread), 0);
  assert.deepEqual(state.memory.globalMemory.slice(512, 515), Uint8Array.of(17, 19, 23));
});
