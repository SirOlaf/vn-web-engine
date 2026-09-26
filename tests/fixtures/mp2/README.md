# Synthetic MP2 comparison fixtures

No game audio is included. `generate.mjs` builds eight frames per fixture:

- 44.1/48 kHz stereo and 32 kHz mono tones followed by zero-valued input, encoded
  with FFmpeg's `mp2` encoder. Stereo channels use different frequencies/gains.
- 44.1 kHz joint stereo constructed directly from grouped quantizer values. Its
  channels share subband4 samples but use different scalefactors. Header CRCs
  cover allocation and scalefactor-selection fields.

All reference PCM is decoded using FFmpeg `mp2float` with CRC checking and fatal
decode errors enabled. `.f32.gz` files contain gzip-compressed, interleaved
little-endian float32 PCM. `manifest.json` records FFmpeg's version and hashes of
the encoded streams and uncompressed PCM. The test itself needs only Node.

Regenerate with:

```sh
FFMPEG=/path/to/ffmpeg node tests/fixtures/mp2/generate.mjs
```

These synthetic fixture signals and the generator are original project material.
