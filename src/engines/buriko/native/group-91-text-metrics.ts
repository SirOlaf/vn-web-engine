import {pop32, push32} from '../bp/state.js';
import {measureBurikoRegisteredText} from './text-metrics.js';
import type {BurikoTextLayoutState} from './text-layout-state.js';
import type {BurikoBpOpcodeContext, BurikoNativeSlotDefinition} from './types.js';

/** 91:95/99/9B use the same annotations, side-bearing policy and font/layout records as drawing. */
export function createGroup91TextMetrics(
  state: BurikoTextLayoutState,
): BurikoNativeSlotDefinition[] {
  const address = (context: BurikoBpOpcodeContext) =>
    context.memory.resolve(context.thread, pop32(context.thread));
  return [
    {
      primary: 0x91,
      secondary: 0x95,
      nativeAddress: 0x1400df070,
      name: 'CollectPersistentTextAnnotations',
      execute: (context) => {
        const source = address(context),
          output = address(context);
        if (source === null) throw new Error('Buriko annotation collection reads null text');
        push32(context.thread, state.annotations.extract(output, source));
        return 0;
      },
    },
    {
      primary: 0x91,
      secondary: 0x99,
      nativeAddress: 0x1400deed0,
      name: 'SetTextProportionalSideBearingDivisor',
      execute: (context) => {
        const value = pop32(context.thread);
        state.proportionalSideBearing =
          value === 0 ? 0 : Math.trunc(((value + 0xffff) >>> 0) / value);
        push32(context.thread, 1);
        return 0;
      },
    },
    {
      primary: 0x91,
      secondary: 0x9b,
      nativeAddress: 0x1400ded80,
      name: 'MeasureRegisteredFontText',
      execute: async (context): Promise<0> => {
        const proportional = pop32(context.thread),
          bold = pop32(context.thread),
          width = pop32(context.thread),
          size = pop32(context.thread),
          font = pop32(context.thread),
          source = address(context),
          output = address(context);
        const status = await measureBurikoRegisteredText(
          state,
          output,
          source,
          font,
          size,
          width,
          bold,
          proportional,
        );
        push32(context.thread, status);
        return 0;
      },
    },
  ];
}
