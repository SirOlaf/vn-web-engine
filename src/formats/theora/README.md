# Theora

`readTheoraOgg` demultiplexes the first Theora logical stream of an Ogg file and parses
its identification, comment and setup headers (`headers.ts`). `TheoraDecoder` decodes
Theora I data packets into three planes of the full, macroblock-aligned frame.

The decoder follows libtheora's arithmetic, so frames match `th_decode_ycbcr_out`
byte for byte with post-processing level 0:

- coded flags from superblock long runs and block short runs, macroblock mode schemes
  0–7, VLC/fixed motion vectors (four-vector macroblocks update the last vector once,
  with their last coded block), and long-run block qi indices;
- DCT tokens per token index over coded luma then chroma fragments, with end-of-block
  runs crossing fragments, planes and token indices; a zero `R12` run ends all
  remaining blocks;
- DC prediction per plane in raster order from coded neighbours with the same
  reference frame, including the 29/−26/29 outlier fallback;
- libtheora's 16-bit iDCT, and its DC-only shortcut `(dc·q + 15) >> 5` when no token
  went past index 1, which differs from the full iDCT for large DC values;
- half-pel luma and quarter-pel decimated chroma prediction (truncation, second offset
  away from zero, averaged), edge clamping equivalent to libtheora's border padding;
- the loop filter over coded fragments (left, bottom, then right/top edges next to
  uncoded fragments) on the frame that becomes the reference.

Planes are stored bottom-up as in the bitstream; `copyPlane` writes them top-down.
An empty packet repeats the previous frame (`decode` returns false). Inter frames
before the first key frame predict from mid-grey references, as libtheora does.
4:2:0, 4:2:2 and 4:4:4 are supported.

`tests/theora.test.mjs` compares per-frame SHA-256 hashes of synthetic FFmpeg test
patterns with libtheora's decoder (`tests/fixtures/theora/`).
