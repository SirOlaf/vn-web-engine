# Native Aokana bitmap SIMD kernels

This dependency-free Rust module accelerates initialized, separate Aokana bitmap
surfaces. `alpha_rgb` implements native spans 14003d950/14003cd30; `mix_all`
implements the bounded coefficient domain of 14003d3f0; `fused_rgb` implements
the bounded 03C8B0/03C580 crossfade and RGB composition path. `affine_copy` implements
the validated copy branch of 052480. Integer SIMD preserves
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
Copy dimming and destination blending retain their existing JavaScript path.
Small damage rectangles also stay in JavaScript when the source contains more
than sixteen times as many pixels, avoiding a large staging copy for little work.

The native TypeScript caller retains unusual coefficients, aliases (including
separate views of one buffer), shared backing buffers, overlapping or reverse rows,
unwritten source/destination reads, and invalid descriptors. This preserves pair load/store order and writes
completed before a later checked access faults. Ordinary coefficients are limited
to integral transparency 0–256. Spans below 1,024 pixels stay in JavaScript because
staging can outweigh SIMD savings. Alpha and fused blending also keep padded spans
narrower than 128 pixels in JavaScript.

The reusable `src/graphics/wasm-pixel-workspace.ts` owns compact row staging,
including an optional second source for fused operations and independently sized
input/output planes for transforms, and
bounded linear-memory growth, capped at 128 MiB. The native caller and this crate
own bitmap numerical policy. Source/destination bytes are copied afresh on every
call; affine copies omit the old destination contents. There is no ownership or
content cache. The module has no imports, allocator,
WASI, relaxed SIMD, or host callbacks. Unsupported Wasm/SIMD or memory allocation
failure selects the existing JavaScript implementation.

`dsc_decode` (`src/dsc.rs`) decodes DSC FORMAT 1.00 resources for
`src/engines/buriko/native/dsc-wasm.ts`. It reproduces the key-stream code
lengths, level-order canonical tree, and node limit of `src/formats/buriko/dsc.ts`.
Every failure returns a nonzero status, and the host reruns the TypeScript
decoder to raise the reference error. Codes of up to 12 bits and their distance
bits are read with one prefix lookup from a 64-bit buffer. Longer codes and the
end of the stream use a scalar tree walk. Literals and repeats store 16-byte
chunks; repeats shorter than 16 bytes use shuffle tables. The host supplies
eight zero padding bytes after the input and 16 bytes of output slack.

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
