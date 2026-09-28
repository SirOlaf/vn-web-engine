# Native Aokana bitmap SIMD kernels

This dependency-free Rust module accelerates initialized, separate Aokana bitmap
surfaces. `alpha_rgb` implements native spans 14003d950/14003cd30; `mix_all`
implements the bounded coefficient domain of 14003d3f0; `fused_rgb` implements
the bounded 03C8B0/03C580 crossfade and RGB composition path. `affine_copy` and
`affine_dim_copy` implement the validated copy and dimming branches of 052480.
`transition_rgb` implements the RGB32 masked transition 04BC40/04B860/04BA70/04B660. Integer SIMD preserves
native floors and the alpha table's 254/255 entries. Fully opaque pixel pairs copy
source alpha, a fully opaque odd tail clears alpha, and zero-alpha pairs and
alpha-zero/one tails retain their existing bytes.

The fused kernel truncates opacity-scaled alpha, premultiplied channels, their
crossfade, and retained destination channels at exactly the original stages.
Processed pixels clear output alpha. A pair whose two mixed alphas are zero
retains all destination bytes; a zero-alpha pixel paired with a nonzero-alpha
pixel still has its alpha cleared. A zero-alpha odd tail retains every byte.
This path accepts factors 0–256 and transparency 0–255 after native coercion.
Factors 0 and 256 use a single-source kernel specialization. Both input planes
still undergo the same host validation and staging; the selected source retains
its premultiplication floor, destination-retention floor, and pair/tail skips.
These endpoints therefore preserve crossfade behavior rather than substituting
the numerically different ordinary alpha blend.

The affine kernel consumes the native Q16 coordinate increments computed by the
TypeScript caller. Nearest sampling wraps the rounding addition to 32 bits;
bilinear sampling uses four-bit fractions, floors horizontally before vertically,
and samples transparent black beyond the source border. Only fully initialized
sources with positive signed-WORD dimensions/pitch and nonaliased, writable
destinations enter this path. It writes every output pixel, including transparent
border pixels, so temporary destinations need no input copy or prior initialization.
The dimming kernel multiplies each RGB byte by the native 16-bit `256 - transparency`
coefficient, keeps the low product word, and shifts it right by eight; alpha passes
through unchanged. When an RGB source feeds an alpha destination, every in-bounds
read, but no border sample, has alpha forced to 255 before interpolation. Opaque
`mix` blending reads old output and retains its existing JavaScript path.
Small damage rectangles also stay in JavaScript when the source contains more
than sixteen times as many pixels, avoiding a large staging copy for little work.

The transition kernel reads an 8-bit mask plane beside separate RGB32 source and
destination planes. Every native per-pixel decision depends only on the mask byte,
so the TypeScript reference derives a 256-entry action table (skip, copy, or a signed
coefficient) from its own coverage, bias, triangle-table and `extra` rules and writes
it to `transition_table()` before each call. Blends compute
`((difference << 4) * k) >> 16`, saturate each RGB channel, and retain destination
alpha; copies take the whole source pixel. The small-parameter Q7 product
`(difference * c) >> 7` is supplied as `k = 32c`, which is exact for its `c < 128`
domain. Shared or overlapping storage uses a checked-once JavaScript traversal in
native pixel order instead, and any partially initialized, out-of-range or unusual
descriptor keeps the per-pixel checked path, preserving the exact fault pixel.

The native TypeScript caller retains unusual coefficients, aliases (including
separate views of one buffer), overlapping byte ranges of one buffer, overlapping or reverse rows,
unwritten source/destination reads, and invalid descriptors. This preserves pair load/store order and writes
completed before a later checked access faults. Ordinary coefficients are limited
to integral transparency 0–256. Spans below 1,024 pixels stay in JavaScript because
staging can outweigh SIMD savings. Alpha and fused blending also keep padded spans
narrower than 128 pixels in JavaScript.

`alpha_rgb` and the three affine kernels take a source and destination stride in
pixels, so they can address resident rows in place (see below). `alpha_rgb` Its host stages each
padded plane as one pitched copy when that copy is at most twice the packed rows,
otherwise row by row, and returns a pitched destination in one copy. The kernel never
writes the bytes between rows, so that copy restores their staged original values.

The reusable `src/graphics/wasm-pixel-workspace.ts` owns compact row staging,
including an optional second source for fused operations (which may pack a different
row width, as the 8-bit transition mask does) and independently sized
input/output planes for transforms, and
bounded linear-memory growth, capped at 128 MiB. The native caller and this crate
own bitmap numerical policy. Source/destination bytes are copied afresh on every
call; affine copies omit the old destination contents. The module has no imports, allocator,
WASI, relaxed SIMD, or host callbacks. Unsupported Wasm/SIMD or memory allocation
failure selects the existing JavaScript implementation.

## Resident bitmaps

