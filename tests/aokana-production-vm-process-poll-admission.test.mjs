import assert from 'node:assert/strict';
import test from 'node:test';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('direct child process poll completes before ordinary mounted VM close', async () => {
  const fixture = await createMountedVmFixture();
  const {core, child} = fixture;
  let polls = 0,
    disposed = 0;
  child.installProcess({
    poll: async () => {
      polls++;
      return 0;
    },
    enqueueMessage() {},
    dispose() {
      disposed++;
    },
  });
  try {
    assert.equal(await child.pollProcess(false), 0);
    await core.scheduler.joinPendingProcessPoll();
    assert.equal(polls, 1);
    assert.equal(core.scheduler.hasActiveProcessPoll, false);
    assert.equal(child.process !== null, true);
    await core.close();
    assert.equal(core.scheduler.firstThread, null);
    assert.equal(disposed, 1);
  } finally {
    await fixture.close();
  }
});

test('scheduler invocation polls a child before its ordinary instruction', async () => {
  const fixture = await createMountedVmFixture();
  const {core, child} = fixture;
  const order = [];
  let disposed = 0;
  child.installProcess({
    poll: async () => {
      order.push('process');
      return 1;
    },
    enqueueMessage() {},
    dispose() {
      disposed++;
    },
  });
  core.scheduler.bindInstructionExecutor(() => {
    order.push('instruction');
    assert.equal(core.scheduler.hasActiveProcessPoll, false);
    assert.equal(core.scheduler.hasActiveInvocation, true);
    return 4;
  });
  try {
    assert.equal(await core.scheduler.run(), 0);
    await core.scheduler.joinPendingInvocation();
    assert.deepEqual(order, ['process', 'instruction']);
    assert.equal(core.scheduler.hasActiveProcessPoll, false);
    assert.equal(core.scheduler.hasActiveInvocation, false);
    assert.equal(core.scheduler.firstThread, null);
    assert.equal(disposed, 1);
  } finally {
    await fixture.close();
  }
});
