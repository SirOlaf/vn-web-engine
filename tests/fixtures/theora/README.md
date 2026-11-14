# Synthetic Theora clips

Regenerate with `node tests/fixtures/theora/generate.mjs`. `FFMPEG`, `CC` and
`LIBTHEORA_PREFIX` override the encoder, compiler and the libtheora/libogg install
prefix. The sources are FFmpeg's `testsrc2` and `mandelbrot` patterns encoded with
FFmpeg's libtheora encoder; nothing here is game content.

`libtheora-frames.c` decodes the first Theora stream from stdin with libtheoradec and
writes every output frame (full frame, Y then Cb then Cr, rows top-down). The manifest
holds the SHA-256 of each such frame, the clip file hash and the frame geometry.

`testsrc2-420` has a 72×40 picture in an 80×48 frame, two key frames and duplicate
(empty) packets. `mandelbrot-420` is encoded to a bitrate target and uses every inter
mode, including four-vector and golden-frame macroblocks. The 4:2:2 and 4:4:4 clips
cover the other chroma layouts.
