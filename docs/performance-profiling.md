# Performance diagnostics

Use **Game options → Performance diagnostics** first when DevTools CPU sampling crashes the tab. Click **Start recording** immediately before a slow story or character transition, reproduce the delay, click **Stop recording**, then **Download timings JSON**. Keep DevTools Performance recording closed during this capture. These measurements describe elapsed wall time in instrumented operations, long tasks, and event-loop delay; they are not CPU samples or a JavaScript call tree. Time spent awaiting a worker, decoding, or I/O can contribute to an operation's elapsed time. Nested operations overlap, so their durations must not be added together as independent costs.

This recorder is opt-in and keeps results in memory. Starting another recording replaces the previous one; reloading loses it, so download before reloading. The JSON includes category aggregates, spans lasting at least 4 ms (16 ms for outer frame and scheduler events; 8 ms for sprite drawing), long tasks when the browser supports observation, and delays of at least 16 ms on a 100 ms event-loop timer. All completed spans contribute to aggregates even below their event threshold. It retains at most 2,048 events and 128 aggregate categories, reporting overwritten events and overflowed category samples. Background throttling also delays timers; keep the tab visible and use the recorded visibility changes when interpreting stalls. No pixel data, asset paths, or sampled stacks are included.

Take a short capture around one reproducible interaction. Include the browser version, game, action, and whether it was the first run or a repeat with the downloaded file. A complete JSON export is more useful than a screenshot of the display. Neither this workflow nor the trace recorder requires game screenshots; do not enable screenshot recording or capture game-image pixels.

## Runtime timing categories

The recorder lives in `src/platform/runtime-performance.ts`; instrumentation uses fixed technical names and numeric dimensions, never resource names or game text. Recording is disabled by default. BGI currently records these boundaries:

| Category                                                             | What the duration includes                                                                                                             |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `buriko.frame` / `buriko.vm.scheduler`                               | Outer frame or native BP traversal, including waits and scheduling points                                                              |
| `buriko.vm.sync-slice`                                               | BP instructions between awaits or host yields, with an instruction count                                                               |
| `buriko.vm.shared-worker` / `buriko.vm.shared-slice`                 | Shared child lifetime, or work between explicit Promise/host waits; slices include numeric-await microtasks and report dispatch counts |
| `buriko.native.sync`                                                 | Native handler invocation before it returns a result or Promise, with numeric primary/secondary opcode IDs                             |
| `buriko.native.async-elapsed`                                        | Returned native Promise through settlement; includes resumed CPU work as well as waits                                                 |
| `buriko.process.poll-sync` / `buriko.process.finish`                 | Process poll invocation, or completion and disposal                                                                                    |
| `buriko.process.poll-async-elapsed`                                  | Returned process Promise through settlement, before completion and disposal                                                            |
| `buriko.text.advance` / `buriko.text.emit`                           | Synchronous base-message advancement or prepared-message emission                                                                      |
| `buriko.sprite.draw.*`                                               | One synchronous sprite draw, grouped by selected drawing mode; slow events include dimensions and effect flags                         |
| `buriko.sprite.mipmaps` / `buriko.sprite.mix` / `buriko.sprite.wave` | Sprite mipmap regeneration, cached source mixing, or wave generation, with numeric dimensions and parameters                           |
| `buriko.text.prepare`                                                | Extended-message preparation, including readings and layout                                                                            |
| `buriko.bmv.decode` / `buriko.bf.decode`                             | Animation I/O and decode, or the BF decode alone, including host yields                                                                |
| `host.cooperative.slice`                                             | An uninterrupted segment of a cooperative computation                                                                                  |
| `buriko.display.draw-*`                                              | Synchronous composition before presentation                                                                                            |
| `buriko.display.present`                                             | Browser presentation and its wait                                                                                                      |
| `buriko.loader.job`                                                  | One iteration of the resource/audio/script loader                                                                                      |
| `buriko.audio.refill` / `buriko.audio.command.*`                     | Streaming refill or a command's browser audio acknowledgement                                                                          |
| `source.local-read` / `source.remote-read`                           | A shared Blob or HTTP range read, including its asynchronous wait but excluding subsequent decoding                                    |

