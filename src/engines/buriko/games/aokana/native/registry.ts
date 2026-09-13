import {AOKANA_NATIVE_SLOT_ADDRESSES} from './inventory.js';
import type {
  AokanaBpOpcodeContext,
  AokanaBpInstructionResult,
  AokanaNativeSlotDefinition,
} from './types.js';

const slotKey = (primary: number, secondary: number): number => (primary << 8) | secondary;
const hexSlot = (primary: number, secondary: number): string =>
  `${primary.toString(16).padStart(2, '0')} ${secondary.toString(16).padStart(2, '0')}`;

export interface AokanaNativeMissingSlot {
  readonly primary: number;
  readonly secondary: number;
  readonly nativeAddress: number;
}

/** A complete bank can only be obtained by validating every installed native slot. */
export class AokanaNativeBank {
  private readonly handlers: ReadonlyMap<number, AokanaNativeSlotDefinition>;

  constructor(definitions: Iterable<AokanaNativeSlotDefinition>) {
    const handlers = new Map<number, AokanaNativeSlotDefinition>();
    for (const definition of definitions) {
      const {primary, secondary, nativeAddress} = definition;
      if (
        !Number.isInteger(primary) ||
        !Number.isInteger(secondary) ||
        primary < 0 ||
        primary > 255 ||
        secondary < 0 ||
        secondary > 255 ||
        AOKANA_NATIVE_SLOT_ADDRESSES[primary]?.[secondary] !== nativeAddress
      ) {
        throw new Error(
          `Aokana native definition has no matching verified slot: ${hexSlot(primary, secondary)}`,
        );
      }
      const key = slotKey(primary, secondary);
      if (handlers.has(key))
        throw new Error(`Duplicate Aokana native slot ${hexSlot(primary, secondary)}`);
      if (typeof definition.execute !== 'function' || definition.name.length === 0) {
        throw new Error(`Invalid Aokana native implementation ${hexSlot(primary, secondary)}`);
      }
      handlers.set(key, Object.freeze({...definition}));
    }
    const missing = missingNativeSlots(handlers.values());
    if (missing.length !== 0) {
      const first = missing[0]!;
      throw new Error(
        `Aokana native bank is incomplete: ${missing.length} missing, beginning ${hexSlot(first.primary, first.secondary)}`,
      );
    }
    this.handlers = handlers;
  }

  execute(
    primary: number,
    secondary: number,
    context: AokanaBpOpcodeContext,
  ): AokanaBpInstructionResult {
    const definition = this.handlers.get(slotKey(primary, secondary));
    if (definition === undefined) {
      throw new Error(
        `Invalid Aokana native opcode ${hexSlot(primary, secondary)} at 0x${context.thread.instructionStart.toString(16)}`,
      );
    }
    return definition.execute(context);
  }
}

/** Counts implementations supplied by native batches, separately from table occupancy. */
export function missingNativeSlots(
  definitions: Iterable<AokanaNativeSlotDefinition>,
): AokanaNativeMissingSlot[] {
  const installed = new Set<number>();
  for (const definition of definitions)
    installed.add(slotKey(definition.primary, definition.secondary));
  const missing: AokanaNativeMissingSlot[] = [];
  for (const [primaryKey, slots] of Object.entries(AOKANA_NATIVE_SLOT_ADDRESSES)) {
    const primary = Number(primaryKey);
    for (const [secondaryKey, nativeAddress] of Object.entries(slots)) {
      const secondary = Number(secondaryKey);
      if (!installed.has(slotKey(primary, secondary)))
        missing.push({primary, secondary, nativeAddress});
    }
  }
  return missing;
}
