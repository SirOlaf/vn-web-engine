/** Reviewed pure integer leaf IR. This is not Ghidra's raw or HighFunction P-code. */
export interface BinaryIdentity {
  programPath: string;
  executableSha256: string;
  languageId: 'x86:LE:32:default' | 'x86:LE:64:default';
  imageBase: string;
}
export type Width = 8 | 16 | 32 | 64;
export type Operand = {ref: string} | {constant: string; bits: Width};
export interface IntegerLeaf {
  schemaVersion: 1;
  kind: 'reviewed-integer-leaf';
  symbol: string;
  binary: BinaryIdentity;
  entryAddress: string;
  bodyRanges: {start: string; end: string}[];
  bodySha256: string;
  provenance: {
    sourceKind: 'synthetic' | 'reviewed-pcode';
    sourceSha256: string;
    exporter: string;
    reviewReference: string;
    assumptions: string[];
  };
  inputs: {id: string; bits: Width}[];
  operations: {
    id: string;
    bits: Width;
    opcode: string;
    inputs: Operand[];
    source: {address: string; sequence: number};
  }[];
  result: Operand;
}
export interface ApprovedTarget {
  binary: BinaryIdentity;
  entryAddress: string;
  bodySha256: string;
  irSha256: string;
}
export interface HandRoute {
  kind: 'hand';
  implementation: {
    id: string;
    sourcePath: string;
    sourceSha256: string;
    exportName: string;
  };
  reviewReference: string;
}
export interface MappingRegistry {
  schemaVersion: 1;
  exact: (ApprovedTarget & {route: HandRoute | {kind: 'blocked'; reason: string}})[];
  patterns: {
    id: string;
    shapeSha256: string;
    approvedTargets: ApprovedTarget[];
    route: HandRoute;
  }[];
}
