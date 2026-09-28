# BP VM WebAssembly: local profiling handoff

This is the working brief for the next session on the Buriko BP interpreter. It covers what the branch contains, what still needs an installation to validate, how to capture the profiles that should decide the next phase, and which work each profile outcome points to. `docs/buriko-bp-vm.md` is the reference for the storage model, provenance, the WebAssembly core and the differential harness; `wasm/buriko-bp/README.md` covers the Rust module.

## State of the branch

Branch `claude/tender-volta-jfe7gz`. Phases 0–4 of the BP VM WebAssembly plan are implemented.

| Phase                     | Result                                                                                                                           | Main locations                                          |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 0 Differential harness    | Generated cases for every pure primary opcode group and ABI, per-instruction digests, mutation self-test, TS-vs-wasm mode        | `tools/differential-buriko-vm.mjs`                      |
| 1 Pointer abstraction     | `BurikoBpPointer {region, offset}`; every bank is a `BurikoBpRegion`; natives resolve bytes at use                               | `bp/region.ts`, `bp/memory.ts`, all of `native/`        |
| 2 Single arena            | All regions, operand stacks and frames in one growable buffer; `memoryViews()`                                                   | `bp/region.ts` (`BurikoBpArena`)                        |
| 3 Provenance in the arena | Bitmap after the data area, sequence/reason side table, operand-cell tags                                                        | `src/core/indeterminate-memory.ts`, `bp/state.ts`       |
| 4 WebAssembly core        | Control, integer, memory, locals, fixed and native-math groups (116 opcodes) over a `WebAssembly.Memory` arena; scheduler bursts | `wasm/buriko-bp/`, `bp/wasm-core.ts`, `bp/scheduler.ts` |

### Verified without an installation

- Differential, TypeScript vs the core, per instruction: 0 mismatches for seeds 1–5 (19,152 cases each) and for 111,636 cases at `--cases 300`; the core also matches `main`'s TypeScript runtime. Deliberately broken wasm handlers are detected.
- Full test suite with the core enabled, disabled, and with the arena relocated on every allocation (stress build): identical to `main`. The cloud container fails 38 tests for environment reasons (missing `site/` build output, `/home/user/Data/*.cpk`, shader evidence JSON); a local baseline on `main` may differ.
- `tools/benchmark-buriko-vm.mjs`: final-state hashes identical; scheduled workloads through the core run about 3× faster than the TypeScript scheduler loop (Chromium, `--profile native`). A workload whose loop contains a native call is unchanged, because the call runs in TypeScript every iteration.

### Not yet validated (requires an installation)

