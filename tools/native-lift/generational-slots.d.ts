import type {MappingDatabase, TypeRef} from './database.js';

export type SlotType =
  | {kind: 'bitvector'; bits: number; safeResetAndRetype: true}
  | {kind: 'float'; bits: number; safeResetAndRetype: true}
  | {kind: 'boolean'; bits: 8; safeResetAndRetype: true}
  | {kind: 'address'; bits: number; safeResetAndRetype: false}
  | {kind: 'unknown'; bits: number; safeResetAndRetype: false};

export type AddressExpression =
  | {kind: 'program'; space: string; address: string}
  | {kind: 'relative'; base: string; offsetBytes: string}
  | {kind: 'indirect'; source: string}
  | {kind: 'anonymous'; identity: string};

export interface SlotReference {
  slotId: string;
  generationId: string;
}

export type NativeProjectionRoot =
  | {kind: 'parameter'; name: string; type: TypeRef}
  | {
      kind: 'global';
      name: string;
      address: string;
      type: TypeRef;
      implementation: {rootType: TypeRef; path: string[]};
    };

export type NativeProjectionStep =
  | {
      kind: 'field';
      layoutId: string;
      ownerType: string;
      name: string;
      offsetBytes: number;
      sizeBytes: number;
      storage: 'inline' | 'pointer';
      type: TypeRef;
    }
  | {
      kind: 'element';
      layoutId: string;
      ownerType: string;
      index: string | SlotReference;
      elementSizeBytes: number;
      type: TypeRef;
    }
  | {kind: 'dereference'; type: TypeRef}
  | {kind: 'offset'; offsetBytes: string};

/** A database-backed path from a native parameter/global into an authored type tree. */
export interface NativeProjection {
  root: NativeProjectionRoot;
  steps: NativeProjectionStep[];
  type: TypeRef | null;
  byteOffset: string;
}

export type AddressDerivation =
  | {
      kind: 'byte-offset';
      opId: string;
      parent: SlotReference;
      offsetBytes: string;
      mapping: NativeProjection | null;
    }
  | {
      kind: 'element-offset';
      opId: string;
      parent: SlotReference;
      index: {kind: 'constant'; value: string} | {kind: 'generation'; value: SlotReference};
      elementSizeBytes: number;
      offsetBytes: string | null;
      mapping: NativeProjection | null;
    };

export interface SlotGeneration {
  id: string;
  index: number;
  kind: 'input' | 'initial-memory' | 'write' | 'merge';
  type: SlotType;
  /** Authored source/native meaning. For pointer values, this is the pointee type. */
  semanticType: TypeRef | null;
  sourceOpId: string | null;
  inputs: string[];
  /** The address slot referenced by this value generation, when it is a pointer. */
  pointsTo: string | null;
  /** Exact parent generation and address operation that created this pointer value. */
  derivation: AddressDerivation | null;
}

export interface GenerationalSlot {
  id: string;
  kind: 'anonymous' | 'derived' | 'address';
  storage: string | null;
  address: AddressExpression | null;
  type: SlotType;
  semanticType: TypeRef | null;
  mapping: NativeProjection | null;
  generations: SlotGeneration[];
  /** Value generations whose pointer value denotes this address slot. */
  aliases: string[];
}

export interface SlotBinding {
  slotId: string;
  generationId: string;
  pointsTo: string | null;
}

export interface SlotAccess {
  opId: string;
  blockId: string;
  kind: 'read' | 'write';
  slotId: string;
  generations: string[];
  viaVarnodeId: string | null;
  mapping: NativeProjection | null;
}

export interface SlotMerge {
  id: string;
  blockId: string;
  opId: string | null;
  slotId: string;
  inputs: string[];
  result: string | null;
  safeResetAndRetype: boolean;
  reason: string;
}

export interface GenerationalSlotIr {
  schema: 'generational-address-slots/v2';
  source: {
    exportSha256: string;
    executableSha256: string;
    entryAddress: string;
    bodySha256: string;
    databaseSha256: string | null;
  };
  allocator: {strategy: 'incrementing'; nextAnonymous: number; nextAddress: number};
  controlFlow: {
    entryBlockId: string;
    blocks: {
      id: string;
      index: number;
      predecessors: {blockId: string; sourceSuccessorIndex: number}[];
      successors: {blockId: string; targetPredecessorIndex: number}[];
      conditionalTargets: {trueBlockId: string; falseBlockId: string} | null;
      opIds: string[];
    }[];
  };
  slots: GenerationalSlot[];
  bindings: Record<string, SlotBinding>;
  accesses: SlotAccess[];
  merges: SlotMerge[];
  unresolvedAddresses: {varnodeId: string; addressSlotId: string; reason: string}[];
  unmappedGlobals: {slotId: string; address: string; space: string}[];
}

export interface SlotAnalysisReceipt {
  schema: 'generational-address-slots-receipt/v2';
  status: 'complete';
  sourceSha256: string;
  outputSha256: string;
  databaseSha256: string | null;
  entryAddress: string;
  bodySha256: string;
  slotCount: number;
  anonymousSlotCount: number;
  derivedSlotCount: number;
  addressSlotCount: number;
  mappedSlotCount: number;
  mappedAccessCount: number;
  generationCount: number;
  memoryWriteCount: number;
  mergeCount: number;
  unsafeMergeCount: number;
  unresolvedAddressCount: number;
  unmappedGlobalCount: number;
}

export function analyzeGenerationalSlots(
  exported: unknown,
  database?: MappingDatabase | null,
): GenerationalSlotIr;
export function slotAnalysisReceipt(ir: GenerationalSlotIr): SlotAnalysisReceipt;
