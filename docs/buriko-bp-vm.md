# Buriko BP VM storage and differential validation

This document describes how BP bytecode addresses resolve to storage, the rules native handlers follow when they touch VM memory, and the differential harness that validates interpreter changes. The interpreter lives in `src/engines/buriko/bp/`; native handlers live in `src/engines/buriko/native/`.

## Addresses, banks and regions

A BP address is `bank << addressBits | offset`. The ABI descriptor (`bp/abi.ts`) supplies `addressBits` and the bank tags per engine revision (1.685.3, 1.665, 1.520.6). `BurikoBpMemory.resolve(thread, address)` maps an address to a `BurikoBpPointer`:

| Bank                       | Storage                                   | Owner                                        |
| -------------------------- | ----------------------------------------- | -------------------------------------------- |
| 0                          | Global data bank                          | `memory.globalRegion`                        |
| 0, `0x0fffS0xx` (1.72 ABI) | Indirect buffer (S = 0) or string (S = 1) | `memory.indirectBanks[S][xx].region`         |
| 1                          | Module (code and module data)             | `thread.moduleRegion`                        |
| 2                          | Frames and locals                         | `thread.frameRegion`                         |
| 3                          | Thread heap                               | `thread.heap.region`                         |
| Pool banks                 | Pooled allocations                        | `memory.pools[group][slot]` (layout per ABI) |
| (not addressable)          | Operand stack cells                       | `thread.stackRegion`                         |

Every bank resolves to a `BurikoBpRegion` (`bp/region.ts`): one contiguous allocation with a fixed size. Addresses stay bank-relative, so replacing a bank's region never changes a VM address.

`BurikoBpRegionTable` (`memory.regions`) creates, relocates and retires every bank region. Threads receive the table through the `regions` constructor option; production threads, shared threads included, use the table of the memory they run against. A thread created without one owns a private table.

### The arena

Each region table places its regions in one `BurikoBpArena`: a single `ArrayBuffer`, allocated first fit at 16-byte aligned offsets. Allocation zero-fills its range and clears its provenance marks.

- **Growth:** when no free block fits, the arena doubles its capacity and reallocates the buffer (`ArrayBuffer.prototype.transfer` where available, which detaches the previous buffer). `arena.generation` advances. Provenance marks move to the new buffer at the same offsets.
- **Views:** `region.view()` and `region.view32()` re-derive their typed array when the generation has changed. A view obtained before a growth is detached (length 0) or stale, which is why natives never hold views across allocations or awaits.
- **Whole-arena access:** `memory.memoryViews()` returns `{bytes, words, generation}` over the entire arena. `region.arenaOffset` is a region's byte offset in it. These are the addresses a WebAssembly module sharing the arena would use.
- **Sizing:** `BurikoBpMemory` reserves `BURIKO_BP_ARENA_BYTES` (1 MiB) initially; the third constructor argument overrides it. Private thread tables start at 4 KiB. `regions.liveBytes` and `arena.capacity` report use for measuring a real title's footprint.
- **Adopted bytes:** `regions.adopt(bytes)` and the `BurikoBpMemory` constructor copy their input into the arena. The caller's array is not the live bank afterwards; read `memory.globalMemory` instead.
- **Buffer identity:** all views of one arena share one `buffer`. Code comparing `a.buffer === b.buffer` must treat that as possible aliasing and compare absolute ranges through `byteOffset`, and code building a `DataView` or typed array from a view must pass its `byteOffset` and `byteLength` (`byteDataView` in `src/core/binary.ts`).

### Relocation and stale pointers

A region never grows. Operations that resize or free storage install a successor region and retire the old one:

- heap growth (`BurikoBpHeap.allocate`), which copies the old contents with provenance;
- `resizeGlobal`, which installs a zeroed arena;
- indirect `resizeBuffer`, `insertBuffer`, `insertStringBytes`, `clearString` and `freeIndirect`;
- `freePooled` and `clearPooled`;
- thread and heap disposal.

A retired region keeps its final bytes: retiring copies them out of the arena into a private array before the arena range is freed for reuse. A pointer resolved before the relocation still reads and writes the retired storage, matching native reads through a stale pointer into freed memory. `region.retired` reports whether that has happened.

