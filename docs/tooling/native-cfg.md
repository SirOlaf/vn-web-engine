# Mapping-driven CFG lifting

`tools/native-lift/cfg.mjs` emits TypeScript from a versioned, reviewed control-flow
graph. It supports branches, loops, simultaneous phi assignment, explicit native
calls, mapped object references, finite code variants, and operations on explicitly
selected unknown representations. The mapping database supplies every function
parameter and return type. No TypeScript declarations are parsed to discover those
contracts.

This is a bounded backend for already decoded functions. It does not decode an
arbitrary executable, reconstruct ownership automatically, or establish native
equivalence. The bridge/importer is a separate frontend. Unsupported instructions
and effects must stop there or at this backend; they are never silently omitted.

## Run the examples

```sh
node tools/native-lift/cfg-cli.mjs check tools/native-lift/examples/cfg/module.json tools/native-lift/examples/cfg/database.json
node tools/native-lift/cfg-cli.mjs emit tools/native-lift/examples/cfg/module.json tools/native-lift/examples/cfg/database.json /private/tmp/new-native-cfg-demo.ts
node --test tests/tooling-native-cfg.test.mjs
```

The output path must be a new `.ts` file in an existing directory. Relative imports
are generated for that exact location; output parents are canonicalized to avoid
macOS symlink-path mistakes. The CLI verifies database source pins before checking
or emitting. Direct library callers should use `loadDatabase` with source
verification before calling the emitter. Neither emitter imports or executes a
game implementation while generating code.

The example contains only synthetic addresses and data. Its generated module
imports the actual example `bump` adapter and the explicit `CounterState` reference
type. Two separate generated bodies represent the base and alternate behavior of
one address slot. An opaque input remains `unknown` and can only be measured by an
explicitly selected text/list adapter. A separate loop example swaps two values
through predecessor-keyed phi nodes.

Generated modules export:

- `lifted(...)`, with the entry implementation's named database parameters and
  result type. Each call owns a fresh execution context.
- `createExecution()`, returning `invoke`, `getTrace` and `getActiveDepths` for
  inspecting repeated calls in one explicit context. It exposes no mutable stacks.
- `cfgReceipt`, recording IR/database hashes, function/variant provenance,
  reachability, edges, dominators, strongly connected components and backedges.

## IR contract

`cfg.d.ts` is the schema reference. A module names its entry implementation and
contains one or more function bodies. A body's `parameterValues` binds every exact
database parameter name to an SSA value ID. Its native identity, exact entry, body
ranges/hash and source-export provenance remain attached to that body. Function
names are not used to identify native code.

Each block contains predecessor-keyed `phis`, ordered `operations`, and one
`JUMP`, `BRANCH`, or `RETURN` terminator. Calls supply arguments keyed by the
implementation's declared parameter names. A direct call resolves its binary hash
and RVA through the database; the emitter uses a named module import or a local
generated implementation. It does not pass an injectable implementation dictionary
to the lifted function.

`CALL_IMPLEMENTATION` is the explicit result of an evidence-backed lifter rule.
It always uses a named module import, even when that implementation ID also names
the current generated body. This distinction prevents an owner adapter from
recursing into the lifted entry function.

When that exact native call target belongs to one registered code-family operation,
the call automatically routes through its active stack frame. Every finite target
must explicitly apply to the same native slot and signature; partial or ambiguous
family matches refuse emission. The receipt records each direct/generated/stack
call route, so an ordinary decoded call cannot bypass a currently active variant.

The validator checks unique block/value IDs, exact edge targets, reachability,
dominance and within-block definition order. Every phi requires exactly one
incoming value for each predecessor. Incoming values must dominate that
predecessor, including valid loop backedges. The emitted code reads all phi values
into temporaries before assigning any phi destination, preserving simultaneous
assignment. A switch/while state machine preserves the graph without assuming
structured loops or reducibility. Entry blocks have no predecessors; loop headers
are separate blocks.

Source locations use the native address and operation sequence. An optional
`loweringIndex` distinguishes multiple generated nodes derived from one native
operation, such as an explicit integer type adapter and a return. It does not
replace the native sequence number. The importer must record what expansion was
performed.

Supported computation includes integer copy/cast, add/subtract/multiply, bitwise
operations, comparisons, extensions, shifts, piece and subpiece. Integer widths
are 8/16/32/64 bits. Database representation determines `number` or `bigint`;
full-width 64-bit values use BigInt. Arithmetic converts to explicit bit patterns,
then wraps to the declared output width/sign. `CAST` supports same-width integer
representation/sign changes. It never coerces unknown data to an object, pointer,
or number. Comparisons may produce a boolean or an 8-bit integer. Floating-point
values can pass through explicit typed calls/copies, but floating-point arithmetic
is unsupported.

P-code phi operations select inputs by predecessor, and analyzed P-code includes
operations that do not occur in raw instruction translation. That distinction is
why the frontend must retain CFG and SSA metadata rather than execute a flat
decompiler operation listing.
[Ghidra additional P-code operations](https://ghidra.re/ghidra_docs/languages/html/additionalpcode.html)

## Variant arrays and active stacks

Finite variant definitions remain arrays in the database. Generated code materializes
those arrays as `unstable_functions_*` or `unstable_types_*`. A scoped
`PUSH_VARIANT` resolves one registered array element and pushes a frame containing
its operation adapters, variant index, source address, block and scope ID.
`VARIANT_CALL` dispatches through the **top active stack frame**. `POP_VARIANT`
restores the previous frame. There is no mutable global selector map.

The validator requires a properly nested scope stack, the same stack at every CFG
join/backedge, and no owned frames left at return. Callees cannot pop caller-owned
frames. Each generated function also restores inherited stack depths in
`try/finally`, so exceptions from a direct adapter do not leak a selected variant
into later calls. Trace records show pushes, calls, pops and exception unwinds.

An explicit database initial variant creates a base frame. An omitted initial
variant leaves the stack empty: attempting an operation throws instead of choosing
index zero or coercing an unknown type. Code and type families use the same stack
discipline. Different representations require explicit adapter implementations
sharing the declared operation signature; no adapter is inferred from a type name.

An alternate generated body needs a `variant` descriptor and exact database
applicability matching its binary, RVA and body hash. It may reference a separately
decoded body or a reviewed patch specification. Patch records contain original and
replacement byte strings, exact spans and base-body identity. **The backend still
requires the separately decoded CFG for the resulting body.** It does not guess
instruction semantics from patched bytes or execute self-modifying native code.

## Validation and limits

Seven focused synthetic tests cover a diamond, loop/backedge phi swaps, a real
mapped object/reference import, two generated same-slot code bodies, nested stack
restoration, unknown type adapters, exception cleanup, explicit BigInt
representation, and refusal of invalid dominance/phi/type/variant metadata.
Both generated example modules passed strict TypeScript checking.

Memory loads/stores, arbitrary indirect calls, native stack recovery, exceptions
inside the source CFG, floating-point/SIMD arithmetic, unrestricted self-modifying
code, and automatic unknown-type reconstruction are outside this backend. A
successful generation receipt proves neither native equivalence nor production
integration.
