# Performance diagnostics

Use **Game options → Performance diagnostics** first when DevTools CPU sampling crashes the tab. Click **Start recording** immediately before a slow story or character transition, reproduce the delay, click **Stop recording**, then **Download timings JSON**. Keep DevTools Performance recording closed during this capture. These measurements describe elapsed wall time in instrumented operations, long tasks, and event-loop delay; they are not CPU samples or a JavaScript call tree. Time spent awaiting a worker, decoding, or I/O can contribute to an operation's elapsed time. Nested operations overlap, so their durations must not be added together as independent costs.

This recorder is opt-in and keeps results in memory. Starting another recording replaces the previous one; reloading loses it, so download before reloading. The JSON includes category aggregates, spans lasting at least 4 ms (16 ms for outer frame and scheduler events; 8 ms for sprite drawing), long tasks when the browser supports observation, and delays of at least 16 ms on a 100 ms event-loop timer. All completed spans contribute to aggregates even below their event threshold. It retains at most 2,048 events and 128 aggregate categories, reporting overwritten events and overflowed category samples. Background throttling also delays timers; keep the tab visible and use the recorded visibility changes when interpreting stalls. The `runtimeProfiles` field lists the profiles selected during the recording. Bundled players also include a `buildId` matching the identifier shown in Performance diagnostics; direct runtime modules report `null`. No pixel data, asset paths, or sampled stacks are included.

Take a short capture around one reproducible interaction. Include the browser version, game, action, and whether it was the first run or a repeat with the downloaded file. A complete JSON export is more useful than a screenshot of the display. Neither this workflow nor the trace recorder requires game screenshots; do not enable screenshot recording or capture game-image pixels.

## Runtime timing categories

The recorder lives in `src/platform/runtime-performance.ts`; instrumentation uses fixed technical names and numeric dimensions, never resource names or game text. Recording is disabled by default. BGI currently records these boundaries:

