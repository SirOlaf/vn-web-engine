import type {AokanaBpScheduler} from '../bp/scheduler.js';
import {AokanaBpSharedThread, pop32, push32, validCodeAddress} from '../bp/state.js';
import type {AokanaEngineErrors} from './engine-errors.js';
import type {AokanaVmControlState} from './group-80-threads.js';
import type {AokanaBpOpcodeContext, AokanaNativeSlotDefinition} from './types.js';

function threadFatal(
  errors: AokanaEngineErrors,
  context: AokanaBpOpcodeContext,
  message: string,
): Promise<never> {
  return errors.threadFatal(
    context.thread,
    context.diagnostics,
    errors.files.text.encodeWide(message, 0),
  );
}

/** Bank 81's child-thread wrapper reserves storage through the current thread's original owner. */
export function createGroup81SharedThreads(
  scheduler: AokanaBpScheduler,
  control: AokanaVmControlState,
  errors: AokanaEngineErrors,
): AokanaNativeSlotDefinition[] {
  return [
    {
      primary: 0x81,
      secondary: 0x44,
      nativeAddress: 0x1400eb560,
      name: 'CreateSharedThread',
      execute: (context) => {
        const {thread} = context;
        const initialIp = pop32(thread),
          frameSize = pop32(thread),
          moduleSize = pop32(thread),
          operandCapacity = pop32(thread);
        const child = new AokanaBpSharedThread({
          id: control.allocateThreadId(),
          operandCapacity,
          mode: 0,
        });
        const result = child.initialize(thread, moduleSize, frameSize, initialIp, (value) =>
          scheduler.append(value),
        );
        if (result === 0x80000002)
          return threadFatal(
            errors,
            context,
            `指定されたサイズ [ ${moduleSize | 0} ] のコード領域を親スレッドに確保することができません`,
          );
        if (result === 0x80000003)
          return threadFatal(
            errors,
            context,
            `指定されたサイズ [ ${frameSize | 0} ] のスタック領域を親スレッドに確保することができません`,
          );
        if (!validCodeAddress(child, initialIp))
          return threadFatal(
            errors,
            context,
            `チャイルドスレッドの初期IPにコード領域のサイズを超える値 $${initialIp.toString(16).toUpperCase()} が設定されました`,
          );
        push32(thread, child.id);
        return 0;
      },
    },
  ];
}
