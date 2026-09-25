import assert from 'node:assert/strict';
import test from 'node:test';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaIndependentProcedure} from '../dist/engines/buriko/games/aokana/native/independent-procedure.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted known simulation tail orders metrics, particle, rain and pre-input owners', async () => {
  let now = 0;
  const fixture = await createMountedVmFixture({performanceNow: () => now});
  const {graph, data, core, child, invoke, memory} = fixture;
  const view = new DataView(memory.globalMemory.buffer);
  const call = async (primary, secondary, args, pushed = 0) => {
    assert.equal(await invoke(primary, secondary, args, 0), pushed);
    assert.equal(child.process, null);
  };
  const result = async (primary, secondary, args) => {
    await call(primary, secondary, args, 1);
    const value = pop32(child.state);
    assert.equal(child.state.stackIndex, 0);
    return value;
  };
  try {
    assert.equal(graph.particleFrames.particles, graph.particles);
    assert.equal(graph.particleFrames.clock, graph.clock);
    assert.equal(graph.rainFrames.rain, graph.rain);
    assert.equal(graph.rainFrames.clock, graph.clock);
    assert.equal(graph.frames.metrics.clock, graph.clock);
    assert.equal(graph.frames.metrics.raster, graph.device);
    assert.equal(graph.device.isPresent(), false);
    assert.equal(graph.manager.configureDescriptor(64, 32, 1, 64 * 32), 1);
    graph.display.requestedWidth = 800;
    graph.display.requestedHeight = 600;
    graph.display.refreshPointerStep();
    graph.input.foreground = true;
    graph.input.inputActive = true;
    graph.input.pointerAvailable = true;
    graph.input.pointerClientX = 12;
    graph.input.pointerClientY = 30;
    graph.input.touchPositions = [[12, 30]];

    const particleHandle = await result(0xc0, 0x00, [4, 2]);
    assert.equal(particleHandle, 0xc0000000);
    const particle = graph.particles.find(particleHandle);
    assert.ok(particle);
    await call(0xc0, 0x04, [particleHandle, 1]);
    await call(0xc0, 0x09, [particleHandle, 20]);
    assert.equal(graph.particles.scheduleHead.handle, particleHandle);
    assert.equal(graph.particles.scheduleHead.nextTick, 0);
    const rainHandle = await result(0xc0, 0x40, [4, 2]);
    assert.equal(rainHandle, 0xc1000000);
    const rain = graph.rain.find(rainHandle);
    assert.ok(rain);
    await call(0xc0, 0x42, [rainHandle, 0]);
    await call(0xc0, 0x44, [rainHandle, 1]);
    await call(0xc0, 0x4f, [1, 50]);
    assert.equal(graph.rainState.frameInterval, 20);
    rain.rainBitmap.storage.bytes.fill(0x7f);

    await call(0x90, 0x11, [0, 8, 8, 1]);
    await call(0x90, 0x13, [0, 0x204060]);
    const spriteHandle = await result(0x90, 0x50, []);
    const sprite = graph.manager.find('sprite', spriteHandle);
    assert.ok(sprite);
    await call(0x90, 0x56, [spriteHandle, 10, 28, 0, 0x80, 0, 0]);
    await call(0x90, 0x54, [spriteHandle, 1]);
    await call(0x90, 0xfa, [spriteHandle]);
    const procedure = new AokanaIndependentProcedure(data.procedures, sprite);
    assert.equal(data.procedures.register(procedure), 1);
    view.setUint32(0x400, 0, true);
    view.setUint32(0x404, 0, true);
    assert.equal(await result(0x80, 0xac, [procedure.id, 2, 0x400]), 1);
    await call(0xb0, 0x05, [20]);
    await call(0x80, 0x1f, [20, 40, 0, 20, 50, 0]);
    graph.input.setPhysicalKey(1, true);
    graph.input.recordKeyDown(1);
    graph.damage.clear();

    const order = [];
    const methods = [
      [graph.frames.metrics, 'begin', 'metrics.begin'],
      [graph.particleFrames, 'updateAll', 'particle.update'],
      [graph.particleFrames, 'pollRefresh', 'particle.refresh'],
      [graph.rainFrames, 'updateAll', 'rain.update'],
      [graph.rainFrames, 'pollRefresh', 'rain.refresh'],
      [graph.frames.metrics, 'end', 'metrics.end'],
      [procedure, 'poll', 'independent'],
      [graph.spriteTargets, 'poll', 'targets'],
      [graph.cursorFrame, 'step', 'cursor'],
    ];
    const originals = methods.map(([owner, name]) => owner[name]);
    try {
      methods.forEach(([owner, name, label], index) => {
        owner[name] = function (...args) {
          order.push(label);
          if (name === 'end') assert.deepEqual(args, [0]);
          return originals[index].apply(this, args);
        };
      });
      assert.equal(await core.runKnownSimulationTailAndPreInputFrame(), 1);
    } finally {
      methods.forEach(([owner, name], index) => {
        owner[name] = originals[index];
      });
    }
    assert.deepEqual(order, [
      'metrics.begin',
      'particle.update',
      'particle.refresh',
      'rain.update',
      'rain.refresh',
      'metrics.end',
      'independent',
      'targets',
      'cursor',
    ]);
    assert.equal(procedure.getEnabled(), 0);
    assert.equal(await result(0x90, 0xfd, [0]), 1);
    assert.equal(particle.controller.previousTick, 10);
    assert.equal(graph.particles.scheduleHead.nextTick, 20);
    assert.equal(graph.rainState.accumulatedMilliseconds, 20);
    assert.ok(rain.rainBitmap.storage.bytes.every((value) => value === 0));
    assert.ok(graph.damage.count > 0 || graph.damage.fullRedraw !== 0);
    assert.equal(graph.manager.redraw.pending, 1);
    assert.equal(graph.cursorPolicy.autoHideShown, 1);
    assert.equal(graph.cursorMotion.active, true);
    assert.equal(data.procedures.hasActiveFrameLane, false);

    assert.equal(data.procedures.setPollingPhase(1), 1);
    procedure.setEnabled(1);
    assert.equal(await result(0x80, 0xac, [procedure.id, 2, 0x400]), 1);
    now = 20;
    assert.equal(await core.runKnownSimulationTailAndPreInputFrame(), undefined);
    assert.equal(procedure.getEnabled(), 0);
    assert.equal(await result(0x90, 0xfd, [0]), 0);
    assert.equal(particle.controller.previousTick, 30);
    assert.equal(graph.particles.scheduleHead.nextTick, 40);
    assert.equal(graph.rainState.accumulatedMilliseconds, 40);
    assert.equal(graph.cursorPolicy.autoHideShown, 0);
    assert.equal(graph.cursorMotion.active, false);
    assert.deepEqual(graph.input.pointerPosition(), [12, 30]);
    assert.equal(data.procedures.hasActiveFrameLane, false);
    assert.equal(data.procedures.hasActivePoll, false);

    await call(0xb0, 0x05, [0]);
    await call(0x90, 0xfb, [spriteHandle]);
    assert.equal(data.procedures.remove(procedure.id), 1);
    await call(0x90, 0x51, [spriteHandle]);
    assert.equal(await result(0x90, 0x12, [0]), 1);
    await call(0xc0, 0x09, [particleHandle, 0]);
    await call(0xc0, 0x01, [particleHandle]);
    await call(0xc0, 0x41, [rainHandle]);
    assert.equal(graph.particles.scheduleHead, null);
    assert.equal(graph.manager.categoryCount(6), 0);
    assert.equal(graph.manager.categoryCount(7), 0);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
  } finally {
    await fixture.close();
  }
});
