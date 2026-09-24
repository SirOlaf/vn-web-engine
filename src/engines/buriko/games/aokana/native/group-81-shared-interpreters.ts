import {pop32} from '../bp/state.js';
import type {AokanaSharedInterpreters} from './shared-interpreters.js';
import type {AokanaBpOpcodeContext, AokanaNativeSlotDefinition} from './types.js';

function threadFatal(
  shared: AokanaSharedInterpreters,
  context: AokanaBpOpcodeContext,
  message: string,
): Promise<never> {
  return shared.errors.threadFatal(
    context.thread,
    context.diagnostics,
    shared.errors.files.text.encodeWide(message, 0),
  );
}

/** Bank 81:48 executes one mode-one shared interpreter per global work-pool worker. */
export function createGroup81SharedInterpreters(
  shared: AokanaSharedInterpreters,
): AokanaNativeSlotDefinition[] {
  return [
    {
      primary: 0x81,
      secondary: 0x48,
      nativeAddress: 0x1400eb470,
      name: 'RunSharedInterpreters',
      execute: async (context): Promise<0> => {
        const {thread} = context;
        const initialIp = pop32(thread),
          frameSize = pop32(thread),
          moduleSize = pop32(thread),
          operandCapacity = pop32(thread);
        const result = await shared.run(
          thread,
          context.diagnostics,
          operandCapacity,
          moduleSize,
          frameSize,
          initialIp,
          context.actor,
        );
        if (result === 0x80000001)
          return threadFatal(
            shared,
            context,
            `指定されたサイズ [ ${moduleSize | 0} ] のコード領域を親スレッドに確保することができません`,
          );
        if (result === 0x80000002)
          return threadFatal(
            shared,
            context,
            `指定されたサイズ [ ${frameSize | 0} ] のスタック領域を親スレッドに確保することができません`,
          );
        if (result === 0x80000003)
          return threadFatal(
            shared,
            context,
            `チャイルドスレッドの初期IPにコード領域のサイズを超える値 $${initialIp.toString(16).toUpperCase()} が設定されました`,
          );
        return 0;
      },
    },
  ];
}
