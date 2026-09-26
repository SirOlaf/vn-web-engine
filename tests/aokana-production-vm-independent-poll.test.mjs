import assert from 'node:assert/strict';
import test from 'node:test';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaIndependentProcedure} from '../dist/engines/buriko/games/aokana/native/independent-procedure.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted VM polls one graph-owned independent procedure through the core lane', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, data, core, child, invoke} = fixture;
  const call = async (secondary, args, pushed = 0) => {
    assert.equal(await invoke(0x90, secondary, args, 0), pushed);
    assert.equal(child.process, null);
  };
  try {
    assert.equal(data.procedures.manager, graph.manager);
    assert.equal(data.procedures.surfaces, graph.surfaces);
    assert.equal(core.data.procedures, data.procedures);
    assert.equal(graph.manager.configureDescriptor(64, 32, 1, 64 * 32), 1);
    await call(0x11, [0, 4, 4, 1]);
    await call(0x13, [0, 0x204060]);
    await call(0x50, [], 1);
    const handle = pop32(child.state);
    assert.equal(child.state.stackIndex, 0);
    const sprite = graph.manager.find('sprite', handle);
    assert.ok(sprite);
    await call(0x56, [handle, 2, 3, 0, 0x80, 0, 0]);

    const procedure = new AokanaIndependentProcedure(data.procedures, sprite);
    assert.equal(data.procedures.register(procedure), 1);
    assert.equal(sprite.getOwner(), procedure);
    procedure.dirty = 1;
    assert.equal(await core.runIndependentPoll('enabled'), 1);
    assert.equal(procedure.dirty, 0);
    assert.equal(data.procedures.hasActivePoll, false);

    assert.equal(procedure.enqueue(Uint32Array.of(0, 0)), 1);
    assert.equal(await core.runIndependentPoll('reset'), undefined);
    assert.equal(procedure.getEnabled(), 0);
    assert.equal(data.procedures.hasActivePoll, false);
    assert.equal(core.hasPendingNativeCallbacks, false);
    assert.equal(data.procedures.remove(procedure.id), 1);
    assert.equal(sprite.getOwner(), null);
    assert.equal(data.procedures.find(procedure.id), null);
    await call(0x51, [handle]);
    await call(0x12, [0], 1);
    assert.equal(pop32(child.state), 1);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
  } finally {
    await fixture.close();
  }
});
