import type {AokanaBpScheduledThread} from '../bp/scheduler.js';
import {AokanaBpScheduler} from '../bp/scheduler.js';
import {pop32, push32} from '../bp/state.js';
import type {AokanaNativeClock} from './clock.js';
import type {AokanaVmControlState} from './group-80-threads.js';
import {AokanaInternetReadProcess} from './internet-read-process.js';
import type {AokanaInternetReads} from './internet-reads.js';
import type {AokanaProcedureState} from './procedure.js';
import type {AokanaResourceLoadingState} from './resource-loading.js';
import {textBytes} from './text.js';
import type {AokanaBpOpcodeContext, AokanaNativeSlotDefinition} from './types.js';

/** Bank 81:31 uses the shared async-load flag and the current scheduled process slot. */
export function createGroup81InternetRead(
  reads: AokanaInternetReads,
  loading: AokanaResourceLoadingState,
  scheduler: AokanaBpScheduler,
  procedures: AokanaProcedureState,
  clock: AokanaNativeClock,
  control: AokanaVmControlState,
): AokanaNativeSlotDefinition[] {
  const scheduled = (h: AokanaBpOpcodeContext): AokanaBpScheduledThread => {
    const node =
      h.thread === scheduler.root.state ? scheduler.root : scheduler.findById(h.thread.id);
    if (node === null || node.state !== h.thread)
      throw new Error('Aokana internet-read thread is not linked to its scheduler');
    return node;
  };
  return [
    {
      primary: 0x81,
      secondary: 0x31,
      nativeAddress: 0x1400ebc00,
      name: 'ReadInternetFile',
      execute: async (h): Promise<0 | 2> => {
        const length = pop32(h.thread),
          offset = pop32(h.thread),
          urlPointer = h.memory.resolve(h.thread, pop32(h.thread)),
          destination = h.memory.resolve(h.thread, pop32(h.thread)),
          asynchronous = control.asynchronousResourceLoads !== 0;
        if (urlPointer === null)
          throw new Error('Aokana internet-read service dereferences a null URL');
        const url = textBytes(urlPointer, true).slice();
        if (!asynchronous) {
          push32(h.thread, await reads.read(destination, url, offset, length));
          return 0;
        }
        const owner = scheduled(h);
        if (owner.process?.hasOutstandingExternalBorrow?.())
          throw new Error('Aokana internet read would replace a process borrowing BP storage');
        const process = new AokanaInternetReadProcess(
          h.thread,
          procedures,
          clock,
          loading,
          reads,
          destination,
          url,
          offset,
          length,
        );
        owner.installProcess(process);
        control.asynchronousResourceLoads = 0;
        return 2;
      },
    },
  ];
}