1. Real-game behaviour with the core enabled: Aokana and 穢翼のユースティア, and any 1.665 / 1.69 title available.
2. A 6×-throttled startup trace comparable with `Trace-20260928T031055.json` (the trace the plan was written from).
3. Arena sizing: the initial reservation `BURIKO_BP_ARENA_BYTES` (1 MiB, doubling) was chosen without a measurement.
4. Differential replay of real bytecode. Out of scope until a recording format that stores only opcodes, operands and hashes is agreed (see the plan's asset-exposure constraint).

## Setup

```sh
npm ci
rustup target add wasm32-unknown-unknown     # needed only to rebuild wasm modules
npm run build:runtime                         # dist/ for tools and tests
npm run build:profile && npm run start:profile  # readable profile build at http://127.0.0.1:8001/
```

- `npm run build:wasm` rebuilds every Rust module. Toolchain versions can re-encode `src/graphics/linear-rgb-wasm-binary.ts` and `src/engines/buriko/native/bitmap-alpha-wasm-binary.ts` without source changes; restore them with `git checkout` unless those modules changed.
- Headless Chromium tools running as root need `--no-sandbox`: pass `--browser` a wrapper script that execs Chromium with that flag.

## Validation before profiling

Run these before trusting any timing:

1. **Suite, both engines.**
   - `node --test tests/*.test.mjs`
   - `node --import ./no-wasm.mjs --test tests/*.test.mjs`, where `no-wasm.mjs` imports `setBurikoBpWasmEnabled` from `dist/engines/buriko/bp/wasm-core.js` and calls it with `false`.
   - Compare the `not ok` names with a baseline run on `main`.
2. **Differential.**
   - `node tools/differential-buriko-vm.mjs --candidate-engine wasm`
   - `node tools/differential-buriko-vm.mjs --reference <main>/dist --candidate dist --candidate-engine wasm`
   - The summary's `wasmInstructions` must show the core completing instructions.
3. **Arena stress.** Relocation of the arena detaches every view; a native that holds a view across an allocation or `await` reads a detached (empty) array.
   - Copy `dist/` and edit `BurikoBpArena.allocate` in the copy's `engines/buriko/bp/region.js`. At the start of each call it transfers `this.buffer` to a same-length buffer, rebinds `this.provenance` to the new buffer and bitmap, and increments `this.generation`.
   - Run the suite with a loader that redirects `dist/` imports to that copy.
   - Detached-view failures in a real game show up as `RangeError`s or silently lost writes after a scene load. Suspect this first if the core misbehaves only after long play.
4. **Play-through, A/B.**
   - Play with the default player URL and with `?bp-wasm=0` (TypeScript only) for each title.
   - Cover boot, title, first scene, a menu, save and load, and a scene transition.
   - Any divergence between the two is a core bug. Find the instruction with the differential tool before changing handlers.

## Profiling

Profile the same reproducible interactions with `?bp-wasm=0` and without it, on the profile build. `docs/performance-profiling.md` describes both capture methods.

- **Performance diagnostics** (in-game, **Game options → Performance diagnostics**): download the timings JSON. Instruction mix, VM slices and arena growth are all in it; see "Runtime metrics" in `docs/buriko-bp-vm.md`.
- **DevTools CPU trace with 6× throttling**, summarized by `node --max-old-space-size=8192 tools/summarize-cpu-trace.mjs trace.json`. This attributes time to functions. Sampling can crash the tab; `tools/capture-browser-trace.mjs` records timeline events without sampling.

Capture at least:

| Interaction           | Why                                                                         |
| --------------------- | --------------------------------------------------------------------------- |
| Cold boot to title    | The VM-bound phase the plan measured (about 7 s of 18.7 s main-thread time) |
| Title → first scene   | Scene setup: display, text and resource natives                             |
| Ordinary text advance | Steady-state per-frame VM cost                                              |
| Save and load         | Heavy global-memory and indirect-buffer traffic                             |

From each timings JSON record:

- `accelerated-instructions / (accelerated-instructions + executor-instructions)`: the share of instructions the core runs;
- `accelerated-instructions / accelerated-runs`: instructions per run (at most 64 between clock checks for batchable code; 1 after each unbatched instruction);
- the ten largest `executor-opcode.XX` and `handback-opcode.XX` totals;
- `buriko.vm.sync-slice` total and maximum, and `budget-yields`;
- the maximum `arena-capacity` and `arena-live-bytes`.

From each CPU trace record the self time of `bp_run` (wasm), the scheduler loop, `BurikoBpWasmCore.run` (the register exchange), `interpreter.step`, and the largest native handlers.

## Choosing the next phase

Pick work by the largest remaining cost in the profiles, in this order of evidence:

| Profile shows                                                                                                                  | Next work                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `handback-opcode` totals high for memory or local opcodes (`08`, `09`, `0A`, `18`, `19`, `1F`, `E4`–`EA`, `F0`–`FB`)           | Most likely pooled or indirect-bank addresses, which the core hands back. Mirror the pool slot tables into the arena and resolve them in `vm.rs` `resolve`. The 1.72 layout has 69,908 slots, 8 bytes each, allocated lazily per pool group. `allocatePooled`, `freePooled`, `clearPooled` and indirect `createIndirect`/`replaceIndirect` update the tables. Confirm first by counting handbacks per bank. |
| Handbacks concentrated on one opcode with provenance marks present (`memory.regions.arena.indeterminateBytes` > 0 during play) | Reads of marked bytes are always host work. Check whether the marks are stale (never cleared by native writes) before moving side-table logic into wasm.                                                                                                                                                                                                                                                    |
| High `accelerated-runs` relative to instructions, and `BurikoBpWasmCore.run` self time significant                             | Per-run overhead: the control block exchange (about 30 words each way) and the 64-instruction clock budget. Options: keep registers resident in the control block between runs of the same thread, or raise the batched checkpoint interval for runs inside the core. The latter changes when host yields happen and needs a decision.                                                                      |
| `executor-opcode` totals dominated by fixed/native-math opcodes (`43`–`5F`) with runs of length 1                              | They are not batchable, so every one ends a run. Deciding to make them batchable in `interpreter.ts` changes clock-check frequency, not results.                                                                                                                                                                                                                                                            |
| `executor-opcode` dominated by native banks (`80`, `81`, `7F`, `D0`, …)                                                        | Phase 5 of the plan: batchable pure natives (group 7F, allocation, global memory, hashing, `group-81-text`). Named maps and bit arrays need their registries in the arena first. Rank candidate natives by their own `beginRuntimeSpan` totals and CPU self time.                                                                                                                                           |
| `executor-opcode` dominated by `66`–`6F`                                                                                       | Text opcodes: mirror the text mode into the control block and port `bp/opcodes/text.ts`.                                                                                                                                                                                                                                                                                                                    |
| Shared-interpreter workers (`81:48`) visible in traces                                                                         | Drive each worker's `dispatchNext` loop through `BurikoBpWasmCore.run`; actor-sensitive natives stay in TypeScript.                                                                                                                                                                                                                                                                                         |
| VM share of the trace already small                                                                                            | Stop VM work; move to the dominant non-VM cost (rendering, decoding, text layout) with its own profiles.                                                                                                                                                                                                                                                                                                    |

Also decide from the arena metrics: set `BURIKO_BP_ARENA_BYTES` to cover the title screen's `arena-live-bytes` without growth, and check the peak against 32-bit device limits.

## Rules that stay in force

- **TypeScript is the reference.** A new wasm handler mirrors its TypeScript handler statement by statement (decode, pop and resolve order included). It returns `Err(Host)` for every fault or host-only condition, and it writes memory only through `vm.store` or as the final action after all checks.
- **Add opcodes in lock-step.** Every new wasm opcode is added to `BURIKO_BP_WASM_OPCODES` in `bp/wasm-core.ts` and to `directHandlers` in `bp/interpreter.ts`. It must reach 0 mismatches with `--candidate-engine wasm` across several seeds, and a deliberately broken handler must be detected, before it is enabled. Rare numeric edge cases need a focused generator: the random harness missed a broken 0x55 power special case that a numeric stress caught.
- **No views across allocations or awaits.** Natives never keep a VM view past an allocation or an `await`; they hold pointers or regions (`docs/buriko-bp-vm.md`, "Rules for native handlers").
- **Mark order.** Provenance copies re-mark in sequence order. This differs from the old implementation only when a single-reason range is copied, partly re-marked with another reason, and then read across both.

## Known limitations

- The core hands back every pooled-bank and indirect-handle access, and every access to a thread without a heap.
- `tools/differential-buriko-vm.mjs` exercises pure primaries only; natives, text opcodes and the scheduler's burst integration are covered by the test suite and play-through, not the harness.
- The browser benchmark's direct (unscheduled) workloads measure the TypeScript interpreter only; compare `wasm-*` against `scheduled-*` cases.
