import {pop32, push32} from '../bp/state.js';
import type {AokanaBpPointer} from '../bp/memory.js';
import {AokanaTextLayoutState} from './text-layout-state.js';
import {AokanaEngineErrors} from './engine-errors.js';
import type {AokanaBpOpcodeContext, AokanaNativeSlotDefinition} from './types.js';

function pointer(context: AokanaBpOpcodeContext): AokanaBpPointer | null {
  return context.memory.resolve(context.thread, pop32(context.thread));
}

/** These shared annotation/settings leaves use the same owner as both text-layout directions. */
export function createGroup91TextSettings(
  state: AokanaTextLayoutState,
  errors: AokanaEngineErrors,
): AokanaNativeSlotDefinition[] {
  return [
    {
      primary: 0x91,
      secondary: 0x94,
      nativeAddress: 0x1400df0c0,
      name: 'SetPersistentTextAnnotation',
      execute: (context) => {
        const reading = pointer(context),
          key = pointer(context);
        state.setAnnotation(key, reading);
        return 0;
      },
    },
    {
      primary: 0x91,
      secondary: 0x96,
      nativeAddress: 0x1400df040,
      name: 'ImportPersistentTextAnnotations',
      execute: (context) => {
        push32(context.thread, state.annotations.import(pointer(context)));
        return 0;
      },
    },
    {
      primary: 0x91,
      secondary: 0x98,
      nativeAddress: 0x1400def00,
      name: 'SetTextLayoutParameters',
      execute: (context) => {
        const f = pop32(context.thread),
          e = pop32(context.thread),
          d = pop32(context.thread),
          c = pop32(context.thread),
          b = pop32(context.thread),
          a = pop32(context.thread),
          result = state.configure(a, b, c, d, e, f);
        if (result === 0x80000001 || result === 0x80000002) {
          const message =
            result === 0x80000001
              ? `無効な読み仮名のサイズレート [ ${d | 0} ] が指定されました`
              : `無効な読み仮名の為の余白サイズ [ ${e | 0} ] が指定されました`;
          return errors.threadFatal(
            context.thread,
            context.diagnostics,
            state.text.encodeWide(message, 0),
          );
        }
        return 0;
      },
    },
  ];
}
