# MPEG-1 program streams

`MpegPsReader` reads bounded PES packets from a shared `ByteSource`. `MpegPsMovie`
indexes elementary access units and their PTS values in one metadata pass, then
decodes MPEG-1 video and optional MP2 audio in a separate pass. `openMovieStream`
in `src/video/movie.ts` selects this container or the existing CRI container.

The index follows I/P/B presentation order, unwraps the 33-bit clock, fills omitted
PTS values using the elementary stream cadence, and normalizes both tracks to a
common origin. Sequence/GOP headers belong to the following video access unit,
including when a PES boundary splits those headers from its picture start.
Explicit frame/PCM times survive the worker boundary and Web Audio scheduling.

The supported program has one MPEG-1 video track and at most one MPEG-1 Layer II
audio track. Multiple tracks, private codecs, MPEG-2 packs/video, format changes,
unbounded PES packets and ambiguous or non-increasing presentation clocks report
errors. Packet reads are at most 64 KiB; each track index is limited to 1,048,576
access units. Indexing never decodes media and does not retain packet payloads.

`tests/mpeg-ps-system.test.mjs` compares only synthetic FFmpeg test patterns and
tone data with reference YUV and PCM, without displaying or playing them.
