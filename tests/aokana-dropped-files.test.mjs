import test from 'node:test';
import assert from 'node:assert/strict';
import {deviceServiceFixture} from './aokana-device-service-fixture.mjs';
import {MountedFileSystem} from '../dist/platform/filesystem.js';
import {BrowserWindowsNamedFileMappingHost} from '../dist/platform/windows-named-file-mapping.js';
import {
  BurikoProgramFiles,
  BurikoProgramMedia,
} from '../dist/engines/buriko/native/program-files.js';
import {BurikoMountedProgramPaths} from '../dist/engines/buriko/native/program-paths.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';
import {BurikoDroppedFiles} from '../dist/engines/buriko/native/dropped-files.js';
import {createGroup80DroppedFiles} from '../dist/engines/buriko/native/group-80-dropped-files.js';
import {BurikoMainWindowMessageReceiver} from '../dist/engines/buriko/native/main-window-messages.js';
import {BurikoWindowMessages as Waits} from '../dist/engines/buriko/native/procedure.js';
import {BurikoKnobDisplays} from '../dist/engines/buriko/native/knob-displays.js';
import {BurikoBpThread, push32, pop32} from '../dist/engines/buriko/bp/state.js';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BURIKO_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/native/inventory.js';

test('80:6C/6D deliver actual dropped Blobs through the shared path buffer and mounted file reader', async () => {
  const s = deviceServiceFixture(),
    listeners = new Map();
  s.canvas.addEventListener = (name, listener) => listeners.set(name, listener);
  s.canvas.removeEventListener = (name) => listeners.delete(name);
  const fs = new MountedFileSystem(),
    text = new BurikoNativeText(),
    paths = new BurikoMountedProgramPaths([{native: 'D:\\Drops', mounted: '/drops'}], 'D:\\Drops'),
    files = new BurikoProgramFiles(fs, text, new BurikoProgramMedia(), paths),
    drops = new BurikoDroppedFiles(s.canvas, s.messages, files, fs, '/drops', 'D:\\Drops'),
    mappings = new BrowserWindowsNamedFileMappingHost();
  new BurikoMainWindowMessageReceiver(
    s.messages,
    new Waits(),
    s.input,
    s.notifications,
    s.controller.host,
    new BurikoKnobDisplays(s.manager, s.input, s.notifications),
    s.controller,
    null,
    drops,
    null,
    null,
    null,
    null,
    null,
    mappings,
  );
  const [enable, read] = createGroup80DroppedFiles(drops),
    thread = new BurikoBpThread({id: 1, operandCapacity: 4, moduleCapacity: 0, frameCapacity: 0}),
    memory = new BurikoBpMemory(new Uint8Array(1024)),
    context = {thread, memory, diagnostics: {}};
  assert.equal(enable.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[0x80][0x6c]);
  assert.equal(read.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[0x80][0x6d]);
  push32(thread, 1);
  assert.equal(enable.execute(context), 0);
  const retained = [];
  for (const [index, content] of ['first payload', 'second payload'].entries()) {
    let prevented = false;
    listeners.get('drop')({
      preventDefault() {
        prevented = true;
      },
      dataTransfer: {files: [new File([content], '資料.txt')]},
    });
    assert.equal(prevented, true);
    assert.deepEqual(s.notifications.take(), {type: 16, value1: 0, value2: 0});
    push32(thread, 32);
    assert.equal(read.execute(context), 0);
    assert.equal(pop32(thread), 1);
    const pointer = memory.resolve(thread, 32),
      native = text.decodeAuto(pointer);
    assert.equal(native, `D:\\Drops\\${index + 1}\\資料.txt`);
    retained.push(native);
    const opened = await files.openWide(native);
    assert.equal(opened.error, 0);
    assert.equal(
      new TextDecoder().decode(await files.read(opened.source, 0, opened.source.size)),
      content,
    );
  }
  // Same-name second drop did not replace the actual first attachment.
  const first = await files.openWide(retained[0]);
  assert.equal(
    new TextDecoder().decode(await files.read(first.source, 0, first.source.size)),
    'first payload',
  );
  push32(thread, 32);
  assert.equal(read.execute(context), 0);
  assert.equal(pop32(thread), 1);
  assert.equal(text.decodeAuto(memory.resolve(thread, 32)), retained[1]);
  const mappedPath = text.encodeWide(retained[0], 1);
  mappings.publish('FMO0000002aForBGI', mappedPath);
  assert.equal(s.messages.send('main', 0x9000, 42, mappedPath.length), 0);
  assert.deepEqual(s.notifications.take(), {type: 16, value1: 0, value2: 0});
  push32(thread, 32);
  assert.equal(read.execute(context), 0);
  assert.equal(pop32(thread), 1);
  assert.equal(text.decodeAuto(memory.resolve(thread, 32)), retained[0]);
  assert.equal(s.messages.send('main', 0x9001, 0, 0), 0);
  assert.deepEqual(s.notifications.take(), {type: 17, value1: 0, value2: 0});
  assert.equal(thread.stackIndex, 0);
  drops.dispose();
  assert.equal(listeners.size, 0);
});
