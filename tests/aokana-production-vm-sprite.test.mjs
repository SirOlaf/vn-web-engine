import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted VM binds sprite lifecycle and input targets to its graph', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, child, definitions, invoke} = fixture;
  try {
    assert.equal(graph.spriteTargets.manager, graph.manager);
    assert.equal(graph.spriteTargets.input, graph.input);
    assert.deepEqual(
      definitions
        .filter(
          ({primary, secondary}) => primary === 0x90 && secondary >= 0x50 && secondary <= 0x5d,
        )
        .map(({secondary}) => secondary)
        .sort((left, right) => left - right),
      [0x50, 0x51, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x5b, 0x5c, 0x5d],
    );
    assert.deepEqual(
      definitions
        .filter(
          ({primary, secondary}) => primary === 0x90 && secondary >= 0xf8 && secondary <= 0xfd,
        )
        .map(({secondary}) => secondary),
      [0xf8, 0xfa, 0xfb, 0xfc, 0xfd],
    );
    for (const [surface, format] of [
      [0, 2],
      [1, 2],
      [2, 3],
      [3, 6],
    ])
      assert.equal(graph.surfaces.allocate(surface, 8, 8, format), 1);
    assert.equal(graph.surfaces.fill(0, 0xff204060), 1);
    assert.equal(graph.surfaces.fill(1, 0xff6080a0), 1);
    const staticMask = graph.surfaces.descriptor(2);
    staticMask.storage.bytes.fill(255);
    staticMask.storage.written(0, staticMask.storage.bytes.length);
    const displacementMap = graph.surfaces.descriptor(3);
    displacementMap.storage.written(0, displacementMap.storage.bytes.length);
    assert.equal(graph.surfaces.coefficientTables.configureRipple(1, 1, 256, 1, 1), 0);
    assert.equal(await invoke(0x90, 0x50, [], 0), 1);
    const lifecycleHandle = pop32(child.state);
    assert.equal(child.state.stackIndex, 0);
    const configuredSprite = graph.manager.find('sprite', lifecycleHandle);
    assert.ok(configuredSprite);
    const callSprite = async (secondary, args) => {
      assert.equal(await invoke(0x90, secondary, args, 0), 0);
    };
    await callSprite(0x56, [lifecycleHandle, 3, 4, 0, 0x80, 12, 7]);
    assert.deepEqual(
      [
        configuredSprite.mode,
        configuredSprite.sourceSurface,
        configuredSprite.position(),
        configuredSprite.getLayer(),
      ],
      [0, 0, {x: 3, y: 4}, 7],
    );
    graph.damage.clear();
    await callSprite(0x53, [lifecycleHandle, 1, 1, 2, 2]);
    assert.deepEqual(graph.damage.snapshot(), [
      {rectangle: {left: 4, top: 5, right: 5, bottom: 6}, key: configuredSprite.sortKey()},
    ]);
    await callSprite(0x57, [lifecycleHandle, 1]);
    assert.equal(configuredSprite.sourceSurface, 1);
    await callSprite(0x58, [lifecycleHandle, 5, 6, 0, 1, 128, 17, 8, 2]);
    assert.deepEqual(
      [configuredSprite.mode, configuredSprite.secondarySurface, configuredSprite.mixValue],
      [1, 1, 128],
    );
    await callSprite(0x59, [lifecycleHandle, 7, 8, 0, 2, 3, 0, 65536, 65536, 0, 0x80, 18, 9]);
    assert.equal(configuredSprite.mode, 2);
    await callSprite(0x5a, [lifecycleHandle, 9, 10, 0, 2, 256, 1, 0x80, 19, 10]);
    assert.deepEqual([configuredSprite.mode, configuredSprite.revealExponent], [3, 256]);
    await callSprite(0x5b, [lifecycleHandle, 11, 12, 0, 3, 1, 1, 256, 20, 11]);
    assert.deepEqual([configuredSprite.mode, configuredSprite.displacementMapSurface], [4, 3]);
    await callSprite(0x5c, [
      lifecycleHandle,
      0x10000,
      0x20000,
      0,
      0,
      0xffffffff,
      128,
      2,
      2,
      3,
      0,
      0,
      0,
      0,
      0x80,
      21,
      12,
    ]);
    assert.deepEqual(
      [configuredSprite.mode, configuredSprite.coordinates()],
      [5, {x: 0x10000, y: 0x20000, z: 0}],
    );
    await callSprite(0x5d, [
      lifecycleHandle,
      0x30000,
      0x40000,
      0,
      0,
      1,
      128,
      2,
      2,
      3,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0x80,
      22,
      13,
    ]);
    assert.deepEqual(
      [
        configuredSprite.mode,
        configuredSprite.coordinates(),
        configuredSprite.getBlendValue(),
        configuredSprite.getLayer(),
      ],
      [6, {x: 0x30000, y: 0x40000, z: 0}, 22, 13],
    );
    await callSprite(0x56, [lifecycleHandle, 3, 4, 0, 0x80, 12, 7]);
    await callSprite(0x54, [lifecycleHandle, 1]);
    assert.equal(configuredSprite.inputActive(), 1);
    await callSprite(0x55, [lifecycleHandle, 2]);
    assert.equal(configuredSprite.staticMaskSurface, 2);
    const previousPointerAvailable = graph.input.pointerAvailable;
    const previousTouchPositions = graph.input.touchPositions;
    graph.input.pointerAvailable = true;
    graph.input.touchPositions = [[4, 5]];
    const spriteCaptures = () =>
      graph.input.captureDiagnosticView().pointer.filter(({object}) => object === configuredSprite)
        .length;
    assert.equal(spriteCaptures(), 0);
    await callSprite(0xfa, [lifecycleHandle]);
    assert.equal(spriteCaptures(), 1);
    assert.equal(await invoke(0x90, 0xfc, [], 0), 1);
    assert.equal(pop32(child.state), 0);
    assert.equal(child.state.stackIndex, 0);
    await callSprite(0xfb, [lifecycleHandle]);
    assert.equal(spriteCaptures(), 0);
    assert.equal(await invoke(0x90, 0xfc, [], 0), 1);
    assert.equal(pop32(child.state), 0xffffffff);
    assert.equal(child.state.stackIndex, 0);
    await callSprite(0xfa, [lifecycleHandle]);
    assert.equal(spriteCaptures(), 1);
    assert.equal(await invoke(0x90, 0xfc, [], 0), 1);
    assert.equal(pop32(child.state), 1);
    assert.equal(child.state.stackIndex, 0);
    await callSprite(0xf8, []);
    assert.equal(spriteCaptures(), 0);
    assert.equal(await invoke(0x90, 0xfc, [], 0), 1);
    assert.equal(pop32(child.state), 0xffffffff);
    assert.equal(child.state.stackIndex, 0);
    graph.input.pointerAvailable = previousPointerAvailable;
    graph.input.touchPositions = previousTouchPositions;
    await callSprite(0x51, [lifecycleHandle]);
    assert.equal(graph.manager.find('sprite', lifecycleHandle), null);
    for (const surface of [3, 2, 1, 0]) assert.equal(graph.surfaces.release(surface), 1);
    graph.surfaces.coefficientTables.clear();
  } finally {
    await fixture.close();
  }
});
