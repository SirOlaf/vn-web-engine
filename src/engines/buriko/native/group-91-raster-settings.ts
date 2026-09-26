import {pop32, push32} from '../bp/state.js';
import type {BurikoBitmapCompositor} from './bitmap-compositor.js';
import type {BurikoNativeFonts} from './fonts.js';
import type {BurikoVmControlState} from './group-80-threads.js';
import type {BurikoNativeSlotDefinition} from './types.js';

/** Live native globals are owned by the consumers; these setters do not flush caches. */
export function createGroup91RasterSettings(
  compositor: BurikoBitmapCompositor,
  fonts: BurikoNativeFonts,
  control: BurikoVmControlState,
): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x91,
      secondary: 0x0a,
      nativeAddress: 0x1400e2a20,
      name: 'SetBitmapRasterProperty',
      execute: ({thread}) => {
        const value = pop32(thread),
          selector = pop32(thread);
        push32(thread, Number(compositor.setProperty(selector, value) === 0));
        return 0;
      },
    },
    {
      primary: 0x91,
      secondary: 0x0b,
      nativeAddress: 0x1400e2a00,
      name: 'SetDistributedBitmapProcessing',
      execute: ({thread}) => {
        control.distributedBitmapProcessingEnabled = pop32(thread);
        return 0;
      },
    },
    {
      primary: 0x91,
      secondary: 0x0c,
      nativeAddress: 0x1400e29d0,
      name: 'SetFontCoverageGamma',
      execute: ({thread}) => {
        push32(thread, Number(fonts.rasterSettings.setGamma(pop32(thread))));
        return 0;
      },
    },
    {
      primary: 0x91,
      secondary: 0x0d,
      nativeAddress: 0x1400e29b0,
      name: 'SetFontVariablePitchPreservation',
      execute: ({thread}) => {
        fonts.rasterSettings.preserveVariablePitch = pop32(thread);
        return 0;
      },
    },
  ];
}
