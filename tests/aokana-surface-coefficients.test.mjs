import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, push32} from '../dist/engines/buriko/bp/state.js';
import {BurikoBitmapCompositor} from '../dist/engines/buriko/native/bitmap-compositor.js';
import {BurikoDistributedAllocator} from '../dist/engines/buriko/native/distributed-processing.js';
import {BurikoNativeFonts} from '../dist/engines/buriko/native/fonts.js';
import {createGroup92CoefficientTables} from '../dist/engines/buriko/native/group-92-coefficients.js';
import {BURIKO_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/native/inventory.js';
import {BurikoSurfaces} from '../dist/engines/buriko/native/surfaces.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';

const packedWord = (value) => {
  const word = value & 0xffff;
  return (word | (word << 16)) >>> 0;
};

function surfaces() {
  const text = new BurikoNativeText();
  return {
    text,
    surfaces: new BurikoSurfaces(
      new BurikoNativeFonts(text),
      new BurikoBitmapCompositor(),
      new BurikoDistributedAllocator(1),
    ),
  };
}

test('surface coefficient sine producer preserves defaults, trailing padding and exact wrapping', () => {
  const owner = surfaces().surfaces.coefficientTables;
  assert.equal(owner.capacity, 8);
  for (let index = 0; index < owner.capacity; index++)
    assert.deepEqual(owner.snapshot(index), {
      active: 0,
      initial: 0,
      lower: 0,
      span: 0,
      end: 0,
      coefficients: null,
    });

  assert.equal(owner.configureRipple(2, 0, 256, 0, 0), 0);
  assert.deepEqual(owner.snapshot(2), {
    active: 1,
    initial: 0,
    lower: 0,
    span: 4,
    end: 4,
    coefficients: Uint32Array.of(0, packedWord(256), 0, packedWord(-256)),
  });
  assert.deepEqual(owner.query(2, 0, 1), {status: 0, available: 1});
  const scaled = new Uint32Array(4);
  assert.equal(owner.expand(scaled, 2, 0, 128, 1), 0);
  assert.deepEqual(scaled, Uint32Array.of(0, packedWord(128), 0, packedWord(-128)));

  assert.equal(owner.configureRipple(2, 1, 256, 2, 2), 0);
  const repeated = owner.snapshot(2);
  assert.deepEqual([repeated.span, repeated.end], [8, 16]);
  assert.deepEqual(
    repeated.coefficients,
    Uint32Array.of(
      0,
      packedWord(256),
      0,
      packedWord(-256),
      0,
      0,
      0,
      0,
      0,
      packedWord(256),
      0,
      packedWord(-256),
      0,
      0,
      0,
      0,
    ),
  );
  const wrapped = new Uint32Array(4);
  assert.equal(owner.expand(wrapped, 2, 2, 256, 1), 0);
  assert.deepEqual(wrapped, repeated.coefficients.slice(8, 12));
  assert.deepEqual(owner.query(2, 2, 3), {status: 0, available: 0});
  const unavailable = new Uint32Array(12).fill(0xdeadbeef);
  assert.equal(owner.expand(unavailable, 2, 2, 256, 3), 0x12);
  assert.equal(
    unavailable.every((value) => value === 0xdeadbeef),
    true,
  );
});

test('surface coefficient envelope retains leading gaps and ordered fade periods', () => {
  const owner = surfaces().surfaces.coefficientTables;
  assert.equal(owner.configureRippleEnvelope(1, 1, 256, 2, 2, 2, 2), 0);
  const record = owner.snapshot(1),
    values = record.coefficients;
  assert.deepEqual(
    [record.active, record.initial, record.lower, record.span, record.end],
    [1, 0, 0, 40, 80],
  );
  assert.equal(values.length, 80);
  assert.equal(
    values.slice(0, 20).every((value) => value === 0),
    true,
  );
  assert.deepEqual(
    [values[21], values[25], values[29], values[33], values[37]],
    [64, 128, 256, 128, 64].map(packedWord),
  );
  assert.equal(
    values.slice(40, 60).every((value) => value === 0),
    true,
  );
  assert.deepEqual(
    [values[61], values[65], values[69], values[73], values[77]],
    [64, 128, 256, 128, 64].map(packedWord),
  );
});

test('surface coefficient replacement and teardown retain the shared eight-record owner', () => {
  const owner = surfaces().surfaces.coefficientTables;
  owner.configureRipple(0, 1, 64, 1, 1);
  owner.configureRippleEnvelope(0, 2, 128, 1, 0, 1, 1);
  assert.deepEqual(
    [owner.snapshot(0).active, owner.snapshot(0).span, owner.snapshot(0).end],
    [1, 16, 16],
  );
  owner.configureRipple(7, 1, 32, 1, 1);
  owner.clear();
  for (let index = 0; index < owner.capacity; index++)
    assert.deepEqual(owner.snapshot(index), {
      active: 0,
      initial: 0,
      lower: 0,
      span: 0,
      end: 0,
      coefficients: null,
    });
});

test('92 00/01 wrappers consume real stacks and configure the attached surface owner', async () => {
  const state = surfaces(),
    definitions = createGroup92CoefficientTables(state.surfaces, {
      files: {text: state.text},
      threadFatal() {
        assert.fail('ordinary coefficient configuration should not raise a thread error');
      },
    });
  assert.deepEqual(
    definitions.map((definition) => [definition.primary, definition.secondary]),
    [
      [0x92, 0x00],
      [0x92, 0x01],
    ],
  );
  for (const definition of definitions)
    assert.equal(
      definition.nativeAddress,
      BURIKO_NATIVE_SLOT_ADDRESSES[definition.primary][definition.secondary],
    );
  const thread = new BurikoBpThread({
      id: 1,
      operandCapacity: 16,
      moduleCapacity: 0,
      frameCapacity: 0,
    }),
    context = {
      thread,
      memory: new BurikoBpMemory(new Uint8Array(0)),
      diagnostics: {},
    };
  async function call(secondary, args) {
    const before = thread.stackIndex;
    for (const value of args) push32(thread, value);
    assert.equal(
      await definitions.find((definition) => definition.secondary === secondary).execute(context),
      0,
    );
    assert.equal(thread.stackIndex, before);
  }
  await call(0x00, [0, 1, 256, 2, 2]);
  await call(0x01, [1, 1, 256, 1, 1, 2, 1]);
  assert.deepEqual(
    [
      state.surfaces.coefficientTables.snapshot(0).span,
      state.surfaces.coefficientTables.snapshot(1).span,
    ],
    [8, 24],
  );
});
