import test from 'node:test';
import assert from 'node:assert/strict';
import {D3d11Lifetime, D3d11Object} from '../dist/native/d3d11/runtime/com.js';
const iid = '00000000-0000-0000-c000-000000000046';

test('native D3D11 handles keep caller and binding ownership separate through final release', () => {
  const events = [];
  let binding = null;
  const lifetime = new D3d11Lifetime(() => {
    events.push('bindings');
    binding?.releaseBinding();
    binding = null;
  });
  const device = new D3d11Object(lifetime, [], () => events.push('device'), true);
  const context = new D3d11Object(lifetime, [], () => events.push('context'), true);
  const resource = new D3d11Object(lifetime, [], () => events.push('resource'));
  const alias = resource.queryInterface(iid.toUpperCase());
  assert.equal(alias.hr, 0);
  assert.equal(alias.value, resource);
  assert.equal(resource.queryInterface('unsupported').value, null);
  resource.retainBinding();
  binding = resource;
  assert.equal(alias.value.release(), 2);
  assert.equal(device.release(), 0);
  // A child GetDevice can reacquire the device while another interface keeps it alive.
  assert.equal(device.addRef(), 1);
  assert.equal(device.release(), 0);
  assert.equal(resource.release(), 1);
  assert.deepEqual(events, []);
  assert.equal(lifetime.closed, false);
  assert.equal(context.release(), 0);
  assert.deepEqual(events, ['bindings', 'resource', 'device', 'context']);
  assert.equal(lifetime.closed, true);
  assert.equal(resource.addRef(), 0);
  assert.equal(context.addRef(), 0);
  assert.equal(context.release(), 0);
  assert.equal(resource.release(), 0);
  assert.deepEqual(events, ['bindings', 'resource', 'device', 'context']);
});

test('replacing a D3D11 binding can retain the same handle before releasing its old reference', () => {
  const events = [];
  const lifetime = new D3d11Lifetime(() => events.push('closed'));
  const device = new D3d11Object(lifetime, [], () => events.push('device'), true);
  const resource = new D3d11Object(lifetime, [], () => events.push('resource'));
  resource.retainBinding();
  assert.equal(resource.release(), 1);
  resource.retainBinding();
  resource.releaseBinding();
  assert.deepEqual(events, []);
  const owned = resource.queryInterface(iid);
  assert.equal(owned.value, resource);
  resource.releaseBinding();
  assert.deepEqual(events, []);
  assert.equal(owned.value.release(), 0);
  assert.deepEqual(events, ['resource']);
  device.release();
  assert.deepEqual(events, ['resource', 'closed', 'device']);
});

test('D3D11 disposal retires every root even if one cleanup fails', () => {
  const events = [];
  const lifetime = new D3d11Lifetime(() => {
    events.push('bindings');
    throw new Error('binding cleanup');
  });
  const first = new D3d11Object(
    lifetime,
    [],
    () => {
      events.push('first');
      throw new Error('first cleanup');
    },
    true,
  );
  const last = new D3d11Object(lifetime, [], () => events.push('last'), true);
  first.release();
  assert.throws(
    () => last.release(),
    (error) => error instanceof AggregateError && error.errors.length === 2,
  );
  assert.deepEqual(events, ['bindings', 'first', 'last']);
  assert.equal(lifetime.closed, true);
  assert.equal(last.release(), 0);
});
