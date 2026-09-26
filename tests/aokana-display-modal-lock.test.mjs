import test from 'node:test';
import assert from 'node:assert/strict';
import {MemoryStore} from '../dist/platform/store.js';
import {BurikoNativeRegistry} from '../dist/engines/buriko/native/windows-registry.js';
import {BurikoDisplayMouseTrails} from '../dist/engines/buriko/native/display-mouse-trails.js';
import {BurikoScopedLock} from '../dist/engines/buriko/native/scoped-lock.js';

test('display DCLock scopes enter the actual recursive root and release in ordinary nesting order', () => {
  const actor = {},
    root = new BurikoScopedLock(() => actor);
  assert.equal(root.enter(), 1);
  const first = root.scope(),
    second = root.scope();
  assert.equal(root.depth, 3);
  assert.equal(first.enter(), 0);
  second.dispose();
  assert.equal(root.depth, 2);
  first.dispose();
  assert.equal(root.depth, 1);
  assert.equal(root.leave(), 1);
  root.dispose();
});

test('mouse-trails mode latch shares its registry value and pairs modal transitions once', async () => {
  const registry = new BurikoNativeRegistry(new MemoryStore()),
    key = await registry.createKey(0x80000001, 'Control Panel\\Mouse', 3),
    bytes = new Uint8Array(8),
    view = new DataView(bytes.buffer),
    transitions = [];
  [...' 7\0'].forEach((character, index) =>
    view.setUint16(index * 2, character.charCodeAt(0), true),
  );
  assert.equal(await registry.setValue(key.handle, 'MouseTrails', 1, bytes), 0);
  registry.closeKey(key.handle);
  const trails = new BurikoDisplayMouseTrails(registry, {
    transition: (value) => transitions.push(value),
  });
  assert.equal(await trails.read(), 7);
  await trails.transition(1);
  await trails.transition(1);
  await trails.transition(0);
  assert.deepEqual(transitions, [true, false]);
  assert.equal(registry.openHandleCount, 0);
});
