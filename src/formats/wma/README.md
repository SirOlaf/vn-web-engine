# WMA audio

`src/video/windows-media.ts` selects these decoders for ASF audio playback, using
Rust SIMD when available and the same TypeScript front end with JavaScript kernels
otherwise. The facade preserves the shared player API and owns stream lifetime.

`WmaLosslessDecoder` in `lossless.ts` decodes complete ASF audio media objects
to caller-owned planar float, retaining packet timestamps and the decoder's
end-of-stream sample trim. `decode(null)` drains the bit reservoir; further
drain calls return an empty array. `close()` is idempotent.

The supported Lossless configuration is stereo, 16 or 24 bits, 44.1 or 48 kHz,
channel mask 3 and compression flags `0x1a1`. Frames contain 2048 samples per
channel, split into as many as sixteen variable-length tiles. The decoder
implements raw PCM, adaptive Rice residues, cascaded LMS prediction,
multichannel LMS prediction, stereo decorrelation, AC prediction, quantization
and padding. Arithmetic coding, splicing and the inverse LPC tool are rejected.
The latter also lacks a working inverse filter in the source decoder.

`createWmaLosslessDecoder` in `wasm-decoder.ts` constructs the shared TypeScript
front end with the Rust SIMD backend, or returns `null` if WebAssembly SIMD is
unavailable. The caller can then construct the JavaScript implementation. Each
accelerated instance reserves a private 512 KiB arena before creating typed-array
views. Reservoir, coefficients, prediction histories and reconstruction buffers
remain in that arena. Entropy decoding and cascaded prediction cross the ABI
once per coded channel per tile; stereo/AC reconstruction crosses once per tile.
The JavaScript implementation uses the same wrapping integer arithmetic and
reusable typed arrays, without allocating in sample loops.

Codec packets are bounded to 64 KiB, compressed media objects to 16 MiB and the
bit reservoir to 64 KiB. The bit reader is shared with `../vc1/bitstream.ts`.
No codec packet is read from disk by this module. ASF demuxing belongs to
`../asf`; the player owns scheduling and worker execution.

`tests/wma-lossless.test.mjs` generates synthetic raw PCM and adaptive-prediction
packets, including signed samples, end trim and isolation checks. No media
fixture is required. `tools/benchmark-wma.mjs` compares PCM hashes and warmed
decode timings against an existing decoder build without displaying or saving
decoded audio.

The implementation is derived from FFmpeg 7.1.1 under LGPL 2.1 or later. See
[NOTICE](NOTICE) and [LICENSE](LICENSE).

`WmaStandardDecoder` in `standard.ts` implements stereo WMA v2 with VLC exponents,
bit reservoir and five variable block sizes (128 through 2048). Supported streams
have flags `0x000f`, or `0x0001` for fixed blocks without a reservoir,
44.1/48 kHz rates and bitrates that disable noise coding.
Spectral run/level decoding, independent or mid/side stereo, float IMDCT and
overlap windows preserve the source decoder's float operation order. The first
4096 samples are suppressed, with the corresponding packet timestamp adjustment;
draining returns the final 2048 samples of overlap output.

`imdct.ts` supplies the power-of-two split-radix inverse MDCT and bounded sine
window caches. The float angle is rounded before evaluating each window's sine.
Transform calls use caller-supplied buffers and allocate no temporary arrays.
`standard-tables.ts` contains exponent, coefficient and frequency-band tables.
Standard packets are bounded to 32 KiB, media objects to 16 MiB and the reservoir
to 32 KiB. `createWmaStandardDecoder` selects the Rust backend, returning `null`
when acceleration is unavailable so callers can use `WmaStandardDecoder` as the
fallback. The packet front end and Rust block loop share a private 512 KiB arena.
One frame crosses the ABI once; entropy, coefficient scaling, stereo, IMDCT and
overlap windows execute in Rust, with SIMD for contiguous scaling and windowing.
The front end copies completed PCM into caller-owned output.

`WmaProDecoder` in `pro.ts` implements the stereo 24-bit, 44.1 kHz Pro profile
with channel mask 3 and flags `0x00e0`. Length-prefixed frames contain 2048
samples and support 128–2048 sample tiles, DPCM scale factors, scale-factor
resampling and run/level updates, vector and run/level coefficients, and
band-selective stereo reconstruction. The inverse quantizer preserves float
rounding before a middle-half IMDCT and sine overlap window. The first decoded
frame is suppressed; explicit start/end trims reduce the returned sample count
without changing its timestamp. Draining returns no additional output, matching
the source codec's lack of delayed-output capability.

Pro codec packets and the bit reservoir are bounded to 32 KiB, media objects to
16 MiB. Each channel retains 1024 samples of overlap between 2048-sample frames.
Multichannel layouts, XMA variants and reserved transform modes are rejected.
Postprocessing and DRC fields are consumed as metadata, matching the source decoder.
`pro-tables.ts` supplies canonical VLC and coefficient tables. `createWmaProDecoder`
uses the shared Rust arena and returns `null` when acceleration is unavailable.
The TypeScript front end parses packet/frame metadata and tiling, then calls Rust
once per frame for scale factors, coefficients, stereo, inverse quantization,
IMDCT and overlap. Channel histories and predictors stay in the same private arena.
The direct `WmaProDecoder` constructor provides the typed-array JavaScript fallback.
