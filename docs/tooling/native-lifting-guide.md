# Using the Ghidra bridge and TypeScript lifter

This guide covers the normal hands-on workflow: export one decoded function from
the open Ghidra program, inspect it, add explicit mapping/lifter data, and emit a
reviewable TypeScript module. Ghidra performs decoding and HighFunction analysis;
the repository tools validate and lower that graph. They do not execute the game.

## 1. Check the installed bridge

Enable `NativeExportBridgePlugin` in the CodeBrowser that has the target program
open. The plugin listens only on loopback port `18493`.

```sh
node tools/native-mcp/cli.mjs health
```

A working 0.2.0 install reports `function-export` and
`function-export-file`. A connection refusal normally means the plugin is not
enabled in that CodeBrowser. A program lookup error during export means the exact
`programPath` in the request does not identify one open program.

## 2. Export directly to local evidence storage

Keep native captures outside source control. This checkout ignores `targetgame/`,
so `targetgame/aokana-lifting/evidence/` is a suitable local location. Create the
directory, then write a request like this with a new output filename:

```json
{
  "schema": "ghidra-function-file-request/v1",
  "binary": {
    "programPath": "/aokana.exe",
    "executableSha256": "f585e28f79923b8aa487d8690165e45ce3377c7e1b8381d3b75c659c7e933d7a",
    "languageId": "x86:LE:64:default",
    "imageBase": "0x140000000"
  },
  "entryAddress": "0x140095bb0",
  "representation": "both",
  "outputPath": "/absolute/path/to/targetgame/aokana-lifting/evidence/aokana-0x140095bb0.json"
}
```

```sh
node tools/native-mcp/cli.mjs export request.json
```

The command prints only a compact receipt. Ghidra writes the graph to the named
file with exclusive creation; it never replaces an existing artifact. The
receipt's `file.sha256` hashes the exact file bytes, including the final newline.

Inspect the graph before writing mappings:

```sh
node tools/native-lift/ghidra-cli.mjs inspect /absolute/path/to/export.json
```

The inspection's `exportSha256` is the canonical JSON hash used by an import
plan. It is intentionally different from the receipt's byte hash.

## 3. Analyze variables and address generations

For a variable-bearing body, create a generational slot artifact before semantic
lowering:

```sh
node tools/native-lift/generational-slots-cli.mjs analyze \
  export.json tools/native-lift/mappings/aokana.json NEW-function.slots.json
```

The file preserves the original CFG and records anonymous parameter/local slots,
canonical relative/indirect/program addresses, pointer aliases, one generation
per static write, derived parent generations, typed field/array/dereference
projections, implementation-owned global roots, and merge decisions. The command
prints only a compact receipt. The database argument may be omitted for an
untyped exploratory artifact, but a reviewed route recomputes typed analysis.
Inspect `unresolvedAddresses` and every merge with
`safeResetAndRetype: false`; do not route or emit through them without an authored
type rule. See [Generational address slots](generational-address-slots.md).

## 4. Add the authored mapping contract

`tools/native-lift/mappings/aokana.json` is the current local database. It owns
the information that generated code may rely on:

- the exact executable and RVA;
- the implementation parameter and return types;
- native register or entry-stack locations;
- the binding from native inputs to implementation arguments;
- direct module/export references with source hashes; and
- exact lifter applicability and evidence;
- partial/exact native record layouts with field offsets and sizes; and
- binary-qualified global addresses mapped to implementation-owned paths.

The tools do not parse TypeScript to infer any of these fields. Add a named type
for an engine object, an implementation descriptor for the code that should run,
and a native function record. If the existing implementation is a method, a
small explicit adapter under `tools/native-lift/adapters/` can provide a named
function export. Give JavaScript adapters a sibling declaration file when their
types are not otherwise discoverable.

Validate every edit and refresh source hashes deliberately:

```sh
shasum -a 256 path/to/pinned/source
node tools/native-lift/database.mjs validate tools/native-lift/mappings/aokana.json
```

Source hash drift is a refusal. Do not update a hash until the changed
implementation and its native contract have been reviewed together.

## 5. Write or select a lifter

