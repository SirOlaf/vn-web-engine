import assert from 'node:assert/strict';
import test from 'node:test';
import {BurikoExternalMutexName} from '../dist/engines/buriko/native/external-mutex-name.js';
import {BurikoExternalProcesses} from '../dist/engines/buriko/native/external-process.js';
import {createGroup80ExternalMutexName} from '../dist/engines/buriko/native/group-80-external-mutex-name.js';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, push32} from '../dist/engines/buriko/bp/state.js';

const bytes = (value) => new TextEncoder().encode(value);

test('EA ANSI global is reread for each E2 mutex attempt without launching a process', async () => {
  const name = new BurikoExternalMutexName();
  const [slot] = createGroup80ExternalMutexName(name);
  const memory = new BurikoBpMemory(new Uint8Array(256));
  const thread = new BurikoBpThread({
    id: 1,
    operandCapacity: 8,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  memory.globalMemory.set(bytes('First title\0ignored'), 64);
  memory.globalMemory.set(bytes('Second title\0'), 128);
  const setName = (offset) => {
    push32(thread, offset);
    assert.equal(slot.execute({thread, memory}), 0);
    assert.equal(thread.stackIndex, 0);
  };
  assert.deepEqual([slot.primary, slot.secondary, slot.nativeAddress], [0x80, 0xea, 0x1400e6980]);
  assert.equal(name.capacity, 256);
  assert.deepEqual(name.readAnsiName(), Uint8Array.of(0));
  setName(64);
  const first = name.readAnsiName();
  assert.deepEqual(first, bytes('Uninstaller for First title is executing.\0'));

  const events = [];
  const handle = {burikoExternalProcessHandle: true};
  const host = {
    async openMutexA(access, inherit, current) {
      events.push(['open', access, inherit, current.slice()]);
      if (events.filter(([kind]) => kind === 'open').length === 1) {
        setName(128);
        return handle;
      }
      return null;
    },
    closeHandle(value) {
      events.push(['close', value]);
    },
    async sleep(milliseconds) {
      events.push(['sleep', milliseconds]);
    },
  };
  const processes = new BurikoExternalProcesses(null, null, null, host, null, name);
  await processes.waitForGlobalMutex();

  assert.deepEqual(events, [
    ['open', 0x1f0001, false, bytes('Uninstaller for First title is executing.\0')],
    ['close', handle],
    ['sleep', 100],
    ['open', 0x1f0001, false, bytes('Uninstaller for Second title is executing.\0')],
  ]);
  assert.deepEqual(first, bytes('Uninstaller for First title is executing.\0'));
});