Compare slow spans with overlapping `browser.long-task` events and event-loop delays. A long decode with short cooperative slices and prompt audio acknowledgements differs from an uninterrupted composition stall. The recorder cannot attribute a browser crash to the last operation it observed, and a completed-span recording is lost if the renderer crashes before export.

For a scheduler stall, first find overlapping `buriko.native.sync`, process, and text events. Convert native event `primary` and `secondary` numbers to hexadecimal and locate the slot in `src/engines/buriko/native/inventory*.ts` and the corresponding `group-*` factory. Opcode details are retained on slow events, while aggregates group native calls together to avoid one category per opcode. A short native invocation with a long `async-elapsed` interval does not prove I/O is slow: shared interpretation and asynchronous continuations can perform CPU work during that interval. If native calls are individually short, inspect interpreter slices for accumulated instruction work. An audio refill duration begins when its callback runs; delayed callback delivery can starve audio without producing a long refill span.

`src/core/host-task-budget.ts` provides a 4 ms default cooperative budget. Its checkpoints yield through a host task, allowing timers and audio messages to run. The BF decoder shares one budget across coefficient, alpha, and reconstruction steps; the BP scheduler checks after each continuing instruction and process poll while retaining native burst counts and child order. Shared interpreters also check between instructions and carry one budget across the indexed workers, preserving numeric-result microtask ordering and child actor ownership. This is a scheduling target, not preemption: allocation, garbage collection, synchronous rendering, and any individual step can exceed the budget. Extend checkpoints only where borrowed storage, native actor identity, and callback order remain valid.

## Sprite pixel processing

Affine sprite setup (`90:5c`) regenerates mipmap chains and the selected mixed/wave sources. Property and display-control updates can rebuild those sources again. The `buriko.sprite.*` spans identify each phase and its dimensions. Cache rebuild order and native pixel results are preserved even when a property repeats its previous value.

Sprite draws use fixed categories for `simple`, `blend`, `affine`, `reveal`, `displacement`, `affine-blend`, and `mesh`, corresponding to selected modes 0–6. A configured affine sprite can select the simple path at unit scale and zero angle; the category describes the selected path. Sum the seven span categories to compare with older captures' single `buriko.sprite.draw` aggregate. Every draw also contributes metrics under its category: `width`, `height`, `pixels`, destination `format` (1 for RGB, 2 for RGBA), `sampling` (0 for nearest, 1 for interpolated), `blend-mode`, `effects`, and `mask`. Sampling only affects paths that use it. The boolean metric totals count enabled draws; dimensions describe the requested draw rectangle, not the number of nontransparent pixels. These aggregates expose repeated small draws that never reach the 8 ms event threshold. Check the aggregate `kind` before summing durations: pixel and dimension metrics are not milliseconds.

`bitmap-reduce.ts` and `bitmap-mix.ts` use validated buffer views to avoid per-pixel storage checks. Reduction preserves vertical-before-horizontal rounded byte averaging, odd edges, and pair load/store ordering. Bounded RGBA mixing retains the measured native reciprocal quantization; its coefficient cache holds at most one factor's 65,536 alpha pairs and populates entries on demand. Small, aliased, or unsupported buffers use JavaScript. Invalid or partially initialized descriptors retain scalar access checks and partial-write fault behavior.

The RGBA kernel lives in `wasm/aokana-bitmap/src/lib.rs`; regenerate its embedded binary with `npm run build:wasm`. Buffer staging uses the shared `src/graphics/wasm-pixel-workspace.ts`. Compare complete sprite operations, including allocation and buffer copies, when evaluating this path. WASM calls are synchronous and do not yield to browser tasks; the scheduler checks its host budget after the operation returns. Unavailable WASM keeps the JavaScript implementation usable.

Native display jobs divide each damage rectangle into horizontal strips using the configured pixel budget. For example, a budget of 6,406 pixels at width 1,920 produces three-row strips. Each strip retains native object traversal and affine coordinate setup; merging strips can change rounding and object/worker order. Many small draw calls can therefore represent a few large sprites, rather than hundreds of separate sprites.

