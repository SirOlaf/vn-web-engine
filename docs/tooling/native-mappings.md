# Explicit native mapping database

`tools/native-lift/database.mjs` manages a versioned JSON mapping database. It reads
explicit contracts and source hashes. It does **not** parse TypeScript, inspect
function declarations, infer signatures, import implementations, or execute code.

The database connects an executable hash and native RVA to a real repository
export. Generated TypeScript can import that export directly. Function arguments,
return types, native parameter locations and the binding from native parameters
to implementation arguments are written into the database in a deliberate order.
There is no injected dictionary of opaque implementation functions.

The complete format and API are declared in
[`database.d.ts`](../../tools/native-lift/database.d.ts). The initial real mappings
are in [`mappings/aokana.json`](../../tools/native-lift/mappings/aokana.json).

## Records and identity

The root requires `schemaVersion: 1`, `kind: "native-mapping-database"`, and five
arrays: `binaries`, `types`, `implementations`, `functions`, and `variantFamilies`.
The optional `lifters`, `layouts`, and `globals` arrays are each equivalent to an
empty list when omitted.

| Record          | Explicit information                                                                                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Binary          | Stable ID, executable SHA-256, program path, Ghidra language ID, image base.                                                                                               |
| Implementation  | ID, repository-relative JavaScript module path, exported identifier, pinned source path/hash, ordered signature, evidence.                                                 |
| Native function | Executable SHA-256 and canonical hexadecimal RVA, implementation ID, native ABI parameters/locations, ordered implementation argument bindings, return location, evidence. |
| Named type      | Exact integer representation, an alias, an imported object reference, or an opaque imported/unknown type.                                                                  |
| Variant family  | Finite selector values, optional initial value, typed operations, explicitly enumerated target implementations, exact native body identities and provenance.               |
| Lifter          | Exact executable/RVA/body applicability, a recognized P-code pattern, direct implementation bindings, and reviewed evidence.                                               |
| Native layout   | A partial/exact struct size and non-overlapping typed fields, or an exact array size/count/element stride.                                                                 |
| Native global   | Executable hash, absolute native address, native type, and an implementation-owned root type/property path.                                                                |

One base function record occupies each `(binarySha256, rva)` pair. The same RVA in
another executable is a different identity. Names and address similarity never
select a mapping. Conflicting source hashes, duplicate identities, unknown types,
cyclic aliases, incomplete argument bindings and mismatched variant signatures
are rejected.

An implementation's `module` is a repository-relative output path, such as
`src/engines/buriko/games/aokana/bp/opcodes/native-math.js`. Its `source.path`
names the corresponding `.ts` file and `source.sha256` pins its exact bytes. Module
paths must correspond to the pinned source (`.ts` → `.js`, `.mts` → `.mjs`,
`.cts` → `.cjs`); an unrelated pinned file cannot authenticate a different import.
The export name and signature remain authored assertions. Compilation of generated
imports is the separate check that those declarations agree with current source.

## Types and argument order

`TypeRef` is a scalar string or `{ "named": "type-id" }`. Scalars are `u8`, `i8`,
`u16`, `i16`, `u32`, `i32`, `u64`, `i64`, `f32`, `f64`, `bool`, `void`, and `unknown`.
Integers through 32 bits use `number`; 64-bit integers use `bigint`. Named integer
definitions can explicitly select `bigint` for smaller widths. Full-width 64-bit
integer values cannot use `number`.

Imported `reference` types include native pointer width, mutability and nullability.
Imported `opaque` types retain a named TypeScript type without inspecting its
structure. An opaque type without an import resolves to `unknown`. No unrecognized
type falls back to `any`. Aliases retain transitive type-import metadata.

Native ABI parameters have names, types and explicit register/stack locations.
Stack offsets are bytes from the stack pointer at native function entry. Unresolved
locations carry a reason. `abi.arguments` lists every implementation parameter in
the implementation signature's order; each source names a native parameter or a
typed constant. This permits explicit reordering and specialization without reading
a TypeScript declaration or guessing from native argument position. Types must
match exactly; representation changes require an explicitly declared adapter.

