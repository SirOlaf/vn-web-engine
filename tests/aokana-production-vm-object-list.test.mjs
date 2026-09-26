import assert from 'node:assert/strict';
import test from 'node:test';
import {pop32} from '../dist/engines/buriko/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted E0:00 traverses the selected pre-device renderer and opens the shared dialog', async () => {
  let onShow;
  let ticks = 0;
  let timestamps = 0;
  const fixture = await createMountedVmFixture({
    prepareRenderer: true,
    performanceNow: () => (ticks += 125),
    cpuHost: {
      cpuid(leaf) {
        switch (leaf) {
          case 0:
            return [1, 0x68747541, 0x444d4163, 0x69746e65];
          case 1:
            return [0x600, 0, 0, 1 << 26];
          case 0x80000000:
            return [0x80000006, 0, 0, 0];
          case 0x80000005:
            return [0, 0, (64 << 24) | 0x80040, 0];
          case 0x80000006:
            return [0, 0, (512 << 16) | 0x6040, 0];
          default:
            return [0, 0, 0, 0];
        }
      },
      readTimestampCounter: () => BigInt(timestamps++ % 2) * 2000000000n,
      setCurrentThreadAffinity: () => 3n,
      logicalProcessorCount: () => 4,
      logicalProcessorInformation: () => [{relationship: 0, processorMask: 3n}],
    },
    engineCaption: new TextEncoder().encode('Ethornell\0'),
    touchProfile: {available: true, compatibilityMouse: 'owned'},
    onDialogShown(dialog) {
      onShow?.(dialog);
    },
  });
  const {graph, child, memory, diagnostics, definitions, invoke} = fixture;
  try {
    assert.equal(graph.objectRendererReady, true);
    assert.equal(graph.manager.environment.displayContext, null);
    assert.equal(graph.device.isPresent(), false);
    assert.equal(
      definitions.filter(({primary, secondary}) => primary === 0xe0 && secondary === 0).length,
      1,
    );
    assert.equal(
      definitions.filter(({primary, secondary}) => primary === 0x92 && secondary === 0x3d).length,
      1,
    );
    assert.equal(await invoke(0x90, 0x11, [0, 3, 2, 1], 0), 0);
    assert.equal(await invoke(0x90, 0x13, [0, 0x204060], 0), 0);
    assert.equal(await invoke(0x90, 0x50, [], 0), 1);
    const handle = pop32(child.state);
    assert.equal(await invoke(0x90, 0x56, [handle, 2, 3, 0, 0, 0, 2], 0), 0);

    const shown = new Promise((resolve) => {
      onShow = resolve;
    });
    const slot = definitions.find(({primary, secondary}) => primary === 0xe0 && secondary === 0);
    const running = slot.execute({thread: child.state, memory, diagnostics});
    const dialog = await shown;
    assert.equal(dialog.children[0].textContent, 'Ethornell');
    assert.equal(dialog.children[1].textContent, '表示オブジェクト一覧');
    const list = dialog.children.find(({tagName}) => tagName === 'SELECT');
    assert.deepEqual(
      list.children.map(({textContent}) => textContent),
      ['BG - $00000000( 0 )', 'Sprite - $00000002( 2 )'],
    );
    dialog.children.find(({textContent}) => textContent === 'OK').listeners.get('click')();
    assert.equal(await running, 0);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(graph.manager.environment.displayContext, null);
  } finally {
    await fixture.close();
  }
});