| Category                                                             | What the duration includes                                                                                                                    |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `buriko.frame` / `buriko.vm.scheduler`                               | Outer frame or native BP traversal, including waits and scheduling points                                                                     |
| `buriko.vm.sync-slice`                                               | BP instructions between awaits or host yields, with an instruction count                                                                      |
| `buriko.vm.shared-worker` / `buriko.vm.shared-slice`                 | Shared child lifetime, or work between explicit Promise/host waits; slices include numeric-await microtasks and report dispatch counts        |
| `buriko.native.sync`                                                 | Native handler invocation before it returns a result or Promise, with numeric primary/secondary opcode IDs                                    |
| `buriko.native.async-elapsed`                                        | Returned native Promise through settlement; includes resumed CPU work as well as waits                                                        |
| `buriko.process.poll-sync` / `buriko.process.finish`                 | Process poll invocation, or completion and disposal                                                                                           |
| `buriko.process.poll-async-elapsed`                                  | Returned process Promise through settlement, before completion and disposal                                                                   |
| `buriko.text.advance` / `buriko.text.emit`                           | Synchronous base-message advancement or prepared-message emission                                                                             |
| `buriko.sprite.draw.*`                                               | One synchronous sprite draw, grouped by selected drawing mode; slow events include dimensions and effect flags                                |
| `buriko.sprite.mipmaps` / `buriko.sprite.mix` / `buriko.sprite.wave` | Sprite mipmap regeneration, cached source mixing, or wave generation, with numeric dimensions and parameters                                  |
| `buriko.text.prepare`                                                | Extended-message preparation, including readings and layout                                                                                   |
| `buriko.text.prepare.build` / `.readings` / `.align`                 | Separate layout, reading, and alignment phases of extended-message preparation                                                                |
| `buriko.text.layout.measure` / `.glyph-draw` / `.annotation-match`   | Drawing-backed measurement, prepared glyph drawing, or suffix encoding and annotation lookup; numeric UTF-16 lengths only                     |
| `buriko.text.glyph.raster` / `.copy`                                 | Glyph cache lookup or rasterization and coverage reduction, followed by coverage-to-bitmap copying; numeric font settings and dimensions only |
| `buriko.bmv.decode` / `buriko.bf.decode`                             | Animation I/O and decode, or the BF decode alone, including host yields                                                                       |
| `buriko.decode.dsc`                                                  | Synchronous DSC decoding                                                                                                                      |
| `buriko.decode.cbg-legacy`                                           | Legacy CBG decoding, including cooperative host waits                                                                                         |
| `buriko.decode.cbg.entropy` / `.runs` / `.predictor`                 | Legacy prefix decoding, run expansion, and pixel reconstruction, including host waits                                                         |
| `buriko.decode.cbg-v2`                                               | CBG v2 decoding, including distributed work and waits                                                                                         |
| `buriko.codec.queue-wait` / `buriko.codec.worker.*`                  | Timer queue delay, or a decode/encode/struct-encode worker's elapsed lifetime, including waits                                                |
| `buriko.bitmap.register-import` / `.register-cache`                  | Completed bitmap worker's surface import, followed by preload/cache insertion and validity checks                                             |
| `buriko.bitmap.composite`                                            | Surface-table composition, with numeric source dimensions, source/destination formats, mode, and opacity                                      |
| `buriko.grid.worker`                                                 | One synchronous logical-grid worker callback, with numeric operation and status                                                               |
| `host.cooperative.slice`                                             | An uninterrupted segment of a cooperative computation                                                                                         |
| `buriko.display.draw-*`                                              | Synchronous composition before presentation                                                                                                   |
| `buriko.display.present`                                             | Preparation, browser presentation/wait, inline paint, and child invalidation                                                                  |
| `buriko.loader.job`                                                  | One iteration of the resource/audio/script loader                                                                                             |
| `buriko.audio.refill` / `buriko.audio.command.*`                     | Streaming refill or a command's browser audio acknowledgement                                                                                 |
| `source.local-read` / `source.remote-read`                           | A shared Blob or HTTP range read, including its asynchronous wait but excluding subsequent decoding                                           |
| `buriko.file.read` / `buriko.file.native-read`                       | Program-file or native-file read boundaries, including the underlying source wait                                                             |
| `buriko.file.read-copy` / `buriko.file.output-preload`               | Synchronous native destination copy, or whole-file read and copy for preserving an existing output file                                       |
| `storage.idb.transaction`                                            | Complete IndexedDB transaction, including queueing, cursor delivery, synchronous processing, and commit                                       |
| `storage.idb.cursor-sync` / `storage.idb.apply-copy-sync`            | One cursor callback's synchronous read, or update callback and its two defensive copies                                                       |
| `storage.idb.compare-sync`                                           | Synchronous comparison of updated records and enqueueing changed writes/deletes                                                               |

Compare slow spans with overlapping `browser.long-task` events and event-loop delays. A long decode with short cooperative slices and prompt audio acknowledgements differs from an uninterrupted composition stall. A frame can also remain slow when several short tasks and waits precede presentation: cooperative budgets bound individual work segments, not complete frame latency. The recorder cannot attribute a browser crash to the last operation it observed, and a completed-span recording is lost if the renderer crashes before export.

Presentation has separate stages inside `buriko.display.present`: `buriko.display.prepare` covers native texture preparation and software rasterization; `buriko.display.vsync-wait` covers an enabled animation-frame wait; `buriko.display.after-present` covers inline painting and child invalidation. The shared `graphics.canvas.upload` span measures the synchronous `putImageData` call and excludes unchanged frames skipped by the presenter. Its `.pixels` metric counts requested full-frame or damage-region pixels, not elapsed time or browser GPU completion.

Shared selectable-text diagnostics use `text.presentation.dom-mode` to count render requests (1 for DOM mode, 0 for native mode). `text.presentation.dom` covers the DOM-mode presentation, including `text.presentation.base` for alternate-frame creation and `text.presentation.overlay` for background upload and glyph slots. Native mode keeps the lazy frame recipe and does not evaluate it. Compare these nested spans with the outer presentation duration without adding them twice. Dimensions, dirty area, and glyph counts are numeric; no text or pixels are recorded.

For a scheduler stall, first find overlapping `buriko.native.sync`, process, and text events. Convert native event `primary` and `secondary` numbers to hexadecimal and locate the slot in `src/engines/buriko/native/inventory*.ts` and the corresponding `group-*` factory. Opcode details are retained on slow events, while aggregates group native calls together to avoid one category per opcode. A short native invocation with a long `async-elapsed` interval does not prove I/O is slow: shared interpretation and asynchronous continuations can perform CPU work during that interval. If native calls are individually short, inspect interpreter slices for accumulated instruction work. An audio refill duration begins when its callback runs; delayed callback delivery can starve audio without producing a long refill span.