The first live lifter kind is `owner-load-call`. It recognizes one exact
HighFunction pattern:

```text
native receiver -> INT_ADD constant offset -> single-use pointer -> LOAD
                                                        |
                                                        v
                                  direct imported implementation call
```

Its database record pins the executable, RVA, body hash, LOAD address and
sequence, address space, byte offset, width, native receiver, implementation,
argument bindings, and evidence. The matcher also proves that the address setup
feeds only that LOAD. If any part differs, import stops.

The live `095bb0` record maps a 16-bit `ram` load at `RCX + 0x26` to
`readPrimaryFrameIndex(particle)`, whose implementation calls the existing
`AokanaParticle.frame()` method. The metadata review is in
[`evidence/aokana-095bb0.md`](evidence/aokana-095bb0.md).

To add a second rule of the same shape, add another database `lifters` entry; no
matcher code change is needed. To add a new pattern kind, implement and test its
strict matcher in `tools/native-lift/lifters.mjs`, add its schema to
`database.d.ts` and `database.mjs`, and emit only existing CFG operations or a
new fully validated operation. A matcher must consume every native setup
operation it replaces and report those operation IDs in the import receipt.

## 6. Import and emit

Create a review plan pinned to the inspection hash:

```json
{
  "schema": "ghidra-cfg-import/v1",
  "exportSha256": "canonical hash from inspect",
  "sourceKind": "reviewed-pcode",
  "reviewReference": "path or review record",
  "assumptions": ["State the exact semantic assumption."],
  "callArguments": {}
}
```

Direct native calls need an entry in `callArguments` keyed by P-code operation
ID. Database lifters supply their own explicit bindings.

```sh
node tools/native-lift/ghidra-cli.mjs import \
  export.json \
  tools/native-lift/mappings/aokana.json \
  plan.json \
  NEW-function.cfg.json

node tools/native-lift/cfg-cli.mjs check \
  NEW-function.cfg.json \
  tools/native-lift/mappings/aokana.json

node tools/native-lift/cfg-cli.mjs emit \
  NEW-function.cfg.json \
  tools/native-lift/mappings/aokana.json \
  NEW-function.lifted.ts
```

All output paths are new files. The generated module imports mapped
implementations directly and carries a `cfgReceipt` with exact provenance,
routes, CFG structure, dominators, loops, and hashes. An emitted prototype still
needs source review and focused behavior tests before runtime integration.

For an exact complete body that already has a reviewed implementation, a
`reviewed-generational-route/v1` plan pins both the canonical export hash and the
fresh slot IR hash. `reviewed-route-cli.mjs import` validates the implementation,
ABI, native inputs, and return storage, then writes a one-call CFG using a forced
direct import. The companion slot file remains the detailed control-flow and
variable representation. The command sequence is documented in
[Generational address slots](generational-address-slots.md).

## Current boundary

The generic importer handles integer CFGs, branches, loops, phi nodes, explicit direct
calls, scoped variant stacks, and exact owner-load calls. Generic memory,
floating-point/SIMD operations, native exceptions, arbitrary indirect calls, and
unreviewed self-modifying bodies remain refusals. The companion generational-slot
analyzer represents loads, stores, aliases, derived address generations, typed
field paths, global roots, and merges without claiming generic semantic lowering.
Reviewed exact whole-function routes can call an
existing mapped implementation while retaining that detailed slot artifact.
Variant alternatives stay in
arrays, while calls dispatch through scoped active stacks with trace records.

The live installation was checked against Ghidra 12.1.3 on 2026-09-19. The
bridge exported Aokana `0x140095bb0` directly to a file, its hashes and permissions
were verified, and the generated TypeScript passed strict checking. This proves
the local transport and one exact mapping route, not general native equivalence.

The second live route is `0x140095be0`, an eight-block particle update with local,
field, indirect, and loop-carried values. Its slot IR and direct
`AokanaParticle.update()` route are recorded in
[`evidence/aokana-095be0.md`](evidence/aokana-095be0.md), with its database-aware
derived-slot artifact in
[`evidence/aokana-095be0-typed-slots.md`](evidence/aokana-095be0-typed-slots.md).
