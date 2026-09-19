# Native lifting toward TypeScript

The useful architecture is a Ghidra front end feeding a project-local, typed
intermediate representation and TypeScript backend. A bounded integer lifter is
feasible now. A general x86/x64 decompiler, exact floating-point translator, or
automatic substitute for owner-aware service reconstruction is a much larger
project. Keep lifting tools outside the browser runtime.

The runnable prototypes are in `tools/native-lift/`. The current path is the
[dedicated Ghidra bridge](ghidra-bridge.md), [reviewed graph importer](ghidra-cfg-import.md),
[explicit mapping database](native-mappings.md), and [CFG v2 backend](native-cfg.md).
It has been exercised with actual Ghidra exports of invented functions. This
document retains the original feasibility investigation and **v1 leaf** contract;
v2 adds direct implementation imports, rich control flow and scoped variant stacks.

The original v1 prototype establishes address identity,
integer-width semantics, traceable output, and reviewed replacement routes. It
does **not** ingest arbitrary executables or automatically translate current MCP
P-code dumps. The first bounded live route now accepts Aokana `0x140095bb0` through
an exact owner-load rule and emits a direct implementation import; see the
[hands-on guide](native-lifting-guide.md). This is one accessor contract, not a
general memory model.

## Front-end choice

| Approach                                    | Reuse                                                                                   | Work still needed here                                                                                            | Recommendation                                           |
| ------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Ghidra export + local IR/backend            | SLEIGH instruction semantics, existing function boundaries, symbols, types and analysis | Versioned export, import validation, ABI contracts, memory model, TS generation and evidence gates                | Start here                                               |
| Ghidra plugin containing the entire backend | Same analysis and immediate UI access                                                   | Java-side compiler, tighter release/install coupling, weaker access to project tooling                            | Keep only the exporter in Ghidra                         |
| Standalone x86 decoder + new semantics      | Independent decoding and deployment                                                     | Semantics, register aliases, flags, CFG recovery, ABI, memory, exception behavior and every unsupported extension | Defer                                                    |
| Existing LLVM-based lifting stack           | Established instruction semantics                                                       | New dependency/build stack and LLVM-to-project-IR integration                                                     | Revisit if Ghidra export becomes the measured bottleneck |

