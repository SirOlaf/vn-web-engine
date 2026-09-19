import {detachLastModule} from '../bp/modules.js';
import {pointerView, type AokanaBpPointer} from '../bp/memory.js';
import type {AokanaBpScheduledThread, AokanaBpScheduler} from '../bp/scheduler.js';
import {pop32, push32, type AokanaBpThread} from '../bp/state.js';
import type {AokanaNativeClock} from './clock.js';
import type {AokanaDiagnosticDialogs} from './modal.js';
import type {AokanaNativeInput} from './input.js';
import {
  AokanaProcedureState,
  AokanaWaitTiming,
  AokanaWaitTimingEx,
  AokanaWaitWindowMessage,
  AokanaWindowMessages,
} from './procedure.js';
import type {AokanaNativeSlotDefinition, AokanaBpOpcodeHandler} from './types.js';

/** Persistent executable globals; these are not reset when a module/thread finishes. */
export class AokanaVmControlState {
  /** 0x1401c9a64, returned by 0x1400ec990 to the boot controller. */
  loopOption = 1;
  /** 0x1401c9a3c; Bank 91:0B and the VM loop share this raw DWORD. */
  distributedBitmapProcessingEnabled = 0;
  /** 0x1401eaf50, consumed by native resource-load wrappers. */
  asynchronousResourceLoads = 0;
  /** 0x1401d27e0 starts at zero and includes root and shared thread construction. */
  nextThreadId = 0;

  allocateThreadId(): number {
    const id = this.nextThreadId;
    this.nextThreadId = (id + 1) >>> 0;
    return id;
  }
}

/** The input-sensitive wait is constructed with the same concrete title input state as bank81. */
export function createGroup80InputWait(
  scheduler: AokanaBpScheduler,
  clock: AokanaNativeClock,
  procedures: AokanaProcedureState,
  input: AokanaNativeInput,
): AokanaNativeSlotDefinition[] {
  return [
    {
      primary: 0x80,
      secondary: 0x5c,
      nativeAddress: 0x1400e8790,
      name: 'WaitTimingOrInput',
      execute: ({thread}) => {
        const keyGroup = pop32(thread),
          inputEnabled = pop32(thread),
          duration = pop32(thread);
        const node =
          thread === scheduler.root.state ? scheduler.root : scheduler.findById(thread.id);
        if (node === null || node.state !== thread)
          throw new Error('Aokana wait thread is not linked to its root');
        node.installProcess(
          new AokanaWaitTimingEx(
            thread,
            procedures,
            clock,
            input,
            duration,
            inputEnabled,
            keyGroup,
          ),
        );
        return 2;
      },
    },
  ];
}

function offsetPointer(pointer: AokanaBpPointer | null, offset: number): AokanaBpPointer {
  if (pointer === null) throw new Error('Aokana native thread message dereferenced null');
  return {bytes: pointer.bytes, offset: pointer.offset + offset};
}

