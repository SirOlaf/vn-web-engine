# Native-lift agent instructions

These instructions apply to `tools/native-lift/` and its descendants. Read
`docs/tooling/native-lifting-guide.md`, `docs/tooling/ghidra-cfg-import.md`, and
`docs/tooling/native-mappings.md` before changing a wire, database, IR, or lifter
contract.

## Fixed boundaries

- Use Ghidra exports as decoded input. Do not add an x86 decoder here.
- Never execute target instructions, launch the game, render media, or create a
  native crash/lifetime reproducer.
- Keep raw game exports under ignored local storage such as `targetgame/`. Commit
  metadata, hashes, synthetic fixtures, and authored contracts only.
- Treat executable hash + language + image base + RVA + body hash as identity.
  Names and similar disassembly are review hints.
- Do not infer implementation signatures by parsing or importing TypeScript.
  Add parameter types, ABI locations, argument bindings, and imports to the local
  mapping database.
- Generated code must use named imports from source-pinned implementations.
  `CALL_IMPLEMENTATION` is a forced import even when its implementation ID is the
  generated entry ID; routing it to the local generated body causes recursion.
- Keep variant alternatives in database arrays. Dispatch calls through scoped
  active stacks, restore inherited depth in `finally`, and retain trace data.
- Unsupported, ambiguous, drifting, or partially matched behavior is a refusal.
  Never drop an operation or invent a default representation.
- Run generational slot analysis before a reviewed whole-function route. A
  static write site creates a generation; loop execution is represented by CFG
  edges and reaching-generation merges, not by inventing dynamic copies.
- Canonical address expressions are immutable. Repeated expressions share an
  address slot and aliases; rebinding an address-holding register to a different
  expression creates another anonymous slot. Absolute program addresses use the
  same address-slot namespace as relative and indirect memory.
- Every address-producing `INT_ADD`, `PTRSUB`, or `PTRADD` generation must retain
  its exact parent slot and generation. Keep that derivation even when the
  resulting address canonicalizes to an existing pointee slot. `PTRADD` also
  retains element size and the constant or generation-backed index.
- Native field names, offsets, sizes, array strides, and global roots come only
  from evidence-backed `layouts` and `globals` database records. Sparse layouts
  are allowed; preserve unknown gaps. Never infer a source layout by parsing
  TypeScript or by treating JavaScript object storage as native memory.
- Run database-aware slot analysis for reviewed routes. Its source identity pins
  the complete database hash, and unmatched absolute addresses remain explicit
  `unmappedGlobals`. Keep typed slot evidence outside database-pinned evidence
  when including its hash would create a database/slot hash cycle.
- Merge generations only when the inferred or authored type explicitly supports
  safe reset and retype. Preserve alternatives for addresses and unknown types.
- `reviewed-route-cli.mjs` requires exact export and freshly recomputed slot-IR
  hashes plus a reviewed implementation/ABI mapping. It may collapse the emitted
  executable CFG to a forced direct import, but the companion slot artifact must
  retain the complete native CFG and variable generations.

## Adding a lifter

1. Capture `both` representations with `/v1/function/file`, inspect the complete
   function, and record the byte hash and canonical export hash separately.
2. Add or update the implementation/type/native ABI mapping. Pin every imported
   source by SHA-256 and use a committed metadata review for non-synthetic
   evidence.
3. Prefer a data-only rule for an existing matcher. The current
   `owner-load-call` rule lives in the database and is matched by `lifters.mjs`.
4. For a new pattern kind, add the TypeScript schema, strict database validation,
   matcher, receipt fields, and focused positive and drift/refusal tests. Match
   exact operation address and sequence as well as graph shape. Prove all
   consumed setup values are single-purpose or model their remaining uses.
5. Lower to existing typed CFG operations when possible. If a new operation is
   necessary, update `cfg.d.ts`, shape validation, type/dominance validation,
   reports, emission, and tests together.
6. Keep source locations unique. Use `loweringIndex` when one native operation
   expands to multiple IR nodes. List every consumed P-code operation in the
   import receipt.
7. Emit to a new file, run strict TypeScript checking, and inspect imports and
   call routes. A successful emitter receipt does not advance native-slot
   integration or equivalence status.

An owner-load rule must verify the exact body, one unique LOAD, address-space ID,
receiver input, constant byte offset, loaded width, producer order, and exclusive
use of the computed pointer. The replacement implementation signature and every
argument source must agree with the mapping database.

## Focused checks

Do not run the broad project test command for tooling work. Use the smallest
reviewed set relevant to the edit:

```sh
node --test tests/tooling-ghidra-cfg-import.test.mjs
node --test tests/tooling-native-cfg.test.mjs tests/tooling-native-mappings.test.mjs
node tools/native-lift/database.mjs validate tools/native-lift/mappings/aokana.json
node_modules/.bin/tsc --ignoreConfig --noEmit --strict tools/native-lift/database.d.ts tools/native-lift/cfg.d.ts tools/native-lift/ir.d.ts
```

For a live capture, also run `ghidra-cli.mjs inspect`, compare the receipt byte
hash with the file, import using an exact hash-pinned plan, emit once to a new
path, and type-check that generated file. Do not restart, close, save, or mutate
the user's Ghidra program as part of this workflow.

For a variable-bearing body, additionally write a new slot artifact with
`generational-slots-cli.mjs`, inspect unresolved addresses and unsafe merges, and
pin its canonical hash in any reviewed whole-function route plan.
