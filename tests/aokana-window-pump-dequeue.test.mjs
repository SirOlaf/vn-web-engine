import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaWindowMessages} from '../dist/engines/buriko/games/aokana/native/window-messages.js';

test('thread-wide pump dequeue preserves FIFO, quit and generated paint order', () => {
  const transitions = [];
  const messages = new AokanaWindowMessages({
    setPhysicalKey(key, down) {
      transitions.push(['arrival', key, down]);
    },
    setDequeuedKey(key, down) {
      transitions.push(['dequeue', key, down]);
    },
  });
  messages.createMainTarget();
  const child = messages.createTarget();
  messages.enqueuePhysicalKey('main', 65, true, 0x1e0001);
  messages.post({target: child, message: 0x8001, wParam: 7, lParam: 8});
  messages.invalidate('main');
  messages.invalidate('main');
  messages.invalidate(child);
  messages.postQuit(42);
  messages.post({target: 'main', message: 0x8002, wParam: 9, lParam: 10});

  assert.deepEqual(transitions, [['arrival', 65, true]]);
  assert.equal(messages.pending, 6);
  assert.equal(messages.takePumpEvent().message.message, 0x100);
  assert.deepEqual(transitions.at(-1), ['dequeue', 65, true]);
  assert.equal(messages.takePumpEvent().message.message, 0x8001);
  assert.deepEqual(messages.takePumpEvent(), {kind: 'quit', exitCode: 42});
  assert.equal(messages.takePumpEvent().message.message, 0x8002);
  const mainPaint = messages.takePumpEvent();
  assert.deepEqual(mainPaint, {
    kind: 'window',
    message: {target: 'main', message: 0xf, wParam: 0, lParam: 0},
  });
  const childPaint = messages.takePumpEvent();
  assert.deepEqual(childPaint, {
    kind: 'window',
    message: {target: child, message: 0xf, wParam: 0, lParam: 0},
  });
  assert.equal(messages.isGeneratedPaint(mainPaint.message), true);
  assert.equal(messages.isGeneratedPaint(childPaint.message), true);
  messages.validatePaint(mainPaint.message);
  messages.validatePaint(childPaint.message);
  assert.equal(messages.takePumpEvent(), null);
  assert.equal(messages.pending, 0);

  messages.invalidate('main');
  messages.post({target: child, message: 0x8003, wParam: 0, lParam: 0});
  const directPaint = messages.takePaint('main');
  assert.equal(directPaint.message, 0xf);
  messages.validatePaint(directPaint);
  assert.equal(messages.takePumpEvent().message.message, 0x8003);
  assert.equal(messages.takePumpEvent(), null);

  messages.invalidate('main');
  messages.post({target: 'main', message: 0xf, wParam: 0, lParam: 0});
  const postedPaint = messages.takePumpEvent().message;
  assert.equal(messages.isGeneratedPaint(postedPaint), false);
  assert.equal(messages.pending, 1);
  messages.validatePaint(postedPaint);
  assert.equal(messages.pending, 0);
});
