import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted knob callbacks share Sprite, input capture and receiver owners', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, child, definitions, invoke} = fixture;
  const call = async (primary, secondary, args, pushed = 0) => {
    assert.equal(await invoke(primary, secondary, args, 0), pushed);
    assert.equal(child.process, null);
  };
  const pop = () => pop32(child.state);
  try {
    assert.equal(graph.knobs.manager, graph.manager);
    assert.equal(graph.knobs.input, graph.input);
    assert.equal(graph.knobs.notifications, graph.notifications);
    assert.equal(graph.receiver.knobs, graph.knobs);
    assert.deepEqual(
      definitions
        .filter(
          ({primary, secondary}) =>
            primary === 0x90 &&
            [0xd0, 0xd1, ...Array.from({length: 12}, (_, index) => index + 0xd4)].includes(
              secondary,
            ),
        )
        .map(({secondary}) => secondary),
      [0xd0, 0xd1, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xdb, 0xdc, 0xdd, 0xde, 0xdf],
    );
    assert.ok(definitions.some(({primary, secondary}) => primary === 0x91 && secondary === 0xdb));

    await call(0x90, 0x11, [0, 10, 5, 2]);
    await call(0x90, 0x13, [0, 0xff204060]);
    await call(0x90, 0x50, [], 1);
    const spriteHandle = pop();
    const sprite = graph.manager.find('sprite', spriteHandle);
    assert.ok(sprite);
    await call(0x90, 0x56, [spriteHandle, 10, 20, 0, 0x80, 12, 2]);
    assert.deepEqual(sprite.position(), {x: 10, y: 20});
    assert.deepEqual(sprite.localRectangle(), {left: 0, top: 0, right: 9, bottom: 4});

    await call(0x90, 0xd0, [spriteHandle], 1);
    const handle = pop();
    assert.equal(handle, 0xf0000000);
    const knob = graph.manager.find('knob', handle);
    assert.ok(knob);
    assert.equal(sprite.parent, knob);
    assert.equal(graph.manager.categoryCount(0x10), 1);
    const captures = () =>
      graph.input.captureDiagnosticView().pointer.filter(({object}) => object === knob).length;
    assert.equal(captures(), 1);

    await call(0x90, 0xd4, [handle, 1]);
    await call(0x90, 0xd9, [handle, 13, 8]);
    await call(0x90, 0xd8, [handle, 6, 4]);
    await call(0x90, 0xd6, [handle, 3, 2]);
    // The 10x5 Sprite source leaves three pixels of travel on each axis.
    assert.deepEqual(sprite.position(), {x: 11, y: 22});
    await call(0x90, 0xd5, [handle, 30, 40]);
    assert.deepEqual(sprite.position(), {x: 31, y: 42});
    await call(0x90, 0xd7, [handle], 2);
    assert.equal(pop(), 2);
    assert.equal(pop(), 3);
    await call(0x90, 0xdc, [handle, 1]);
    assert.equal(knob.dragAnchor, 1);

    await call(0x90, 0xdd, [9], 1);
    assert.equal(pop(), 1);
    assert.equal(graph.knobs.wheelModeValue(), 9);
    await call(0x90, 0xde, [handle]);
    assert.equal(graph.knobs.handleWheel(0), true);
    assert.deepEqual(knob.value(), {x: 3, y: 1});
    assert.deepEqual(sprite.position(), {x: 31, y: 41});
    await call(0x90, 0xda, [handle], 1);
    assert.equal(pop(), 0);
    await call(0x90, 0xdb, [], 1);
    assert.equal(pop(), 0);
    await call(0x91, 0xdb, [], 1);
    assert.equal(pop(), 0);

    graph.input.foreground = true;
    graph.input.pointerAvailable = true;
    graph.input.touchPositions = [[31, 41]];
    const receiver = graph.knobs.findPointerReceiver();
    assert.ok(receiver);
    assert.equal(receiver.id, handle);
    graph.knobs.beginPointerInteraction(receiver, 31, 41);
    await call(0x91, 0xdb, [], 1);
    assert.equal(pop(), handle);
    await call(0x90, 0xdf, [handle]);
    assert.equal(graph.knobs.handleWheel(0), false);
    await call(0x90, 0xd1, [handle]);
    assert.equal(graph.manager.find('knob', handle), null);
    assert.equal(graph.manager.categoryCount(0x10), 0);
    assert.equal(sprite.parent, null);
    assert.equal(captures(), 0);
    await call(0x91, 0xdb, [], 1);
    assert.equal(pop(), 0);
    await call(0x90, 0x51, [spriteHandle]);
    assert.equal(graph.manager.find('sprite', spriteHandle), null);
    await call(0x90, 0x12, [0], 1);
    assert.equal(pop(), 1);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
  } finally {
    await fixture.close();
  }
});