## Layouts and global type roots

A struct layout names a mapped type, states whether its byte size is exact or a
reviewed minimum, and records each known field's offset, size, storage mode, and
type. Sparse partial layouts are valid; absent fields remain unknown. Fields may
be `inline` scalars/records or native `pointer` fields. Array layouts require an
exact total size, element type, element size, and count, with
`size = elementSizeBytes * count`.

Global records are qualified by executable SHA-256 and an absolute canonical
address. Their native `type` anchors address projection, while
`implementation.rootType` and `implementation.path` identify the corresponding
owned value in the web implementation. The database describes a relationship
between native and implementation state; it does not claim that JavaScript
objects have native in-memory layouts.

The generational slot analyzer consumes these records directly. Constant pointer
arithmetic folds into field or array-element steps, dereferences retain their
parent type, and every step keeps the authored offset/size metadata. Addresses
without a global record remain explicit unmapped program slots so later lifting
work can extend the type tree from evidence.

## Lifter rules

Lifter records connect a recovered native effect to an existing implementation
without treating a pointer as an untyped JavaScript number. The initial
`owner-load-call` kind pins one LOAD by executable, RVA, body hash, source address
and sequence, address space, constant byte offset and result width. It names the
native receiver parameter, direct implementation, and ordered bindings for that
implementation.

Database validation checks the target function, implementation signature, native
parameter types, return width and reviewed evidence. The graph matcher performs
the remaining structural checks and refuses body drift or partial pattern matches.
Generated `CALL_IMPLEMENTATION` operations always import the mapped export,
including when its implementation ID is also the generated entry ID.

## Variant arrays and active stacks

The database stores finite **arrays of alternatives**, never a mutable active
selector. Each operation declares a common ordered signature and one target for
every permitted selector value. Targets may use different implementation names,
but their parameter/return types must match the operation contract. Type families
also enumerate the selected type for each value; their operations dispatch through
explicit typed adapters rather than inferred methods.

An absent `selector.initial` means no initial target is known. The generated
execution layer owns active variant **stacks**, including nested push/pop scopes
and restoration in `finally`. Stack frames can carry target and provenance data.
The database itself has no current selector, active frame or global dispatch state.

Each target enumerates exact applicability records:

```json
{
  "binarySha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "rva": "0x10",
  "body": {
    "kind": "synthetic",
    "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "provenance": {
      "path": "tests/fixture.json",
      "sha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      "section": "Synthetic alternate body"
    }
  }
}
```

Two targets can identify the **same executable and RVA** while choosing distinct
implementations and native body hashes. This supports reviewed decoded or patched
variants at one address. Applicability must name an existing base native-function
record, but the alternative need not use its base implementation. Alternate
reviewed implementations require `reviewed-patch` or `reviewed-decoded-body`
provenance; an original target may use `reviewed-original-body`. Synthetic and
reviewed evidence cannot be mixed. Every target has its own evidence, and an
unreviewed `source-assertion` cannot become a finite approved variant target.

Body hashes and review references identify the authored evidence. This database
does not fetch Ghidra bodies or independently establish their equivalence. The
lifting/emission verifier must match its exact input body hash to the selected
applicability record before routing that body.

## API and commands

```js
import {
  loadDatabase,
  resolveFunction,
  resolveGlobal,
  resolveLayout,
  describeImplementation,
  resolveType,
  resolveVariantFamily,
  resolveVariantTarget,
} from './tools/native-lift/database.mjs';

const db = await loadDatabase('tools/native-lift/mappings/aokana.json', {
  root: process.cwd(),
});
const mapping = resolveFunction(
  db,
  'f585e28f79923b8aa487d8690165e45ce3377c7e1b8381d3b75c659c7e933d7a',
  '0x315f0',
);
const descriptor = describeImplementation(db, mapping.implementation, {
  fromFile: 'src/generated/aokana-example.ts',
});
// descriptor.import supplies moduleSpecifier/export/localName for a real named import.
// descriptor.parameters and returnType supply explicit types and transitive type imports.
const particleLayout = resolveLayout(db, 'aokana.Particle');
const snowRoot = resolveGlobal(
  db,
  'f585e28f79923b8aa487d8690165e45ce3377c7e1b8381d3b75c659c7e933d7a',
  '0x1401e08e0',
);
```

