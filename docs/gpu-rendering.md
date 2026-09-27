# GPU rendering research

Buriko uses the software renderer. An exact WebGL 2 composition experiment did not outperform it in the complete synthetic display workload below, so the player has no experimental GPU backend or selector. The experiment, numerical verifier, and results are preserved under [`tools/research/buriko-webgl`](../tools/research/buriko-webgl/README.md). They are outside the runtime build.

## Complete native traversal measurement

The archived production verifier exercises exported bitmap operations and the unmodified native display traversal with generated pixels and synthetic live text. It checks native bytes, textless presentation bytes, glyph metadata, observed values, native faults, and partial stores. Eligible cases must report completed GPU commands and readbacks; software fallback alone cannot pass them. Recovery after real WebGL context loss is included.

Observed on 2026-09-27 using headless Chromium 154 with ANGLE Metal on an Apple M4 Pro:

| Production scene measurement                                     | Software | WebGL 2 |
| ---------------------------------------------------------------- | -------: | ------: |
| Warmed 1920×1080 median, three frames, recorder enabled for both |  24.2 ms | 24.6 ms |
| First scene draw, recorder disabled for both                     |  19.0 ms | 48.9 ms |

All 61 numerical cases passed. Every measured GPU scene frame completed 2,208 commands with two readbacks and no software replay. Complete native and textless output buffers and glyph metadata matched software. The first GPU scene draw includes lazy context, shader, and resource initialization.

The measured backend groups independent destination regions into dependency waves and avoids redundant texture bindings and shader uniform updates. Overlapping draws retain their original order. Native strip coordinates and callback order remain unchanged. CPU command collection, text metadata, texture uploads, and synchronous readback remain part of the total.

This is approximate steady-state parity, not a demonstrated GPU speedup. The isolated shader results below do not establish a whole-engine benefit. Measurements on other adapters or heavier pixel workloads may differ; game cadence and asset presentation require user verification.

## Native equivalence requirements

Buriko exposes mutable CPU byte arrays and data views. Surface reads, exports, masks, aliases, display-texture updates, and textless presentation consume those pixels synchronously. Pending GPU writes must finish before these observations. Retained raw views mean a lazy storage getter alone cannot establish that every observation is intercepted.

An equivalent backend needs a bounded traversal containing known operations, or a flush before entering unknown code. Aliased buffers, unwritten bytes, released allocations, signed strides, partial stores before faults, and native worker callbacks remain observable. Unsupported cases must retain checked software traversal. GPU recovery may replay pure uncommitted pixel operations, but cannot repeat native object callbacks or notifications.

WebGL 2 integer textures, texel fetches, unsigned fragment outputs, and framebuffer readback can reproduce Buriko's pixel arithmetic without hardware filtering or alpha blending. An affine alpha shader must preserve wrapping Q16 coordinates, nearest-sample rounding, a zero border, four-bit interpolation fractions with horizontal flooring before vertical flooring, native Q7 alpha coefficients, and the destination alpha byte. Ordinary alpha composition also has distinct opaque-pair and odd-tail alpha-byte behavior. See the [WebGL 2 specification](https://registry.khronos.org/webgl/specs/2.0/).

The archived experiment covers initialized RGB clears, RGB copies, ordinary RGBA-over-RGB composition, and both RGBA-over-RGB affine samplers. It retains native strip setup and uses CPU fallbacks for unsupported operations and descriptors. Browser context/resource handling, integer staging, dependency scheduling, and completed readback are shared graphics code inside the patch; Buriko owns shaders and native admission rules. The resource budget is 128 MiB for CPU staging/readback, the dependency grid, and GPU pixel textures, excluding opaque driver overhead.

The maintenance cost includes two implementations of supported pixel arithmetic, CPU-observation barriers, callback and storage admission, textless presentation handling, context-loss recovery, and driver validation. A replacement needs a demonstrated gain across representative complete workloads before those responsibilities justify runtime integration.

## Runnable integer-kernel probe

`tools/benchmark-buriko-webgl.mjs` launches an isolated headless Chromium-family browser against a generated numeric fixture. It never loads a game, attaches to an existing browser, samples the CPU, takes screenshots, or presents the generated framebuffer. It compares WebGL output with the production scalar affine-alpha implementation and reports the actual adapter, browser version, uploads, submission time, and completed readback time.

```sh
npm run build:runtime
node tools/benchmark-buriko-webgl.mjs --browser '/path/to/chromium'
```

