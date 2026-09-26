import assert from 'node:assert/strict';
import test from 'node:test';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaBrowserCursorPosition} from '../dist/engines/buriko/games/aokana/native/cursor-motion.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted cursor frame steps motion, auto-hide and custom Sprite in native order', async () => {
  let now = 0;
  const fixture = await createMountedVmFixture({performanceNow: () => now});
  const {graph, child, definitions, invoke} = fixture;
  const call = async (primary, secondary, args, pushed = 0) => {
    assert.equal(await invoke(primary, secondary, args, 0), pushed);
    assert.equal(child.process, null);
  };
  const visibility = async () => {
    await call(0xb0, 0x06, [], 1);
    const result = pop32(child.state);
    assert.equal(child.state.stackIndex, 0);
    return result;
  };
  try {
    assert.equal(
      definitions.filter(({primary, secondary}) => primary === 0x80 && secondary === 0x1f).length,
      1,
    );
    assert.equal(graph.cursorMotion.input, graph.input);
    assert.equal(graph.cursorMotion.clock, graph.clock);
    assert.equal(graph.cursorMotion.platform, graph.cursorPosition);
    assert.equal(graph.cursorFrame.motion, graph.cursorMotion);
    assert.equal(graph.cursorFrame.policy, graph.cursorPolicy);
    assert.ok(graph.cursorPosition instanceof AokanaBrowserCursorPosition);
    assert.equal(graph.manager.configureDescriptor(64, 32, 1, 64 * 32), 1);
    assert.equal(graph.device.isPresent(), false);
    graph.display.requestedWidth = 800;
    graph.display.requestedHeight = 600;
    graph.display.refreshPointerStep();
    graph.input.foreground = true;
    graph.input.pointerAvailable = true;
    graph.input.pointerClientX = 12;
    graph.input.pointerClientY = 30;

    await call(0x90, 0x11, [0, 4, 4, 1]);
    await call(0x90, 0x13, [0, 0x204060]);
    await call(0x90, 0x50, [], 1);
    const handle = pop32(child.state);
    assert.equal(child.state.stackIndex, 0);
    const sprite = graph.manager.find('sprite', handle);
    assert.ok(sprite);
    await call(0x90, 0x56, [handle, 0, 0, 0, 0x80, 0, 0]);
    await call(0xb0, 0x04, [handle, -2, -7]);
    assert.deepEqual(sprite.position(), {x: 10, y: 23});
    assert.equal(graph.cursor.requestedVisibility, 0);
    await call(0xb0, 0x05, [100]);
    await call(0x80, 0x1f, [20, 40, 0, 100, 20, 0]);
    assert.equal(graph.cursorMotion.active, true);

    const order = [];
    const methods = [
      [graph.cursorMotion, 'advance', 'motion'],
      [graph.cursorPolicy, 'advanceAutoHide', 'auto-hide'],
      [graph.cursorPolicy, 'updateCustom', 'custom'],
    ];
    const originals = methods.map(([owner, name]) => owner[name]);
    try {
      methods.forEach(([owner, name, label], index) => {
        owner[name] = function (...args) {
          order.push(label);
          return originals[index].apply(this, args);
        };
      });
      graph.cursorFrame.step();
    } finally {
      methods.forEach(([owner, name], index) => {
        owner[name] = originals[index];
      });
    }
    assert.deepEqual(order, ['motion', 'auto-hide', 'custom']);
    now = 50;
    graph.cursorFrame.step();
    assert.equal(graph.cursorMotion.active, true);
    assert.deepEqual(graph.input.pointerPosition(), [12, 30]);
    now = 100;
    graph.cursorFrame.step();
    assert.equal(graph.cursorMotion.active, false);
    assert.deepEqual(graph.input.pointerPosition(), [12, 30]);
    assert.equal(graph.cursorPosition.setClientPosition(20, 40), false);
    assert.equal(graph.cursorPolicy.autoHideShown, 0);
    assert.equal(await visibility(), 0);

    graph.input.pointerClientX = 14;
    graph.input.pointerClientY = 31;
    now = 101;
    graph.cursorFrame.step();
    assert.equal(graph.cursorPolicy.autoHideShown, 1);
    assert.equal(await visibility(), 1);
    assert.deepEqual(sprite.position(), {x: 12, y: 24});
    await call(0xb0, 0x04, [0, 0, 0]);
    await call(0xb0, 0x05, [0]);
    assert.equal(graph.cursor.requestedVisibility, 1);
    await call(0x90, 0x51, [handle]);
    await call(0x90, 0x12, [0], 1);
    assert.equal(pop32(child.state), 1);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
  } finally {
    await fixture.close();
  }
});
