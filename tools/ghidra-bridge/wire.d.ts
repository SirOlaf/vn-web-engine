/** NativeExportBridge 0.2.0: program reads and explicit new artifact files. */
export interface BinaryIdentity {
  programPath: string;
  executableSha256: string;
  languageId: string;
  imageBase: string;
}
export interface ExportRequest {
  schema: 'ghidra-function-request/v1';
  binary: BinaryIdentity;
  entryAddress: string;
  representation?: 'raw' | 'high' | 'both'; // default both
  limits?: {
    decompileSeconds?: number; // default 30, maximum 120
    maxBodyBytes?: number; // default 1048576, maximum 8388608
    maxInstructions?: number; // default 20000, maximum 50000
    maxPcodeOps?: number; // default 50000, maximum 100000, combined raw + high
  };
}
export interface ExportFileRequest extends Omit<ExportRequest, 'schema'> {
  schema: 'ghidra-function-file-request/v1';
  /** Absolute NEW .json destination; parent must exist on the Ghidra host. */
  outputPath: string;
}
export interface ExportFileReceipt {
  schema: 'ghidra-function-file-receipt/v1';
  status: 'complete';
  file: {
    path: string;
    byteLength: number;
    sha256: string;
    contentSchema: 'ghidra-function-export/v1';
  };
  binary: BinaryIdentity;
  function: {entryAddress: string; name: string; bodySha256: string; bodyByteLength: number};
  representation: 'raw' | 'high' | 'both';
  counts: {
    instructions: number | null;
    rawOps: number | null;
    highBlocks: number | null;
    highOps: number | null;
  };
  state: {stable: true; savedState: 'unverified'; changed: boolean; modificationNumber: string};
  exporter: {name: 'NativeExportBridge'; version: '0.2.0'; ghidraVersion: string};
}
export interface AddressSpace {
  id: number;
  name: string;
  type: number;
  sizeBits: number;
  addressableUnitSize: number;
  isDefault: boolean;
  isOverlay: boolean;
}
export interface StorageNode {
  spaceId: number;
  space: string;
  offset: string; // unsigned lowercase 0x hex, including stack offsets
  size: number; // bytes
  register: string | null;
  kind: 'constant' | 'register' | 'unique' | 'stack' | 'memory' | 'other';
}
export interface TypeHint {
  name: string;
  path: string;
  length: number;
  metatype: string;
}
export interface VariableStorage {
  text: string;
  valid: boolean;
  unassigned: boolean;
  forcedIndirect: boolean;
  auto: boolean;
  pieces: StorageNode[]; // preserve piece order; do not sort compound storage
}
export interface Parameter {
  ordinal: number;
  name: string;
  typeHint: TypeHint;
  storage: VariableStorage;
  source: string;
  auto: boolean;
}
export interface FunctionEvidence {
  entryAddress: string;
  name: string;
  bodyRanges: {start: string; end: string; byteLength: number; bytesSha256: string}[];
  bodyByteLength: number;
  bodySha256: string; // ordered concatenation, no gap bytes
  callingConvention: {
    name: string;
    compilerSpecId: string;
    signatureSource: string;
    customStorage: boolean;
    variadic: boolean;
    noReturn: boolean;
  };
  parameters: Parameter[]; // database signature, not inferred HighFunction parameters
  returnValue: {typeHint: TypeHint; storage: VariableStorage};
  thunk: boolean;
}
export interface Sequence {
  address: string;
  addressSpace: string;
  time: number; // Ghidra unsigned 32-bit sequence unique value
  order: number; // Ghidra sequence order, not a block list position
}
export interface RawOp {
  id: string;
  index: number;
  opcode: string;
  sequence: Sequence;
  output: StorageNode | null;
  inputs: StorageNode[];
}
export interface RawRepresentation {
  kind: 'raw-pcode';
  source: 'Instruction.getPcode(true)';
  ssa: false;
  instructions: {
    address: string;
    length: number;
    mnemonic: string;
    operands: string[];
    flow: {type: string; override: string; fallthrough: string | null; targets: string[]};
    ops: RawOp[];
  }[];
  instructionCount: number;
  opCount: number;
}
export interface HighVarnode extends StorageNode {
  id: string; // SSA identity assigned by object identity, never storage address alone
  ssaUniqueId: number | null; // Ghidra VarnodeAST.getUniqueId, signed Java int
  flags: {
    input: boolean;
    constant: boolean;
    addressTied: boolean;
    persistent: boolean;
    unaffected: boolean;
  };
  definitionOpId: string | null;
  typeHint: TypeHint | null;
  high: {className: string; name: string | null; parameterIndex: number | null} | null;
  joinStorage?: VariableStorage; // present for VARIABLE/join-space varnodes; original piece order
}
export interface HighBlock {
  id: string;
  index: number;
  start: string | null;
  stop: string | null; // bounding addresses only, not asserted complete ranges
  predecessors: {blockId: string; sourceSuccessorIndex: number}[];
  successors: {blockId: string; targetPredecessorIndex: number}[];
  conditionalTargets: {falseBlockId: string; trueBlockId: string} | null;
  opIds: string[]; // exact live PcodeBlockBasic.getIterator() order
}
export interface HighOp {
  id: string;
  blockId: string;
  index: number; // position among this block's live ops
  opcode: string;
  sequence: Sequence;
  output: string | null; // varnode ID
  inputs: string[]; // varnode IDs, original slot order
  phiInputs?: {
    inputIndex: number;
    predecessorIndex: number;
    predecessorBlockId: string;
    predecessorSuccessorIndex: number;
    varnodeId: string;
  }[]; // MULTIEQUAL only; input i belongs to predecessor edge i
}
export interface HighRepresentation {
  kind: 'high-pcode';
  source: 'DecompInterface.HighFunction';
  ssa: true;
  simplificationStyle: 'normalize';
  entryBlockId: string;
  blocks: HighBlock[];
  ops: HighOp[]; // block order then exact live op order, never sequence-address sorted
  varnodes: HighVarnode[];
  inputVarnodeIds: string[];
  parameters: {ordinal: number; name: string; typeHint: TypeHint; storage: VariableStorage}[];
  prototype: {callingConvention: string; variadic: boolean};
  opCount: number;
  decompilerMessage: string;
}
export interface ProgramState {
  changed: boolean;
  transactionOpen: boolean;
  modificationNumber: string;
  domainFile: {programPath: string; fileId: string | null; lastModifiedMs: string; version: number};
}
export interface FunctionExport {
  schema: 'ghidra-function-export/v1';
  status: 'complete';
  capturedAt: string;
  exporter: {name: 'NativeExportBridge'; version: '0.1.0' | '0.2.0'; ghidraVersion: string};
  binary: BinaryIdentity;
  function: FunctionEvidence;
  addressSpaces: AddressSpace[];
  state: {before: ProgramState; after: ProgramState; stable: true; savedState: 'unverified'};
  raw?: RawRepresentation;
  high?: HighRepresentation;
}
