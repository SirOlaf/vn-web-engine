import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpScheduler} from '../dist/engines/buriko/games/aokana/bp/scheduler.js';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaBpDiagnostics} from '../dist/engines/buriko/games/aokana/native/diagnostics.js';
import {AokanaEngineErrors} from '../dist/engines/buriko/games/aokana/native/engine-errors.js';
import {AokanaVmControlState} from '../dist/engines/buriko/games/aokana/native/group-80-threads.js';
import {createGroup81SharedThreads} from '../dist/engines/buriko/games/aokana/native/group-81-shared-threads.js';

test('81 44 creates one owner-backed shared child in native stack and scheduler order', () => {
  const control = new AokanaVmControlState();
  const root = new AokanaBpThread({
    id: control.allocateThreadId(),
    operandCapacity: 0,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const scheduler = new AokanaBpScheduler(root, () => 1);
  const owner = new AokanaBpThread({
    id: control.allocateThreadId(),
    operandCapacity: 16,
    moduleCapacity: 128,
    frameCapacity: 96,
  });
  owner.moduleSize = 32;
  const ownerNode = scheduler.append(owner);
  const errors = new AokanaEngineErrors({}, {}, Uint8Array.of(0), Uint8Array.of(0));
  const [definition] = createGroup81SharedThreads(scheduler, control, errors);
  const context = {
    thread: owner,
    memory: new AokanaBpMemory(new Uint8Array()),
    diagnostics: new AokanaBpDiagnostics(() => {}),
  };

  assert.equal(definition.primary, 0x81);
  assert.equal(definition.secondary, 0x44);
  assert.equal(definition.nativeAddress, 0x1400eb560);
  for (const value of [6, 24, 16, 120]) push32(owner, value);
  assert.equal(definition.execute(context), 0);
  const childId = pop32(owner);
  const childNode = scheduler.findById(childId);

  assert.equal(childId, 2);
  assert.equal(control.nextThreadId, 3);
  assert.equal(owner.stackIndex, 0);
  assert.equal(scheduler.firstThread, ownerNode);
  assert.equal(ownerNode.next, childNode);
  assert.equal(childNode.next, null);
  const child = childNode.state;
  assert.equal(child.id, childId);
  assert.equal(child.mode, 0);
  assert.equal(child.operandStack.length, 6);
  assert.equal(child.sharedInitialized, true);
  assert.equal(child.sharedOwner, owner);
  assert.equal(child.storageOwner, owner);
  assert.equal(child.moduleMemory, owner.moduleMemory);
  assert.equal(child.frameMemory, owner.frameMemory);
  assert.equal(child.heap, owner.heap);
  assert.equal(child.moduleFloor, 104);
  assert.equal(child.moduleSize, 104);
  assert.equal(child.moduleCapacity, 24);
  assert.equal(child.moduleUsableCapacity, 24);
  assert.equal(child.frameFloor, 80);
  assert.equal(child.frameCursor, 80);
  assert.equal(child.frameCapacity, 16);
  assert.equal(child.frameUsableCapacity, 16);
  assert.equal(child.pc, 120);
  assert.equal(child.instructionStart, 120);
  assert.equal(owner.retentionCount, 1);
  assert.equal(owner.moduleUsableCapacity, 104);
  assert.equal(owner.frameUsableCapacity, 80);
  assert.deepEqual(owner.moduleReservations, [{borrower: child, offset: 104, size: 24}]);
  assert.deepEqual(owner.frameReservations, [{borrower: child, offset: 80, size: 16}]);
});
