import assert from 'node:assert/strict';
import test from 'node:test';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {BrowserWindowsDialogPicker} from '../dist/platform/windows-picker.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

const encode = (value) => new TextEncoder().encode(value);
const selectedSlots = ['80:3b', '81:38', '81:3a'];
const slotId = ({primary, secondary}) =>
  `${primary.toString(16)}:${secondary.toString(16).padStart(2, '0')}`;

test('mounted file and folder pickers share explicit selected host and main-window identity', async () => {
  const requests = [];
  const pickerHost = {
    async selectOpenFile(request) {
      requests.push({kind: 'open', request});
      return encode('C:\\game\\picture.png\0');
    },
    async selectSaveFile(request) {
      requests.push({kind: 'save', request});
      return encode('C:\\game\\chapter.bp\0');
    },
    async selectFolder(request) {
      requests.push({kind: 'folder', request});
      return 'C:\\game\\assets';
    },
  };
  const fixture = await createMountedVmFixture({pickerHost});
  const {graph, core, child, definitions, invoke, memory} = fixture;
  const bytes = memory.globalMemory;
  const view = new DataView(bytes.buffer);
  const put = (address, value) => bytes.set(encode(`${value}\0`), address);
  const result = async (primary, secondary, args) => {
    assert.equal(await invoke(primary, secondary, args, 0), 1);
    const value = pop32(child.state);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
    return value;
  };
  try {
    assert.deepEqual(
      definitions.map(slotId).filter((id) => selectedSlots.includes(id)),
      selectedSlots,
    );
    assert.equal(graph.pickerHost, pickerHost);
    assert.equal(graph.fileSelection.host, pickerHost);
    assert.equal(graph.folderSelection.host, pickerHost);
    assert.equal(graph.fileSelection.dialogs, graph.dialogs);
    assert.equal(graph.fileSelection.clock, graph.clock);
    assert.equal(graph.fileSelection.mainWindowIdentity, graph.host);
    assert.equal(graph.folderSelection.localized, graph.localized);
    assert.equal(graph.folderSelection.mainWindowIdentity, graph.host);
    assert.equal(graph.device.isPresent(), false);
    put(0x100, 'Images');
    put(0x120, 'png');
    put(0x140, 'Select image');
    put(0x160, 'C:\\game');
    put(0x180, 'Scripts');
    put(0x1a0, '*.bp');
    put(0x1c0, 'Save script');
    put(0x1e0, 'Choose folder');
    view.setUint32(0x400, 0x180, true);
    view.setUint32(0x420, 0x1a0, true);

    bytes.fill(0xcc, 0xfff, 0x1000 + 0x30d);
    assert.equal(await result(0x80, 0x3b, [0x1000, 0x100, 0x120, 0x140, 0x160, 0]), 0);
    const openBytes = encode('C:\\game\\picture.png\0');
    assert.deepEqual(bytes.slice(0x1000, 0x1000 + openBytes.length), openBytes);
    assert.equal(bytes[0xfff], 0xcc);
    assert.equal(bytes[0x1000 + 0x30c], 0xcc);
    assert.deepEqual(requests[0], {
      kind: 'open',
      request: {
        structureSize: 0x98,
        owner: graph.host,
        filter: encode('Images(*.png)\0*.png\0\0'),
        filterIndex: 1,
        fileCapacity: 0x30c,
        initialDirectory: encode('C:\\game\0'),
        title: encode('Select image\0'),
        defaultExtension: Uint8Array.of(0),
        flags: 0x1804,
      },
    });

    bytes.fill(0xcc, 0x13ff, 0x1400 + 0x30d);
    assert.equal(await result(0x81, 0x38, [0x1400, 1, 0x400, 0x420, 0x1c0, 0x160, 1]), 0);
    const saveBytes = encode('C:\\game\\chapter.bp\0');
    assert.deepEqual(bytes.slice(0x1400, 0x1400 + saveBytes.length), saveBytes);
    assert.equal(bytes[0x13ff], 0xcc);
    assert.equal(bytes[0x1400 + 0x30c], 0xcc);
    assert.deepEqual(requests[1], {
      kind: 'save',
      request: {
        structureSize: 0x98,
        owner: graph.host,
        filter: encode('Scripts\0*.bp\0\0'),
        filterIndex: 1,
        fileCapacity: 0x30c,
        initialDirectory: encode('C:\\game\0'),
        title: encode('Save script\0'),
        defaultExtension: Uint8Array.of(0),
        flags: 0x806,
      },
    });

    bytes.fill(0xcc, 0x17ff, 0x1850);
    assert.equal(await result(0x81, 0x3a, [0x1800, 0x1e0, 0x160]), 1);
    const folderBytes = encode('C:\\game\\assets\0');
    assert.deepEqual(bytes.slice(0x1800, 0x1800 + folderBytes.length), folderBytes);
    assert.equal(bytes[0x17ff], 0xcc);
    assert.equal(bytes[0x1800 + folderBytes.length], 0xcc);
    assert.deepEqual(requests[2], {
      kind: 'folder',
      request: {
        owner: graph.host,
        rootItemIdentifier: 0x11,
        displayNameCapacity: 784,
        title: 'Choose folder',
        flags: 3,
        initialFolder: 'C:\\game',
        centerOnInitialize: true,
        image: 0,
      },
    });
    await core.joinPendingNativeCallbacks();
    assert.equal(core.pendingNativeCallbackCount, 0);
    assert.equal(graph.display.modalDepth, 0);
    assert.equal(child.state.stackIndex, 0);
  } finally {
    await fixture.close();
  }

  const browser = await createMountedVmFixture();
  try {
    assert.ok(browser.graph.pickerHost instanceof BrowserWindowsDialogPicker);
    assert.equal(browser.graph.fileSelection.host, browser.graph.pickerHost);
    assert.equal(browser.graph.folderSelection.host, browser.graph.pickerHost);
    assert.deepEqual(
      browser.definitions.map(slotId).filter((id) => selectedSlots.includes(id)),
      selectedSlots,
    );
  } finally {
    await browser.close();
  }
});
