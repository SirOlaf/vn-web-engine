import assert from 'node:assert/strict';
import test from 'node:test';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('one mounted native callback enters the scheduler only on its instruction stack', async () => {
  const fixture = await createMountedVmFixture();
  const {core, child, definitions, memory, diagnostics, graph} = fixture;
  const launcher = definitions.find(
    ({primary, secondary}) => primary === 0x80 && secondary === 0xfd,
  );
  assert.ok(launcher);
  const context = {thread: child.state, memory, diagnostics};
  try {
    assert.equal(core.scheduler.isDispatchingInstructionFor(child.state), false);
    assert.equal(launcher.execute(context), 0);
    assert.equal(pop32(child.state), 1);
    assert.equal(child.state.stackIndex, 0);

    let instructions = 0;
    core.scheduler.bindInstructionExecutor((thread) => {
      assert.equal(thread, child.state);
      assert.equal(core.scheduler.isDispatchingInstructionFor(thread), true);
      assert.equal(core.scheduler.isDispatchingInstructionFor(core.root), false);
      instructions++;
      if (instructions === 1) return launcher.execute(context);
      assert.equal(pop32(thread), 1);
      assert.equal(thread.stackIndex, 0);
      return 4;
    });
    assert.equal(await core.scheduler.run(), 0);
    assert.equal(instructions, 2);
    assert.equal(core.scheduler.isDispatchingInstructionFor(child.state), false);
    assert.equal(core.scheduler.hasActiveInvocation, false);
    assert.equal(core.pendingNativeCallbackCount, 0);
    assert.equal(core.scheduler.firstThread, null);
    assert.equal(graph.device.isPresent(), false);
  } finally {
    await fixture.close();
  }
});
