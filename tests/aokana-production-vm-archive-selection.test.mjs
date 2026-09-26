import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted 81:3B selects the real boot archive entry through the shared dialog', async () => {
  let showDialog;
  const shown = new Promise((resolve) => {
    showDialog = resolve;
  });
  const fixture = await createMountedVmFixture({onDialogShown: showDialog});
  const {graph, core, child, memory, definitions, diagnostics, encode} = fixture;
  try {
    assert.equal(graph.selectionDialog.dialogs, graph.dialogs);
    assert.equal(graph.selectionDialog.text, graph.text);
    assert.equal(graph.resource.resources.files, graph.resource.files);
    assert.equal(graph.resource.resources.dialogs, graph.dialogs);
    const slot = definitions.find(({primary, secondary}) => primary === 0x81 && secondary === 0x3b);
    assert.ok(slot);

    memory.globalMemory.fill(0xa5, 0x2ff, 0x310);
    memory.globalMemory.set(encode('Archive Entries'), 0x100);
    memory.globalMemory.set(encode('Choose'), 0x140);
    memory.globalMemory.set(encode('system.arc'), 0x180);
    for (const value of [0x300, 0x100, 0x140, 0x180]) push32(child.state, value);
    const completion = slot.execute({thread: child.state, memory, diagnostics});
    assert.ok(completion instanceof Promise);
    assert.equal(core.pendingNativeCallbackCount, 1);

    const dialog = await shown;
    assert.equal(dialog.tagName, 'DIALOG');
    assert.equal(dialog.open, true);
    assert.equal(dialog.parent, graph.host.parent);
    assert.equal(dialog.children[0].textContent, 'Archive Entries');
    assert.equal(dialog.children[1].textContent, 'Choose');
    const select = dialog.children.find(({tagName}) => tagName === 'SELECT');
    assert.ok(select);
    assert.deepEqual(
      select.children.map(({textContent}) => textContent),
      ['ipl._bp'],
    );
    assert.equal(select.selectedIndex, 0);
    const button = dialog.children.find(
      ({tagName, textContent}) => tagName === 'BUTTON' && textContent === 'OK',
    );
    assert.ok(button);
    button.listeners.get('click')();

    await core.joinPendingNativeCallbacks();
    assert.equal(await completion, 0);
    assert.equal(core.pendingNativeCallbackCount, 0);
    assert.equal(pop32(child.state), 0);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
    assert.deepEqual([...memory.globalMemory.subarray(0x300, 0x308)], [...encode('ipl._bp')]);
    assert.equal(memory.globalMemory[0x2ff], 0xa5);
    assert.equal(memory.globalMemory[0x308], 0xa5);
    assert.equal(dialog.open, false);
    assert.equal(dialog.parent, null);
    assert.equal(graph.host.parent.children.includes(dialog), false);
  } finally {
    await fixture.close();
  }
});
