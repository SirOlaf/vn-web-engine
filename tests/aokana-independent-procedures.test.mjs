import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBitmapCompositor} from '../dist/engines/buriko/native/bitmap-compositor.js';
import {BurikoDisplayDamage} from '../dist/engines/buriko/native/display-damage.js';
import {BurikoDisplayManager} from '../dist/engines/buriko/native/display-manager.js';
import {
  BurikoDisplayObject,
  BurikoDisplayObjectEnvironment,
} from '../dist/engines/buriko/native/display-object.js';
import {BurikoNativeDisplayState} from '../dist/engines/buriko/native/display-state.js';
import {BurikoDistributedAllocator} from '../dist/engines/buriko/native/distributed-processing.js';
import {BurikoNativeFonts} from '../dist/engines/buriko/native/fonts.js';
import {
  BurikoIndependentProcedure,
  BurikoIndependentProcedures,
} from '../dist/engines/buriko/native/independent-procedure.js';
import {BurikoSurfaces} from '../dist/engines/buriko/native/surfaces.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';

function setup() {
  const compositor = new BurikoBitmapCompositor();
  const environment = new BurikoDisplayObjectEnvironment(
    compositor,
    new BurikoDisplayDamage(32, {left: 0, top: 0, right: 799, bottom: 599}),
  );
  const surfaces = new BurikoSurfaces(
    new BurikoNativeFonts(new BurikoNativeText()),
    compositor,
    new BurikoDistributedAllocator(1),
  );
  const manager = new BurikoDisplayManager(
    environment,
    surfaces,
    new BurikoNativeDisplayState(1920, 1080),
  );
  const registry = new BurikoIndependentProcedures(manager);
  return {manager, registry, object: () => new BurikoDisplayObject(environment, 1, 0, 1)};
}

test('independent procedures share native manager aliases, constructor IDs and object associations', () => {
  const {manager, registry, object} = setup();
  const firstObject = object(),
    secondObject = object();
  const first = new BurikoIndependentProcedure(registry, firstObject),
    second = new BurikoIndependentProcedure(registry, secondObject);
  assert.deepEqual([first.id, second.id], [1, 2]);
  assert.equal(first.category, 0x80);
  assert.equal(first.getEnabled(), 1);
  assert.equal(first.dirty, 0);
  assert.equal(firstObject.getOwner(), first);
  assert.equal(registry.manager, manager);
  assert.equal(registry.surfaces, manager.surfaces);
  assert.equal(registry.registrationCount, 0);
  assert.equal(registry.pollingPhase, 0);
  assert.equal(registry.setPollingPhase(1), 1);
  assert.equal(registry.setPollingPhase(2), 0);
  assert.equal(registry.pollingPhase, 1);
  assert.equal(registry.register(first), 1);
  assert.equal(registry.register(second), 2);
  assert.equal(registry.find(1), first);
  assert.equal(registry.find(2), second);
  assert.equal(registry.remove(1), 1);
  assert.equal(firstObject.getOwner(), null);
  assert.equal(registry.registrationCount, 2);
  registry.clear();
  assert.equal(secondObject.getOwner(), null);
  assert.equal(registry.registrationCount, 0);
  assert.equal(registry.pollingPhase, 1);
  const third = new BurikoIndependentProcedure(registry, object());
  assert.equal(third.id, 3);
});

test('the DWORD FIFO copies commands and drains through disable before deciding whether to redraw', async () => {
  const {manager, registry, object} = setup();
  const seen = [];
  class Procedure extends BurikoIndependentProcedure {
    handleMessage(words) {
      seen.push(Array.from(words));
      return 77; // 08e000 ignores the handler return.
    }
  }
  const procedure = new Procedure(registry, object());
  const command = Uint32Array.of(9, 12, 34);
  assert.equal(procedure.enqueue(command), 1);
  command[1] = 99;
  procedure.enqueue(Uint32Array.of(0, 123, 456)); // Zero command with three words is ignored.
  procedure.enqueue(Uint32Array.of(0, 0));
  procedure.enqueue(Uint32Array.of(10, 56));
  procedure.dirty = 1;
  assert.equal(await procedure.poll(), 0);
  assert.deepEqual(seen, [
    [9, 12, 34],
    [10, 56],
  ]);
  assert.equal(procedure.getEnabled(), 0);
  assert.equal(procedure.dirty, 1);
  assert.equal(manager.redraw.pending, 0);
  procedure.enqueue(Uint32Array.of(0, 0xffffffff));
  assert.equal(await procedure.poll(), 0);
  assert.equal(procedure.getEnabled(), 0xffffffff);
  assert.equal(procedure.dirty, 0);
  assert.equal(manager.redraw.pending, 1);
  assert.equal(manager.redraw.mode, 0);
});

test('registry traversal is newest first, waits for each poll and resets through the native base virtual', async () => {
  const {registry, object} = setup();
  const seen = [];
  class Procedure extends BurikoIndependentProcedure {
    result = 0;
    async poll() {
      seen.push(`start ${this.id}`);
      await Promise.resolve();
      seen.push(`end ${this.id}`);
      return this.result;
    }
    handleMessage(words) {
      seen.push(`message ${this.id}:${words[0]}`);
      return 1;
    }
  }
  const first = new Procedure(registry, object()),
    second = new Procedure(registry, object()),
    third = new Procedure(registry, object());
  for (const procedure of [first, second, third]) registry.register(procedure);
  second.result = 3;
  assert.equal(await registry.pollEnabled(), 0);
  assert.deepEqual(seen, ['start 3', 'end 3', 'start 2', 'end 2']);
  seen.length = 0;
  second.setEnabled(0);
  second.enqueue(Uint32Array.of(0, 1));
  first.enqueue(Uint32Array.of(20));
  third.enqueue(Uint32Array.of(30));
  await registry.resetEnabled();
  assert.deepEqual(seen, ['message 3:30', 'message 1:20']);
  assert.equal(second.getEnabled(), 0);
  seen.length = 0;
  assert.equal(await registry.pollEnabled(), 1);
  assert.deepEqual(seen, ['start 3', 'end 3', 'start 1', 'end 1']);
  second.setEnabled(2);
  await registry.resetEnabled();
  assert.equal(second.getEnabled(), 1);
});

test('dirty redraw uses the live unsigned sort threshold and clears even when below it', async () => {
  const {manager, registry, object} = setup();
  const associated = object();
  const procedure = new BurikoIndependentProcedure(registry, associated);
  manager.setMinimumLayer(1);
  procedure.dirty = 1;
  assert.equal(procedure.redrawEligible(), false);
  await procedure.poll();
  assert.equal(procedure.dirty, 0);
  assert.equal(manager.redraw.pending, 0);
  associated.layer = 1;
  assert.equal(procedure.redrawEligible(), true);
  procedure.dirty = 7;
  await procedure.poll();
  assert.equal(procedure.dirty, 0);
  assert.equal(manager.redraw.pending, 1);
  assert.equal(manager.redraw.mode, 0);
});
