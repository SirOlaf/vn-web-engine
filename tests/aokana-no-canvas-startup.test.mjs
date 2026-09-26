import assert from 'node:assert/strict';
import {test} from 'node:test';
import {BrowserX86CompatibilityCpuHost} from '../dist/platform/browser-x86-cpu.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('production display starts and presents logically without acquiring a canvas context', async () => {
  let now = 0;
  const performanceNow = () => (now += 250);
  const cpuHost = new BrowserX86CompatibilityCpuHost({now: performanceNow});
  const fixture = await createMountedVmFixture({
    boot: false,
    presentationMode: 'none',
    cpuHost,
    performanceNow,
  });
  try {
    fixture.graph.display.requestedWidth = 800;
    fixture.graph.display.requestedHeight = 600;
    assert.equal(await fixture.graph.initializeDisplayForEngineStartup(), 1);
    assert.equal(fixture.graph.displayReadyForScriptGeometry, true);
    assert.equal(fixture.graph.device.isPresent(), true);
    const output = {waitCount: -1};
    assert.equal(await fixture.graph.device.present(output), 0);
    assert.equal(output.waitCount, 0);
  } finally {
    await fixture.close();
  }
});
