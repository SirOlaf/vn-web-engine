import assert from 'node:assert/strict';
import test from 'node:test';
import {pop32} from '../dist/engines/buriko/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted B0 cursor callbacks share Sprite, input, clock and scoped physical cursor', async () => {
  let now = 0;
  const fixture = await createMountedVmFixture({performanceNow: () => now});
  const {graph, child, definitions, invoke} = fixture;
  const call = async (primary, secondary, args, pushed = 0) => {
    assert.equal(await invoke(primary, secondary, args, 0), pushed);
    assert.equal(child.process, null);
  };
  const queryVisibility = async () => {
    await call(0xb0, 0x06, [], 1);
    const visible = pop32(child.state);
    assert.equal(child.state.stackIndex, 0);
    return visible;
  };
  try {
    assert.deepEqual(
      definitions
        .filter(({primary, secondary}) => primary === 0xb0 && secondary <= 0x08)
        .map(({secondary}) => secondary),
      [0x04, 0x05, 0x06],
    );
    assert.equal(graph.cursorPolicy.manager, graph.manager);
    assert.equal(graph.cursorPolicy.input, graph.input);
    assert.equal(graph.cursorPolicy.clock, graph.clock);
    assert.equal(graph.cursorPolicy.physical, graph.cursor);
    assert.equal(graph.resource.errors.files.text, graph.text);
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
    assert.equal(graph.cursorPolicy.customObject, handle);
    assert.equal(sprite.activation, 1);
    assert.deepEqual(sprite.position(), {x: 10, y: 23});
    assert.equal(graph.cursor.requestedVisibility, 0);
    assert.equal(await queryVisibility(), 1);

    await call(0xb0, 0x04, [0, 0, 0]);
    assert.equal(graph.cursorPolicy.customObject, 0);
    assert.equal(sprite.activation, 0);
    assert.equal(graph.cursor.requestedVisibility, 1);
    await call(0x90, 0x51, [handle]);
    assert.equal(graph.manager.find('sprite', handle), null);
    await call(0x90, 0x12, [0], 1);
    assert.equal(pop32(child.state), 1);
    assert.equal(child.state.stackIndex, 0);

    await call(0xb0, 0x05, [100]);
    assert.deepEqual(
      [
        graph.cursorPolicy.autoHideEnabled,
        graph.cursorPolicy.autoHideShown,
        graph.cursorPolicy.autoHideDelay,
      ],
      [1, 1, 100],
    );
    // The frame pump is not mounted yet; advance the real graph policy explicitly.
    graph.cursorPolicy.advanceAutoHide();
    now = 99;
    graph.cursorPolicy.advanceAutoHide();
    assert.equal(await queryVisibility(), 1);
    now = 100;
    graph.cursorPolicy.advanceAutoHide();
    assert.equal(graph.cursorPolicy.autoHideShown, 0);
    assert.equal(graph.cursor.requestedVisibility, 0);
    assert.equal(await queryVisibility(), 0);
    graph.input.foreground = false;
    graph.cursorPolicy.advanceAutoHide();
    assert.equal(graph.cursorPolicy.autoHideShown, 1);
    assert.equal(graph.cursor.requestedVisibility, 1);
    assert.equal(await queryVisibility(), 1);
    await call(0xb0, 0x05, [0]);
    assert.equal(graph.cursorPolicy.autoHideEnabled, 0);

    graph.input.foreground = true;
    await call(0xb0, 0x05, [100]);
    graph.cursorPolicy.advanceAutoHide();
    now = 200;
    graph.cursorPolicy.advanceAutoHide();
    assert.equal(graph.cursor.requestedVisibility, 0);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
    await fixture.close();
    assert.equal(graph.cursor.requestedVisibility, 1);
    assert.notEqual(graph.host.surface.style.cursor, 'none');
  } finally {
    await fixture.close();
  }
});