Node.js 22 or newer is required. Browser selection accepts `--browser`, `BROWSER`, or `CHROME_BIN`, then searches installed Brave/Chrome/Chromium. `--smoke` retains the scalar parity cases but uses a 256×144 timing workload and one measured run. `--iterations` accepts 1–20; the default is three. `--output` selects a new JSON file and rejects existing files. Results, browser logs, and the isolated profile remain in the printed temporary directory.

The workload uses initialized nonoverlapping RGBA sources and an RGB destination whose alpha byte is retained. Nearest and bilinear cases include borders, odd dimensions, transparency extremes, rotations, and wrapping Q16 coordinates. Timing strips partition one global Q16 coordinate field to isolate transfer overhead. They do not reproduce native per-strip transform setup, worker order, or a complete scene. Use the archived production verifier for those checks; its reproduction instructions are in the [research archive](../tools/research/buriko-webgl/README.md).

### Isolated shader measurements

On the same adapter and date, 96 single-operation cases matched all 39,219 output pixels. Values below are warmed medians of three 1920×1080 bilinear runs after one warmup per mode:

| Workload                                                                       | Completed time | Upload bytes | Readback bytes |
| ------------------------------------------------------------------------------ | -------------: | -----------: | -------------: |
| One layer, one draw and final readback                                         |         6.0 ms |     16.59 MB |        8.29 MB |
| One layer, 120 strips and final readback                                       |         6.5 ms |     16.59 MB |        8.29 MB |
| One layer, 360 strips and final readback                                       |         6.0 ms |     16.59 MB |        8.29 MB |
| One layer, readback after each of 120 strips                                   |        49.5 ms |     16.59 MB |        8.29 MB |
| One layer, readback after each of 360 strips                                   |        92.5 ms |     16.59 MB |        8.29 MB |
| One layer, source-region/destination upload and readback per 360 strips        |       146.8 ms |    188.01 MB |        8.29 MB |
| Eight layers, 120 strips each, alternating resident targets and final readback |         8.1 ms |     16.59 MB |        8.29 MB |

MB uses decimal bytes. Total time includes input uploads and synchronous readback, which waits for pending GPU work. Setup, shader compilation, texture allocation, and CPU staging allocation are excluded. Submission time alone does not measure completed GPU execution. The eight-layer case reuses one source; eight distinct cold sources require additional upload traffic. Nearest sampling showed the same synchronization trend.

## Existing shared graphics code

| Path                                          | Responsibility                                               | Constraint                                                                                                                |
| --------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `src/graphics/webgl-draw.ts`                  | WebGL 2 draw commands, textures, targets, and captures       | Normalized colors, floating-point shaders, and hardware blending do not automatically reproduce Buriko integer arithmetic |
| `src/graphics/draw-list.ts`                   | Engine-independent draw commands                             | Does not express native bitmap initialization or synchronous CPU visibility                                               |
| `src/graphics/canvas-frame-presenter.ts`      | Uploading completed software frames                          | Replacing presentation alone does not remove affine composition cost                                                      |
| `src/graphics/wasm-pixel-workspace.ts`        | Reusable pixel-buffer staging                                | Example of shared platform ownership for engine-independent staging                                                       |
| `src/engines/buriko/native/display-device.ts` | Native texture updates, quad sampling, movies, and captures  | Native CPU resources remain distinct from browser presentation                                                            |
| `src/engines/buriko/native/bitmap-affine.ts`  | Native coordinates, sampling, blending, and software kernels | Numerical reference for future alternatives                                                                               |

The existing shared WebGL draw-list renderer remains available to other engines. Future browser GPU abstractions belong under shared graphics code; native arithmetic and compatibility decisions belong in the engine adapter.

## WebGPU and future work

WebGPU compute and storage buffers fit native pixel arrays more directly than framebuffer draws. GPU-written buffers become available to the CPU through asynchronous mapping, which cannot silently replace synchronous native bitmap APIs. See the [WebGPU memory and mapping model](https://gpuweb.github.io/gpuweb/explainer/). OS and GPU coverage differs across browser implementations; consult the [implementation overview](https://developer.chrome.com/docs/web-platform/webgpu/overview) and retain software support.

A future evaluation should demonstrate a complete-workload benefit, including cold initialization, uploads, text provenance, native callbacks, and completed CPU readback. Moving more state permanently onto the GPU may change observable timing or mutation semantics. Such changes require an explicit browser-optimized runtime profile, separate from an equivalent implementation choice. Presentation-only acceleration is another bounded option, but must preserve native sampling and quantization to remain equivalent.
