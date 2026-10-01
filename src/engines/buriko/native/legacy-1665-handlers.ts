import {BURIKO_1665_NATIVE_SLOT_ADDRESSES} from './inventory-1665.js';
import type {BurikoNativeSlotDefinition} from './types.js';

/** 1.665 E0 dispatch 004688d0: the diagnostic leaves occupy different slots.
 * 1.658.5 E0 dispatch 004669e0 installs the identical leaves at its own addresses. */
export function createLegacy1665NativeDefinitions(
  shared: readonly BurikoNativeSlotDefinition[],
  slots: Readonly<
    Record<number, Readonly<Record<number, number>>>
  > = BURIKO_1665_NATIVE_SLOT_ADDRESSES,
): BurikoNativeSlotDefinition[] {
  // 004683a0 enumerate; 004683d0 flags; 00468410 write; 00468450 clear.
  return [
    [0x90, 0x91],
    [0x92, 0x93],
    [0x94, 0x92],
    [0x96, 0x90],
  ].map(([secondary, source]) => {
    const definition = shared.find((slot) => slot.primary === 0xe0 && slot.secondary === source);
    if (definition === undefined)
      throw new Error('Buriko 1.665 diagnostic bank requires the shared diagnostic services');
    return {
      ...definition,
      secondary: secondary!,
      nativeAddress: slots[0xe0]![secondary!]!,
    };
  });
}
