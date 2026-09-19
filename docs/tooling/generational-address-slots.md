# Generational address slots

`tools/native-lift/generational-slots.mjs` lifts a validated normalized Ghidra
HighFunction into a variable and memory-state IR. Ghidra still performs decoding.
This stage assigns stable address identities, local storage identities, write
generations, aliases, reaching memory states, and control-flow joins.

Run it against a direct-to-file bridge export:

```sh
node tools/native-lift/generational-slots-cli.mjs analyze \
  targetgame/aokana-lifting/evidence/function.json \
  tools/native-lift/mappings/aokana.json \
  targetgame/aokana-lifting/work/NEW-function.slots.json
```

The output path uses exclusive creation. The command writes the full IR to that
file and prints only a compact receipt containing the canonical input/output
hashes and counts. Raw exports and generated IR stay under ignored local storage.
Omit the database argument only for an explicitly untyped exploratory analysis.
Reviewed routes always recompute the database-aware form and bind the slot
artifact to the database SHA-256.

## Slot identity

Anonymous slots use a deterministic incrementing allocator. Parameters are
allocated first in the HighFunction input order. Local and register slots then
use storage identity. A write to an existing storage slot creates another
generation. A pointer-bearing register also includes its symbolic address in its
storage key, so rebinding the same register to a different address creates a new
anonymous slot.

Address slots have one immutable canonical address expression:

- `program` identifies an absolute address in a named program address space;
- `relative` identifies a constant byte offset from a parameter or another
  canonical address expression;
- `indirect` identifies the pointee loaded from a canonical address slot; and
- `anonymous` preserves an unresolved pointee identity instead of guessing.

Repeated calculations of the same expression reuse one address slot. Distinct
register generations can therefore list the same address slot in `pointsTo`, and
the target slot records both as aliases. Address-tied High P-code values use the
same mechanism: all SSA names for `ram:0x140189b40`, for example, share one
program-space slot and one generation sequence.

Generation zero is the memory value entering the function. Each static write
site receives the next generation. A write inside a loop still has one static
generation; repeated runtime executions of that definition are represented by
the loop edge and its reaching-generation merge. Local HighFunction outputs also
receive a generation for every SSA definition.

## Derived slots

An address-producing operation creates a `derived` slot generation. For
`INT_ADD base, constant` (the High P-code form commonly produced for an x86
`lea`), the generation stores the exact parent `{slotId, generationId}`, the
producing P-code operation, the signed byte offset, and the database-backed type
projection when one is known.

`PTRADD` additionally stores its element size and either a constant index or the
slot/generation that supplies a dynamic index. The resulting address still uses
the ordinary canonical `pointsTo` slot. Two register values can therefore point
to the same address while retaining different derivation histories. A later
semantic lifter can recognize a field access or iterator without discarding
alias identity or generation order.

## Types, layouts, and merges

The analyzer infers fixed-width bitvectors, booleans, floating values, addresses,
and unknown values from storage width, operations, and address use. With a
mapping database it also attaches authored `semanticType` and `mapping` values.
The mapping is a path from a native parameter or global root through struct
fields, array elements, and dereferences. Each field step retains its byte
offset, byte size, storage mode, owner layout, and type. The analyzer does not
parse TypeScript to obtain those facts.

Absolute program addresses use the same projection mechanism. A `globals`
database record ties an exact binary-qualified address to a native type and an
implementation-owned root/path. An address inside a mapped array advances
through the recorded element stride. Program slots without a global root appear
in `unmappedGlobals` so the type tree can be extended deliberately.

Bitvectors, booleans, and floats explicitly support safe reset and retype.
Addresses and unknown values do not.

`MULTIEQUAL` nodes and memory-state joins record all incoming generations. A
single result generation is valid only when every incoming type agrees and the
type advertises `safeResetAndRetype: true`. Otherwise `result` is `null`, the
incoming generation set remains visible, and downstream work must add an
authored type rule or refuse the semantic lift. Address identity is never merged
through the scalar reset rule.

The IR carries the original block IDs, predecessor/successor edge records,
conditional targets, and ordered operation IDs. Access records attach each load
and store to a block, operation, address slot, and exact reaching generation set.
This preserves the native control-flow graph even when a reviewed semantic route
later emits one direct call to an existing implementation.

## Reviewed whole-function routes

When a complete native body has an existing reviewed implementation, use an
exact route plan after generating the slot IR:

```json
{
  "schema": "reviewed-generational-route/v1",
  "exportSha256": "CANONICAL_EXPORT_HASH",
  "slotIrSha256": "GENERATIONAL_SLOT_IR_HASH",
  "sourceKind": "reviewed-pcode",
  "reviewReference": "docs/tooling/evidence/review.md",
  "assumptions": ["State the reviewed semantic domain."]
}
```

```sh
node tools/native-lift/reviewed-route-cli.mjs import \
  export.json tools/native-lift/mappings/aokana.json plan.json NEW-route.cfg.json

node tools/native-lift/cfg-cli.mjs emit \
  NEW-route.cfg.json tools/native-lift/mappings/aokana.json NEW-lifted.ts
```

The route re-runs the slot analysis and refuses an export or slot hash mismatch.
It also requires a reviewed mapping-database implementation, explicit ABI,
bijection from recovered native inputs to implementation parameters, and matching
return storage. The generated CFG uses `CALL_IMPLEMENTATION`, which forces a
named import even when the mapped implementation is also the generated entry.
This avoids recursive routing and makes the existing implementation visible in
the generated TypeScript.

## Current live example

Aokana `0x140095be0` (`AokanaParticle_Advance`) is the first live typed generational
route. Its HighFunction has eight blocks, 34 operations, three explicit phis,
four memory writes, and two loops. The original v1 slot IR had 18 anonymous
slots. V2 classifies seven of those as derived, leaving 11 ordinary anonymous
slots plus nine address slots. It retains 57 generations and six safe merges;
16 slots and all 14 memory accesses have native type projections.
Repeated `particle + 0x24` and `particle + 0x28` computations alias their
respective field slots. The `images` load creates an address-valued generation,
and its pointee is a separate indirect slot. The typed path folds that indirect
four-byte load to `particle.images -> dereference -> count`.

The exact reviewed route imports `advanceParticle`, whose adapter directly calls
the existing `AokanaParticle.update()` method. See
[`evidence/aokana-095be0.md`](evidence/aokana-095be0.md) for hashes, the recovered
layout, and the semantic contract. The database-aware artifact is recorded in
[`evidence/aokana-095be0-typed-slots.md`](evidence/aokana-095be0-typed-slots.md).

## Boundaries

This IR is an analysis and routing prerequisite. It does not by itself emit
field-by-field TypeScript, recover ownership, prove native equivalence, or infer
source-level field names. Pointer arithmetic currently recognizes constants,
copies/casts, `INT_ADD`, `PTRSUB`, `PTRADD`, phis with identical expressions, and
pointers loaded from known slots. Variable `PTRADD` indices retain their
generation even when the final concrete address is unknown. Other pointer
expressions become explicit anonymous address slots. A reviewed route can only
replace a whole body when the mapping database and exact export/slot hashes
authorize that replacement.
