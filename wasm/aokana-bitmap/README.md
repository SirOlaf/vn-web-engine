# Native Aokana bitmap SIMD kernels

This dependency-free Rust module accelerates initialized, separate Aokana bitmap
surfaces. `alpha_rgb` implements native spans 14003d950/14003cd30; `mix_all`
implements the bounded coefficient domain of 14003d3f0; `fused_rgb` implements
the bounded 03C8B0/03C580 crossfade and RGB composition path. Integer SIMD preserves
native floors and the alpha table's 254/255 entries. Fully opaque pixel pairs copy
source alpha, a fully opaque odd tail clears alpha, and zero-alpha pairs and
alpha-zero/one tails retain their existing bytes.

The fused kernel truncates opacity-scaled alpha, premultiplied channels, their
crossfade, and retained destination channels at exactly the original stages.
Processed pixels clear output alpha. A pair whose two mixed alphas are zero
retains all destination bytes; a zero-alpha pixel paired with a nonzero-alpha
pixel still has its alpha cleared. A zero-alpha odd tail retains every byte.
This path accepts factors 0–256 and transparency 0–255 after native coercion.

The native TypeScript caller retains unusual coefficients, aliases (including
separate views of one buffer), shared backing buffers, overlapping or reverse rows, partially initialized
storage, and invalid descriptors. This preserves pair load/store order and writes
completed before a later checked access faults. Ordinary coefficients are limited
to integral transparency 0–256. Spans below 1,024 pixels, and padded spans narrower
than 128 pixels, stay in JavaScript because staging can outweigh SIMD savings.

The reusable `src/graphics/wasm-pixel-workspace.ts` owns compact row staging,
including an optional second source for fused operations, and
bounded linear-memory growth, capped at 128 MiB. The native caller and this crate
own bitmap numerical policy. Source/destination bytes are copied afresh on every
call; there is no ownership or content cache. The module has no imports, allocator,
WASI, relaxed SIMD, or host callbacks. Unsupported Wasm/SIMD or memory allocation
failure selects the existing JavaScript implementation.

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
