import test from 'node:test';
import assert from 'node:assert/strict';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted message process settings write the shared text layout policy', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, child, definitions, invoke} = fixture;
  const state = graph.windowState.textLayout;
  const call = async (secondary, args) => {
    assert.equal(await invoke(0x90, secondary, args, 0), 0);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
  };
  try {
    assert.equal(state.surfaces, graph.surfaces);
    assert.equal(state.text, graph.text);
    assert.equal(graph.resource.errors.files, graph.resource.files);
    assert.deepEqual(
      definitions
        .filter(
          ({primary, secondary}) =>
            primary === 0x90 &&
            [0x91, 0x92, 0x94, 0x95, 0x96, 0x97, 0x99, 0x9b, 0x9c, 0x9d, 0x9f].includes(secondary),
        )
        .map(({secondary}) => secondary),
      [0x91, 0x92, 0x94, 0x95, 0x96, 0x97, 0x99, 0x9b, 0x9c, 0x9d, 0x9f],
    );
    await call(0x91, [1, 7]);
    await call(0x95, [4, 10]);
    await call(0x96, [5, 11]);
    await call(0x97, [1, 12]);
    await call(0x99, [16]);
    await call(0x9b, [1, 13]);
    await call(0x9c, [2]);
    await call(0x9d, [20, 30, 128]);
    await call(0x94, [25]);
    await call(0x92, [1]);
    await call(0x9f, [1]);
    assert.deepEqual(
      [
        state.captureMode,
        state.captureLayer,
        state.scrollSteps,
        state.scrollInterval,
        state.fadeSteps,
        state.fadeInterval,
        state.autoWaitEnabled,
        state.autoWaitInterval,
        state.overlayFrameInterval,
        state.initialWaitEnabled,
        state.initialWaitInterval,
        state.glyphInterval,
        state.suppressProcedureRedraw,
        state.finishOnInput,
      ],
      [1, 7, 4, 10, 5, 11, 1, 12, 16, 1, 13, 25, 1, 1],
    );
    assert.deepEqual(state.defaultEffect, {
      mode: 2,
      radiusXPercent: 20,
      radiusYPercent: 30,
      color: 0,
      opacity: 128,
    });
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
  } finally {
    await fixture.close();
  }
});
