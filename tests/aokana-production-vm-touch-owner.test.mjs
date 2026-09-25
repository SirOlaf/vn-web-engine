import assert from 'node:assert/strict';
import test from 'node:test';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('selected touch profile shares one receiver, ingress, and registration owner', async () => {
  const fixture = await createMountedVmFixture({
    touchProfile: {available: true, compatibilityMouse: 'owned'},
  });
  const {graph, definitions, invoke, child} = fixture;
  try {
    assert.equal(graph.touch.available, true);
    assert.equal(graph.touch.input, graph.input);
    assert.equal(graph.touch.window, graph.touchWindow);
    assert.equal(graph.touchWindow.host, graph.host);
    assert.equal(graph.touchWindow.registered, false);
    assert.equal(graph.receiver.touch, graph.touch);
    assert.equal(graph.domInput.touch.touch, graph.touch);
    assert.equal(graph.domInput.touch.touchWindow, graph.touchWindow);
    assert.equal(graph.host.surface.style.touchAction, 'none');
    assert.deepEqual(
      definitions
        .filter(({primary, secondary}) => primary === 0x81 && secondary >= 0x16 && secondary <= 0x19)
        .map(({secondary}) => secondary),
      [0x16, 0x17, 0x18, 0x19],
    );
    assert.equal(definitions.some(({primary, secondary}) => primary === 0x92 && secondary === 0x3d), false);
    assert.equal(await invoke(0x81, 0x16, [4, 1], 0), 1);
    assert.equal(pop32(child.state), 1);
    assert.equal(await invoke(0x81, 0x18, [1], 0), 1);
    assert.equal(pop32(child.state), 1);
    assert.equal(graph.touchWindow.registered, true);
    assert.equal(await invoke(0x81, 0x19, [0], 0), 1);
    assert.equal(pop32(child.state), 0);
    await fixture.close();
    assert.equal(graph.touchWindow.registered, false);
  } finally {
    await fixture.close();
  }
});
