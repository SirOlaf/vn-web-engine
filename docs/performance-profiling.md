# Performance diagnostics

Use **Game options → Performance diagnostics** first when DevTools CPU sampling crashes the tab. Click **Start recording** immediately before a slow story or character transition, reproduce the delay, click **Stop recording**, then **Download timings JSON**. Keep DevTools Performance recording closed during this capture. These measurements describe elapsed wall time in instrumented operations, long tasks, and event-loop delay; they are not CPU samples or a JavaScript call tree. Time spent awaiting a worker, decoding, or I/O can contribute to an operation's elapsed time. Nested operations overlap, so their durations must not be added together as independent costs.

This recorder is opt-in and keeps results in memory. Starting another recording replaces the previous one; reloading loses it, so download before reloading. The JSON includes category aggregates, spans lasting at least 4 ms (16 ms for outer frame and scheduler events; 8 ms for sprite drawing), long tasks when the browser supports observation, and delays of at least 16 ms on a 100 ms event-loop timer. All completed spans contribute to aggregates even below their event threshold. It retains at most 2,048 events and 512 aggregate categories, reporting overwritten events and overflowed category samples. Background throttling also delays timers; keep the tab visible and use the recorded visibility changes when interpreting stalls. The `runtimeProfiles` field lists the profiles selected during the recording. Bundled players also include a `buildId` matching the identifier shown in Performance diagnostics; direct runtime modules report `null`. No pixel data, asset paths, or sampled stacks are included.

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

`src/core/host-task-budget.ts` provides a 4 ms default cooperative budget. Its checkpoints yield through a host task, allowing timers and audio messages to run. The BF decoder shares one budget across coefficient, alpha, and reconstruction steps; the BP scheduler checks after each continuing instruction and process poll while retaining native burst counts and child order. Both profiles amortize clock reads across small instructions as described below. Shared interpreters also check between instructions and carry one budget across the indexed workers, preserving numeric-result microtask ordering and child actor ownership. This is a scheduling target, not preemption: allocation, garbage collection, synchronous rendering, and any individual step can exceed the budget. Extend checkpoints only where borrowed storage, native actor identity, and callback order remain valid.