Ghidra's SLEIGH describes instruction decoding and translation into P-code, so
using it avoids designing both a decoder and a semantic instruction model.
[Ghidra language documentation](https://ghidra.re/ghidra_docs/languages/index.html)
`Instruction.getPcode()` exposes raw instruction operations; its overload can
include flow overrides, which must be an explicit export setting.
[Instruction API](https://ghidra.re/ghidra_docs/api/ghidra/program/model/listing/Instruction.html)

A decoder is not a full lifting solution. Zydis provides x86/x64 decoding and
encoding, while Remill explicitly provides instruction translation into LLVM
bitcode. Adopting either introduces work and dependencies absent from this session.
The table's recommendation is an architectural inference from those different
interfaces and this repository's existing Ghidra evidence.
[Zydis](https://github.com/zyantific/zydis),
[Remill](https://github.com/lifting-bits/remill)

Do not use decompiled C text as the primary IR. Formatting, inferred types,
temporary names and simplifications are useful to reviewers but do not constitute
an execution contract. Keep raw instruction P-code and analyzed HighFunction
P-code as separate export kinds with separate importers.

## What the installed MCP actually exports

On 2026-09-19, read-only `get_current_program_info` and `get_program_options`
confirmed `/aokana.exe`, `x86:LE:64:default`, image base `0x140000000`, and SHA-256
`f585e28f79923b8aa487d8690165e45ce3377c7e1b8381d3b75c659c7e933d7a`.
The program reports creation with Ghidra 12.1.3; the installed extension archive is
GhidraMCP 6.0.0. This was tool capability research, not function acceptance.

The complete inspected function was `0x140095bb0..0x140095bb4`, named
`AokanaParticle_ReadPrimaryFrameIndex`. Exact-address lookup and full disassembly
returned only `MOVZX EAX,word ptr [RCX + 0x26]` and `RET`.
`get_function_pcode(granularity="high", program="/aokana.exe")` returned:

- Block order: `INT_ADD`, `CAST`, `LOAD`, `COPY`, `RETURN`.
- `high_pcodes` order: `INT_ADD`, `LOAD`, `COPY`, `CAST`, `RETURN`.
- The `LOAD` uses the value produced by `CAST`, so the second list must not be
  executed in its returned order.
- The block list contains `CAST`; despite the tool's “low” description, this
  observed list is not raw instruction P-code.
- Varnodes contain storage space/offset/size but no unique SSA ID or input marker.
  Sequence records contain an address but no time/order; blocks have no edges.
  The result has no executable hash, schema/exporter version, ABI contract or
  address-space ID table for the `LOAD` space constant.

Ghidra documents `CAST` as an analysis-added operation, distinct from raw P-code.
[Additional P-code operations](https://ghidra.re/ghidra_docs/languages/html/additionalpcode.html)
Its whole-function iterator includes live and dead operations in sequence-number
order; that is not a block execution ordering guarantee.
[PcodeSyntaxTree API](https://ghidra.re/ghidra_docs/api/ghidra/program/model/pcode/PcodeSyntaxTree.html)
`getTime()` distinguishes operations at one instruction, while `getOrder()`
describes their position within a block. Export both, plus an explicit ordered
live-operation list.
[SequenceNumber API](https://ghidra.re/ghidra_docs/api/ghidra/program/model/pcode/SequenceNumber.html)
Export `VarnodeAST.getUniqueId()` and `isInput()` rather than treating register
offsets as SSA identities.
[VarnodeAST API](https://ghidra.re/ghidra_docs/api/ghidra/program/model/pcode/VarnodeAST.html)

`inspect-pcode` inventories a parsed current MCP result and reports these import
blockers. It never labels a dump executable merely because its opcodes look
familiar. No Ghidra state was changed and no native code was executed.

## Original v1 leaf contract and use

```sh
node tools/native-lift/cli.mjs check tools/native-lift/examples/leaf.json
node tools/native-lift/cli.mjs emit tools/native-lift/examples/leaf.json
node tools/native-lift/cli.mjs emit tools/native-lift/examples/leaf.json tools/native-lift/examples/registry.json
node tools/native-lift/cli.mjs inspect-pcode /path/to/parsed-pcode-result.json
node --test tests/tooling-native-lift.test.mjs
```

`emit` writes TypeScript to stdout only after validation succeeds. Failure writes
a structured diagnostic to stderr and exits nonzero. `check` reports schema,
route and opcode eligibility; it does not verify implementation files or native
evidence. `emit` additionally verifies the selected implementation's source hash.
All bundled examples are synthetic and are labeled as such. The core `.mjs`
tools use only Node built-ins; tests also require Node's `stripTypeScriptTypes`
(validated with the workspace's Node 26.8.2).

`ir.d.ts` defines the representation. Its strict schema admits pure, straight-line
leaves with explicit parameters, SSA values, typed constants and one result. Every
operation carries an address and sequence. It rejects unknown fields, forward or
duplicate definitions, invalid widths, out-of-body provenance and unsupported
operations. There is no implicit memory, control flow, flag state, call or exception
channel.

Supported widths are 8, 16, 32 and 64 bits. Supported operations are copy/cast,
add/subtract/multiply, integer negate/complement, bitwise and/or/xor, signed and
unsigned comparisons, zero/sign extension, three shifts, piece and subpiece.
Boolean comparison results occupy 8 bits. Other operations—including division,
carry flags, memory, calls, branches, phi nodes, floating point, SIMD and
`CALLOTHER`—refuse emission unless an exact reviewed whole-function hand route
replaces the leaf.

Values are unsigned bit patterns represented as BigInt. Every assignment truncates
to its declared width; signed operations explicitly reinterpret the bits. Shift
counts at or above the operand width yield zero or sign fill, rather than masking
the count like JavaScript number shifts. These follow the supported P-code integer
operators; x86-specific shift masking belongs in upstream instruction semantics.
[P-code operation reference](https://ghidra.re/ghidra_docs/languages/html/pcodedescription.html)
The backend uses standardized `BigInt.asUintN`/`asIntN` for finite-width conversion.
[ECMAScript BigInt specification](https://tc39.es/ecma262/multipage/numbers-and-dates.html#sec-bigint.asuintn)

Generated modules export `lifted(inputs, implementations)` and `liftReceipt`.
No implementation module is automatically imported or executed. The host must
bind the reviewed implementation explicitly, using the declared ID and the
unsigned-BigInt input/result convention. Source hash validation does not prove
that the host supplied that same function; binding review remains necessary.
`sourcePath` is relative to the CLI working directory, and paths resolving outside
that directory are refused.

## Address slots, versions, and progressive routes

Binary identity is `{programPath, executableSha256, languageId, imageBase}`.
Addresses are canonical lowercase `0x` strings and use BigInt internally. A slot
key is `SHA256:languageId:rva:0x...`; a function name is only a label. The entry,
full ordered inclusive body ranges, body hash, source-export hash, review reference
and assumptions survive in generated receipts. `bodySha256` means SHA-256 of full
body bytes concatenated in ascending range order, compatible with the separate
Ghidra ledger. The prototype records these evidence assertions; it does not read
the executable or independently verify a supplied native body hash.

Route precedence is explicit:

1. An exact address route can block generation or select a hand implementation.
2. A structural pattern may select a hand implementation only after its
   `approvedTargets` contains that exact binary, address, body hash and IR hash.
3. Otherwise the supported integer backend emits the leaf; structural matches are
   reported as unapproved candidates.

Any stale target or ambiguous active route refuses generation. Exact routes take
precedence over patterns. Hand routes pin source bytes, export name and review
reference. Pattern fingerprints normalize value names and omit addresses while
retaining constants, widths and graph connectivity. They are candidate-finding
keys, not proofs of equivalence. New executable versions require new explicit
target approval even when their fingerprint matches. The prototype does not
implement arbitrary graph rewriting or intra-function replacement yet.

This fits the 840-slot manifest without conflating it with semantic lifting:
manifest entries can reference the native slot key and generated receipt, but
source presence, native evidence, focused validation and aggregate integration
remain separate states. A successful emitter run must not increment integrated
coverage or make a shared-owner identity claim.

## Useful next implementation slices

1. Add a read-only versioned exporter to the Ghidra bridge or a project-local
   Ghidra script. Export raw instruction operations separately from HighFunction
   blocks; include instruction bytes, complete body ranges/hash, export settings,
   language/compiler versions, SSA IDs, ordered live operations, edges, memory
   spaces, register aliases, ABI evidence and full executable identity. Keep raw
   evidence immutable and hash it before normalization. Keep any extracted native
   bytes in local evidence storage outside source control; commit metadata and
   hashes rather than game code bytes.
2. Continue importing reviewed HighFunction leaves with explicit
   input/return bindings. Use a genuine exact-body ledger receipt and compare the
   emitted result to a separately written integer reference on ordinary synthetic
   inputs. Reject every memory or analysis effect the importer cannot explain.
   The `095bb0` memory getter is now the first narrow owner-load route: its exact
   body/operation/space/offset/width maps to an existing implementation adapter.
3. Expand memory reads only through typed address spaces and ownership adapters.
   Native addresses must resolve through per-title owner mappings; a JavaScript
   number or ad hoc array cannot silently stand in for the engine's object graph.
   A raw importer additionally needs overlapping register storage, x86 write-width
   behavior, flags and reviewed calling-convention semantics.
4. Add CFG blocks, explicit terminators and phi inputs bound to predecessor edges.
   Start with acyclic integer branches and conservative structured/state-machine
   output. Add direct calls through the exact registry with explicit effects and
   ABI contracts. Indirect calls require finite reviewed target sets or refusal.
5. Add reviewed graph-pattern rewrites and per-version candidate reports. Keep
   exact approval and semantic evidence gates even after recognition improves.

Floating-point/SSE2 support needs a separate precision and rounding model. This
prototype does not solve the pending `023710` power implementation or establish
that JavaScript `Math.pow` matches it. Browser execution, performance work, service
startup integration and cross-version semantic validation are also future work.

Validation completed for this slice: eight focused synthetic deterministic tests
passed; generated integer and hand-route TypeScript plus `ir.d.ts` passed strict
TypeScript 7.0.2 checking. There were no game launches, native probes, media runs,
screenshots or broad test suites.