`loadDatabase` validates and freezes the data and verifies implementation/type
source hashes by default. `verifyDatabaseSources` returns a deterministic receipt.
`resolveFunction`, `resolveImplementation`, `resolveType`, `resolveLayout`,
`resolveGlobal`, `resolveVariantFamily`, `resolveVariantTarget` and
`resolveLifters` reject unknown identities. Supply `fromFile` when using
`describeImplementation` or `resolveType` to emit code: it produces a relative
module specifier for that generated source location and stable import aliases.

```sh
node tools/native-lift/database.mjs validate tools/native-lift/mappings/aokana.json
node tools/native-lift/database.mjs query tools/native-lift/mappings/aokana.json --binary f585e28f79923b8aa487d8690165e45ce3377c7e1b8381d3b75c659c7e933d7a --rva 0x315f0 --from src/generated/aokana-example.ts
node tools/native-lift/database.mjs publish tools/native-lift/mappings/aokana.json --out /tmp/aokana-mappings-next.json
node --test tests/tooling-native-mappings.test.mjs
```

All CLI commands verify source pins. `publish` writes and syncs a temporary file,
then atomically creates the new destination using a hard link. It refuses existing
destinations, including symlinks, and cleans the temporary file. To prepare an
update, edit a candidate JSON file, validate it, and publish to a new reviewable
path. Source inputs must be regular files inside the canonical repository root;
symlinked source components and path traversal are rejected. No compiler, external
service or new dependency is required by this database.

## Aokana mappings and evidence limits

The database contains three source-assertion mappings and two live reviewed
particle mappings:

| Native RVA | Existing export/adapter     | Declared parameters                                        |
| ---------- | --------------------------- | ---------------------------------------------------------- |
| `0x315f0`  | `nativeVectorAngle`         | `x: i32`, `y: i32`                                         |
| `0xa0f60`  | `nativeVectorAngle`         | `x: i32`, `y: i32`                                         |
| `0xef720`  | `nativeCursorInterpolation` | `delta: i32`, `easing: i32`, `progress: u32`, `steps: u32` |
| `0x95bb0`  | `readPrimaryFrameIndex`     | `particle: aokana.Particle`                                |
| `0x95be0`  | `advanceParticle`           | `particle: aokana.Particle`                                |

The source comments identify the first and third entries. The existing logical
spatial investigation records the middle cached wrapper as equivalent to the
complete integer-vector angle helper. Those are preserved as **source assertions**,
with exact source/evidence hashes. Native register/stack locations, entry/body
verification, direct readback and save remain explicitly unresolved. The cursor
source documents the caller domain `0 < progress < steps`.

The `0x95bb0` record is separately pinned to a live body and exact owner-load
pattern. Its Win64 receiver/return ABI and adapter route are reviewed in
[`evidence/aokana-095bb0.md`](evidence/aokana-095bb0.md). This narrow contract
does not upgrade the other three mappings. `0x95be0` supplies the first reviewed
partial `AokanaParticle` layout and typed derived-slot route. The database also
maps the exact `AokanaParticleImages` record size/count field and the snow and
firefly parameter-table global roots described in
[`evidence/aokana-native-layouts.md`](evidence/aokana-native-layouts.md).

The source-assertion records demonstrate binary-qualified source correspondence and direct
imports. They are not acceptance of whole-function native replacement or proof of
numerical equivalence. No real variant family is marked reviewed in the seed.
Finite code/type variant validation is exercised with synthetic metadata in the
focused tests, including two bodies and implementations at the same native entry.
Imported bitmap/thread types and an explicit 64-bit native-address representation
illustrate reference, opaque and integer contracts without inferring layouts.