The shared yield posts a `MessageChannel` task which closes its ports and schedules the continuation with a zero-delay timer. Scheduling that timer from a non-timer task resets the [HTML timer nesting level](https://html.spec.whatwg.org/multipage/timers-and-user-prompts.html#timer-initialisation-steps), avoiding the minimum 4 ms delay accumulated by repeated timer yields. The continuation remains an ordinary timer task. Hosts without `MessageChannel` retain the direct timer fallback. This mechanism is shared by cooperative decoders and interpreters; engine code should reuse it.

Text preparation's phase spans locate work under the outer `buriko.text.prepare` interval. Measurement includes its scratch allocation and all glyph drawing used to determine extents. `glyph-draw` measures the prepared node's glyph draw separately; it does not include measurement's glyph draws. `annotation-match` includes encoding the remaining UTF-16 suffix and matching readings. The span counts expose repeated operations, and slow events include numeric lengths without retaining characters or annotations. Build/readings phases can await fonts or surfaces, so their elapsed durations alone do not establish synchronous blocking.

## Runtime profiles

**Game options → Runtime → Runtime profile** selects a shared runtime policy. **Native** is the default. Changes apply to subsequent work, and the player remembers the selection when local storage is available. The policy API lives in `src/platform/runtime-profile.ts`; engine-specific scheduling and drawing decisions belong to the engine.

Native preserves the existing host turn after each completed BP child burst while background work is pending. Browser optimized relies on the scheduler's 4 ms checkpoints and adds one host turn at the end of a traversal if background work is pending and no checkpoint yielded. This prevents a cheap traversal from accumulating many decoder slices before the frame can present, while still servicing workers during passes that only poll waiting processes. Each browser-optimized invocation starts a fresh CPU budget. Both profiles retain the complete BP traversal, instruction burst limit, selected child, process-poll admission, and callback leases.

Both runtime profiles use the shared budget's `checkpointBatched()` after known small synchronous BP instructions, reading the clock at least every 64 such steps. The interpreter's allowlist admits only the original scalar, stack, arithmetic, local-descriptor, watched-store, and control handlers whose fixed-width or varint operands bound their work, by function identity; a watched store's registered-watch search and synchronous report are bounded as well. Native slot definitions may opt in with `batchable: true` when they are synchronous, free of host effects, and bounded by their operands; the scheduler reads the secondary byte after a native primary to select them, and version overrides must opt in again. Named bit-array access (`80:89`–`80:8B`) and named-value write, remove, and read (`80:D2`–`80:D4`) are marked. Other native calls, bulk operations, replacement handlers, awaited results, process polls, and traversal boundaries still check time immediately. Custom executors retain full polling unless explicitly bound with the interpreter's eligibility table and a small synchronous context factory. Every full checkpoint or budget reset restarts the count. The 4 ms target can be exceeded by up to 63 additional eligible instructions before the next clock read. Clock reads select only host yield points, never VM-visible state, so the native profile shares this policy.

Browser optimized can change when background completion becomes visible to a later child. Its larger display jobs can also change affine rounding and draw-callback/worker order, as described below. Use Native when those details are significant. Both profiles use the same pixel kernels and asset formats; Browser optimized can present through WebGL, as described below. Scheduler events identify the active policy and report `backgroundYields` and `budgetYields`. The `buriko.vm.background-yields` and `.budget-yields` aggregate metrics count those host turns per invocation; their values are counts, not milliseconds.

Browser optimized also coalesces unused intermediate sprite mixes within each synchronous display-control or spline-control setter group. Coordinates, blend, and depth still update in their original order; the final mix is ready before the process resumes, resorts the object, or requests redraw. The scope includes child sprites in the same display environment and never spans a BP instruction boundary or an asynchronous yield. `display-update-batch.ts` owns this engine-specific derived-cache policy and uses the shared runtime profile API. Native continues rebuilding at every setter.

Only initialized, bounded RGB/RGBA inputs with matching dimensions and factors from 0 through 256 may defer a mix. Invalid inputs keep immediate checked traversal. Wave and mesh consumers force any required mix immediately, and cache retirement cancels pending work. Source descriptors are captured at the setter; there is no pixel cache across control steps, so later source writes remain visible on the next rebuild. The optimized profile omits intermediate allocations and worker dispatches, and allocation failures can therefore occur at a different point within the setter group. Failed groups discard pending work. `buriko.sprite.mix.deferred` counts queued requests, while `.batch-flush` counts rebuilds completed by the scope's flush callback; immediate consumers can cancel a queued request and rebuild it themselves. These metrics are counts, not milliseconds.

Browser optimized can also reuse a sprite's previous mix allocation as its next destination. Every pixel is recomputed from the current sources. Reuse requires matching RGB/RGBA dimensions, bounded factors, initialized nonaliased sources, and no raster-text sidecar on either source or destination. Invalid, unsupported, resized, or text-bearing inputs keep fresh allocations. Each sprite retains at most one mix destination between rebuilds; mode changes and disposal release it. Native retains allocation and retirement at every refresh. `buriko.sprite.mix.reused-destination` counts reuse, and `.allocate-destination` counts only new allocations. Reuse can reduce first-write page costs inside `.wasm-stage-out` even when allocation spans themselves are short.

Browser optimized presents Buriko frames through WebGL 2 when it is available and the presentation filter is point or linear. The software device instead copies dirty rows into its sampled texture, filters them into an `ImageData` frame, and uploads that with `putImageData`. The WebGL path uploads the source texture's dirty bounds with `texSubImage2D`, draws the quad in a shader, and copies the WebGL canvas into the shared 2D canvas with `drawImage`. Column and row coordinates are computed on the CPU exactly as the software rasterizer computes them. The shader rounds each product before adding and converts to bytes with round-half-even, matching the software device's binary32 unfused arithmetic. The copy into the sampled texture is deferred until a software frame, or a DOM-text frame, reads it. In DOM text mode both paths present the textless plane instead: the WebGL path keeps it in a second image, `textless`, beside the native `display` image. Cubic filtering, WebGL loss, and non-finite quad coordinates fall back to the software device, which then rasterizes a complete frame. `?gpu=0` keeps software presentation for A/B captures. `buriko.display.gpu-upload`, `.gpu-draw`, and `graphics.canvas.copy` time the three steps.

`node tools/probe-buriko-gpu-presentation.mjs` compares the WebGL output (`gl.readPixels`) with the reference sampler over generated textures for 1:1, upscaled, downscaled, and shaken quads with both samplers. On Chrome 154 on Apple silicon, every case matches bit for bit. The browser's WebGL-to-2D canvas copy then changes about 250 of 2.07 million pixels by one step. The probe reports that separately as `copyDiffering`; the engine cannot control it.

While WebGL presents, Browser optimized also composites display frames on the GPU. Each frame's render jobs, one per damage rectangle, draw into a stand-in display descriptor. Nine kernels declare a GPU implementation through the `gpu` option of `withBurikoBitmapText`, and those run on the display image instead: row copy, clear, RGB dim, all-channel mix, alpha into RGB with and without transparency, blended affine drawing of RGBA sources, masked RGB32 transitions, and mixed sprite blends into RGB. Transitions use the software kernel's own clipping (`burikoTransitionOperands`) and its per-mask-byte action table (`burikoTransitionActions`). The 8-bit mask is cached like other sources, as an R8 texture. Each shader repeats its TypeScript kernel's integer arithmetic on the same DWORDs, including pixel pairs counted from the operation's left edge.

Any other access to display pixels fails the frame. This includes a kernel without a GPU implementation, or reading `bytes`, `view`, `range` or `written` on the stand-in. Failure writes only to the software texture. The GPU then restores the jobs' area from its backup, reads the image back into the software texture, and the renderer draws the same jobs in software before the frame's notifications. Nothing throws, so worker pools and locks keep their state. After a failure, GPU compositing pauses for 30 frames, doubling on each consecutive failure up to 1,800.

In DOM text mode each GPU frame also maintains the textless image. `withBurikoBitmapText` dispatches a display kernel once with its native arguments and replays it inside `replay` with the textless planes of its sources, as `withRasterText` replays software kernels. It then records the kernel's glyph bookkeeping on the software display storage without touching its bytes. A failed frame restores both images from their backups and the display's glyph records from a snapshot. DOM text asks which glyphs still have ink with a small GPU pass over their clips (`ink`), read through a pixel buffer behind a fence, so presentation never waits for the GPU. `buriko.display.gpu-compose.ink-queries` counts the clips per query.

While the GPU holds the only current display pixels, software readers read them back first, the textless plane included. Those readers are display capture, software presentation, and a software frame. Switching to DOM text hands the display back to software and forces a full redraw, because GPU frames in Native text mode do not maintain the textless plane.

Source bitmaps are cached as textures, one per storage, laid out on the storage's own row grid. A cached texture is reused while the storage's `generation` is unchanged. The generation advances on every `bytes`, `view`, `initializedView`, write-range, `written` or `release` access. Any code that could write pixels therefore invalidates the texture, whoever it is. Textures unused for 120 frames are dropped, as are the least recently used ones beyond 384 MiB.

While GPU compositing is active, sprite mixes (`mixBurikoBitmaps`) are deferred instead of computed. The call is recorded as its destination storage's pending write, and the GPU draws it into the destination's cached texture when a frame first reads it. RGBA mixes use a 256 × 256 table of `burikoMixAlphaCoefficient`, the RCPSS weight of each alpha pair, computed on the CPU and cached for 64 factors. Any access to the destination's pixels settles the pending write first, as does any possibly-writing access to one of its sources. Settling runs the software kernel on the unchanged inputs, so software readers see the exact native result, and a lost WebGL context loses nothing. A pending destination that is released, or wholly replaced by the next mix step, is discarded without computing.

Read-only paths use accessors that do not count as writes: `readOnlyBytes()` settles only the storage's own pending write, and `isInitialized()` and `backing()` settle nothing. The copy kernel reads its source this way, and so do the sprite's mix eligibility checks. Deferral is limited to mixes whose three bitmaps share a format and size, carry no raster text, do not alias, and do not use distributed strips. `.deferred-mixes`, `.gpu-mixes` and `.settled-mixes` count them.

`?gpu-compose=0` keeps software compositing while WebGL presents. `?gpu-compose=verify` also draws every GPU frame in software from the same starting pixels, compares the results, and reports `buriko.display.gpu-compose.differing-pixels` with a console warning. Verify mode disables the source cache, because the software draw touches every source. Other metrics are `.frames`, `.fallbacks`, `.upload-pixels`, `.cached-pixels`, `.draw` and `.read-back`. Each fallback also counts under `.fallback.<reason>`, and a console message names it. The reason is the kernel's function name for a kernel without a GPU implementation. For a direct pixel access, the message adds the caller's stack.

`node tools/probe-buriko-gpu-compositor.mjs` runs each GPU kernel on generated pixels, in software on one display texture and through a GPU frame on an identical one, and compares the results byte for byte. Its cases cover odd widths, boundary alphas, rotated, scaled and aligned affine transforms in both samplers, a source rewritten within one frame, and an unsupported kernel, whose fallback must leave the display unchanged. Deferred sprite mixes are covered too, across RGB and RGBA and factors 0 to 256: each must still be pending after its GPU frame and must settle to the software result. It also covers masked transitions across parameter, blend and `extra` settings, mask placements and clipping offsets, and mixed sprite blends across factors and transparencies. On Chrome 154 on Apple silicon, all 314 cases match. `?gpu-compose=verify` found no differing pixels in 1,178 frames of the three Aokana test scenes.

`node tools/benchmark-buriko-sprite-control.mjs --output /tmp/sprite-control.json` compares both profiles using generated pixel buffers and fixed-clock coordinate-spline updates. Setup, mipmap generation, and output hashing are outside the timed process polls. The probe checks complete mixed-pixel hashes and final control state without displaying images; its control-step durations are not game frame times.

Browser optimized also rasterizes a horizontal text layout's new glyphs on workers before the layout runs; see "Glyph rasterization" below. The layout native call then crosses a host turn where Native completes it synchronously. Glyph bytes are identical.

The shared installed-font catalog snapshots this profile before enumeration. Native reads one font at a time; Browser optimized admits up to four independent Blob/metadata jobs. Both return the browser's record order and each collection's face order, skip unreadable records, and retain only metadata. Profile changes affect the next catalog request. This policy changes read scheduling without changing font selection or cache lifetime.

A generated background computation and ordered BP children can compare scheduling without game assets:

```sh
npm run build:runtime
node tools/benchmark-buriko-scheduling.mjs --output /tmp/scheduling-current.json
```

The report includes scheduler pass latency, background completion time, instruction-order checks, and output hashes for both profiles. Each completed traversal is a possible presentation point; the probe does not render or measure game FPS. A shorter traversal can improve presentation cadence without improving background throughput. Use a game capture to establish the actual effect.

## Bytecode execution

Slow `buriko.vm.sync-slice` events include the BP thread ID, `startPc`, `nextPc`, and `nextOpcode` at the slice boundary, alongside the instruction count. These are numeric offsets and a single opcode byte; they contain no module names, strings, or instruction operands. `nextOpcode: -1` means no byte is available at that offset. Repeated boundaries can locate long-running loops without instrumenting each instruction. They are suspension-point samples, not an unbiased opcode-frequency profile, and an asynchronous handler can still be pending at the reported boundary.

Opcode and single-byte operand reads in `src/engines/buriko/bp/decode.ts` access ordinary in-range `Uint8Array` bytes directly. Exceptional offsets and absent bytes use the existing DataView path, preserving offset conversion, bounds and detachment faults, and program-counter updates. Variable-length operands retain one fixed DataView for shared storage or offsets whose conversion can run code, so growth during a read does not extend the operand's original bounds. The decoder does not cache bytecode contents or change instruction ordering.

`src/engines/buriko/bp/decode.ts` sign-extends signed and typed variable-length operands using integer operations. Native shifts use a 64-bit mask and return its low 32 bits: sign shifts from 32 through 63 contribute zero, while smaller shifts contribute `-1 << shift`. The explicit range check avoids JavaScript's modulo-32 shift behavior without constructing a BigInt for each negative operand. Overlong encodings retain native shift wrapping, and incomplete operands retain the original program counter.

The generated VM benchmark uses the actual interpreter, arithmetic, branch, local-memory, and native random handlers without loading game files:

```sh
node tools/benchmark-buriko-vm.mjs --output /tmp/vm-current.json
```

Use `--runtime-root /path/to/previous/dist` for an independent baseline and `--profile native` for the original clock-polling policy. Direct workloads isolate instruction execution; scheduled workloads include the real scheduler and enabled timing diagnostics, defaulting to Browser optimized. Each workload executes a fixed instruction count and reports final-state hashes. Scheduled cases also report synchronous slice totals, retained slice instruction counts, and budget yields. Compare fixed-width arithmetic, variable-length operands, local memory, and native calls. A direct decoder gain does not predict the full scheduler gain; game scheduler spans can also include native handlers, asynchronous waits, and intervening browser work.

## Glyph processing

Startup CPU calibration is recorded as `buriko.cpu.measure-clock`. Both runtime profiles retain the native one-second measurement loop, including clock reads, affinity handling, and signed timestamp-counter division. Treat its fixed interval separately from instruction work that grows with workload or CPU cost.

Font discovery can precede the first glyph. `.local-query` measures the browser enumeration request and `text.font.local-catalog` each metadata read over a set of installed records (its `records` detail gives the count), `.local-blob` each font Blob request, and `.local-metadata` each font's metadata read and parsing. Its `concurrency` detail reports the snapshotted job limit, and `worker` whether a module worker (`src/text/local-font-metadata-worker.ts`) performed the Blob range reads and parsing. The Local Font Access query and each `blob()` request stay on the main thread; one font Blob is posted per job, so the job limit still bounds live font data. With the worker, `.local-metadata` includes the worker round trip and its range reads do not appear as main-thread `source.local-read` spans; a worker failure reverts the remaining jobs to in-thread parsing, where nested source-read spans are installed-font reads, not game archive I/O. The Native profile reads every installed record once, matching GDI's complete `EnumFontFamiliesEx` view. Browser optimized reads only common Windows system families and records whose browser-reported family, full or PostScript name equals the queried name, each at most once; other installed fonts are absent from Buriko enumeration and pitch/charset queries, but CSS `local()` can still render them. This bounds startup on hosts with many large installed fonts. Parsed metadata is cached in IndexedDB (`vn-web-engine-font-metadata`) by each record's family, full and PostScript names, so later launches skip the Blob and table reads for cached fonts; `text.font.cache-read` and `.cache-write` cover the batched lookups and writes, and the catalog's `cached` detail counts hits. Local Font Access reports no file version without the Blob, so a font replaced under the same names keeps its cached metadata. Denied or unreadable fonts are not cached and are retried. While uncached fonts are read, the player shows "Processing installed fonts n/total" even when the general loading indicator is set to Essential only. Parallel job durations overlap; use catalog wall time for elapsed startup cost rather than summing job totals. Font names and identifiers are excluded. Metadata reads cover the sfnt header, table directory, and the `head`, `hhea`, `OS/2`, `name`, and `post` tables; needed tables separated by less than 4 KiB share one read, which never extends past the last table it covers.

`buriko.font.create` covers browser font selection and face construction. Its numeric `source` detail identifies the selected path: 0 before selection, 1 resource font, 2 local font, or 3 browser fallback. `buriko.font.local-face-load` isolates a first-time local `FontFace.load()` wait. These durations include asynchronous waits; compare them with synchronous slices and long tasks before attributing font setup to CPU work.

The catalog benchmark uses generated font metadata and actual Blob range reads without querying installed fonts or rendering glyphs:

```sh
node tools/benchmark-local-fonts.mjs --profile browser-optimized --output /tmp/fonts-current.json
```

Use `--profile native` for the sequential control, and `--runtime-root /path/to/previous/dist` for an independent baseline. Compare ordered metadata hashes, face counts, failed records, read counts, and bytes before elapsed time. Generated in-memory Blobs exercise range-read scheduling; installed-font IPC and disk latency require browser startup recordings.

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

`BurikoBitmapStorage` represents contiguous initialized bytes with a prefix length. Allocation, sequential writes, and full replacement do not allocate a parallel validity array. A write beyond the prefix materializes a byte map to retain holes; imported validity maps preserve their byte values. Range checks, cloned storage, and exported validity masks retain unwritten-memory faults and native heap-read behavior. This reduces allocation and metadata writes without changing pixel bytes or surface ownership.

Large nonaliased half reductions use SIMD byte averages through the shared workspace's independent-plane transform. Vertical averages precede horizontal averages, odd edges retain their single available pair, and RGB's fourth byte is averaged too. Staging includes only the accessed input and output rows. The complete four-level chain benchmark includes fresh allocations, staging, and initialization updates:

```sh
node tools/benchmark-buriko-reduce.mjs --output /tmp/reduce-current.json
```

`bitmap-alpha.ts` also accelerates initialized RGBA-over-RGBA composition. Its bounded JavaScript traversal retains source-pair and destination-pair load order, transparent/opaque pair shortcuts, and the distinct integer odd-tail calculation, including division faults. A bounded cache stores the native float32 reciprocal coefficients for one transparency's alpha pairs. No coefficients are reused across transparency changes.

The RGBA kernel lives in `wasm/aokana-bitmap/src/lib.rs`; regenerate its embedded binary with `npm run build:wasm`. Buffer staging uses the shared `src/graphics/wasm-pixel-workspace.ts`. Replacement kernels can skip staging old destination bytes; blending kernels retain that copy by default. Compare complete sprite operations, including allocation and buffer copies, when evaluating this path. WASM calls are synchronous and do not yield to browser tasks; the scheduler checks its host budget after the operation returns. Unavailable WASM keeps the JavaScript implementation usable.

Sprite mix diagnostics separate `buriko.sprite.mix.allocate-destination`, `.wasm-stage-in`, `.wasm-kernel`, and `.wasm-stage-out`. These measure fresh bitmap allocation, input copies into WASM, kernel execution, and copying the result back. `.wasm-memory-growth` records expansion of the shared linear memory when needed. The workspace accepts optional fixed timing labels; other pixel operations do not acquire these mix spans. All phases remain synchronous, and recording stays opt-in. The outer `.mix` span also includes eligibility checks, storage bookkeeping, and text presentation metadata; do not add it to its nested phase timings. Output pages may be committed when first written, so a low allocation time does not rule out allocation-related cost during copy-out.

The `.wasm-applied` metric counts attempted WASM mix calls: its count is attempts and its total is completed applications. Rejected eligibility checks, unavailable WASM, and exceptions contribute zero. Direct endpoint copies and paths that never attempt WASM are absent from this metric; zero alone does not identify a JavaScript fallback. It contains no image data.

The browser mix benchmark measures complete crossfades of generated RGBA buffers, including staging and native storage updates:

```sh
npm run build:runtime
node tools/benchmark-buriko-mix.mjs --output /tmp/mix-current.json
```

Use `--runtime-root /path/to/previous/dist` with a separate output filename for an independent baseline. Compare output hashes, cold calls, and warm medians across all reported factors. Generated inputs cover random alpha, opaque planes, transparent planes with nonzero invisible RGB, binary masks, and opaque interiors with fractional edges. This distinguishes general throughput gains from changes that benefit only one coverage pattern. The benchmark serves compiled modules and synthetic buffers without a game or presentation surface.

Add `--diagnostics` to measure the mix phases with fresh destination allocations. Measured calls report phase aggregates per coverage and factor; warmup calls are excluded. The mix elapsed timer excludes allocation and recorder setup, while the allocation span reports its own duration. Without this option the benchmark retains its reusable destination and disabled recorder for comparison with earlier throughput reports. Both modes validate numeric output hashes without rendering pixels.

Native display jobs divide each damage rectangle into horizontal strips using the configured pixel budget. For example, a budget of 6,406 pixels at width 1,920 produces three-row strips. Each strip retains native object traversal and affine coordinate setup; merging strips can change rounding and object/worker order. Many small draw calls can therefore represent a few large sprites, rather than hundreds of separate sprites.

Browser optimized uses a minimum job budget of 65,536 pixels for bounded positive rectangles, producing 34-row strips at width 1,920. This amortizes object traversal, text replay setup, and WASM staging; larger rotated strips can also meet the bounded-source-footprint eligibility ratio where thinner strips fall back to JavaScript. The BP-visible pixel budget remains unchanged. Zero budgets, invalid/wrapping rectangles, and drawing modes that prohibit independent strips retain their existing paths. Each damage rectangle keeps its key and submission order, and completion notifications still follow the complete draw. Affine rounding restarts less often, so rotated/scaled pixels and glyph clip fragments can differ from Native. This is an explicit profile tradeoff, not a claim of native-equivalent output.

`buriko.display.render-jobs` records the submitted job count per full/damage draw. `buriko.display.render-job-budget` records the effective budget per strip-eligible rectangle; its values are pixels, not milliseconds. Use these with damage-render durations and sprite/kernel call counts to measure batching.

The generated strip-size probe compares translation, rotation, and scaling with and without text replay, records complete native/presentation byte differences, and verifies Browser optimized against its equivalent explicit budget. It opens no game files or presentation surface:

```sh
node tools/benchmark-buriko-render-strips.mjs --output /tmp/render-strips.json
```

Timings cover synchronous drawing, not frame cadence. Native remains the reference even when another budget produces faster output.

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

Consumed preloads transfer their private payload through `bitmap-loading.ts` into the resource cache after a successful import. The surface still owns a separate pixel allocation. Ordinary cache reads and nonconsuming preload reads return copies; failed imports consume the preload without promoting it. Resource-cache capacity gates, duplicate-key behavior, and eviction order also apply to adopted payloads. This removes two payload-sized copies from successful consumed-preload promotion without changing pixel math or native-visible cache behavior, and applies in both profiles.

`buriko.bitmap.preload-transferred-bytes` counts consumed payloads whose first copy was avoided, including subsequently failed imports. `buriko.bitmap.cache-adopted-bytes` counts successful promotions whose second copy was avoided. Their totals are bytes, not elapsed time.

The generated bitmap setup benchmark measures allocation plus clearing, full RGBA composition, decoded-image import plus preload insertion, import from an existing preload entry, and consumed-preload import with resource-cache promotion. It includes native allocations, validity processing, and payload copies without opening game files. The promotion case prepares the preload before timing and validates cache ownership/results afterward:

```sh
node tools/benchmark-buriko-bitmap-setup.mjs --output /tmp/bitmap-setup-current.json
```

Use `--runtime-root /path/to/previous/dist` and a different output filename with either bitmap setup or reduction benchmarks to compare an independent build's output hashes and elapsed times. These are synthetic workloads; game spans determine their contribution to a particular transition.

## File-read throughput

Shared source read spans retain numeric source size, byte offset, requested/completed byte counts, and success on slow events. Source size and offset distinguish a whole-file request from a range within an archive. The `source.local-read.completed-bytes` and `source.remote-read.completed-bytes` metrics include successful reads below the event threshold. Their totals divided by recording duration measure delivered bytes per second over the capture; dividing by summed read durations instead measures bytes per accumulated read time. Overlapping reads make those quantities different. Reads that started before recording can contribute completed bytes without a latency span. The recorder observes its own JavaScript context; reads performed exclusively inside a separate browser worker require forwarding that worker's measurements. Compare source spans with loader and decode spans before attributing loading time to storage. No source paths, URLs, or game text are retained.

`buriko.file.read-copy` separates native destination copying and initialization-mask updates from the preceding source wait. `buriko.file.output-preload` identifies whole-file reads needed to preserve existing output contents. Codec workers scheduled by native procedures run outside the loader job; use their queue and worker spans with the format-specific decode spans to distinguish delayed dispatch from decoding. Worker and both CBG version durations can include waits, while DSC and grid-worker spans are synchronous. A long task outside all these spans remains unattributed; asynchronous envelope overlap alone does not identify its CPU work.

Shared IndexedDB storage records transaction elapsed time separately from synchronous cursor, callback/copy, and comparison phases. `storage.idb.read-bytes`, `.copy-bytes`, `.compare-bytes`, and `.write-bytes` are byte metrics, not durations. Compare bytes count equal-length input sizes; a mismatch may terminate comparison early. Counts and sizes include aborted transactions' attempted work. Browser transaction scheduling, value deserialization before a callback, and commit can fall outside the synchronous spans. Snapshot reads also produce transaction and cursor spans.

`IndexedDbStore` serves snapshots from the last committed state it observed; `storage.idb.cached-snapshots` counts snapshots answered without a transaction. A commit through any store instance invalidates other instances of the same database synchronously in the same realm and through a `BroadcastChannel` in other tabs and workers. Updates always read inside their readwrite transaction, so cross-tab writes still serialize. Snapshot values share bytes with the cache and are read-only for callers.

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

Buriko callers decode DSC resources through `decodeBurikoDsc` (`src/engines/buriko/native/dsc-wasm.ts`), which runs the DSC 1.00 decoder in its own instance of the `wasm/aokana-bitmap` module. `src/formats/buriko/dsc.ts` remains the engine-agnostic reference. The kernel stages the input with eight zero bytes and decodes into its linear memory, and the host copies the result into a fresh array. Only a success status uses Wasm output. Any other status reruns the reference decoder, which raises the native error for malformed trees, truncated streams, invalid back-references, and size mismatches. The same fallback applies when Wasm is unavailable, memory growth fails, or the workspace would exceed 256 MiB. Memory grown for a large resource is not released. `buriko.decode.dsc.wasm-applied` records 1 for each Wasm result and 0 for each fallback. On all 908 Aokana DSC resources, Node 26 decoded 527 MB in 164 ms, compared with 393 ms for the reference. For the largest resource (4.3 MB compressed, 6.2 MB decoded), decoding took 17 ms instead of 30 ms.

The Wasm run stage stores runs of up to 32 bytes with two 16-byte vector stores and lets the next run overwrite the excess, so its input and output buffers each carry 32 bytes of slack. Most runs are a few bytes long, and a bulk-memory call per run cost more than entropy decoding and prediction combined. On 120 Aokana sprites and event images (mostly 1920×1080), Node 26 decodes 8.5 ms per image instead of 13.3 ms.

### Decode workers

`decodeBurikoResource` (`src/engines/buriko/native/resource-decode.ts`) sends DSC resources and legacy CompressedBG images with at least 256 KiB of output to module workers (`resource-decode-worker.ts`) under both runtime profiles. The shared `WorkerPool` (`src/platform/worker-pool.ts`) runs at most two workers and leaves one hardware thread to the page. `resource-decode-offload.ts` owns eligibility and publication.

- **Input.** The worker decodes a copy of the stored bytes, taken when the job is posted.
- **Owned output.** DSC output and a packed image (header followed by pixels) are transferred back and returned without another copy.
- **Caller destinations.** `publishCompressedBgLegacyAsync` (`src/formats/buriko/compressed-bg.ts`) writes the image in the reference order: the source header after validation, then 1 MiB groups of rows with pixels before their initialization mask, then the 24-bit header rewrite. It yields between groups and validates borrowed storage on each resumption.
- **Timing.** Native BGI decodes on its own threads while the script runs. A snapshot decode is the interleaving in which script writes to the source, or to already published rows, land after the native thread has read them.
- **In-thread cases.** These keep the in-thread path: smaller outputs, empty images, depths other than 8, 24 and 32, pixel and initialization views that overlap (the reference predictor reads such rows back), unavailable workers, and every decoder failure. A failed job reruns in-thread, which raises the native error and leaves its partial writes. Ineligible resources are decided synchronously, so the in-thread path gains no extra microtask.
- **Diagnostics.** `buriko.decode.dsc.worker` and `buriko.decode.cbg-legacy.worker` time the round trip. `.worker-applied` records 1 per worker result and 0 per fallback. `buriko.decode.cbg-legacy.publish` covers writes into caller storage.
- **A/B switch.** `?decode-worker=0` keeps all decoding on the main thread.

In a 6× throttled Aokana slot 3 capture, main-thread legacy decoding fell from 719 ms to zero. The eight decodes took 129 ms of worker round trips.

Three copies on the loading path are now skipped in both profiles. None of them changes VM-visible bytes or fault checks:

- **No mask for private legacy output.** Private legacy CompressedBG output is written completely, so `decodeBurikoResource` no longer attaches an all-ones validity mask. An absent mask already means fully defined. This saves a fill of the image size, about 23 MB per Aokana sprite sheet, and every later zero-byte scan of it.
- **Preload adoption.** `RegisterBitmapProcess` releases the decoder's private output right after preloading it. When no import ran first, the preload cache now adopts that buffer (`insertPointer(..., owned)`) instead of copying it. Masked sources are still validated before adoption. Slot 3's eight preload inserts fell from 183 ms to 0.3 ms (`buriko.bitmap.register-cache`).
- **Owned raw reads.** Aokana's script loads `system.arc`, a 34 MB archive, whole as a loose resource, eight times in the slot 3 window. `looseFile` passes ownership of its fresh whole-file read (`readsFreshBytes`, true for blob-backed sources), so raw output returns that array instead of copying it.

- **Size query cache.** Aokana's `scrmsg._bp` queries the decoded size of `C:\game\system.arc` (80:35 `ReadDecodedResourceSize`) before every message. It then reads 4 bytes of the file with 81:32 `ReadDriveFile` and ignores both results. Native 1400bd6b0 loads and decodes the whole resource to answer, so each message read 34 MB. `BurikoProgramResources` now remembers successful loose decoded sizes by opened `ByteSource`. Installed files reopen as the same immutable source. Written or shadowing files open as new sources and are measured again, and failed reads are not remembered. Loads still read the file. In slot 3, one of eight queries read the file, and bytes read in the window fell from 282 MB to 44 MB. `buriko.resource.size-cache-hit` records 1 per hit and 0 per miss.

Importing a preloaded image into a bitmap still copies it, because the resource cache adopts the same bytes afterwards (`bitmap-loading.ts`). Native keeps both copies too.

### Streamed Vorbis music

Native BGI decodes Ogg Vorbis with `ov_read` in each 100 ms stream refill. The browser path used to decode a whole track before its stream opened, and the VM waits on that call. In Aokana slot 4, the first click changes the soundtrack. The new track is 3.95 MB of Ogg, 98 s at 44.1 kHz, and decoding it took about 211 ms. For that long, the game presented no frames and neither track played, in both runtime profiles.

- **Streaming.** `createBurikoLiveOggWaveStream` now opens single-link tracks through `BurikoProgressiveOggDecoder` (`src/engines/buriko/native/audio/progressive-ogg.ts`). A reused worker (`src/audio/vorbis-stream-worker.ts`) decodes the track in chunks: first 5 s, which covers the stream's 4 s prefill, then 10 s at a time. libvorbis keeps its state between chunks, so their concatenation equals a single decode. With an EOS granule, planes are allocated to that bound. Each read and loop seek waits until the frames it needs are final, then runs the complete-PCM reader unchanged, so the produced bytes are identical.
- **Error timing.** A decode error in a later packet now surfaces at the first read that needs those frames, as a native refill would see it, instead of when the stream opens.
- **Complete decoding.** These keep it: chained links, tracks without a plausible EOS granule (reads wait for completion), static sounds, paired exchange streams, and the diagnostic `OfflineAudioContext` profile.
- **Measurement.** The slot 4 freeze fell from about 265 ms to 50–58 ms at 1× in both profiles, measured as the longest gap between presents across the click. rAF gaps do not show it, because the main thread is idle while the VM waits.
- **Other Vorbis decodes.** Complete decodes run on reused `WorkerPool` workers. Creating a worker, loading libvorbis and compiling it per decode made an 89 KB clip take 68 ms for 12 ms of decoding. It now takes 22–24 ms.

### Glyph rasterization

Buriko text uses the native NONANTIALIASED DIB path: `BurikoBrowserFontFace.rasterText` (`src/engines/buriko/native/font-browser.ts`) fills one glyph into a supersampled canvas, reads it back, and thresholds alpha at 128. `BurikoFontRaster` then box-filters that to coverage. At Aokana's text quality the DIB is 16× the glyph cell, about 530–670 × 780–1010 samples. Each uncached glyph therefore reads back about 2.7 MB of RGBA. In slot 3 no character was rasterized twice, so a cache across layouts would not help. Batching readbacks would not help either, because the cost scales with pixels, not calls.

- **Both profiles.** `BurikoFontTextCanvas` (`font-canvas.ts`) keeps one configured context per DIB size. It clears in device space, because the face's horizontal scale can be below 1, and thresholds alpha as the sign of each 32-bit pixel. The old path created a canvas per glyph and resolved the CSS font on its first draw (`configure` and `scale` in profiles).
- **Browser optimized.** Before `buildBurikoHorizontalTextLayout` starts, `BurikoFontRaster.prefetch` collects the text's characters that are missing from the native glyph cache. It does not touch the cache or its order. The face sends them to at most two workers (`font-raster-worker.ts`), which rasterize with the same `BurikoFontTextCanvas`. The layout awaits the results, then runs unchanged, and its synchronous `rasterText` calls consume the stored DIBs. Only reads happen before the await, and the layout re-reads its text and font state afterwards. Resource fonts reach a worker as their own bytes and descriptors, sent once per worker. Faces loaded with `local()` stay in-thread. One prefetch holds at most 64 DIBs. Characters beyond that, in fonts other than the base font, or evicted within one layout rasterize in-thread as before. A failed job disables the offload for the session.
- **Diagnostics.** `buriko.text.raster.worker` times the round trip, and `.worker-applied` records 1 per successful prefetch and 0 per failure. `buriko.text.raster.prefetched` counts DIBs served from a prefetch.
- **A/B switch.** `?text-worker=0` keeps glyph rasterization on the main thread.
- **Measurements.** These are Aokana slot 3 captures at 6×, run under Browser optimized with `--frames --no-profile`. Before the change, main-thread gaps over 100 ms were 216, 208 and 124 ms, and `buriko.text.glyph.raster` totaled 816 ms. With the canvas reuse only (`?text-worker=0`), the gaps were 158 and 151 ms, and raster time was 566 ms. With workers, no gap exceeded 100 ms and raster time was 86 ms. All nine prefetches succeeded and served 78 of the 81 new glyphs. Worker round trips totaled 59 ms. Under Native, most slot 3 frames at 6× already take 100–135 ms. There the two glyph hitches fell from 217 and 208 ms to 150 and 149 ms, and raster time fell from 800 to 590 ms.
- **Verification.** `node tools/probe-buriko-font-raster.mjs` compares both paths with a fresh-canvas reference, byte for byte. It uses a resource font loaded from bytes (`--font`, macOS Arial Unicode by default) and the generic fallback family, sizes 18–42, width percentages 50–140 and sample scales 1, 4 and 16. It also reports worker results that were not consumed.

## Local profiling build

```sh
npm run build:profile
npm run start:profile
```

The build produces `site-profile/`, served at `http://127.0.0.1:8001/`. It keeps readable function names and source maps for local diagnostics. The normal `npm run build` output remains `site/`; `npm start` serves that normal build. Rebuild the profiling output after changing source, and reload the player before comparing captures.

Browser storage belongs to an origin and browser profile. `http://localhost:8001`, `http://127.0.0.1:8001`, and another port have separate saves, retained game files, and directory permissions. Use the same origin for repeat measurements. A fresh profile requires selecting the game files again; it does not inherit the normal browser's saves or permissions.

Each Vite invocation embeds a mode and UTC build timestamp through `src/platform/runtime-build.ts`. The diagnostics panel and JSON export read that same module constant, so a cached player identifies the bundle actually loaded. This stamp is diagnostic metadata; service-worker installation and activation still use the existing content-derived revision. Check the build identifier when comparing recordings after a rebuild.

The profiling build includes the service worker. An already open player keeps its loaded code, and an installed worker can keep serving the previous cached build. After rebuilding, close every tab and installed app window for that origin, then reopen it so a waiting update can activate. If an older build still appears, allow the update to download, close all its windows, and reopen once more. A reload alone does not necessarily activate a waiting worker. A new recorder profile starts without an old worker or cached build.

## Summarizing a DevTools CPU trace

A trace saved from the DevTools Performance panel contains sampled call stacks. `tools/summarize-cpu-trace.mjs` prints self and inclusive time per function from those samples, without opening the Performance panel:

```sh
node --max-old-space-size=8192 tools/summarize-cpu-trace.mjs trace.json \
  --lines decodeLegacy,checkpoint --callers copyIn --timeline 1000
```

- `--lines` splits the self time of the named functions by source line.
- `--callers` lists the heaviest caller chains that lead to the named functions.
- `--timeline` lists the top self-time functions in each bucket of the given width in milliseconds.
- `--thread` selects a profiled thread other than `CrRendererMain`.

Locations name the served chunk and line (`buriko-<hash>.js:<line>`). For a trace of the profiling build, open that line in `site-profile/assets/`. Each rebuild changes the chunk hashes, so keep the matching `site-profile/` build alongside a trace. Starting the CPU profiler costs about a second of main-thread time (`CpuProfiler::StartProfiling`). The samples charge that second as self time to whatever function was running at the start of the trace, usually at its first line. Discount self time that sits only at the start of a trace. Under DevTools CPU throttling, every per-call cost is multiplied, including `performance.now()` and typed-array allocation.

An open DevTools window, or any client that enables the CDP `Debugger` domain, switches WebAssembly to unoptimized debug code. The BP interpreter core then runs about 4–5× slower, which makes it slower than the TypeScript interpreter. Traces recorded from the DevTools Performance panel therefore misstate every WebAssembly cost, including `?bp-wasm=0` A/B comparisons. Profiler-only sampling (`Profiler.start` without `Debugger.enable`) does not change WebAssembly speed. For WebAssembly measurements, close DevTools and use the in-game timings, or collect samples over a CDP connection that never enables `Debugger`.

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