Most Buriko bitmap storage lives inside a second instance of this module, so
kernels read and write it in place instead of staging it per call.
`src/graphics/wasm-resident-heap.ts` reserves the whole budget with one `grow`
when that instance is created and never grows it again. The memory's
`ArrayBuffer` therefore never detaches, and it stays a fixed-length buffer. That
matters: JavaScript pixel loops over views of a resizable buffer
(`toResizableBuffer`) ran several times slower in V8, which cancelled the kernel
savings. Untouched pages cost no physical memory; a failed reservation retries
with halves down to 64 MiB, then leaves residency off.

`src/engines/buriko/native/bitmap-resident.ts` owns the instance, the device-dependent budget
(384 MiB with 8 GiB or more of device memory, 256 MiB with 4 GiB or when unknown, 128 MiB
below that) and the 16 KiB minimum size. Kernel calls never create the instance. `BurikoBitmapStorage.allocate`, `adopt` and
`cloneRange` place storage there when it fits, and ordinary buffers otherwise.
The display textures, native surfaces, decoded images and raster-text presentation
planes (which replay every draw) all qualify. Blocks are first fit with
coalescing, zeroed on reuse, and freed on `release()` or, for storage that is
only collected, by a `FinalizationRegistry`. Resident bytes must never be
retained past their storage. The staging instance remains separate because DSC
and staged kernels reuse its scratch area from `__heap_base`.

Many storages share the resident buffer, so buffer identity no longer means
aliasing: callers use `byteSpansOverlap`/`viewsOverlap` from `src/core/binary.ts`.
A kernel runs in place only when every plane is resident, 4-byte aligned where
it holds pixels, and the destination overlaps no source. The packed-only kernels
(`mix_all`, `mix_rgba`, `fused_rgb`, `transition_rgb`, `reduce_half`)
additionally need packed rows. Any other call stages through the workspace as
before; `buriko.bitmap.wasm-resident` counts both outcomes, and
`buriko.bitmap.wasm-staged-plane` names the plane that forced staging. The
player's `?bitmap-resident=0` switch disables residency for A/B captures.

`dsc_decode` (`src/dsc.rs`) decodes DSC FORMAT 1.00 resources for
`src/engines/buriko/native/dsc-wasm.ts`. It reproduces the key-stream code
lengths, level-order canonical tree, and node limit of `src/formats/buriko/dsc.ts`.
Every failure returns a nonzero status, and the host reruns the TypeScript
decoder to raise the reference error. Codes of up to 12 bits and their distance
bits are read with one prefix lookup from a 64-bit buffer. Longer codes and the
end of the stream use a scalar tree walk. Literals and repeats store 16-byte
chunks; repeats shorter than 16 bytes use shuffle tables. The host supplies
eight zero padding bytes after the input and 16 bytes of output slack.

The `cbg_*` exports (`src/cbg.rs`) implement the entropy, run, and predictor
stages of legacy CompressedBG (0x1400bfa50) for
`src/engines/buriko/native/compressed-bg-wasm.ts`. The TypeScript decoder
retains the header, checksum, header publication, and frequency tree, and remains
the reference. `cbg_tables` builds a length table, a four-symbol table, and a
first-node table from the tree. Only the length byte lies on the decoder's
dependency chain. `cbg_entropy` reads a 64-bit bit buffer and uses a scalar tree
walk for codes longer than the prefix. `cbg_runs` expands the alternating
literal and zero runs, and `cbg_predict` reconstructs whole rows. The 24- and
32-bit predictors add sixteen-bit lanes of one 64-bit word. Every stage resumes
from state passed by the host, so a decode yields between bounded steps. Any
entropy or run failure returns a negative status. The host then reruns the
TypeScript stages to raise the reference error. Both stages write only instance
memory, so no destination pixel has been written at that point.

A decode can yield to the host while its intermediate data is live, and other
kernels use the shared instance's scratch memory during those yields. Each CBG
decode therefore leases a private instance of this module, and one idle instance
of at most 32 MiB is kept. Every entropy step stages the 128 KiB bitstream window
it reads. Each predictor step restages the destination row above its first row.
Rows publish their pixels, then their initialization. When pixel and
initialization views overlap, each row restages its upper row after the previous
row's initialization.

Rebuild with `npm run build:wasm`. This performs locked, offline Cargo builds of
both graphics crates and embeds their generated binaries. Normal `npm run build`
requires neither Rust nor separately served Wasm assets. The current artifact uses
`rustc 1.100.0-nightly (bba531001 2026-09-20)` with `-C target-feature=+simd128`.

Validation uses synthetic numeric buffers, including every source alpha in pair
and odd-tail positions, bounded and unusual coefficients, row padding, byte
subarrays, shifted aliases, reverse/overlapping rows, and memory growth. Existing
bitmap system tests cover checked fault/store semantics. No rendered assets are
needed. Performance measurements must include every input copy and the output copy;
packed and padded rectangles have different staging costs.
