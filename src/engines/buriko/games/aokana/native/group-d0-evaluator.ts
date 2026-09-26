import {pop32, push32} from '../bp/state.js';
import type {AokanaGridEvaluationWorkers} from './grid-evaluation-workers.js';
import type {
  AokanaBpOpcodeContext,
  AokanaBpOpcodeHandler,
  AokanaNativeSlotDefinition,
} from './types.js';

/** Nine verified D0 wrappers for persistent DCTESLGEvaluator background workers. */
export function createGroupD0Evaluator(
  workers: AokanaGridEvaluationWorkers,
): AokanaNativeSlotDefinition[] {
  const pointer = (h: AokanaBpOpcodeContext) => h.memory.resolve(h.thread, pop32(h.thread));
  const entries: [number, number, string, AokanaBpOpcodeHandler][] = [
    [
      0x80,
      0x1400d2730,
      'CreateGridEvaluationWorker',
      (h) => {
        workers.create(pointer(h));
        return 0;
      },
    ],
    [
      0x81,
      0x1400d2700,
      'DestroyGridEvaluationWorker',
      async (h): Promise<0> => {
        push32(h.thread, await workers.destroy(pop32(h.thread)));
        return 0;
      },
    ],
    [
      0x84,
      0x1400d26c0,
      'SetGridEvaluationTypeCount',
      (h) => {
        const value = pop32(h.thread),
          id = pop32(h.thread);
        push32(h.thread, workers.setTypeCount(id, value));
        return 0;
      },
    ],
    [
      0x87,
      0x1400d2670,
      'TakeGridEvaluationStatus',
      (h) => {
        const id = pop32(h.thread),
          output = pointer(h);
        push32(h.thread, workers.takeStatus(output, id));
        return 0;
      },
    ],
    [
      0x88,
      0x1400d2600,
      'InitializeGridEvaluationActors',
      (h) => {
        const asynchronous = pop32(h.thread),
          input = pointer(h),
          count = pop32(h.thread),
          gridId = pop32(h.thread),
          id = pop32(h.thread);
        push32(h.thread, workers.initialize(id, gridId, count, input, asynchronous));
        return 0;
      },
    ],
    [
      0x8a,
      0x1400d2570,
      'QueueGridEvaluation',
      (h) => {
        const maximum = pop32(h.thread),
          index = pop32(h.thread),
          id = pop32(h.thread),
          count = pointer(h),
          output = pointer(h);
        push32(h.thread, workers.evaluate(output, count, id, index, maximum));
        return 0;
      },
    ],
    [
      0x8c,
      0x1400d2530,
      'ReplaceGridEvaluationGrid',
      (h) => {
        const gridId = pop32(h.thread),
          id = pop32(h.thread);
        push32(h.thread, workers.replaceGrid(id, gridId));
        return 0;
      },
    ],
    [
      0x8d,
      0x1400d24b0,
      'UpdateGridEvaluationActor',
      (h) => {
        const asynchronous = pop32(h.thread),
          recompute = pop32(h.thread),
          input = pointer(h),
          index = pop32(h.thread),
          id = pop32(h.thread);
        push32(h.thread, workers.update(id, index, input, recompute, asynchronous));
        return 0;
      },
    ],
    [
      0x8e,
      0x1400d2450,
      'ReadGridEvaluationActor',
      (h) => {
        const index = pop32(h.thread),
          id = pop32(h.thread),
          output = pointer(h);
        push32(h.thread, workers.copyRecord(output, id, index));
        return 0;
      },
    ],
  ];
  return entries.map(([secondary, address, name, handler]) => ({
    primary: 0xd0,
    secondary,
    nativeAddress: address,
    name,
    execute: handler,
  }));
}
