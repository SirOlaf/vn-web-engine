# Persistent GPU render surfaces

`GpuRenderSurface` describes a GPU-owned RGBA8 image in the shared graphics layer.
It has fixed dimensions and an identity, with no CPU pixel copy. Prepare it on a
`WebGLDrawTarget` with `prepareRenderSurface` (or `prepareImage`) before use. A
surface is local to that target; another target must allocate its own storage.

A `gpu-target` command binds the prepared surface. Its optional `clearColor`
clears that surface; without it, previous contents persist. Bind `surface: null`
to return to the main presentation target before the stream ends. Nested rendering
uses explicit switches between surfaces. Resolve a surface through the ordinary
texture lookup to sample it in sprites, primitives, masks or additional textures.
Coordinates retain the shared top-down image convention for all those bindings.
Sampling the currently bound render surface is refused to prevent framebuffer
feedback. GPU surfaces are not automatically evicted between frames.

A `gpu-copy` command copies every RGBA texel from its `source` to its
`destination`, retaining the active target and viewport. Both surfaces must be
prepared on the same target, distinct, and have matching dimensions. The copy
uses the GPU framebuffer directly; it does not blend, reallocate, upload or read
CPU pixels. The destination may then serve as a background snapshot while the
source remains the current render target.

Target switches do not read back or upload surface pixels. The existing `target`
command retains its CPU-owned texture publication behavior, and an explicit
`capture` still returns a CPU image. Mixing both target kinds is supported;
only the CPU-owned target publishes on a switch. Invalidate a GPU surface when
its owner releases it; invalidation is idempotent. Re-preparing an invalidated
surface creates fresh transparent storage. Target disposal releases all remaining
attachments. An aborted stream restores the main framebuffer binding.

The synthetic browser fixture `tests/browser/draw-list.html` verifies nested
surfaces, vertical orientation, masks and extra textures, alpha, frame retention,
feedback rejection, background copies, legacy publication and explicit capture. Instrumented WebGL
calls check that switches and repeated frames perform no readbacks or reallocations,
and that attachments are released once. No game images are used.