/** Fully local lifecycle/message/deadline slots. Resource and input-dependent slots join separately. */
export function createGroup80Threads(
  scheduler: AokanaBpScheduler,
  clock: AokanaNativeClock,
  control: AokanaVmControlState,
  procedures: AokanaProcedureState,
  windowMessages: AokanaWindowMessages,
  dialogs: AokanaDiagnosticDialogs,
): AokanaNativeSlotDefinition[] {
  const node = (thread: AokanaBpThread): AokanaBpScheduledThread => {
    if (thread === scheduler.root.state) return scheduler.root;
    const found = scheduler.findById(thread.id);
    if (found === null || found.state !== thread)
      throw new Error('Aokana current thread is not linked to its root');
    return found;
  };
  const target = (id: number): AokanaBpScheduledThread => {
    const found = scheduler.findById(id);
    if (found === null) throw new Error(`Aokana message target thread ${id >>> 0} does not exist`);
    return found;
  };
  const remaining = (thread: AokanaBpThread): number =>
    Math.max(0, (node(thread).deadline - Number(BigInt.asUintN(32, clock.read()))) | 0);
  const handlers: readonly [number, number, string, AokanaBpOpcodeHandler][] = [
    [
      0x41,
      0x1400e8db0,
      'UnloadLastModule',
      ({thread}) => {
        const count = detachLastModule(thread);
        if (count === 0 && thread.storageOwner === thread)
          throw new Error('Aokana cannot unload the final module of a root-owned thread');
        push32(thread, count);
        return 0;
      },
    ],
    [0x45, 0x1400e8d00, 'EndThread', () => 4],
    [
      0x46,
      0x1400e8ce0,
      'GetThreadId',
      ({thread}) => {
        push32(thread, thread.id);
        return 0;
      },
    ],
    [
      0x47,
      0x1400e8ca0,
      'ThreadExists',
      ({thread}) => {
        push32(thread, Number(scheduler.findById(pop32(thread)) !== null));
        return 0;
      },
    ],
    [
      0x48,
      0x1400e8c40,
      'SendThreadWord',
      ({thread}) => {
        const value = pop32(thread);
        target(pop32(thread)).enqueueMessage(value);
        return 0;
      },
    ],
    [
      0x49,
      0x1400e8c00,
      'ReceiveThreadWord',
      ({thread, memory}) => {
        const destination = memory.resolve(thread, pop32(thread));
        const sender = node(thread);
        const value = sender.peekMessage();
        if (value !== undefined) {
          pointerView(offsetPointer(destination, 0), 4).setUint32(0, value, true);
          sender.dequeueMessage();
        }
        push32(thread, Number(value !== undefined));
        return 0;
      },
    ],
    [
      0x4a,
      0x1400e8b30,
      'SendThreadWords',
      ({thread, memory}) => {
        const source = memory.resolve(thread, pop32(thread));
        const count = pop32(thread) | 0;
        const recipient = target(pop32(thread));
        if (count < 1) throw new RangeError(`Aokana thread message count ${count} is not positive`);
        for (let index = 0; index < count; index++)
          recipient.enqueueMessage(
            pointerView(offsetPointer(source, index * 4), 4).getUint32(0, true),
          );
        return 0;
      },
    ],
    [
      0x4b,
      0x1400e8a60,
      'ReceiveThreadWords',
      ({thread, memory}) => {
        const destination = memory.resolve(thread, pop32(thread));
        const count = pop32(thread) | 0;
        if (count < 1) throw new RangeError(`Aokana thread message count ${count} is not positive`);
        let received = 0;
        for (; received < count; received++) {
          const sender = node(thread);
          const value = sender.peekMessage();
          if (value === undefined) break;
          pointerView(offsetPointer(destination, received * 4), 4).setUint32(0, value, true);
          sender.dequeueMessage();
        }
        push32(thread, received);
        return 0;
      },
    ],
    [
      0x4c,
      0x1400e89d0,
      'SendProcedureMessage',
      ({thread}) => {
        const value2 = pop32(thread),
          value1 = pop32(thread),
          code = pop32(thread);
        const recipient = scheduler.findById(pop32(thread));
        recipient?.process?.enqueueMessage({code, value1, value2});
        // Native checks the process pointer again after enqueuing.
        push32(thread, Number(recipient?.process != null));
        return 0;
      },
    ],
    [
      0x52,
      0x1400e8990,
      'SetVmLoopOption',
      ({thread}) => {
        control.loopOption = pop32(thread);
        return 0;
      },
    ],
    [
      0x53,
      0x1400e8970,
      'EnableNextAsynchronousResourceLoad',
      () => {
        control.asynchronousResourceLoads = 1;
        return 0;
      },
    ],
    [
      0x54,
      0x1400e8910,
      'WaitWindowMessage',
      ({thread}) => {
        const message = pop32(thread);
        node(thread).installProcess(
          new AokanaWaitWindowMessage(thread, procedures, clock, windowMessages, dialogs, message),
        );
        return 2;
      },
    ],
    [
      0x58,
      0x1400e88e0,
      'SetThreadDeadline',
      ({thread}) => {
        const duration = pop32(thread);
        node(thread).deadline = (Number(BigInt.asUintN(32, clock.read())) + duration) >>> 0;
        return 0;
      },
    ],
    [
      0x59,
      0x1400e88a0,
      'ExtendThreadDeadline',
      ({thread}) => {
        const duration = pop32(thread);
        const current = node(thread);
        current.deadline = (current.deadline + duration) >>> 0;
        push32(thread, Number(remaining(thread) !== 0));
        return 0;
      },
    ],
    [
      0x5a,
      0x1400e8820,
      'WaitThreadDeadline',
      ({thread}) => {
        const duration = remaining(thread);
        if (duration !== 0)
          node(thread).installProcess(new AokanaWaitTiming(thread, procedures, clock, duration));
        push32(thread, Number(duration !== 0));
        return 2;
      },
    ],
    [
      0x5d,
      0x1400e8760,
      'SetExclusiveThread',
      ({thread}) => {
        const exclusive = pop32(thread) !== 0;
        scheduler.exclusiveThread = exclusive ? node(thread) : null;
        scheduler.exclusiveMode = exclusive;
        return 0;
      },
    ],
    [
      0x5e,
      0x1400e8740,
      'SelectThread',
      ({thread}) => {
        scheduler.selectedThreadId = pop32(thread);
        return 3;
      },
    ],
    [0x5f, 0x1400e8730, 'YieldThread', () => 1],
    [0x6a, 0x1400e84a0, 'RequestSchedulerStop', () => 6],
  ];
  return handlers.map(([secondary, nativeAddress, name, execute]) => ({
    primary: 0x80,
    secondary,
    nativeAddress,
    name,
    execute,
  }));
}
