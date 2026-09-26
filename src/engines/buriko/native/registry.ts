import {BURIKO_NATIVE_SLOT_ADDRESSES, BURIKO_PRIMARY_SLOT_ADDRESSES} from './inventory.js';
import {BURIKO_169_NATIVE_SLOT_ADDRESSES} from './inventory-169.js';
import {BURIKO_169_PRIMARY_SLOT_ADDRESSES} from './inventory-169.js';
import {
  BURIKO_1665_NATIVE_SLOT_ADDRESSES,
  BURIKO_1665_PRIMARY_SLOT_ADDRESSES,
} from './inventory-1665.js';
import {BURIKO_BP_ABI_172, type BurikoBpAbi} from '../bp/abi.js';
import type {
  BurikoBpOpcodeContext,
  BurikoBpInstructionResult,
  BurikoNativeSlotDefinition,
} from './types.js';

const slotKey = (primary: number, secondary: number): number => (primary << 8) | secondary;
const hexSlot = (primary: number, secondary: number): string =>
  `${primary.toString(16).padStart(2, '0')} ${secondary.toString(16).padStart(2, '0')}`;

export function burikoNativeSlots(abi: BurikoBpAbi = BURIKO_BP_ABI_172) {
  if (abi.revision === '1.665') return BURIKO_1665_NATIVE_SLOT_ADDRESSES;
  return abi.revision === '1.520.6'
    ? BURIKO_169_NATIVE_SLOT_ADDRESSES
    : BURIKO_NATIVE_SLOT_ADDRESSES;
}

export function burikoPrimarySlots(abi: BurikoBpAbi = BURIKO_BP_ABI_172) {
  if (abi.revision === '1.665') return BURIKO_1665_PRIMARY_SLOT_ADDRESSES;
  return abi.revision === '1.520.6'
    ? BURIKO_169_PRIMARY_SLOT_ADDRESSES
    : BURIKO_PRIMARY_SLOT_ADDRESSES;
}

export interface BurikoNativeMissingSlot {
  readonly primary: number;
  readonly secondary: number;
  readonly nativeAddress: number;
}

/** A complete bank can only be obtained by validating every installed native slot. */
export class BurikoNativeBank {
  private readonly handlers: ReadonlyMap<number, BurikoNativeSlotDefinition>;

  constructor(
    definitions: Iterable<BurikoNativeSlotDefinition>,
    readonly abi: BurikoBpAbi = BURIKO_BP_ABI_172,
    overrides: Iterable<BurikoNativeSlotDefinition> = [],
  ) {
    const selectedSlots = burikoNativeSlots(abi);
    const handlers = new Map<number, BurikoNativeSlotDefinition>();
    for (const definition of definitions) {
      const {primary, secondary, nativeAddress} = definition;
      if (
        !Number.isInteger(primary) ||
        !Number.isInteger(secondary) ||
        primary < 0 ||
        primary > 255 ||
        secondary < 0 ||
        secondary > 255 ||
        (BURIKO_NATIVE_SLOT_ADDRESSES[primary]?.[secondary] !== nativeAddress &&
          selectedSlots[primary]?.[secondary] !== nativeAddress)
      ) {
        throw new Error(
          `Buriko native definition has no matching verified slot: ${hexSlot(primary, secondary)}`,
        );
      }
      // Production fragments provide shared implementations; unavailable slots remain absent.
      const selectedAddress = selectedSlots[primary]?.[secondary];
      if (selectedAddress === undefined) continue;
      const key = slotKey(primary, secondary);
      if (handlers.has(key))
        throw new Error(`Duplicate Buriko native slot ${hexSlot(primary, secondary)}`);
      if (typeof definition.execute !== 'function' || definition.name.length === 0) {
        throw new Error(`Invalid Buriko native implementation ${hexSlot(primary, secondary)}`);
      }
      handlers.set(key, Object.freeze({...definition, nativeAddress: selectedAddress}));
    }
    const replaced = new Set<number>();
    for (const definition of overrides) {
      const {primary, secondary, nativeAddress} = definition;
      const key = slotKey(primary, secondary);
      if (
        selectedSlots[primary]?.[secondary] !== nativeAddress ||
        replaced.has(key) ||
        typeof definition.execute !== 'function' ||
        definition.name.length === 0
      )
        throw new Error(`Invalid Buriko version override ${hexSlot(primary, secondary)}`);
      replaced.add(key);
      handlers.set(key, Object.freeze({...definition}));
    }
    const missing = missingNativeSlots(handlers.values(), abi);
    if (missing.length !== 0) {
      const first = missing[0]!;
      throw new Error(
        `Buriko native bank is incomplete: ${missing.length} missing, beginning ${hexSlot(first.primary, first.secondary)}`,
      );
    }
    this.handlers = handlers;
  }

  execute(
    primary: number,
    secondary: number,
    context: BurikoBpOpcodeContext,
  ): BurikoBpInstructionResult {
    const definition = this.handlers.get(slotKey(primary, secondary));
    if (definition === undefined) {
      throw new Error(
        `Invalid Buriko native opcode ${hexSlot(primary, secondary)} at 0x${context.thread.instructionStart.toString(16)}`,
      );
    }
    return definition.execute(context);
  }
}

/** Counts implementations supplied by native batches, separately from table occupancy. */
export function missingNativeSlots(
  definitions: Iterable<BurikoNativeSlotDefinition>,
  abi: BurikoBpAbi = BURIKO_BP_ABI_172,
): BurikoNativeMissingSlot[] {
  const installed = new Set<number>();
  for (const definition of definitions)
    installed.add(slotKey(definition.primary, definition.secondary));
  const missing: BurikoNativeMissingSlot[] = [];
  for (const [primaryKey, slots] of Object.entries(burikoNativeSlots(abi))) {
    const primary = Number(primaryKey);
    for (const [secondaryKey, nativeAddress] of Object.entries(slots)) {
      const secondary = Number(secondaryKey);
      if (!installed.has(slotKey(primary, secondary)))
        missing.push({primary, secondary, nativeAddress});
    }
  }
  return missing;
}
