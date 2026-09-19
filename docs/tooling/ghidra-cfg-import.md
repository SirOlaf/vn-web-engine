# Importing decoded Ghidra graphs

The [dedicated bridge](ghidra-bridge.md) exports decoded instructions and an ordered
HighFunction SSA graph. `tools/native-lift/ghidra-import.mjs` converts a reviewed
subset of that graph into the [CFG representation](native-cfg.md). It is a lifter,
not an x86 decoder. Raw instructions remain evidence; the legacy MCP's flattened
p-code output cannot substitute for this graph.

The importer checks the full binary identity, exact function entry, disjoint body
hashes, stable program state, address spaces, live operation order, reciprocal
edges, SSA producer identities and phi input-to-edge associations. Conditional
roles come from Ghidra's explicit
[false/true successor APIs](https://ghidra.re/ghidra_docs/api/ghidra/program/model/pcode/PcodeBlock.html).
The CFG validator then checks reachability, dominance, use order, joins and loops.

The [mapping database](native-mappings.md) supplies implementation signatures and
native register/stack bindings. The importer does not infer contracts from
TypeScript or treat Ghidra type hints as proof. Source-assertion mappings with an
unresolved ABI remain useful inventory, but cannot authorize a native graph import.
Native graph imports require explicit reviewed contracts; synthetic fixtures may
use synthetic contracts. The CLI verifies source pins before producing output.

```sh
node tools/native-lift/ghidra-cli.mjs inspect /tmp/function.json
node tools/native-lift/ghidra-cli.mjs import /tmp/function.json mappings.json plan.json /tmp/NEW-cfg.json
```

Pass the artifact path from the bridge's file receipt to these commands. The
receipt itself is a small summary, not an importable graph. Its file SHA-256
checks exact bytes; the review plan below uses the separate canonical export hash.

The import plan pins the canonical export hash shown by `inspect`:

```json
{
  "schema": "ghidra-cfg-import/v1",
  "exportSha256": "COPY_THE_INSPECTED_EXPORT_SHA256",
  "sourceKind": "reviewed-pcode",
  "reviewReference": "Path/section of the reviewed decoded function and ABI contract",
  "assumptions": [],
  "callArguments": {}
}
```

For each direct `CALL`, `callArguments` names every native parameter using the
operation's exact ID and varnode IDs, for example
`{"b0:o2":{"nativeX":"v3","nativeY":"v4"}}`. These graph-specific bindings
must account for every recovered argument; the database then defines implementation
argument order. This separates the
[decompiler's recovered call inputs](https://ghidra.re/ghidra_docs/languages/html/pcodedescription.html)
from an explicitly reviewed parameter contract.

The current importer handles integer/boolean operations, copies, same-width casts, direct
mapped calls, exact database-selected owner loads, phi nodes, conditional branches, jumps, returns and implicit block
fallthrough. Same-width signedness/representation adaptations are explicit CFG
operations. A lowering index distinguishes several generated operations that share
one original native sequence. Phi adaptations execute in predecessor blocks and
the backend assigns phi values simultaneously on the selected edge.

The `owner-load-call` lifter is the sole current memory exception. It matches an
exact body and one base-plus-constant LOAD, proves its pointer is single-use, and
replaces the address setup and load with a forced direct import. Its rule pins the
operation address/sequence, address space, offset, width, receiver and adapter
bindings. The receipt lists both consumed P-code operations. Other explicit memory
operations and RAM/stack/persistent outputs attached to ordinary copies or
arithmetic reject import. Assigned function storage, RETURN storage and CALL
result storage must match the database's explicit return ABI; an unassigned
Ghidra formal return hint may be supplied by the reviewed database contract and
is still checked against the HighFunction RETURN value.

Unmapped memory effects, floating arithmetic, indirect calls/branches, empty high blocks,
parallel edges and unbound inputs currently reject the entire function. Entry
contracts require a bijection to native inputs. The importer does not erase these
effects, infer object layouts or guess self-modifying bytes. Reviewed code/type
variant bodies can be composed in the CFG module with the backend's scoped stack
dispatch. Variants stay in an array-backed store; callees use the active stack
frame. The importer does not yet recognize patching patterns automatically.

The separate [generational address-slot analyzer](generational-address-slots.md)
can represent generic loads, stores, aliases, absolute globals, and their
reaching generations without weakening this importer's refusal boundary. An
exact reviewed whole-function route may use that artifact to call an existing
mapped implementation directly; it is not generic field-by-field lowering.

The resulting receipt pins the export, import plan, database and IR hashes and
lists explicit type/fallthrough lowerings and matched lifter/consumed-operation
receipts. Native equivalence, saved-state
persistence and game integration remain separate review claims.
