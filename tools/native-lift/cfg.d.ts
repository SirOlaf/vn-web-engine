export type ScalarType =
  | 'u8'
  | 'i8'
  | 'u16'
  | 'i16'
  | 'u32'
  | 'i32'
  | 'u64'
  | 'i64'
  | 'f32'
  | 'f64'
  | 'bool'
  | 'void'
  | 'unknown';
export type TypeRef = ScalarType | {named: string};
export type Operand = {ref: string} | {constant: string; type: ScalarType} | {boolean: boolean};
export interface SourceLocation {
  address: string;
  sequence: number;
  loweringIndex?: number;
}
export interface Provenance {
  binary: {programPath: string; executableSha256: string; languageId: string; imageBase: string};
  entryAddress: string;
  bodyRanges: {start: string; end: string}[];
  bodySha256: string;
  sourceKind: 'synthetic' | 'reviewed-pcode';
  sourceSha256: string;
  exporter: string;
  reviewReference: string;
  assumptions: string[];
}
export interface Phi {
  id: string;
  type: TypeRef;
  incoming: Record<string, Operand>;
  source: SourceLocation;
}
export type Operation =
  | {id: string; type: TypeRef; opcode: string; inputs: Operand[]; source: SourceLocation}
  | {
      id: string | null;
      opcode: 'CALL';
      target: {binarySha256: string; rva: string};
      arguments: Record<string, Operand>;
      source: SourceLocation;
    }
  | {
      id: string | null;
      opcode: 'CALL_IMPLEMENTATION';
      implementation: string;
      arguments: Record<string, Operand>;
      source: SourceLocation;
    }
  | {
      id: string | null;
      opcode: 'VARIANT_CALL';
      family: string;
      operation: string;
      arguments: Record<string, Operand>;
      source: SourceLocation;
    }
  | {
      opcode: 'PUSH_VARIANT';
      scopeId: string;
      family: string;
      selectorValue: number;
      reviewReference: string;
      source: SourceLocation;
    }
  | {opcode: 'POP_VARIANT'; scopeId: string; source: SourceLocation};
export type Terminator =
  | {opcode: 'JUMP'; target: string; source: SourceLocation}
  | {
      opcode: 'BRANCH';
      condition: Operand;
      trueTarget: string;
      falseTarget: string;
      source: SourceLocation;
    }
  | {opcode: 'RETURN'; value: Operand | null; source: SourceLocation};
export interface Block {
  id: string;
  phis: Phi[];
  operations: Operation[];
  terminator: Terminator;
}
export interface DecodedVariant {
  kind: 'decoded-body';
  family: string;
  selectorValue: number;
  reviewReference: string;
}
export interface PatchedVariant {
  kind: 'reviewed-patch';
  family: string;
  selectorValue: number;
  reviewReference: string;
  baseBodySha256: string;
  patches: {address: string; originalHex: string; replacementHex: string}[];
}
export interface CfgFunction {
  implementation: string;
  provenance: Provenance;
  variant: DecodedVariant | PatchedVariant | null;
  /** Keys are exact mapping-database parameter names; values are SSA input IDs. */
  parameterValues: Record<string, string>;
  entryBlock: string;
  blocks: Block[];
}
export interface CfgModule {
  schemaVersion: 2;
  kind: 'reviewed-cfg-module';
  entryImplementation: string;
  functions: CfgFunction[];
}
