# MPEG-1 Layer II audio

`decoder.ts` exports `Mp2Decoder`, `readMp2Header`, `Mp2Header` and `Mp2PcmFrame`.
The decoder accepts elementary-stream bytes at arbitrary chunk boundaries:

```ts
const decoder = new Mp2Decoder();
const frames = decoder.push(bytes);
decoder.flush(); // Throws if a partial frame remains.
```

Each output frame contains independent planar `Float32Array[]` channels,
`sampleRate`, and a cumulative per-channel `startSample`. Frames contain 1152
samples per channel. Synthesis history persists between frames. The decoder has
no browser, filesystem, playback, or game dependency.

The header helper returns null for fewer than four available bytes and throws on
unsupported/malformed complete headers. It exposes the frame size, sample rate,
channel count, bitrate in bits per second, channel mode and CRC presence.

Supported streams use MPEG-1 Layer II table bitrates at 32, 44.1 or 48 kHz, with
mono, stereo, dual-channel or joint-stereo coding. Bitrate and padding may change
between frames. Sample-rate/channel-count changes require a new decoder.
Free-format framing and other MPEG versions/layers are explicitly unsupported.
Output PCM precedes optional analog de-emphasis, as with FFmpeg's MP2 decoder.

Every bit read is bounded to its complete frame. Invalid sync/header fields,
reserved quantizer codes, protected-header CRC mismatches and truncated final
frames throw. Decoder errors are terminal. Input chunks are limited to 1 MiB and
256 completed frames to bound retained PCM; feed smaller chunks for long streams.

The synthesis transform, window and allocation tables are adapted from
[JSMpeg's MP2 decoder](https://github.com/phoboslab/jsmpeg/blob/c5fabf047f1161bcec51bca68ca7c32d377753d8/src/mp2.js),
Copyright (c) 2017 Dominic Szablewski, under the accompanying MIT [LICENSE](LICENSE).
JSMpeg credits kjmp2 by Martin J. Fiedler. `source.json` pins the upstream commit,
path and original file SHA-256. No JSMpeg player or audio host is included.

This adaptation uses normalized requantization and floating accumulation instead
of JSMpeg's approximate integer path, which inverted polarity and produced about
half amplitude. Joint stereo uses the distinct scalefactors for both channels.
The framing, incremental API, CRC checking and bounded reads are local additions.

`tests/mp2-system.test.mjs` compares chunked decoding against FFmpeg `mp2float`
references generated entirely from synthetic tones, silence and constructed
CRC-protected joint-stereo frames. It does not depend on FFmpeg at test time or
play audio. The observed largest difference is below 5.4e-7, with RMS below
1.2e-7 across the fixtures.
