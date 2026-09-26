import {pop32, push32} from '../bp/state.js';
import type {BurikoEngineErrors} from './engine-errors.js';
import type {BurikoNativeSlotDefinition} from './types.js';

/** Bank 81's capture controls share the first-message owner used by fatal errors. */
export function createGroup81ErrorCapture(
  errors: BurikoEngineErrors,
): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x81,
      secondary: 0x6a,
      nativeAddress: 0x1400eb280,
      name: 'SetErrorCaptureEnabled',
      execute: (h) => {
        errors.setCaptureEnabled(pop32(h.thread));
        return 0;
      },
    },
    {
      primary: 0x81,
      secondary: 0x6b,
      nativeAddress: 0x1400eb250,
      name: 'ReadCapturedError',
      execute: (h) => {
        const output = h.memory.resolve(h.thread, pop32(h.thread));
        push32(h.thread, errors.readCaptured(output));
        return 0;
      },
    },
  ];
}
