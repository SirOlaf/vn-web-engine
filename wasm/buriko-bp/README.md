# Buriko BP interpreter core

This dependency-free Rust module executes pure BP primary opcodes over the VM arena. It is built by `npm run build:wasm` into `src/engines/buriko/bp/wasm-binary.ts` and driven by `src/engines/buriko/bp/wasm-core.ts`. `docs/buriko-bp-vm.md` describes the arena, banks and provenance it relies on.

## Memory

The module imports its memory (`env.memory`). That memory is the arena of one `BurikoBpMemory`, so every region's arena offset is a wasm address. The module's statics and its 64 KiB stack occupy the arena prefix up to `__heap_base`; the arena never places regions there. The provenance bitmap sits after the arena's data area at `bitmapOffset`.

## Interface

| Export            | Purpose                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bp_control`      | Address of the `Control` block (`src/vm.rs`): thread registers, region bases and sizes, ABI parameters, run limit, and run results               |
| `bp_opcode_flags` | Address of 256 opcode flags: bit 0 enabled (wasm implements the opcode and the interpreter uses its canonical handler), bit 1 batchable          |
| `bp_call_log`     | Address of the call-site log: one 64-bit entry per call (the call site) or return (high word 1), replayed onto `thread.callSites` after each run |
| `bp_run`          | Runs the thread described by the control block                                                                                                   |

A run stops at `limit`, before an instruction it cannot complete (`STATUS_HOST`), after a nonzero handler result, or after an unbatched instruction.

## Handing instructions back

Wasm never formats an error. Each instruction logs its memory writes; when the instruction would fault or needs host state, the writes are undone, the registers restored, and the run returns `STATUS_HOST`. The TypeScript handler then executes that instruction on the same arena. Host-only conditions:

- a read or write of a byte marked indeterminate, or a pop of a tagged operand cell (the reason strings and side table live in JavaScript);
- write watches enabled, for opcodes that report watched writes;
- pooled and indirect-handle banks, a thread without a heap, and address 0;
- every native fault condition (bounds, invalid targets, frame overflow, division overflow).

## Source layout

| File         | TypeScript counterpart                             |
| ------------ | -------------------------------------------------- |
| `vm.rs`      | decoder, banks, provenance checks, stack, run loop |
| `control.rs` | `bp/opcodes/control.ts`                            |
| `integer.rs` | `bp/opcodes/integer.ts`                            |
| `memory.rs`  | `bp/opcodes/memory.ts`                             |
| `locals.rs`  | `bp/opcodes/locals.ts`                             |

Each handler follows its TypeScript handler statement by statement, including decode, pop and resolution order. `tools/differential-buriko-vm.mjs --candidate-engine wasm` compares the two per instruction.
