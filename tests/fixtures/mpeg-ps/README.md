# Synthetic MPEG program streams

Regenerate with `node tests/fixtures/mpeg-ps/generate.mjs`. `FFMPEG` and `FFPROBE`
can override the executable paths. The source is FFmpeg's 64×48 `testsrc2` at
30 fps for 0.6 seconds. The optional audio source is the repository's synthetic
48 kHz stereo MP2 tone, delayed by 80 ms and ending before the video.

The fixtures contain I, P and B pictures. References are planar YUV420 and
interleaved float32 PCM decoded by FFmpeg (`mp2float` for audio), compressed with
gzip. The manifest records tool version, content hashes and frame metadata.
Nothing in these fixtures is game content.

The delayed-audio mux splits a sequence/GOP header and its picture start across
PES packets. FFprobe's `best_effort_timestamp` sequence becomes non-monotonic at
that boundary; `probeVideoPts` preserves its report for inspection. The asserted
presentation cadence comes from the known constant-rate synthetic source, with
video starting at zero and audio at 0.08 seconds after common-origin normalization.
