import assert from 'node:assert/strict';
import test from 'node:test';
import {pop32, push32} from '../dist/engines/buriko/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

function descendants(element, tagName, type) {
  return element.children.flatMap((child) => [
    ...(child.tagName === tagName && (type === undefined || child.type === type) ? [child] : []),
    ...descendants(child, tagName, type),
  ]);
}

test('mounted B0 forms share the graph ANSI host, product-key state and BP outputs', async () => {
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
  const forms = definitions.filter(
    ({primary, secondary}) =>
      primary === 0xb0 && [0x84, 0x85, 0x86, 0x87, 0x8f].includes(secondary),
  );
  const slot = (secondary) => {
    const matches = forms.filter((entry) => entry.secondary === secondary);
    assert.equal(matches.length, 1);
    return matches[0];
  };
  const writeAnsi = (offset, value) => memory.globalMemory.set(graph.ansiUi.encode(value), offset);
  const readAnsi = (offset) => graph.ansiUi.decode({bytes: memory.globalMemory, offset});
  const button = (dialog, label) => {
    const match = dialog.children.find(
      (child) => child.tagName === 'BUTTON' && child.textContent === label,
    );
    assert.ok(match);
    return match;
  };
  const invoke = async (secondary, args, inspect, action = 'OK', result = 1) => {
    for (const arg of args) push32(child.state, arg);
    const completion = slot(secondary).execute({thread: child.state, memory, diagnostics});
    assert.ok(completion instanceof Promise);
    assert.equal(core.pendingNativeCallbackCount, 1);
    const dialog = await nextDialog();
    assert.equal(dialog.open, true);
    assert.equal(dialog.parent, graph.host.parent);
    inspect(dialog);
    const joined = core.joinPendingNativeCallbacks();
    button(dialog, action).listeners.get('click')();
    assert.equal(await completion, 0);
    await joined;
    assert.equal(core.pendingNativeCallbackCount, 0);
    assert.equal(pop32(child.state), result);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(dialog.open, false);
    assert.equal(dialog.parent, null);
  };
  try {
    assert.deepEqual(
      forms.map(({secondary}) => secondary),
      [0x84, 0x85, 0x86, 0x87, 0x8f],
    );
    assert.equal(graph.ansiUi.text, graph.text);
    assert.equal(graph.ansiDialogs.document, graph.host.document);
    assert.equal(graph.ansiDialogs.parent, graph.host.parent);
    assert.equal(graph.ansiDialogs.dialogs, graph.dialogs);
    assert.equal(graph.ansiDialogs.ansi, graph.ansiUi);
    assert.equal(graph.ansiDialogs.language, graph.localized.language);
    assert.equal(graph.productKeyDialog.dialogs, graph.dialogs);
    assert.equal(graph.productKeyDialog.text, graph.text);

    writeAnsi(0x100, 'Single form');
    writeAnsi(0x140, 'Init');
    await invoke(0x84, [0x800, 0x100, 0x140, 8], (dialog) => {
      assert.equal(dialog.children[0].textContent, 'Single form');
      const [input] = descendants(dialog, 'INPUT', 'text');
      assert.equal(input.value, 'Init');
      input.value = 'Entry';
    });
    assert.equal(readAnsi(0x800), 'Entry');

    writeAnsi(0x180, 'Pair form');
    writeAnsi(0x1c0, 'First');
    writeAnsi(0x200, 'Second');
    writeAnsi(0x240, 'old');
    writeAnsi(0x280, 'old');
    await invoke(0x85, [0x840, 0x880, 0x180, 0x1c0, 0x240, 12, 0x200, 0x280, 12], (dialog) => {
      const inputs = descendants(dialog, 'INPUT', 'text');
      assert.deepEqual(
        inputs.map(({value}) => value),
        ['old', 'old'],
      );
      inputs[0].value = '花';
      inputs[1].value = '空';
    });
    assert.deepEqual(memory.globalMemory.subarray(0x840, 0x843), Uint8Array.of(0x89, 0xd4, 0));
    assert.deepEqual(memory.globalMemory.subarray(0x880, 0x883), Uint8Array.of(0x8b, 0xf3, 0));

    memory.globalMemory.set(encode('Product key'), 0x300);
    memory.globalMemory.set(encode('Enter four parts'), 0x340);
    memory.globalMemory.fill(0xa5, 0x8c0, 0x8e0);
    await invoke(
      0x86,
      [0x8c0, 0x300, 0x340, 5, 0],
      (dialog) => {
        const [input] = descendants(dialog, 'INPUT', 'text');
        assert.ok(input);
        input.listeners.get('beforeinput')({
          inputType: 'insertText',
          data: '山',
          preventDefault() {},
        });
        assert.equal(input.value, '');
      },
      'ｷｬﾝｾﾙ',
      0,
    );
    assert.deepEqual(memory.globalMemory.subarray(0x8c0, 0x8e0), new Uint8Array(32).fill(0xa5));
    await invoke(0x86, [0x8c0, 0x300, 0x340, 5, 0], (dialog) => {
      assert.equal(dialog.children[0].textContent, 'Product key');
      const inputs = descendants(dialog, 'INPUT', 'text');
      assert.equal(inputs.length, 4);
      for (const value of ['A', 'B']) {
        inputs[0].listeners.get('beforeinput')({
          inputType: 'insertText',
          data: value,
          preventDefault() {},
        });
        assert.equal(inputs[0].value, value === 'A' ? '' : 'B');
      }
      ['EFGH', 'IJKL', 'MNOP'].forEach((value, index) => {
        inputs[index + 1].value = value;
      });
    });
    const productKey = encode('B-EFGH-IJKL-MNOP');
    assert.deepEqual(memory.globalMemory.subarray(0x8c0, 0x8c0 + productKey.length), productKey);
    assert.equal(memory.globalMemory[0x8c0 + productKey.length], 0xa5);

    writeAnsi(0x380, 'Two fields');
    await invoke(
      0x87,
      [1, 0x900, 0x940, 0x380, 0x1c0, 0x240, 8, 1, 0x200, 0x280, 8, 1],
      (dialog) => {
        const inputs = descendants(dialog, 'INPUT', 'text');
        assert.equal(inputs.length, 2);
        inputs[0].value = '12';
        inputs[1].value = '34';
      },
    );
    assert.equal(readAnsi(0x900), '12');
    assert.equal(readAnsi(0x940), '34');

    const names = ['山田', '太郎', '花子', '私'];
    const nameOffsets = [0x980, 0x9c0, 0xa00, 0xa40];
    names.forEach((name, index) => writeAnsi(nameOffsets[index], name));
    const view = new DataView(memory.globalMemory.buffer);
    view.setInt32(0xa80, 0, true);
    view.setInt32(0xa84, 0, true);
    await invoke(0x8f, [...nameOffsets, 0xa80, 0xa84], (dialog) => {
      const inputs = descendants(dialog, 'INPUT', 'text');
      assert.deepEqual(
        inputs.map(({value}) => value),
        names,
      );
      const [month, day] = descendants(dialog, 'SELECT');
      assert.ok(month);
      assert.ok(day);
      month.selectedIndex = 3;
      month.listeners.get('change')();
      day.selectedIndex = 11;
    });
    assert.deepEqual(nameOffsets.map(readAnsi), names);
    assert.deepEqual([view.getInt32(0xa80, true), view.getInt32(0xa84, true)], [3, 11]);
    assert.equal(child.process, null);
  } finally {
    for (const dialog of graph.host.parent.children.filter(
      ({tagName, open}) => tagName === 'DIALOG' && open,
    )) {
      button(dialog, 'OK').listeners.get('click')();
    }
    await fixture.close();
  }
});
