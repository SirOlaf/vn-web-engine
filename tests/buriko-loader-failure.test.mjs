import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoProductionFrameCoordinator} from '../dist/engines/buriko/native/production-frame-coordinator.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('an automatic loader host failure reaches the production frame instead of leaving a wait process stalled', async () => {
  const fixture = await createMountedVmFixture({boot: false});
  const worker = fixture.graph.resource.worker;
  const failure = new Error('Synthetic decoder worker could not start');
  const original = worker.loading.processNext;
  try {
    worker.loading.processNext = async () => {
      throw failure;
    };
    if (!worker.isRunning) worker.start();
    else worker.resumeAutomatic();
    for (let count = 0; worker.isRunning && count < 100; count++)
      await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(worker.isRunning, false);
    await assert.rejects(
      new BurikoProductionFrameCoordinator(fixture.core).tick(),
      (error) => error === failure,
    );
    await assert.rejects(worker.join(), (error) => error === failure);
  } finally {
    worker.loading.processNext = original;
    // Normal aggregate teardown also reports the original failure after its
    // existing stopped-worker recovery retires the script section.
    await assert.rejects(fixture.close(), (error) => error === failure);
  }
});
