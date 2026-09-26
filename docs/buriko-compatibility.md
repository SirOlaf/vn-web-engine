# BGI / Buriko compatibility

The reusable interpreter, native services, and bytecode storage live in
`src/engines/buriko/`. Game identity is installation data. The explicit
`ui/game-profiles/aokana.ts` profile retains that release's existing browser save
namespace and product identifier; it does not select engine behavior.

## Verified revision selection

| Interpreter | Compatibility | Bytecode pointers                          | Boot module / frame capacity |
| ----------- | ------------- | ------------------------------------------ | ---------------------------- |
| 1.520.6     | 1.69          | 26-bit offsets, separate 64 MiB pool slots | 512 KiB / 256 KiB            |
| 1.665       | 1.72          | 26-bit offsets, five grouped pool sizes    | 8 MiB / 4 MiB                |
| 1.685.3     | 1.72          | Modern address tags and indirect buffers   | 8 MiB / 4 MiB                |

`native/engine-version.ts` selects an exact verified pair. A version string is
not a claim that every future engine revision shares its implementation.
Unrecognized pairs require native analysis before admission.

Revision `1.665` has separate primary and native dispatch inventories, grouped
x86 allocations, and Intel CRT arithmetic. Compatibility `1.72` alone cannot
select its pointer tags or numeric behavior.

The older revision has its own native slot inventory and overrides for changed
primary bytecodes, text operations, Flash surfaces, and audio archive storage.
Its x87 integer operations use the shared `src/core/x87-integer.ts` arithmetic
implementation. Uncertain rounding and observations of unwritten native storage
remain explicit failures rather than guessed values.

Mask transitions also select the native revision. Compatibility 1.69 uses the
low three parameter bits for triangle frequency and its older coefficient
arithmetic in both surface and backdrop paths. Its invalid coefficient-table
read remains an explicit error. Revision 1.685.3 retains its full-parameter
frequency and separate arithmetic.

Masked sprite reveals keep the configured mask exponent separate from animated
`D8(0)` progress. Revisions 1.520.6 and 1.685.3 pass exponent before progress to their bitmap
kernels. Compatibility 1.69 accepts RGBA sources, uses Q7 direct blending, and
preserves its unclamped x86 shifts and even-width MMX / odd-width scalar reads.
Revision 1.685.3 retains its separate Q12 interpolation and source dispatch.

A missing global database leaves the native coordinate pair unwritten. The BP
stack and scalar stores carry those outputs as indeterminate values, allowing
the script to replace them on the failure branch. Numeric use still fails.
Shared byte-storage provenance lives in `src/core/indeterminate-memory.ts`;
native readbacks do not receive invented coordinates.

The 1.69 `80:ec`, `80:ed`, and `80:ee` slots implement registration checking,
COMAP readback, and the unsalted system identity. Revision 1.685.3 uses these
slot numbers for DLL operations. The older checker preserves the native
`reg.exe` launch and retry cadence through the shared process host. COMAP
readback writes only transferred bytes and returns whether the file opened;
missing files do not produce a successful registration. Short or invalid
registration data that would read unwritten native stack bytes raises an
explicit error. Process launch marshaling lives in `src/platform/windows-process.ts`.

The 1.520.6 audio reader owns a `PackFile` index per stream storage. It preserves
first-match lookup, short-read counts, and the native bug that adds read-error
codes to the cursor. The 1.685.3 audio reader retains its separate DCArchive
cache and ARC20 admission rules. The general script/resource archive reader
supports both directory formats.

Revision 1.665 owns a separate load-once `PackFile` / ARC20 index per stream.
Its lookup, stale-index reads and cursor behavior follow that revision's native
storage implementation.

Static audio also differs by revision. Compatibility 1.69 has 64 static channels,
16-bit output, and normal-speed/full-gain defaults for its simple sound-load
instruction. Its accelerated mode copies alternate 75 ms blocks. Compatibility
1.685.3 retains 128 channels and its distinct rate-scaling behavior. These choices
belong to the engine revision, not a title-specific handler.

Compatibility 1.69 stream prefill performs one decoder read; the producer worker
handles subsequent loop transitions. Its Vorbis reader rounds and clips to
signed 16-bit PCM before applying gain, retaining encoded channel order. Revision
1.685.3 keeps its separate floating-point gain conversion and channel
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

Boot enters the reconstructed interpreter through `ipl._bp`; it does not execute
the Windows executable's entry point or its protection loader. The original
executable can therefore supply metadata without a NoDVD patch. Script-visible
file reads still use the original mounted bytes, and media and DLL requests
retain their native failure or success contracts through the selected host.

Extracted discs use a [direct runtime view](buriko-disc-runtime.md) over the
selected source handles. This browser policy excludes disc-only markers and
installer files using the engine's integrity catalog without copying the game
into browser storage. Installed folders retain their complete file tree.

`tools/probe-buriko.mjs` checks production boot without presenting pixels. To
compare an original backup with the installed executable, use a root filename:

```sh
npm run build:runtime
BURIKO_PROBE_EXECUTABLE=BGI.OLD node tools/probe-buriko.mjs /path/to/installation
```

The override substitutes that file at the selected executable's mounted path
without changing either disk file. The probe does not use process dumps. Its
default host lacks a browser font set; reaching a font-configuration error is a
control-flow boundary, not evidence of disc-protection failure or complete
playability. Errors include a bounded instruction tail and JavaScript stack
locations; localized dialog contents and resource bytes remain suppressed.

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
