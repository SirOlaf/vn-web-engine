/** Explicit mapping contracts. No declarations are inferred from TypeScript source. */
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
export interface SourcePin {
  path: string;
  sha256: string;
}
export interface ImportDescriptor {
  module: string;
  export: string;
  source: SourcePin;
}
export interface Evidence {
  state: 'synthetic' | 'source-assertion' | 'reviewed-contract';
  references: {path: string; sha256: string; section: string}[];
  notes: string[];
}
export type NamedType =
  | {
      id: string;
      kind: 'integer';
      bits: 8 | 16 | 32 | 64;
      signed: boolean;
      representation: 'number' | 'bigint';
    }
  | {id: string; kind: 'alias'; target: TypeRef}
  | {
      id: string;
      kind: 'reference';
      import: ImportDescriptor;
      nativeBits: 32 | 64;
      nullable: boolean;
      mutability: 'mutable' | 'readonly';
    }
  | {id: string; kind: 'opaque'; import: ImportDescriptor | null; nullable: boolean};
export interface Signature {
  parameters: {name: string; type: TypeRef}[];
  returnType: TypeRef;
}
export interface Implementation extends ImportDescriptor {
  id: string;
  signature: Signature;
  evidence: Evidence;
}
export interface Binary {
  id: string;
  programPath: string;
  executableSha256: string;
  languageId: 'x86:LE:32:default' | 'x86:LE:64:default';
  imageBase: string;
}
export type NativeLocation =
  | {kind: 'register'; name: string}
  | {kind: 'stack'; offsetBytes: number}
  | {kind: 'unresolved'; reason: string}
  | {kind: 'void'};
export interface NativeFunction {
  binarySha256: string;
  rva: string;
  implementation: string;
  abi: {
    convention: 'win64' | 'cdecl' | 'stdcall' | 'fastcall' | 'custom' | 'unresolved';
    parameters: {name: string; type: TypeRef; location: NativeLocation}[];
    arguments: {
      parameter: string;
      source:
        | {kind: 'parameter'; name: string}
        | {kind: 'constant'; type: TypeRef; value: string | boolean};
    }[];
    returnLocation: NativeLocation;
  };
  evidence: Evidence;
}
export interface NativeLayoutSize {
  bytes: number;
  kind: 'exact' | 'minimum';
}
export interface NativeField {
  name: string;
  offsetBytes: number;
  sizeBytes: number;
  storage: 'inline' | 'pointer';
  type: TypeRef;
}
export type NativeLayout =
  | {
      id: string;
      kind: 'struct';
      type: string;
      size: NativeLayoutSize;
      fields: NativeField[];
      evidence: Evidence;
    }
  | {
      id: string;
      kind: 'array';
      type: string;
      size: {bytes: number; kind: 'exact'};
      elementType: TypeRef;
      elementSizeBytes: number;
      count: number;
      evidence: Evidence;
    };
