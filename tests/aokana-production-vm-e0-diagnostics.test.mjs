import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

const caption = new TextEncoder().encode('Ethornell - BURIKO General Interpreter\0');
const diagnosticSlots = [0x40, 0x80];

test('mounted E0 diagnostics use one selected engine caption with real captures and BP modules', async () => {
  let showDialog;
  const selectedCaption = caption.slice();
  const fixture = await createMountedVmFixture({
    engineCaption: selectedCaption,
    onDialogShown(dialog) {
      showDialog?.(dialog);
    },
  });
  const {graph, core, child, memory, diagnostics, definitions, invoke} = fixture;
  const shown = () =>
    new Promise((resolve) => {
      showDialog = resolve;
    });
  const select = (dialog, expectedFaces) => {
    assert.equal(dialog.open, true);
    assert.equal(dialog.parent, graph.host.parent);
    assert.equal(dialog.children[0].textContent, 'Ethornell - BURIKO General Interpreter');
    const list = dialog.children.find(({tagName}) => tagName === 'SELECT');
    assert.ok(list);
    assert.deepEqual(
      list.children.map(({textContent}) => textContent),
      expectedFaces,
    );
    const button = dialog.children.find(
      ({tagName, textContent}) => tagName === 'BUTTON' && textContent === 'OK',
    );
    assert.ok(button);
    button.listeners.get('click')();
    assert.equal(dialog.open, false);
    assert.equal(dialog.parent, null);
    assert.equal(graph.host.parent.children.includes(dialog), false);
  };
  const run = async (secondary, expectedPrompt, expectedFaces) => {
    const slot = definitions.find(
      (definition) => definition.primary === 0xe0 && definition.secondary === secondary,
    );
    assert.ok(slot);
    const dialogPromise = shown();
    const completion = slot.execute({thread: child.state, memory, diagnostics});
    assert.ok(completion instanceof Promise);
    assert.equal(core.pendingNativeCallbackCount, 1);
    const dialog = await dialogPromise;
    assert.equal(dialog.children[1].textContent, expectedPrompt);
    select(dialog, expectedFaces);
    await core.joinPendingNativeCallbacks();
    assert.equal(await completion, 0);
    assert.equal(core.pendingNativeCallbackCount, 0);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
  };
  try {
    assert.notEqual(graph.engineCaption, selectedCaption);
    assert.notEqual(graph.engineCaption, graph.title.bytes);
    assert.deepEqual([...graph.engineCaption], [...caption]);
    selectedCaption[0] = 0x58;
    assert.deepEqual([...graph.engineCaption], [...caption]);
    assert.equal(graph.selectionDialog.dialogs, graph.dialogs);
    assert.equal(graph.selectionDialog.text, graph.text);
    assert.equal(graph.input.display, graph.display);
    assert.deepEqual(
      definitions
        .filter(({primary, secondary}) => primary === 0xe0 && diagnosticSlots.includes(secondary))
        .map(({secondary}) => secondary),
      diagnosticSlots,
    );
    assert.equal(
      definitions.some(({primary, secondary}) => primary === 0xe0 && secondary === 0),
      false,
    );

    assert.equal(await invoke(0x90, 0x11, [0, 3, 2, 1], 0), 0);
    assert.equal(await invoke(0x90, 0x13, [0, 0x204060], 0), 0);
    assert.equal(await invoke(0x90, 0x50, [], 0), 1);
    const handle = pop32(child.state);
    assert.equal(await invoke(0x90, 0x56, [handle, 2, 3, 0, 0, 0, 2], 0), 0);
    const sprite = graph.manager.find('sprite', handle);
    assert.ok(sprite);
    assert.equal(await invoke(0x90, 0x54, [handle, 0], 0), 0);
    graph.input.resetCaptures();
    graph.input.installObjectCapture(5, [0, 0, 0, 0], sprite);
    graph.input.installKeyCapture(5);
    graph.input.installKeyCapture(7);
    assert.deepEqual(
      graph.input.captureDiagnosticView().pointer.map(({token}) => token),
      [5, 1],
    );
    await run(0x40, '入力フォーカス一覧', [
      '$00000007',
      '$00000005 : Sprite [ 2, 3 - 4, 4 (2x1) ] <無効> ',
      '$00000001',
    ]);

    assert.equal(child.state.modules.length, 1);
    assert.deepEqual([...child.state.modules[0].name], [...new TextEncoder().encode('ipl._bp')]);
    assert.equal(child.state.modules[0].base, 0);
    await run(0x80, `Thread [ ${child.state.id} ]`, ['ipl._bp - $000000']);

    graph.input.resetCaptures();
    assert.equal(await invoke(0x90, 0x51, [handle], 0), 0);
    assert.equal(await invoke(0x90, 0x12, [0], 0), 1);
    assert.equal(pop32(child.state), 1);
    assert.equal(child.state.stackIndex, 0);
  } finally {
    await fixture.close();
  }
});

test('mounted partial catalog omits E0 diagnostics without a selected caption', async () => {
  const fixture = await createMountedVmFixture();
  try {
    assert.equal(fixture.graph.engineCaption, null);
    assert.equal(
      fixture.definitions.some(
        ({primary, secondary}) => primary === 0xe0 && diagnosticSlots.includes(secondary),
      ),
      false,
    );
  } finally {
    await fixture.close();
  }
});
