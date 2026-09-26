# Ogg Vorbis decoder attribution

The shared audio decoder bundles the low-level `Decoder` export from
`@wasm-audio-decoders/ogg-vorbis` **0.1.20**, including its embedded WebAssembly.
The exact npm version and integrity are recorded in `package-lock.json`. The package's
published `gitHead` is
[`6fe55b9a29543d0a5a2d896338c39199a81d9a58`](https://github.com/eshaz/wasm-audio-decoders/tree/6fe55b9a29543d0a5a2d896338c39199a81d9a58).

The browser bundle retains the decoder, its shared helpers and `simple-yenc`. The
high-level `OggVorbisDecoder` and upstream worker wrapper are removed by tree shaking;
the project provides its own Ogg packet handling and worker. The build checks that the
LGPL `codec-parser` dependency is excluded from the distributed decoder bundle. It is
still installed by npm as an upstream package dependency; this notice does not relicense
that dependency or upstream's complete prebuilt bundle.

| Included component | License and provenance |
| --- | --- |
| `@wasm-audio-decoders/ogg-vorbis` 0.1.20 and `@wasm-audio-decoders/common` 9.0.7 | MIT; Ethan Halsall. The published decoder banner carries copyright 2021–2025. Upstream declares the license in its [package metadata](https://github.com/eshaz/wasm-audio-decoders/blob/6fe55b9a29543d0a5a2d896338c39199a81d9a58/src/ogg-vorbis/package.json) and [licensing section](https://github.com/eshaz/wasm-audio-decoders/blob/6fe55b9a29543d0a5a2d896338c39199a81d9a58/README.md#licensing). |
| `simple-yenc` 1.0.4 | MIT; copyright 2021–2023 Ethan Halsall. The notice is copied from the installed package's `LICENSE`; [upstream source](https://github.com/eshaz/simple-yenc). |
| libvorbis in the embedded WebAssembly | BSD 3-Clause; copyright 2002–2020 Xiph.org Foundation. The decoder source revision pins [`84c023699cdf023a32fa4ded32019f194afcdad0`](https://github.com/xiph/vorbis/tree/84c023699cdf023a32fa4ded32019f194afcdad0); notice copied from [COPYING](https://github.com/xiph/vorbis/blob/84c023699cdf023a32fa4ded32019f194afcdad0/COPYING). |
| libogg in the embedded WebAssembly | BSD 3-Clause; copyright 2002 Xiph.org Foundation. The decoder source revision pins [`3069cc2bb44160982cdb21b2b8f0660c76b17572`](https://github.com/xiph/ogg/tree/3069cc2bb44160982cdb21b2b8f0660c76b17572); notice copied from [COPYING](https://github.com/xiph/ogg/blob/3069cc2bb44160982cdb21b2b8f0660c76b17572/COPYING). |
| puff, used by the common helpers to inflate embedded WebAssembly | zlib license; copyright 2002–2013 Mark Adler. Its full notice is copied from the installed common package's `src/puff/puff.h`. The accompanying `README` marks this copy as altered for inlining. [Original upstream source](https://github.com/madler/zlib/tree/master/contrib/puff). |

The libvorbis and libogg identifiers above are the upstream source pins, not inferred
codec release versions. The package supplies the compiled module; this project bundles
that module without rebuilding those C libraries.

[LICENSE.txt](LICENSE.txt) contains the notices and is copied by the build to
`dist/vendor/ogg-vorbis.LICENSE.txt` alongside the distributed decoder.