`src/core/host-task-budget.ts` provides a 4 ms default cooperative budget. Its checkpoints yield through a host task, allowing timers and audio messages to run. The BF decoder shares one budget across coefficient, alpha, and reconstruction steps; the BP scheduler checks after each continuing instruction and process poll while retaining native burst counts and child order. Shared interpreters also check between instructions and carry one budget across the indexed workers, preserving numeric-result microtask ordering and child actor ownership. This is a scheduling target, not preemption: allocation, garbage collection, synchronous rendering, and any individual step can exceed the budget. Extend checkpoints only where borrowed storage, native actor identity, and callback order remain valid.

The shared yield posts a `MessageChannel` task which closes its ports and schedules the continuation with a zero-delay timer. Scheduling that timer from a non-timer task resets the [HTML timer nesting level](https://html.spec.whatwg.org/multipage/timers-and-user-prompts.html#timer-initialisation-steps), avoiding the minimum 4 ms delay accumulated by repeated timer yields. The continuation remains an ordinary timer task. Hosts without `MessageChannel` retain the direct timer fallback. This mechanism is shared by cooperative decoders and interpreters; engine code should reuse it.

Text preparation's phase spans locate work under the outer `buriko.text.prepare` interval. Measurement includes its scratch allocation and all glyph drawing used to determine extents. `glyph-draw` measures the prepared node's glyph draw separately; it does not include measurement's glyph draws. `annotation-match` includes encoding the remaining UTF-16 suffix and matching readings. The span counts expose repeated operations, and slow events include numeric lengths without retaining characters or annotations. Build/readings phases can await fonts or surfaces, so their elapsed durations alone do not establish synchronous blocking.

## Runtime profiles

**Game options → Runtime → Runtime profile** selects a shared runtime policy. **Native** is the default. **Browser optimized** applies on the next BP scheduler invocation, and the player remembers the selection when local storage is available. The policy API lives in `src/platform/runtime-profile.ts`; engine-specific scheduling decisions belong to the engine's scheduler.

Native preserves the existing host turn after each completed BP child burst while background work is pending. Browser optimized relies on the scheduler's 4 ms checkpoints and adds one host turn at the end of a traversal if background work is pending and no checkpoint yielded. This prevents a cheap traversal from accumulating many decoder slices before the frame can present, while still servicing workers during passes that only poll waiting processes. Each browser-optimized invocation starts a fresh CPU budget. Both profiles retain the complete BP traversal, instruction burst limit, selected child, process-poll admission, and callback leases.

Browser optimized can change when background completion becomes visible to a later child. Use Native when that interleaving is significant. The toggle does not change pixel math, asset formats, caches, or renderer backend. Scheduler events identify the active policy and report `backgroundYields` and `budgetYields`. The `buriko.vm.background-yields` and `.budget-yields` aggregate metrics count those host turns per invocation; their values are counts, not milliseconds.

A generated background computation and ordered BP children can compare scheduling without game assets:

```sh
npm run build:runtime
node tools/benchmark-buriko-scheduling.mjs --output /tmp/scheduling-current.json
```

The report includes scheduler pass latency, background completion time, instruction-order checks, and output hashes for both profiles. Each completed traversal is a possible presentation point; the probe does not render or measure game FPS. A shorter traversal can improve presentation cadence without improving background throughput. Use a game capture to establish the actual effect.

## Glyph processing

`buriko.text.glyph.raster` measures cache lookup and, on a miss, browser font rasterization plus native coverage reduction. Slow events include size, supersampling scale, and gamma mode. `buriko.text.glyph.copy` measures conversion of coverage into the native scratch bitmap. Both are nested within drawing-backed measurement and prepared glyph drawing; their durations are not additional independent costs.

`font-raster.ts` counts nonzero coverage bytes four at a time for bounded, aligned 4×, 8×, and 16× TextOut supersampling. The count accepts every nonzero byte value and retains native floor rounding and sine-based gamma conversion. `font-bitmap.ts` validates complete independent source and destination envelopes before copying RGB/RGBA glyphs through direct storage views and marking completed rows initialized. Aliases, short allocations, and unsupported layouts retain scalar access and partial-write faults. Glyph cache capacity, eviction, lookup order, and invalidation remain native.

The font benchmark uses generated DIB coverage without loading fonts, game files, or browser surfaces:

```sh
npm run build:runtime
node tools/benchmark-buriko-fonts.mjs /path/to/previous/dist
```

The optional baseline directory must have an ESM `package.json` in its ancestry. With a baseline, the tool compares pixel bytes, initialization masks, glyph metadata, and faults across supersampling, gamma, bitmap formats, aliases, and malformed buffers. Timing batches measure 32 cached or uncached glyph draws, including coverage processing and bitmap copying but excluding actual browser font rasterization. Use game captures to measure the complete browser-backed text path.

## Sprite pixel processing

Affine sprite setup (`90:5c`) regenerates mipmap chains and the selected mixed/wave sources. Property and display-control updates can rebuild those sources again. The `buriko.sprite.*` spans identify each phase and its dimensions. Cache rebuild order and native pixel results are preserved even when a property repeats its previous value.

Sprite draws use fixed categories for `simple`, `blend`, `affine`, `reveal`, `displacement`, `affine-blend`, and `mesh`, corresponding to selected modes 0–6. A configured affine sprite can select the simple path at unit scale and zero angle; the category describes the selected path. Sum the seven span categories to compare with older captures' single `buriko.sprite.draw` aggregate. Every draw also contributes metrics under its category: `width`, `height`, `pixels`, destination `format` (1 for RGB, 2 for RGBA), `sampling` (0 for nearest, 1 for interpolated), `blend-mode`, `effects`, and `mask`. Sampling only affects paths that use it. The boolean metric totals count enabled draws; dimensions describe the requested draw rectangle, not the number of nontransparent pixels. These aggregates expose repeated small draws that never reach the 8 ms event threshold. Check the aggregate `kind` before summing durations: pixel and dimension metrics are not milliseconds.

`bitmap-reduce.ts` and `bitmap-mix.ts` use validated buffer views to avoid per-pixel storage checks. Reduction preserves vertical-before-horizontal rounded byte averaging, odd edges, and pair load/store ordering. Bounded RGBA mixing retains the measured native reciprocal quantization; its coefficient cache holds at most one factor's 65,536 alpha pairs and populates entries on demand. SIMD applies the cached coefficients to four pixels at a time, with independent native alpha weighting and a scalar tail. At factor 256, validated sources permit an exact second-source copy when it does not alias the destination. At factor zero, every positive first alpha produces the native RGB coefficient 127, while zero first alpha produces coefficient 0. Its SIMD specialization uses those exact constants and preserves the first alpha. It still reads both sources: the second RGB contributes 1/128 for positive alpha and supplies all RGB for zero alpha. Small, aliased, or unsupported buffers use JavaScript. Invalid or partially initialized descriptors retain scalar access checks and partial-write fault behavior.

Large nonaliased half reductions use SIMD byte averages through the shared workspace's independent-plane transform. Vertical averages precede horizontal averages, odd edges retain their single available pair, and RGB's fourth byte is averaged too. Staging includes only the accessed input and output rows. The complete four-level chain benchmark includes fresh allocations, staging, and initialization updates:

```sh
node tools/benchmark-buriko-reduce.mjs --output /tmp/reduce-current.json
```

`bitmap-alpha.ts` also accelerates initialized RGBA-over-RGBA composition. Its bounded JavaScript traversal retains source-pair and destination-pair load order, transparent/opaque pair shortcuts, and the distinct integer odd-tail calculation, including division faults. A bounded cache stores the native float32 reciprocal coefficients for one transparency's alpha pairs. No coefficients are reused across transparency changes.

The RGBA kernel lives in `wasm/aokana-bitmap/src/lib.rs`; regenerate its embedded binary with `npm run build:wasm`. Buffer staging uses the shared `src/graphics/wasm-pixel-workspace.ts`. Replacement kernels can skip staging old destination bytes; blending kernels retain that copy by default. Compare complete sprite operations, including allocation and buffer copies, when evaluating this path. WASM calls are synchronous and do not yield to browser tasks; the scheduler checks its host budget after the operation returns. Unavailable WASM keeps the JavaScript implementation usable.

The browser mix benchmark measures complete crossfades of generated RGBA buffers, including staging and native storage updates:

```sh
npm run build:runtime
node tools/benchmark-buriko-mix.mjs --output /tmp/mix-current.json
```

Use `--runtime-root /path/to/previous/dist` with a separate output filename for an independent baseline. Compare output hashes, cold calls, and warm medians across all reported factors. Generated inputs cover random alpha, opaque planes, transparent planes with nonzero invisible RGB, binary masks, and opaque interiors with fractional edges. This distinguishes general throughput gains from changes that benefit only one coverage pattern. The benchmark serves compiled modules and synthetic buffers without a game or presentation surface.

Native display jobs divide each damage rectangle into horizontal strips using the configured pixel budget. For example, a budget of 6,406 pixels at width 1,920 produces three-row strips. Each strip retains native object traversal and affine coordinate setup; merging strips can change rounding and object/worker order. Many small draw calls can therefore represent a few large sprites, rather than hundreds of separate sprites.

`bitmap-affine.ts` accelerates initialized RGBA-to-RGB affine draws across rotations, scales, crops, and both sampling modes. Its packed JavaScript arithmetic retains horizontal-before-vertical Q4 interpolation, wrapping Q16 coordinates, native Q7 opacity quantization, and destination alpha. The WASM path stages a conservative rectangle containing every source sample and its bilinear neighbors, together with the old destination. It rejects accumulator overflow before calculating that rectangle; rebasing into the staged source preserves sampled pixels and fractional bits. This avoids copying the entire source image for each thin destination strip. Small draws, excessive source footprints, and unsupported WASM use JavaScript; aliases, partially initialized storage, and unusual descriptors retain checked native traversal and fault order.

The affine WASM alpha kernel processes four destination pixels together for arbitrary Q16 column and row increments. Each lane gathers its own source samples; vector arithmetic retains wrapping coordinates and the horizontal Q4 floor before the vertical floor. The exact horizontal increment `(65536, 0)` uses a specialized contiguous-load path that also supports fractional translations and arbitrary row increments. Groups touching source borders and remaining tail pixels use the scalar sampler. The alpha coefficient maps source alpha 254/255 to numerator 128 before applying opacity, and every result preserves destination alpha. Dispatch depends on coordinates and storage eligibility, never on an image, animation, or strip size.

Pixel metrics distinguish `buriko.affine.alpha.bounded-pixels` (WASM or a proven empty source footprint), `buriko.affine.alpha.js-pixels`, and `buriko.affine.alpha.checked-pixels`. Separate `buriko.affine.copy.pixels`, `.dim.pixels`, and `.mix.pixels` categories identify other affine operations. Each pixel metric's count is an invocation count and its total is requested destination pixels, not elapsed time. `buriko.affine.alpha.column-x` and `.column-y` aggregate the exact signed Q16 horizontal increments; their minima/maxima distinguish scaling and rotation from the unit-column condition. `buriko.affine.alpha.unit-column-pixels` counts requested pixels meeting the contiguous-load condition, before WASM eligibility and edge checks; it does not count all SIMD work or only vectorized pixels. Integral aligned draws can take the existing compositor shortcut without entering an affine pixel kernel.

`buriko.affine.alpha.wasm-nearest` and `.wasm-bilinear` time each eligible-storage WASM attempt, including source-footprint checks, staging, execution, and output copying. Failed eligibility probes remain in these aggregates and report `applied: false` when slow enough to retain an event. `buriko.affine.alpha.javascript` measures the initialized JavaScript fallback. Compare these totals with sprite draw spans to distinguish kernel work from object traversal and text presentation overhead; nested spans and replays must not be added as independent frame costs.

The shared text presentation layer can replay pixel operations into a textless copy so selectable browser text can replace native raster ink. These replays contribute to kernel metrics but remain inside the original sprite span. Twice as many affine kernel calls as sprite calls can therefore indicate presentation replay. `text.raster.replay.destination-glyphs` and `.source-glyphs` record the retained destination and captured source glyph counts for each replay. Their aggregate count is the number of replays, and their total is the sum of those glyph counts. They contain no strings. Empty glyph counts do not prove the copy is stale: decorative ink has no selectable glyphs.

`src/text/raster-text.ts` retires a cropped-clear presentation copy only when no glyphs remain and its complete storage matches the native bytes. Equality checks are amortized over an allocation's worth of clears, deferred when incoming text provenance remains active, and skipped when a remembered differing byte still proves decorative ink remains. `text.raster.retirement-checks` and `text.raster.retired-stale-planes` count comparisons and successful retirements. Native storage, retained snapshots, and live text replay remain authoritative.

The affine scene benchmark exercises complete display-manager traversal with two generated RGBA layers, nearest and bilinear sampling, fractional coordinates, and 720 strip draws into a 1080p RGB target. It uses no game files or presentation surface:

```sh
npm run build:runtime
node tools/benchmark-aokana-hotspots.mjs "" "Affine scene"
```

Pass a previous compiled `dist` directory as the first argument to compare output bytes and median timings against that build. The benchmark measures general affine composition, including native strip traversal; dimensions and layer counts are synthetic workload parameters, not engine dispatch conditions. Browser recordings remain necessary to measure animation cadence and audio responsiveness.

For an isolated browser comparison that includes source-footprint staging and destination copies:

```sh
node tools/benchmark-buriko-affine.mjs --output /tmp/affine-current.json
```

Use `--runtime-root /path/to/previous/dist` for the baseline. Generated cases cover nearest and bilinear sampling, wide and narrow padded strips, row shear, zero borders, combined scale/shear, near-unit increments of 65535 and 65537, scaling, and reversed horizontal traversal. Compare output hashes before timing results. These kernel measurements exclude display-list traversal and selectable-text replay; use the complete affine-scene benchmark and game captures for those costs.

See [GPU rendering](gpu-rendering.md) for the runnable integer-kernel probe, archived complete-backend experiment, and measured transfer costs. Complete native-traversal measurements did not outperform software, so the player retains the software renderer.

## Bitmap registration

Bitmap registration continues after the codec worker completes. `buriko.bitmap.register-import` covers the surface import or records `skipped: true` when only caching was requested. `buriko.bitmap.register-cache` covers the subsequent preload or resource-cache insertion. Compare these spans with `buriko.process.poll-sync`; a fast decoder can still be followed by synchronous registration work. `buriko.bitmap.composite` identifies the mode and formats used by surface-table drawing such as `90:18`.

Private bitmap validity snapshots recognize their initialized prefix and retire an all-valid mask. The shared `indexOfZeroByte` helper in `src/core/binary.ts` checks four bytes at a time, retaining the first zero's byte offset on aligned and unaligned views. Bitmap and codec range checks use it for large validity spans; they retain their existing bounds checks and errors. Replacement row copies require bounded live output, without requiring its old bytes to be initialized, and publish only the written rows. Source aliases and invalid ranges retain native block traversal and partial-write faults.

The generated bitmap setup benchmark measures full RGBA composition and decoded-image import plus preload insertion. It includes native allocations, validity processing, and payload copies without opening game files:

```sh
node tools/benchmark-buriko-bitmap-setup.mjs --output /tmp/bitmap-setup-current.json
```

Use `--runtime-root /path/to/previous/dist` and a different output filename with either bitmap setup or reduction benchmarks to compare an independent build's output hashes and elapsed times. These are synthetic workloads; game spans determine their contribution to a particular transition.

## File-read throughput

Shared source read spans retain numeric source size, byte offset, requested/completed byte counts, and success on slow events. Source size and offset distinguish a whole-file request from a range within an archive. The `source.local-read.completed-bytes` and `source.remote-read.completed-bytes` metrics include successful reads below the event threshold. Their totals divided by recording duration measure delivered bytes per second over the capture; dividing by summed read durations instead measures bytes per accumulated read time. Overlapping reads make those quantities different. Reads that started before recording can contribute completed bytes without a latency span. The recorder observes its own JavaScript context; reads performed exclusively inside a separate browser worker require forwarding that worker's measurements. Compare source spans with loader and decode spans before attributing loading time to storage. No source paths, URLs, or game text are retained.

`buriko.file.read-copy` separates native destination copying and initialization-mask updates from the preceding source wait. `buriko.file.output-preload` identifies whole-file reads needed to preserve existing output contents. Codec workers scheduled by native procedures run outside the loader job; use their queue and worker spans with the format-specific decode spans to distinguish delayed dispatch from decoding. Worker and both CBG version durations can include waits, while DSC and grid-worker spans are synchronous. A long task outside all these spans remains unattributed; asynchronous envelope overlap alone does not identify its CPU work.

Shared IndexedDB storage records transaction elapsed time separately from synchronous cursor, callback/copy, and comparison phases. `storage.idb.read-bytes`, `.copy-bytes`, `.compare-bytes`, and `.write-bytes` are byte metrics, not durations. Compare bytes count equal-length input sizes; a mismatch may terminate comparison early. Counts and sizes include aborted transactions' attempted work. Browser transaction scheduling, value deserialization before a callback, and commit can fall outside the synchronous spans. Snapshot reads also produce transaction and cursor spans.

`src/platform/store.ts` compares unchanged records with exact aligned word reads and a byte tail instead of invoking a callback for every byte. Unaligned views retain a byte loop. The update callback still receives a defensive copy, its result is copied again, and all reads and writes remain in one readwrite transaction to serialize concurrent tabs. No host yields occur inside that transaction. A synthetic Chromium update with one unchanged 33,990,807-byte record and one changed byte measured a five-run median of 17.3 ms versus 170.4 ms for the callback comparator. This demonstrates the storage improvement; a game capture containing the new storage spans is needed to attribute a gameplay stall to it.

`src/core/source.ts` reads each requested Blob slice in one operation and issues one HTTP range request per remote read. Neither path imposes a read-chunk cap. `SliceSource` forwards the bounded range to its underlying source. Buriko retains the native serial loader order and reopens archive members' backing files so replacements remain observable. The installation cache's 4 MiB chunks apply to saving an installation into browser storage, not ordinary reads from a running game.

The [File API](https://www.w3.org/TR/FileAPI/) specifies slice and buffer-read behavior without a portable throughput limit. The [File System Standard](https://fs.spec.whatwg.org/) restricts synchronous access handles to origin-private files in dedicated workers; they cannot directly replace reads from arbitrary selected game files. Measure the actual backend and workload before changing read sizes or concurrency.

## Legacy image decoding

`src/formats/buriko/compressed-bg.ts` provides synchronous inspector/encoder entry points and `decodeCompressedBgLegacyAsync` for native resource workers. Both execute the same generator. The asynchronous entry runs decryption, entropy batches, RLE expansion, and predictor rows within the shared host budget, validating borrowed worker storage after each host resumption. Header publication follows checksum validation, initialization masks publish after each reconstructed row, and worker completion follows the complete decode. Faults retain their partial writes.

Entropy decoding fills contiguous Huffman prefix ranges and emits up to four symbols per lookup into private scratch storage. Intermediate streams of at least 64 KiB use a 16-bit prefix; smaller streams use 12 bits to limit table setup. Long codes, short tails, and invalid branches retain scalar traversal and fault behavior.

Aligned 32-bit pixel storage uses packed byte arithmetic for reconstruction. Each lane averages its own left/up bytes with native floor rounding, then adds the residual modulo 256. The left pixel stays in a local value within a row and reloads from storage after any host yield. The calculation preserves row dependencies and initialization-mask overlap; unaligned views and other depths retain scalar prediction. The optimization applies to all eligible legacy CBG images without image-specific caches or dispatch rules.

The synthetic browser benchmark generates encoded inputs without opening game files or presenting images:

```sh
npm run build:runtime
node tools/benchmark-buriko-cbg.mjs --output /tmp/cbg-current.json
```

Use `--runtime-root /path/to/previous/dist` with a separate output filename for an independent baseline. Reports contain exact-output hashes, malformed-input and overlapping-buffer outcomes, complete elapsed decode time, phase and cooperative slice timings, and borrowed-storage checks. The `entropy`, `runs`, and `predictor` spans include host waits; use overlapping cooperative slices to distinguish synchronous work from scheduling delay. Compare both elapsed time and uninterrupted slices: short slices alone do not prove that decode throughput improved.

## Local profiling build

```sh
npm run build:profile
npm run start:profile
```

The build produces `site-profile/`, served at `http://127.0.0.1:8001/`. It keeps readable function names and source maps for local diagnostics. The normal `npm run build` output remains `site/`; `npm start` serves that normal build. Rebuild the profiling output after changing source, and reload the player before comparing captures.

Browser storage belongs to an origin and browser profile. `http://localhost:8001`, `http://127.0.0.1:8001`, and another port have separate saves, retained game files, and directory permissions. Use the same origin for repeat measurements. A fresh profile requires selecting the game files again; it does not inherit the normal browser's saves or permissions.

Each Vite invocation embeds a mode and UTC build timestamp through `src/platform/runtime-build.ts`. The diagnostics panel and JSON export read that same module constant, so a cached player identifies the bundle actually loaded. This stamp is diagnostic metadata; service-worker installation and activation still use the existing content-derived revision. Check the build identifier when comparing recordings after a rebuild.

The profiling build includes the service worker. An already open player keeps its loaded code, and an installed worker can keep serving the previous cached build. After rebuilding, close every tab and installed app window for that origin, then reopen it so a waiting update can activate. If an older build still appears, allow the update to download, close all its windows, and reopen once more. A reload alone does not necessarily activate a waiting worker. A new recorder profile starts without an old worker or cached build.

## Sampling-free Chromium trace

Use this when timings alone cannot explain a pause, or when renderer termination evidence is needed. The standalone recorder controls an isolated Chromium-family browser through its browser-level DevTools connection. It does not evaluate page scripts, simulate player input, or request screenshots. The user operates the game normally.

With the profiling server running, launch a separate terminal:

```sh
node tools/capture-browser-trace.mjs \
  --browser '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' \
  --url http://127.0.0.1:8001/buriko.html \
  --output /tmp/aokana-trace-01.json
```

Use the executable path for the Chromium-family browser under test. Node.js must provide the built-in `WebSocket` API. The URL must use loopback HTTP, and the output and metadata filenames must not already exist.

1. Prepare the desired game state in the isolated browser. Leave DevTools Performance recording closed.
2. Press Enter in the recorder terminal to begin.
3. Reproduce the transition or delay, then press Enter to finish. Closing the selected tab or receiving a renderer crash also stops recording. Ctrl-C requests a stop and attempts to save the trace.
4. Keep the trace, its `.metadata.json` sibling, and the retained profile path printed by the tool. Import a saved trace into the browser's Performance panel for analysis.

CPU sampling defaults to **off**. The configuration disables JavaScript stack sampling and excludes V8 CPU-profiler categories. It retains timeline, frame, V8 execution, garbage-collection, and user-timing events. These can establish task boundaries and correlate stalls with instrumented timings, but do not provide sampled function attribution. The explicit `--samples on` option exists for a separate sampling comparison; it can reproduce the sampling-related crash and is not needed for the normal workflow. Screenshot tracing is excluded in either mode. `--headless` is intended for synthetic tooling checks, not user-operated game captures.

The trace uses a 32 MiB rolling buffer. A long recording replaces earlier events with more recent ones, retaining the window closest to the stop or failure. Keep captures short when the beginning matters. Buffer usage is written to metadata roughly once a second; completion also records the browser's `dataLossOccurred` flag. That flag can report ring-buffer wraparound and is not itself evidence of a renderer bug. Configuration and event meanings follow the [Chrome DevTools Protocol tracing schema](https://github.com/ChromeDevTools/devtools-protocol/blob/master/pdl/domains/Tracing.pdl).

## Crash evidence and capture limits

The metadata file is updated throughout the run and records the browser and V8 versions, executable, process ID, selected target, sampling configuration, stop reason, buffer status, and received termination events. Browser stderr is saved as `browser-stderr.log` inside the retained temporary profile. Keep that profile until the investigation is complete; browser crash reports may be stored there when the browser produces them. The recorder closes its own browser after preserving the trace and metadata, and leaves the profile on disk.

Trace data is requested as a stream **after recording ends**, rather than streamed to disk during recording. A renderer crash can still yield a trace if the browser process remains available. If the entire browser or DevTools connection disappears, trace retrieval may fail. Inspect `trace.status` in metadata: `saved` identifies a completed file; `incomplete` indicates a partial file; `unavailable` means no stream was recovered; `not-started` means recording never began. An incomplete JSON file may not import. Preserve the metadata and browser log even when there is no usable trace.

An unfinished `CppGC.IncrementalSweep` at a crash trace's tail identifies observed activity near termination; it does not establish the root cause. Likewise, a passing numeric bitmap/WebAssembly or disposable offscreen-canvas probe does not reproduce all the full game's object lifetimes and browser interactions. Use the timings and termination evidence to narrow the next experiment before changing native runtime behavior.
