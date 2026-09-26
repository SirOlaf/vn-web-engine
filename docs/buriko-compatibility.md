# BGI / Buriko compatibility

The reusable interpreter, native services, and bytecode storage live in
`src/engines/buriko/`. Game identity is installation data. The explicit
`ui/game-profiles/aokana.ts` profile retains that release's existing browser save
namespace and product identifier; it does not select engine behavior.

## Verified revision selection

| Interpreter | Compatibility | Bytecode pointers                          | Boot module / frame capacity |
| ----------- | ------------- | ------------------------------------------ | ---------------------------- |
| 1.520.6     | 1.69          | 26-bit offsets, separate 64 MiB pool slots | 512 KiB / 256 KiB            |
| 1.685.3     | 1.72          | Modern address tags and indirect buffers   | 8 MiB / 4 MiB                |

`native/engine-version.ts` selects an exact verified pair. A version string is
not a claim that every future engine revision shares its implementation.
Unrecognized pairs require native analysis before admission.

The older revision has its own native slot inventory and overrides for changed
primary bytecodes, text operations, Flash surfaces, and audio archive storage.
Its x87 integer operations use the shared `src/core/x87-integer.ts` arithmetic
implementation. Uncertain rounding and reads of unwritten native storage remain
explicit failures rather than guessed values.

The older audio reader owns a `PackFile` index per stream storage. It preserves
first-match lookup, short-read counts, and the native bug that adds read-error
codes to the cursor. The newer audio reader retains its separate DCArchive
cache and ARC20 admission rules. The general script/resource archive reader
supports both directory formats.

Static audio also differs by revision. Compatibility 1.69 has 64 static channels,
16-bit output, and normal-speed/full-gain defaults for its simple sound-load
instruction. Its accelerated mode copies alternate 75 ms blocks. Compatibility
1.72 retains 128 channels and its distinct rate-scaling behavior. These choices
belong to the engine revision, not a title-specific handler.

Compatibility 1.69 stream prefill performs one decoder read; the producer worker
handles subsequent loop transitions. Its Vorbis reader rounds and clips to
signed 16-bit PCM before applying gain, retaining encoded channel order. The
newer revision keeps its separate floating-point gain conversion and channel
permutation.

## Optional executable resources

An interpreter executable supplies revision metadata and remains mounted as a
game file. Its cursor and product string are optional metadata. A matching
process dump can recover these resources when executable sections are packed;
it is never executed or required for startup.

When a boot script directly compares the native product identifier with a
constant, bounded static analysis can recover that identifier from `ipl._bp`.
This recognizer proves the comparison's data flow; it does not substitute an
arbitrary matching string or alter the comparison opcode.

Save namespaces use the recovered product identity. If that is unavailable,
they use a versioned fingerprint of the complete boot archive, read in bounded
chunks. Adding an optional process dump does not change the namespace.
Unknown native mutex identities are scoped to that installation by the browser
process host without changing the product bytes exposed to bytecode.
Optional metadata failures remain available in the browser console.

## Shared media and platform services

MPEG-1 program streams, video, and Layer II audio live under `src/formats/` and
`src/video/`. The traditional Buriko movie adapter supplies decoded frames to its
native renderer and preserves the existing timing, volume, and close contract.
Delayed audio starts, video-only streams, worker failure, and pending frame
delivery during close are handled by the shared movie layer.

Windows services live under `src/platform/`. The engine issues native requests;
the chosen browser or desktop host decides how to fulfill them. For example,
the Flash surface path retains its lifecycle and native status behavior, while
the browser host reports that it cannot create an ActiveX control.