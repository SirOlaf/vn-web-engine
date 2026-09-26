import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBitmapCompositor} from '../dist/engines/buriko/native/bitmap-compositor.js';
import {BurikoDisplayDamage} from '../dist/engines/buriko/native/display-damage.js';
import {BurikoDisplayKnob} from '../dist/engines/buriko/native/display-knob.js';
import {
  BurikoDisplayObject,
  BurikoDisplayObjectEnvironment,
} from '../dist/engines/buriko/native/display-object.js';

class KnobTarget extends BurikoDisplayObject {
  constructor(environment) {
    super(environment, 2, 4, 1);
    assert.equal(this.configureGeometry(3, 2), 1);
    this.move(10, 20);
    this.setLayer(2);
    this.blendMode = 0x21;
    this.setBlendValue(77);
  }
}

test('CDspObjKnob owns its target and maps ordinary range, precision, drag and wheel state', () => {
  const compositor = new BurikoBitmapCompositor();
  compositor.defaultFormat = 2;
  const environment = new BurikoDisplayObjectEnvironment(
      compositor,
      new BurikoDisplayDamage(32, {left: 0, top: 0, right: 99, bottom: 99}),
    ),
    target = new KnobTarget(environment),
    knob = new BurikoDisplayKnob(environment, 7, target);

  assert.equal(target.parent, knob);
  assert.deepEqual([knob.category, knob.depthOrder, knob.value120], [10, 7, 1]);
  assert.deepEqual([knob.blendMode, knob.getBlendValue(), knob.getLayer()], [0x21, 77, 2]);
  assert.deepEqual(knob.position(), {x: 10, y: 20});

  knob.setActivation(1);
  assert.deepEqual([knob.activation, target.activation], [1, 1]);
  knob.setBlendValue(123);
  assert.deepEqual([knob.getBlendValue(), target.getBlendValue()], [123, 123]);

  assert.equal(knob.setRange(13, 8), 1);
  assert.equal(knob.setPrecision(6, 4), 1);
  assert.equal(knob.setValue(3, 2), 1);
  assert.deepEqual(knob.value(), {x: 3, y: 2});
  assert.deepEqual(target.position(), {x: 16, y: 24});

  knob.move(30, 40);
  assert.deepEqual(target.position(), {x: 36, y: 44});
  knob.beginPointerDrag(37, 45);
  assert.equal(knob.updatePointerDrag(39, 45), 1);
  assert.deepEqual(knob.value(), {x: 4, y: 2});
  assert.deepEqual(target.position(), {x: 38, y: 44});

  knob.moveWheel(-1);
  assert.deepEqual(knob.value(), {x: 4, y: 1});
  assert.deepEqual(knob.takeEvent(), {pending: 1, x: 0, y: -1, rejected: 0});
  assert.deepEqual(knob.takeEvent(), {pending: 0, x: 0, y: 0, rejected: 0});

  knob.dispose();
  assert.equal(target.parent, null);
});