## Pointers

`BurikoBpPointer` is `{region, offset}`:

- `view()` returns the region's bytes. `offset` indexes into them.
- `add(n)` performs pointer arithmetic within the same allocation.
- `hostPointer(bytes, offset)` wraps host-owned bytes (decoder output, file data, scratch buffers, constants) that are not VM banks. Two host pointers over the same array have distinct regions, so buffer identity is compared through `view().buffer`, not `region`.
- `codecPrivatePointer(bytes, initialized, offset)` (`native/codec-storage.ts`) adds a validity bitmap for codec-private storage.

### Rules for native handlers

1. Resolve bytes at use. A view obtained inside one synchronous handler is valid until that handler returns or allocates VM storage.
2. State kept across calls, awaits, process ticks or callbacks holds the pointer or region, never a view. Re-acquire the view after every `await`.
3. Use `pointerView` (bounds-checked `DataView` with provenance) or the helpers in `bp/opcodes/operands.ts` and `native/text.ts` for access; they apply the provenance checks described below.

Rule 2 matters because of arena growth: any VM allocation, on any thread, can move every region.

## Provenance

Bytes that native code leaves unwritten carry an "indeterminate" mark (`src/core/indeterminate-memory.ts`), keyed by buffer and absolute byte offset. Reading a marked byte raises the reason recorded when it was marked; the earliest mark among the covered bytes selects the message. Writes clear marks, and `copyMemoryBytes` moves them with the data. Operand stack cells carry the same provenance through `pushIndeterminate32` and `popDeferred32` in `bp/state.ts`.

## Differential harness

`tools/differential-buriko-vm.mjs` (`npm run differential`) compares two compiled runtimes on generated cases for every pure primary opcode group: control, integer, memory, locals, fixed, native math, write watch, and the 1.69 and 1.665 legacy overrides.

Each case seeds a thread (module, frame and heap banks), the global arena, two pooled allocations, indirect handles on the 1.72 ABI, provenance marks, indeterminate operand cells and an optional write watch. It then runs one instruction, or a burst of up to 16 pure instructions for the burst cases. After every instruction it digests:

- status: `ok`, `result n`, `fault` with its message, `yield-host` for an opcode outside the pure groups, or `unbounded` for an element-count loop whose count exceeds the work limit;
- `pc`, instruction start, stack index, frame cursor and call sites;
- all operand stack cells and their provenance;
- a hash and the provenance marks of every bank, pool and indirect region;
- write-watch state and reports.

```sh
npm run build:runtime
node tools/differential-buriko-vm.mjs --reference /path/to/baseline/dist --candidate dist
node tools/differential-buriko-vm.mjs --self-test
node tools/differential-buriko-vm.mjs --record /tmp/vm.json
node tools/differential-buriko-vm.mjs --compare /tmp/vm.json
```

| Option                   | Effect                                                                  |
| ------------------------ | ----------------------------------------------------------------------- |
| `--reference DIR`        | Reference runtime root (default `dist`)                                 |
| `--candidate DIR`        | Candidate runtime root (default: the reference)                         |
| `--abi LIST`             | Comma list of `1.72`, `1.665`, `1.69` (default all)                     |
| `--cases N`              | Single-instruction cases per opcode and ABI (default 48)                |
| `--bursts N`             | Multi-instruction cases per ABI (default 512)                           |
| `--seed N`               | Generator seed (default 1)                                              |
| `--record` / `--compare` | Write or check per-case digest hashes of the candidate                  |
| `--break GROUP`          | Corrupt the lowest opcode of one group in the candidate                 |
| `--self-test`            | Corrupt each group in turn; exits non-zero unless every one is detected |
| `--verbose`              | Print every mismatching case instead of the first per opcode            |

A mismatch prints the case, the instruction index and the first differing digest line from each runtime. The exit status is non-zero when any case differs.

The harness does not yet replay recorded startup bytecode. That requires a recording format that stores only opcodes, operands and hashes, so that no asset content leaves an installation.
