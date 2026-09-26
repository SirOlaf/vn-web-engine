import type {BurikoBpScheduledThread} from '../bp/scheduler.js';
import {BurikoBpScheduler} from '../bp/scheduler.js';
import {pop32, push32} from '../bp/state.js';
import type {BurikoNativeClock} from './clock.js';
import type {BurikoVmControlState} from './group-80-threads.js';
import type {BurikoProcedureState} from './procedure.js';
import type {BurikoResourceLoadingState} from './resource-loading.js';
import {
  BurikoExamineFileHealthProcess,
  BurikoReadBinaryProcess,
} from './resource-service-processes.js';
import {textBytes} from './text.js';
import type {BurikoBpOpcodeContext, BurikoNativeSlotDefinition} from './types.js';

/** Bank 81:30/34 share the actual CProcLoad/FIFO/cache and scheduled-thread owners. */
export function createGroup81ResourceServices(
  loading: BurikoResourceLoadingState,
  scheduler: BurikoBpScheduler,
  procedures: BurikoProcedureState,
  clock: BurikoNativeClock,
  control: BurikoVmControlState,
): BurikoNativeSlotDefinition[] {
  const scheduled = (h: BurikoBpOpcodeContext): BurikoBpScheduledThread => {
    const node =
      h.thread === scheduler.root.state ? scheduler.root : scheduler.findById(h.thread.id);
    if (node === null || node.state !== h.thread)
      throw new Error('Buriko resource service thread is not linked to its scheduler');
    return node;
  };
  return [
    {
      primary: 0x81,
      secondary: 0x30,
      nativeAddress: 0x1400ebce0,
      name: 'ReadBinary',
      execute: async (h): Promise<0 | 2> => {
        const length = pop32(h.thread),
          offset = pop32(h.thread),
          namePointer = h.memory.resolve(h.thread, pop32(h.thread)),
          archivePointer = h.memory.resolve(h.thread, pop32(h.thread)),
          destination = h.memory.resolve(h.thread, pop32(h.thread)),
          asynchronous = control.asynchronousResourceLoads !== 0;
        const archive = archivePointer === null ? null : textBytes(archivePointer).slice();
        if (namePointer === null)
          throw new Error('Buriko binary-resource read dereferences a null resource name');
        const name = textBytes(namePointer).slice();
        if (!asynchronous) {
          const result = await loading.ranges.read(destination, archive, name, offset, length);
          push32(h.thread, result.result);
          return 0;
        }
        const owner = scheduled(h),
          process = await BurikoReadBinaryProcess.create(
            h,
            procedures,
            clock,
            loading,
            destination,
            archive,
            name,
            offset,
            length,
          );
        owner.installProcess(process);
        control.asynchronousResourceLoads = 0;
        return 2;
      },
    },
    {
      primary: 0x81,
      secondary: 0x34,
      nativeAddress: 0x1400ebad0,
      name: 'ExamineFileHealth',
      execute: async (h): Promise<0 | 2> => {
        const actor = h.actor ?? loading.metadata.allocator.currentActor;
        const namePointer = h.memory.resolve(h.thread, pop32(h.thread)),
          archivePointer = h.memory.resolve(h.thread, pop32(h.thread));
        if (archivePointer === null) {
          push32(h.thread, 9);
          return 0;
        }
        const archive = textBytes(archivePointer).slice();
        if (namePointer === null)
          throw new Error('Buriko file-health service dereferences a null resource name');
        const name = textBytes(namePointer).slice();
        if (!(await loading.ranges.isAvailable(archive, name))) {
          push32(h.thread, 1);
          return 0;
        }
        const owner = scheduled(h),
          process = new BurikoExamineFileHealthProcess(
            h,
            procedures,
            clock,
            loading,
            archive,
            name,
            actor,
          );
        owner.installProcess(process);
        return 2;
      },
    },
  ];
}
