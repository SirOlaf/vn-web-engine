import assert from 'node:assert/strict';
import test from 'node:test';
import {pop32} from '../dist/engines/buriko/bp/state.js';
import {BurikoIndependentProcedure} from '../dist/engines/buriko/native/independent-procedure.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted pre-input frame polls independent work before Sprite targets and cursor policy', async () => {
  let now = 0;
  const fixture = await createMountedVmFixture({performanceNow: () => now});
  const {graph, data, core, child, definitions, invoke, memory} = fixture;
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
  const captures = () => {
    const state = graph.input.captureDiagnosticView();
    return {
      pointer: state.pointer.map(({token}) => token),
      key: state.key.map(({token}) => token),
    };
  };
  try {
    assert.deepEqual(
      definitions
        .filter(
          ({primary, secondary}) => primary === 0x90 && secondary >= 0xf8 && secondary <= 0xfd,
        )
        .map(({secondary}) => secondary),
      [0xf8, 0xfa, 0xfb, 0xfc, 0xfd],
    );
    assert.equal(core.data.procedures, data.procedures);
    assert.equal(graph.spriteTargets.manager, graph.manager);
    assert.equal(graph.spriteTargets.input, graph.input);
    assert.equal(graph.cursorFrame.motion, graph.cursorMotion);
    assert.equal(graph.cursorFrame.policy, graph.cursorPolicy);
    assert.equal(graph.manager.configureDescriptor(64, 32, 1, 64 * 32), 1);
    assert.equal(graph.device.isPresent(), false);
    graph.display.requestedWidth = 800;
    graph.display.requestedHeight = 600;
    graph.display.refreshPointerStep();
    graph.input.foreground = true;
    graph.input.inputActive = true;
    graph.input.pointerAvailable = true;
    graph.input.pointerClientX = 12;
    graph.input.pointerClientY = 30;
    graph.input.touchPositions = [[12, 30]];
    const initialCaptures = captures();

    await call(0x90, 0x11, [0, 8, 8, 1]);
    await call(0x90, 0x13, [0, 0x204060]);
    const targetHandle = await result(0x90, 0x50, []);
    const customHandle = await result(0x90, 0x50, []);
    const target = graph.manager.find('sprite', targetHandle);
    const custom = graph.manager.find('sprite', customHandle);
    assert.ok(target);
    assert.ok(custom);
    await call(0x90, 0x56, [targetHandle, 10, 28, 0, 0x80, 0, 0]);
    await call(0x90, 0x54, [targetHandle, 1]);
    await call(0x90, 0x56, [customHandle, 0, 0, 0, 0x80, 0, 0]);
    await call(0x90, 0xfa, [targetHandle]);
    assert.equal(await result(0x90, 0xfd, [0]), 0);
    const procedure = new BurikoIndependentProcedure(data.procedures, target);
    assert.equal(data.procedures.register(procedure), 1);
    view.setUint32(0x400, 0, true);
    view.setUint32(0x404, 0, true);
    assert.equal(await result(0x80, 0xac, [procedure.id, 2, 0x400]), 1);
    await call(0xb0, 0x04, [customHandle, -2, -7]);
    await call(0xb0, 0x05, [100]);
    await call(0x80, 0x1f, [20, 40, 0, 100, 20, 0]);
    graph.input.setPhysicalKey(1, true);
    graph.input.recordKeyDown(1);

    const order = [];
    const originalProcedurePoll = procedure.poll;
    const originalTargetPoll = graph.spriteTargets.poll;
    const originalCursorStep = graph.cursorFrame.step;
    procedure.poll = async function (...args) {
      order.push('independent');
      return originalProcedurePoll.apply(this, args);
    };
    graph.spriteTargets.poll = function (...args) {
      order.push('targets');
      return originalTargetPoll.apply(this, args);
    };
    graph.cursorFrame.step = function (...args) {
      order.push('cursor');
      return originalCursorStep.apply(this, args);
    };
    try {
      assert.equal(await core.runPreInputFrame(), 1);
    } finally {
      procedure.poll = originalProcedurePoll;
      graph.spriteTargets.poll = originalTargetPoll;
      graph.cursorFrame.step = originalCursorStep;
    }
    assert.deepEqual(order, ['independent', 'targets', 'cursor']);
    assert.equal(procedure.getEnabled(), 0);
    assert.equal(await result(0x90, 0xfd, [0]), 1);
    assert.equal(await result(0x90, 0xfd, [0]), 1);
    assert.deepEqual(custom.position(), {x: 10, y: 23});
    assert.equal(data.procedures.hasActiveFrameLane, false);
    assert.equal(data.procedures.hasActivePoll, false);

    assert.equal(data.procedures.setPollingPhase(1), 1);
    procedure.setEnabled(1);
    assert.equal(await result(0x80, 0xac, [procedure.id, 2, 0x400]), 1);
    now = 100;
    assert.equal(await core.runPreInputFrame(), undefined);
    assert.equal(procedure.getEnabled(), 0);
    assert.equal(await result(0x90, 0xfd, [0]), 0);
    assert.equal(graph.cursorMotion.active, false);
    assert.equal(graph.cursorPolicy.autoHideShown, 0);
    assert.deepEqual(graph.input.pointerPosition(), [12, 30]);

    graph.input.pointerClientX = 14;
    graph.input.pointerClientY = 31;
    graph.input.touchPositions = [[14, 31]];
    now = 101;
    assert.equal(await core.runPreInputFrame(), undefined);
    assert.equal(graph.cursorPolicy.autoHideShown, 1);
    assert.deepEqual(custom.position(), {x: 12, y: 24});
    await call(0xb0, 0x04, [0, 0, 0]);
    await call(0xb0, 0x05, [0]);
    await call(0x90, 0xfb, [targetHandle]);
    assert.equal(data.procedures.remove(procedure.id), 1);
    assert.equal(target.getOwner(), null);
    assert.deepEqual(captures(), initialCaptures);
    await call(0x90, 0x51, [customHandle]);
    await call(0x90, 0x51, [targetHandle]);
    assert.equal(await result(0x90, 0x12, [0]), 1);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
  } finally {
    await fixture.close();
  }
});
