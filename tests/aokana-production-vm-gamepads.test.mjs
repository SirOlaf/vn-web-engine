import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaBrowserGamepads} from '../dist/engines/buriko/games/aokana/native/browser-gamepads.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted 81:1B/1D use one explicitly initialized and polled in-memory gamepad owner', async () => {
  const pad = {
    index: 0,
    id: 'selected test pad',
    connected: true,
    mapping: 'standard',
    axes: [0, 0, 0, 0],
    buttons: Array.from({length: 16}, () => ({pressed: false, value: 0})),
  };
  const capabilities = {
    size: 44,
    flags: 0,
    deviceType: 20,
    axes: 4,
    buttons: 16,
    povs: 1,
    forceFeedbackSamplePeriod: 0,
    forceFeedbackMinimumTimeResolution: 0,
    firmwareRevision: 0,
    hardwareRevision: 0,
    forceFeedbackDriverVersion: 0,
  };
  const gamepadHost = new AokanaBrowserGamepads({getGamepads: () => [pad]}, [
    {
      browserIndex: 0,
      browserId: pad.id,
      browserMapping: 'standard',
      instanceGuid: '00112233-4455-6677-8899-aabbccddeeff',
      capabilities,
      axes: [{index: 0}, {index: 1}, {index: 2}, null, null, {index: 3}, null, null],
      povs: [{up: 12, right: 15, down: 13, left: 14}, null, null, null],
      buttons: Array.from({length: 32}, (_, index) => (index < 16 ? index : null)),
    },
  ]);
  const fixture = await createMountedVmFixture({gamepadHost});
  const {graph, child, definitions, memory, invoke} = fixture;
  try {
    assert.equal(graph.gamepadHost, gamepadHost);
    assert.equal(graph.gamepads.host, gamepadHost);
    assert.equal(graph.gamepads.input, graph.input);
    assert.equal(graph.gamepads.notifications, graph.notifications);
    assert.deepEqual(
      definitions
        .filter(({primary, secondary}) => primary === 0x81 && [0x1b, 0x1d].includes(secondary))
        .map(({secondary}) => secondary),
      [0x1b, 0x1d],
    );

    assert.equal(graph.gamepads.initialize(), 1);
    assert.deepEqual(graph.gamepads.deviceIds, [1]);
    assert.equal(await invoke(0x81, 0x1b, [0, 13], 0), 1);
    assert.equal(pop32(child.state), 1);
    assert.equal(graph.gamepads.mapping(0), 13);

    pad.axes.splice(0, 4, 1, -1, 0.5, -0.5);
    for (const button of [0, 12, 15]) {
      pad.buttons[button].pressed = true;
      pad.buttons[button].value = 1;
    }
    assert.equal(graph.gamepads.poll(), 0);
    assert.equal(graph.input.totalPresses(13), 1);
    assert.deepEqual(
      Array.from({length: 6}, () => graph.notifications.take()),
      [
        {type: 0x102, value1: 1, value2: 1},
        {type: 0x100, value1: 0x80, value2: 1},
        {type: 0x100, value1: 0x8c, value2: 1},
        {type: 0x100, value1: 0x8f, value2: 1},
        {type: 0x101, value1: 0xc00400, value2: 1},
        {type: 0x101, value1: 0x1e00200, value2: 1},
      ],
    );
    assert.equal(graph.notifications.take(), null);

    assert.equal(await invoke(0x81, 0x1d, [0x200, 1], 0), 1);
    assert.equal(pop32(child.state), 1);
    const output = new DataView(memory.globalMemory.buffer, 0x200, 24);
    assert.deepEqual(
      [
        output.getInt32(0, true),
        output.getInt32(4, true),
        output.getInt32(8, true),
        output.getInt32(12, true),
        output.getUint32(16, true),
        output.getUint32(20, true),
      ],
      [1024, -1024, 512, -512, 1, 0x9001],
    );
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
    await fixture.close();
    assert.equal(graph.gamepads.enabled, 0);
    assert.deepEqual(graph.gamepads.deviceIds, []);
    assert.equal(graph.gamepads.pendingDeviceCloseCount, 0);
  } finally {
    await fixture.close();
  }
});

test('mounted catalog selects the browser gamepad host', async () => {
  const fixture = await createMountedVmFixture();
  try {
    assert.ok(fixture.graph.gamepadHost);
    assert.equal(fixture.graph.gamepads.host, fixture.graph.gamepadHost);
    assert.equal(
      fixture.definitions.filter(
        ({primary, secondary}) => primary === 0x81 && [0x1b, 0x1d].includes(secondary),
      ).length,
      2,
    );
  } finally {
    await fixture.close();
  }
});
