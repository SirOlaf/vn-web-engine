`vorbis-boundaries.ogg` is a generated 440 Hz cosine, mono, 48 kHz, exactly 4,109 frames.
It contains no game assets. `generate-vorbis-boundaries.c` generates the stream with
libvorbisenc 1.3.7 (quality 0.4, Ogg serial 1729).

`vorbis-boundaries.f32` contains the first 128 followed by the last 128 decoded samples,
as little-endian float32 from native libvorbisfile 1.3.7 (`ov_read_float`). It is a
boundary oracle, not the original input: Vorbis is lossy.

WebKit 26.5 `OfflineAudioContext.decodeAudioData` returns only 3,981 frames for this
fixture, while native libvorbis returns all 4,109. The regression checks both sample
count and actual boundary PCM so padding or trimming cannot pass it.

Regenerate the Ogg file with a C compiler and libvorbis development headers/libraries:

```sh
cc generate-vorbis-boundaries.c -lvorbisenc -lvorbis -logg -lm -o generate-vorbis-boundaries
./generate-vorbis-boundaries vorbis-boundaries.ogg
```