`bitmap-affine.ts` accelerates initialized RGBA-to-RGB affine draws across rotations, scales, crops, and both sampling modes. Its packed JavaScript arithmetic retains horizontal-before-vertical Q4 interpolation, wrapping Q16 coordinates, native Q7 opacity quantization, and destination alpha. The WASM path stages a conservative rectangle containing every source sample and its bilinear neighbors, together with the old destination. It rejects accumulator overflow before calculating that rectangle; rebasing into the staged source preserves sampled pixels and fractional bits. This avoids copying the entire source image for each thin destination strip. Small draws, excessive source footprints, and unsupported WASM use JavaScript; aliases, partially initialized storage, and unusual descriptors retain checked native traversal and fault order.

Pixel metrics distinguish `buriko.affine.alpha.bounded-pixels` (WASM or a proven empty source footprint), `buriko.affine.alpha.js-pixels`, and `buriko.affine.alpha.checked-pixels`. Separate `buriko.affine.copy.pixels`, `.dim.pixels`, and `.mix.pixels` categories identify other affine operations. Each metric's count is an invocation count and its total is requested destination pixels, not elapsed time. Integral aligned draws can take the existing compositor shortcut without entering an affine pixel kernel.

The affine scene benchmark exercises complete display-manager traversal with two generated RGBA layers, nearest and bilinear sampling, fractional coordinates, and 720 strip draws into a 1080p RGB target. It uses no game files or presentation surface:

```sh
npm run build:runtime
node tools/benchmark-aokana-hotspots.mjs "" "Affine scene"
```

Pass a previous compiled `dist` directory as the first argument to compare output bytes and median timings against that build. The benchmark measures general affine composition, including native strip traversal; dimensions and layer counts are synthetic workload parameters, not engine dispatch conditions. Browser recordings remain necessary to measure animation cadence and audio responsiveness.

## File-read throughput

Shared source read spans retain numeric requested/completed byte counts and success on slow events. The `source.local-read.completed-bytes` and `source.remote-read.completed-bytes` metrics include successful reads below the event threshold. Their totals divided by recording duration measure delivered bytes per second over the capture; dividing by summed read durations instead measures bytes per accumulated read time. Overlapping reads make those quantities different. Reads that started before recording can contribute completed bytes without a latency span. The recorder observes its own JavaScript context; reads performed exclusively inside a separate browser worker require forwarding that worker's measurements. Compare source spans with loader and decode spans before attributing loading time to storage. No source paths, URLs, or game text are retained.

`src/core/source.ts` reads each requested Blob slice in one operation and issues one HTTP range request per remote read. Neither path imposes a read-chunk cap. `SliceSource` forwards the bounded range to its underlying source. Buriko retains the native serial loader order and reopens archive members' backing files so replacements remain observable. The installation cache's 4 MiB chunks apply to saving an installation into browser storage, not ordinary reads from a running game.

The [File API](https://www.w3.org/TR/FileAPI/) specifies slice and buffer-read behavior without a portable throughput limit. The [File System Standard](https://fs.spec.whatwg.org/) restricts synchronous access handles to origin-private files in dedicated workers; they cannot directly replace reads from arbitrary selected game files. Measure the actual backend and workload before changing read sizes or concurrency.

## Local profiling build

```sh
npm run build:profile
npm run start:profile
```

The build produces `site-profile/`, served at `http://127.0.0.1:8001/`. It keeps readable function names and source maps for local diagnostics. The normal `npm run build` output remains `site/`; `npm start` serves that normal build. Rebuild the profiling output after changing source, and reload the player before comparing captures.

Browser storage belongs to an origin and browser profile. `http://localhost:8001`, `http://127.0.0.1:8001`, and another port have separate saves, retained game files, and directory permissions. Use the same origin for repeat measurements. A fresh profile requires selecting the game files again; it does not inherit the normal browser's saves or permissions.

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