export interface NativeGlobal {
  binarySha256: string;
  address: string;
  name: string;
  type: TypeRef;
  implementation: {
    rootType: TypeRef;
    path: string[];
  };
  evidence: Evidence;
}
export interface VariantBody {
  kind: 'synthetic' | 'reviewed-patch' | 'reviewed-decoded-body' | 'reviewed-original-body';
  sha256: string;
  provenance: {path: string; sha256: string; section: string};
}
export interface VariantTarget {
  selectorValue: number;
  implementation: string;
  applicability: {binarySha256: string; rva: string; body: VariantBody}[];
  evidence: Evidence;
}
export interface VariantOperation {
  id: string;
  signature: Signature;
  targets: VariantTarget[];
}
export interface VariantFamily {
  id: string;
  kind: 'code' | 'type';
  selector: {type: ScalarType; values: number[]; initial?: number};
  operations: VariantOperation[];
  types?: {selectorValue: number; type: TypeRef; evidence: Evidence}[];
}
export interface OwnerLoadCallLifter {
  id: string;
  kind: 'owner-load-call';
  target: {
    binarySha256: string;
    rva: string;
    bodySha256: string;
  };
  operation: {
    address: string;
    sequence: number;
    addressSpace: string;
    offsetBytes: number;
    widthBits: 8 | 16 | 32 | 64;
  };
  receiverParameter: string;
  implementation: string;
  arguments: {
    parameter: string;
    source: {kind: 'native-parameter'; name: string};
  }[];
  evidence: Evidence;
}
export interface MappingDatabase {
  schemaVersion: 1;
  kind: 'native-mapping-database';
  binaries: Binary[];
  types: NamedType[];
  implementations: Implementation[];
  functions: NativeFunction[];
  variantFamilies: VariantFamily[];
  /** Exact, evidence-backed P-code patterns. Omission is equivalent to an empty list. */
  lifters?: OwnerLoadCallLifter[];
  /** Partial or exact native referent layouts. Omission is equivalent to an empty list. */
  layouts?: NativeLayout[];
  /** Binary-qualified native globals mapped into implementation-owned type paths. */
  globals?: NativeGlobal[];
}
export interface GeneratedImport {
  module: string;
  moduleSpecifier: string;
  export: string;
  localName: string;
  typeOnly: boolean;
  source: SourcePin;
}
export interface ResolvedType {
  type: TypeRef;
  kind: 'integer' | 'float' | 'boolean' | 'void' | 'unknown' | 'reference' | 'opaque';
  representation: 'number' | 'bigint' | 'boolean' | 'void' | 'unknown' | 'object';
  typeScript: string;
  bits?: number;
  signed?: boolean;
  nativeBits?: number;
  nullable?: boolean;
  imports: GeneratedImport[];
}
export class DatabaseError extends Error {
  code: string;
  details: Record<string, unknown>;
}
export function canonicalJson(value: unknown): string;
export function databaseSha256(database: MappingDatabase): string;
export function validateDatabase(database: unknown): MappingDatabase;
export function loadDatabase(
  file: string,
  options?: {root?: string; verifySources?: boolean},
): Promise<MappingDatabase>;
export function verifyDatabaseSources(
  database: MappingDatabase,
  root: string,
): Promise<{
  schemaVersion: 1;
  kind: 'mapping-source-receipt';
  databaseSha256: string;
  ok: true;
  sources: SourcePin[];
}>;
export function resolveFunction(
  database: MappingDatabase,
  binarySha256: string,
  rva: string,
): NativeFunction;
export function resolveImplementation(database: MappingDatabase, id: string): Implementation;
export function resolveVariantFamily(database: MappingDatabase, id: string): VariantFamily;
export function resolveVariantTarget(
  database: MappingDatabase,
  family: string,
  operation: string,
  selectorValue: number,
): VariantTarget;
export function resolveLifters(
  database: MappingDatabase,
  binarySha256: string,
  rva: string,
  bodySha256: string,
): OwnerLoadCallLifter[];
export function resolveLayout(database: MappingDatabase, type: string): NativeLayout;
export function resolveGlobal(
  database: MappingDatabase,
  binarySha256: string,
  address: string,
): NativeGlobal;
export function resolveType(
  database: MappingDatabase,
  type: TypeRef,
  options?: {fromFile?: string},
): ResolvedType;
export function describeImplementation(
  database: MappingDatabase,
  id: string,
  options?: {fromFile?: string},
): {
  id: string;
  import: GeneratedImport;
  signature: Signature;
  parameters: {name: string; type: ResolvedType}[];
  returnType: ResolvedType;
  imports: GeneratedImport[];
};
/** Verify pins, then atomically publish a new file. Existing destinations are never overwritten. */
export function publishDatabase(
  database: MappingDatabase,
  destination: string,
  options?: {root?: string},
): Promise<{path: string; databaseSha256: string}>;
