import assert from 'node:assert/strict';
import test from 'node:test';
import {pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted B0 modals share the graph title, DOM presenter, BP results and selection output', async () => {
  const shown = [];
  const waiters = [];
  const fixture = await createMountedVmFixture({
    onDialogShown(dialog) {
      const next = waiters.shift();
      if (next) next(dialog);
      else shown.push(dialog);
    },
  });
  const {graph, core, child, memory, diagnostics, definitions, encode} = fixture;
  const nextDialog = () =>
    shown.length > 0
      ? Promise.resolve(shown.shift())
      : new Promise((resolve) => waiters.push(resolve));
  const slots = definitions.filter(
    ({primary, secondary}) =>
      primary === 0xb0 && [0x80, 0x81, 0x82, 0x83, 0x8c].includes(secondary),
  );
  const slot = (secondary) => {
    const matches = slots.filter((entry) => entry.secondary === secondary);
    assert.equal(matches.length, 1);
    return matches[0];
  };
  const button = (dialog, label) => {
    const match = dialog.children.find(
      (child) => child.tagName === 'BUTTON' && child.textContent === label,
    );
    assert.ok(match);
    return match;
  };
  const invokeModal = async (secondary, args, inspect, label, result) => {
    for (const arg of args) push32(child.state, arg);
    const completion = slot(secondary).execute({thread: child.state, memory, diagnostics});
    assert.ok(completion instanceof Promise);
    assert.equal(core.pendingNativeCallbackCount, 1);
    const dialog = await nextDialog();
    assert.equal(dialog.open, true);
    assert.equal(dialog.parent, graph.host.parent);
    inspect(dialog);
    const joined = core.joinPendingNativeCallbacks();
    button(dialog, label).listeners.get('click')();
    assert.equal(await completion, 0);
    await joined;
    assert.equal(core.pendingNativeCallbackCount, 0);
    assert.equal(dialog.open, false);
    assert.equal(dialog.parent, null);
    assert.equal(graph.host.parent.children.includes(dialog), false);
    if (result === null) assert.equal(child.state.stackIndex, 0);
    else {
      assert.equal(pop32(child.state), result);
      assert.equal(child.state.stackIndex, 0);
    }
  };
  try {
    assert.equal(slots.length, 5);
    assert.equal(
      graph.dialogs.usesOwners(
        graph.diagnosticDialogs,
        graph.text,
        graph.clock,
        graph.input,
        graph.cursor,
        graph.device,
        graph.display,
      ),
      true,
    );
    assert.equal(graph.selectionDialog.dialogs, graph.dialogs);
    assert.equal(graph.selectionDialog.text, graph.text);
    assert.equal(graph.dialogs.fallbackTitle, graph.title.bytes);
    memory.globalMemory.set(encode('Preferred title'), 0x100);
    memory.globalMemory.set(encode('First\\nSecond'), 0x140);
    memory.globalMemory.set(encode('Continue?'), 0x1a0);
    memory.globalMemory.set(encode('Accept?'), 0x1e0);
    memory.globalMemory.set(encode('List title'), 0x240);
    memory.globalMemory.set(encode('Choose one'), 0x280);
    memory.globalMemory.set(encode('Alpha\nBeta\n'), 0x2c0);
    memory.globalMemory.fill(0xa5, 0x400, 0x420);

    push32(child.state, 0x100);
    assert.equal(slot(0x83).execute({thread: child.state, memory, diagnostics}), 0);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(core.pendingNativeCallbackCount, 0);
    assert.equal(
      graph.text.decodeAuto({bytes: graph.dialogs.preferredTitle, offset: 0}),
      'Preferred title',
    );

    await invokeModal(
      0x80,
      [0x140],
      (dialog) => {
        assert.equal(dialog.children[0].textContent, 'Preferred title');
        assert.equal(dialog.children[1].textContent, 'First\nSecond');
        assert.deepEqual(
          dialog.children
            .filter(({tagName}) => tagName === 'BUTTON')
            .map(({textContent}) => textContent),
          ['OK'],
        );
      },
      'OK',
      null,
    );
    await invokeModal(
      0x81,
      [0x1a0, 0],
      (dialog) => {
        assert.equal(dialog.children[1].textContent, 'Continue?');
        assert.deepEqual(
          dialog.children
            .filter(({tagName}) => tagName === 'BUTTON')
            .map(({textContent}) => textContent),
          ['はい', 'いいえ'],
        );
      },
      'はい',
      1,
    );
    await invokeModal(
      0x82,
      [0x1e0, 1, 0],
      (dialog) => {
        assert.equal(dialog.children[1].textContent, 'Accept?');
        assert.deepEqual(
          dialog.children
            .filter(({tagName}) => tagName === 'BUTTON')
            .map(({textContent}) => textContent),
          ['OK', 'キャンセル'],
        );
      },
      'キャンセル',
      0,
    );
    await invokeModal(
      0x8c,
      [0x400, 0x240, 0x280, 0x2c0],
      (dialog) => {
        assert.equal(dialog.children[0].textContent, 'List title');
        assert.equal(dialog.children[1].textContent, 'Choose one');
        const select = dialog.children.find(({tagName}) => tagName === 'SELECT');
        assert.ok(select);
        assert.deepEqual(
          select.children.map(({textContent}) => textContent),
          ['Alpha', 'Beta'],
        );
        select.selectedIndex = 1;
      },
      'OK',
      1,
    );
    const selected = encode('Beta');
    assert.deepEqual(memory.globalMemory.subarray(0x400, 0x400 + selected.length), selected);
    assert.equal(memory.globalMemory[0x400 + selected.length], 0xa5);
    assert.equal(child.process, null);
  } finally {
    for (const dialog of graph.host.parent.children.filter(
      ({tagName, open}) => tagName === 'DIALOG' && open,
    )) {
      const choice = dialog.children.find(({tagName}) => tagName === 'BUTTON');
      choice?.listeners.get('click')?.();
    }
    await fixture.close();
  }
});
