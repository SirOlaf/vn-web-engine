# d3d11.dll contract

`contract.ts` defines the native device, immediate context, resource, view, shader
and state interfaces used by D3D11 clients. It names COM slots, including the three
`IUnknown` slots. The definitions follow the [Microsoft SDK header](https://github.com/microsoft/win32metadata/blob/main/generation/WinSDK/RecompiledIdlHeaders/um/d3d11.h).
The interface subset grows with client coverage; view descriptors currently describe
Texture2D views. Forward declarations for adapter and shader linkage objects expose
only their inherited operations needed at this boundary.

Calls are synchronous. Descriptors and output parameters use plain records; buffer
and shader data use `Uint8Array`. Parallel native count/pointer arrays use one array
where the array length supplies the count. Optional creation output pointers are
represented by `validateOnly`; a validation call can return `S_FALSE` without a
resource. These declarations do not select or register an implementation.

Resource creation returns an owned reference. Bindings retain their interfaces;
getters returning interfaces add references, including `getDevice`, `getResource`
and `getImmediateContext`. Callers release returned objects. Mapped bytes are borrowed
until `unmap`, which commits writes across the implementation boundary. A backend
copies descriptors and shader inputs according to the native object's lifetime.

Clients import only this contract. The UI runtime wiring registers the chosen
implementation with the existing native-library loader. Rendering hosts, browser
surfaces, shader translators and implementation classes stay outside the contract.

UI registration can supply `deviceCreated` to receive the borrowed native device
and its `D3d11WebGl2TextureSharing` service. This backend service is separate from
the DLL ABI. A color-texture lease retains a single-level RGBA8/BGRA8 render target
on its existing context; `prepare` publishes pending uploads without reading back
the framebuffer. The compositor attaches the borrowed texture with its explicit
row origin, detaches it before lease disposal, and restores its own draw state.
Engines use `D3d11SurfaceHost` and Native contracts instead of this backend service.

## Resource storage

`runtime/com.ts` separates caller references from internal bindings. The device and
immediate context can be reacquired while any child interface remains owned. Final
caller release clears bindings before retiring device/context storage.

`runtime/resources.ts` owns ordinary vertex/index/constant buffers and single-sample
typed Texture2D bytes. Creation copies input rows and descriptors; subresources follow
native mip/array order. Map returns borrowed bytes, and unmap snapshots writes. Read
maps preserve storage. Discard replaces the dynamic texture mip chain; no-overwrite
is limited to dynamic vertex/index buffers. Updates and copies validate complete
regions before writing, including compressed edge blocks and byte-based buffer boxes.

The format subset is RGBA8, BGRA8, R8, A8, R8G8, BC1/2/3/7, D32 and D24S8. Compressed
base dimensions are multiples of four; lower mip storage rounds up to whole blocks.
Typeless formats, multisampling, cube/shared resources and structured/raw buffers are
rejected. Storage is bounded to256 MiB per resource. Validation-only creation allocates
no interface. `runtime/views.ts` provides typed single-texture shader-resource,
render-target and depth/stencil views. Views hold resources through binding references;
`getResource` and `getDevice` return owned references. Mip ranges and descriptors are
copied, and factories reject foreign-device resources and missing bind flags. Array
views and typeless reinterpretation are outside the declared view subset.

`webgl2/device.ts` composes these components and routes GPU writes/readback through
the same resource storage. UI wiring registers the selected library implementation.
The internal resource owner can synchronize deferred GPU writes before borrowed-byte
reads, preserving maps, partial updates and copies. Validation precedes synchronization.
Whole-resource copies synchronize their source; their destination is replaced in full.
WRITE_DISCARD skips synchronization because it replaces the relevant storage. Resource
revisions distinguish those CPU replacements from pending device writes.
An optional readiness query lets Map(DO_NOT_WAIT) return
DXGI_ERROR_WAS_STILL_DRAWING before synchronizing or allocating mapped storage.

`runtime/states.ts` owns blend, depth/stencil, rasterizer and sampler descriptions.
Creation copies nested records, converts native float fields to float32, and interns
identical descriptions with an additional caller reference. Each kind is limited to
4,096 live unique states; final release removes its cache entry. Getters return copies,
and binding references keep a state alive independently of its creating caller. Fields
ignored by disabled blend/depth/stencil/sampler features retain their supplied values.
Sampler descriptors cover ordinary and comparison filters; minimum/maximum reduction
filters require a newer feature subset.

Interning and limits follow [CreateBlendState](https://learn.microsoft.com/en-us/windows/win32/api/d3d11/nf-d3d11-id3d11device-createblendstate)
and the [native return codes](https://learn.microsoft.com/en-us/windows/win32/direct3d11/d3d11-graphics-reference-returnvalues).

`runtime/context-state.ts` provides the immediate context's VS/PS constant buffers,
PS resource/sampler/shader slots, input assembler and output/rasterizer bindings.
Its implemented methods are checked against the native context contract. Updates
validate all incoming handles before replacing bindings, and getters return owned
interface references or copied scalar records. Shader-resource/render-target overlap
is resolved per mip range. Output views must have compatible dimensions and cannot
bind one subresource twice. Setting outputs preserves viewport/scissor state.

`clearState` resets all covered bindings and defaults. Final device lifetime teardown
uses the same cleanup without reacquiring a caller reference, attempts every release,
and retires state even if host disposal fails. Drawing, resource transfers and flushing
belong to the concrete rendering backend; this binding component does not register one.
It accepts SM4 shaders, whose class-instance arrays are empty.

Binding ownership and hazards follow [PSSetShaderResources](https://learn.microsoft.com/en-us/windows/win32/api/d3d11/nf-d3d11-id3d11devicecontext-pssetshaderresources),
[OMSetRenderTargets](https://learn.microsoft.com/en-us/windows/win32/api/d3d11/nf-d3d11-id3d11devicecontext-omsetrendertargets)
and [ClearState](https://learn.microsoft.com/en-us/windows/win32/api/d3d11/nf-d3d11-id3d11devicecontext-clearstate).

`runtime/input-layout.ts` creates owned input-layout metadata from SM4 signatures.
It copies semantic records and resolves APPEND offsets independently for each stream.
The current float-input subset covers R32G32_FLOAT, R32G32B32_FLOAT and
B8G8R8A8_UNORM; unsupported types and element spans beyond2,048bytes return E_NOTIMPL.
Unused declared elements are retained, and missing/duplicate semantics are rejected.
Elements sharing an input slot must agree on instance class and step rate. The input
subset uses one semantic per register; packed IA signatures return E_NOTIMPL.
Validation-only calls create no interface. Shared `graphics/dxgi-vertex.ts` reads these
in-bounds element formats into caller-owned float4 storage, preserving packed color
normalization and the missing-component defaults0,0,0,1.

`runtime/input-assembly.ts` provides borrowed vertex/index readers for one synchronous
draw while context bindings retain the resources. Vertex reads combine streams in the
requested register order and preserve each element's float4 format expansion. Address
multiplication and addition wrap to32bits. Wrapped addresses below the bound buffer
offset and elements extending beyond storage return zero for present format components
and native defaults for missing components. Zero stride repeats an element; ordinary
Draw/DrawIndexed use instance0 for instance-class elements. Used streams must be bound
in this subset. Mapped, foreign and released buffers fail explicitly.

Index reads accept R16_UINT/R32_UINT, apply the same wrapping and lower bound, return
zero outside storage and retain strip-cut words. The draw operation consumes strip cuts
before adding BaseVertexLocation. Readers allocate no objects per vertex or index.
The shared DXGI helper still exposes strict in-bounds reads for other callers.

Addressing follows sections8.3/8.5/8.19 of the [Direct3D functional specification](https://microsoft.github.io/DirectX-Specs/d3d/archive/D3D11_3_FunctionalSpec.htm).

Layout ownership and signature matching follow [CreateInputLayout](https://learn.microsoft.com/en-us/windows/win32/api/d3d11/nf-d3d11-id3d11device-createinputlayout).
Missing-component defaults follow section19.1.3.3 of the [Direct3D functional specification](https://microsoft.github.io/DirectX-Specs/d3d/archive/D3D11_3_FunctionalSpec.htm).

`runtime/shaders.ts` creates owned vertex/pixel device children from DXBC bytes.
The shared SM4 compiler owns immutable interface and executable records, so releasing
or changing caller bytecode cannot change a created shader. Stage mismatches and
malformed interfaces fail before allocation; validation-only calls return S_FALSE.
The supported shader model uses float registers and no dynamic class linkage.
Shaders participate in the same binding/getter/device reference lifetime as other
children. Compiling linked GPU programs and managing their cache belongs to the
concrete backend; these shader objects do not register a rendering device.

Creation and bytecode lifetime follow [CreateVertexShader](https://learn.microsoft.com/en-us/windows/win32/api/d3d11/nf-d3d11-id3d11device-createvertexshader)
and [CreatePixelShader](https://learn.microsoft.com/en-us/windows/win32/api/d3d11/nf-d3d11-id3d11device-createpixelshader).

`webgl2/shaders.ts` compiles and links these native shader pairs on WebGL2. Its
device-owned cache retains the shader children and bounds programs with LRU eviction.
Eviction and disposal delete GPU programs and release both children. Pair lookup uses
weak identity maps; successful selection makes the corresponding program current.
Failed compilation or linkage releases every partially created GPU object.

Active uniform reflection bounds raw constant uploads to the array size retained by
the driver. Short and unbound buffers are zero-filled; unchanged buffer identities
and revisions avoid repeated uploads. Texture/sampler pairs receive independent units.
The synthetic shader probe exercises this cache, native buffer updates, unbinding,
eviction and disposal with raw float readback. The immediate context binds
textures, input assembly, targets and raster/output state through this implementation.

Pixel output ranges are draw state. The linked output wrapper clamps each UNORM
output to `[0,1]` before blending, as required by the
[D3D11 output-merger rules](https://microsoft.github.io/DirectX-Specs/d3d/archive/D3D11_3_FunctionalSpec.htm).
Per-output uniforms follow the bound color attachments; shader-pair reuse does not
imply that the output formats stayed the same. Unbound or non-normalized slots keep
their original float output. The program cache avoids repeating unchanged range
uploads. This handling stays inside the backend and does not change Native contracts.

## GPU texture storage

`webgl2/textures.ts` owns single-sample Texture2D images, mip attachments and independent
shader-view mip ranges. Ordinary source images retain their upload rows; writable
canonical targets keep native top at the GL top. Shader-resource views present
native row order. Full-range ordinary views share their source image; target and
mip-range views use revision-cached independent GPU images with their own base levels.
A draw acquires its context-owned views together, pinning their images until release. Unbound resources
sample an all-zero image, including alpha.

R8/RG8 upload directly. BGRA, A8 and BC1/2/3/7 use the shared integer GPU decoder in
`graphics/block-texture.ts`; their canonical images contain the corresponding RGBA8
texels. Depth uploads support D32_FLOAT and D24_UNORM_S8_UINT, with native depth/stencil
bit order converted to GL's packed order. CPU upload/readback reverses bounded row
chunks when storage is reflected; native byte order remains top-left. GPU resource
copies map each rectangle endpoint according to its source and destination origin.
Shader-view aliases use NEAREST blits to reflect integer rows, preserving sampler
tie selection without changing sample coordinates. Their 64 MiB cache budget and
pinned draw lifetime also apply to full-range aliases.

Color-target clears, shader-view copies and their consuming draws share the ordered
GPU command stream. Their error query is batched until context flush; allocation, resource
transfer and CPU readback queries also check the batch. Shared-texture publication does not
wait for the GPU process: it reports device removal and leaves the batch pending. A failed
batch invalidates its cached alias revisions so later use refreshes their pixels.
CPU validation and framebuffer completeness checks still precede submission.

Render-target clears ignore scissor and component write masks. A8 render targets
store alpha only; their physical RGBA8 image keeps RGB zero, and CPU readback
extracts alpha into native one-byte texels. Device writes advance
the resource revision and defer CPU readback. The resource owner's synchronization
callback commits pending color writes in native byte order before a preserving CPU
operation. CPU changes re-upload the coherent mip chain; WRITE_DISCARD replaces obsolete
contents. Map(DO_NOT_WAIT) queries a lazily created fence with zero timeout, returning
still-drawing until ready. Fences are retired on another device write, CPU replacement,
completed synchronization or final release. Lost contexts report device-removed.

Texture allocations, aliases and packed-upload scratch share a 2 GiB limit; block formats
are stored as decoded RGBA8. Aliases
and scratch each have a64MiB bound; idle view ranges use LRU eviction with eight cached
ranges per resource. Active draws can temporarily pin more ranges within the memory
bound. Readback uses chunks of at most1MiB. Resource final release deletes its images
and attachments; decoder programs, scratch and the zero image belong to the device.

Texture arrays and CPU depth/stencil readback are outside the GPU view subset. Staging
depth textures are already rejected by resource creation; native depth copies stay on
the GPU. The concrete immediate context supplies drawing and raster/output state; the device
composes their ownership. Registration belongs to UI runtime wiring.

## Immediate-context transfers

`webgl2/transfers.ts` extends the native context binding storage with map/unmap,
updates, copies, color/depth/stencil clears, mip generation and flush. Foreign or
released handles are rejected. Map returns device errors as HRESULT results, including
device removal after context loss. Texture2D updates ignore the unused slice pitch.

Copies share `runtime/resources.ts` validation with the CPU storage path. Whole copies
validate every subresource before changing any destination. Ordinary single-array
typed color and depth/stencil copies use GPU blits; scissor and component/depth/stencil
write masks do not restrict them. Copies between different mips of one texture are
supported. Buffer, compressed and CPU array copies preserve canonical native bytes.

GenerateMips requires render-target/shader-resource binding and GENERATE_MIPS at
resource creation. Missing flags or a one-level view have no effect. Generation starts
at the view's largest mip and stops at its last mip, preserving every excluded level.
Generated levels and copies participate in deferred CPU synchronization and shader-view
invalidation. Automatic mip filtering uses the underlying normalized GPU format.

Depth/stencil clears cover the full view, ignore viewport/scissor/write masks and
clamp depth to [0,1]. Each aspect can be cleared independently. Clears of read-only
aspects, nonexistent stencil and NaN depth values are outside the supported clear
subset and fail explicitly. CPU depth/stencil readback remains unsupported.

The [native copy](https://learn.microsoft.com/en-us/windows/win32/api/d3d11/nf-d3d11-id3d11devicecontext-copysubresourceregion),
[mip generation](https://learn.microsoft.com/en-us/windows/win32/api/d3d11/nf-d3d11-id3d11devicecontext-generatemips)
and [depth clear](https://learn.microsoft.com/en-us/windows/win32/api/d3d11/nf-d3d11-id3d11devicecontext-cleardepthstencilview)
operations define these ranges and state-independent effects.

`tools/probe-d3d11-transfers.mjs` verifies independent synthetic byte expectations
through the immediate-context methods. It checks GPU copies without CPU synchronization
or readback, invalid-copy atomicity, alias invalidation, view-limited mip generation,
native shadow coherence, nonblocking staging maps, independent depth/stencil clears,
raw D32 float words, buffer transfers, device removal and lifetime cleanup.

## Pixel samplers

`webgl2/samplers.ts` applies immutable native sampler descriptions to one reusable
GPU sampler per pixel texture unit. Ordinary 2D sampling supports all eight point/
linear minification, magnification and mip combinations, wrap/mirror/clamp U/V
addressing and independent minimum/maximum LOD. These LODs are relative to the
shader resource view's first mip. A null state selects native linear filtering,
clamped addressing and unbounded LOD defaults.

GPU sampler objects retain description records without retaining native interface
references; the context owns native bindings. Separate units keep independent state
even when they sample the same image. Uploads and other private operations may change
bindings, so each draw rebinds its prepared GPU samplers. Allocation is bounded by the
pixel texture-unit limit, and device disposal deletes every allocated sampler.

Border/mirror-once addressing, anisotropy, comparison filtering and nonzero LOD bias
are outside this ordinary-sample backend subset and return E_NOTIMPL when used. The
state factory still validates and preserves native descriptors independently of this
execution subset. AddressW and comparison/anisotropy fields have no effect on ordinary
2D samples. The texture probe checks numeric filtering/addressing/mip results, default
state, simultaneous units, unsupported-mode rejection and native/GPU ownership.

The null-state defaults follow [PSSetSamplers](https://learn.microsoft.com/en-us/windows/win32/api/d3d11/nf-d3d11-id3d11devicecontext-pssetsamplers).

## Raster and output execution

`webgl2/output.ts` owns the immediate context's draw framebuffer. It prepares typed
color/depth images before attaching them, tracks mip attachments, and detaches retired
resources through the resource owner's `destroy` callback. Context bindings retain
the native views; cached framebuffer attachments acquire no native references.
Device disposal deletes the framebuffer. A draw with only a first color target and no
depth view binds that mip's own complete framebuffer, the one its clears and copies
use, so alternating mask/copy/output passes never re-attach images per draw.

Draw state reapplies viewport/scissor, front-face/cull, fill, clipping, depth/stencil,
blend equations/factors and component masks after private texture preparation. Native
top-left viewport/scissor coordinates are mapped against the attachment height.
Vertex clip-space Y retains its native orientation; pixel SV_Position converts GL Y
to native top-left coordinates. Culling follows that same orientation. Missing
viewports, zero-sized viewports,
empty output sets and a zero single-sample mask emit no geometry. Scissors intersect
the target extent before their dimensions are passed to GL.

Depth clipping disabled uses `EXT_depth_clamp`; it preserves clipping of X/Y and W
without changing vertex depths. Optional wireframe fill uses `WEBGL_polygon_mode`.
Indexed blend/mask state uses `OES_draw_buffers_indexed` for multiple outputs. A8
attachments force RGB write masks off while retaining their native alpha mask.
Ordinary blend factors, separate color/alpha equations, all depth comparisons and
stencil operations map to GL state. Read-only DSV flags disable the corresponding
write mask while preserving tests. Actual draws notify texture storage of writes.

The current output execution subset rejects nonzero depth bias, fractional/oversized
viewports, alpha-to-coverage, dual-source blend factors and destination alpha-saturate
blending. Missing required optional extensions also fail explicitly. `webgl2/context.ts`
and `device.ts` compose these components; UI registration selects the implementation.
Decoded texture uploads restore solid fill before running their private decoder draw,
and the next native draw reapplies its own raster state.

`tools/probe-d3d11-output.mjs` checks numeric synthetic output: viewport/scissor,
native winding/culling, actual near/far depth clamping, blending and write masks,
A8 and independent targets, depth writes, read-only depth/stencil, stencil replace/
compare, decoding after wireframe and resource/framebuffer retirement. It captures
no screenshots or game data.

State semantics follow [native rasterizer state](https://learn.microsoft.com/en-us/windows/win32/api/d3d11/ns-d3d11-d3d11_rasterizer_desc),
[depth clamping](https://registry.khronos.org/webgl/extensions/EXT_depth_clamp/)
and [indexed draw-buffer state](https://registry.khronos.org/webgl/extensions/OES_draw_buffers_indexed/).

## Draw assembly

`webgl2/context.ts` completes the immediate-context interface with Draw/DrawIndexed.
It combines the owned bindings and transfers with native vertex/index readers,
shader programs, pinned resource views, samplers and output state. Resource/target
preparation precedes reapplying raster state, vertex arrays, programs and constants.
View leases are released after draws, skipped output and errors.

Draw calls validate native arguments and bindings synchronously, while GPU commands
remain queued across adjacent draws. `flush` checks GPU submission errors before returning
to the host; shared-texture `prepare` checks device removal and invalidates cached state, and
its queued errors surface at the next flush, allocation, transfer or readback. Resource allocation, uploads and
readback retain their own error checks. The private output framebuffer caches its
completeness until an attachment changes or is destroyed; each draw still reapplies
the raster state after texture preparation and host-context use.

Output completeness also remembers up to 64 previously validated immutable attachment
configurations, with least-recently-used eviction and resource-retirement invalidation.
Returning from a mask/copy pass can reuse that validation. Shader-view row copies
validate each immutable alias mip once. Pixel revisions still refresh the copies,
and allocation, copy and submission errors retain their existing checks.

The current input conversion stages float4 register planes using the verified CPU
readers. Planes support16attributes without exceeding WebGL's255-byte interleaved
stride limit. Staging is reusable and bounded to64MiB, with a corresponding streaming
GPU vertex buffer. Device teardown frees both the vertex array and buffer. Instance
streams use instance0 for these non-instanced draws.

Points, line lists/strips and triangle lists/strips are supported. Indexed strips
consume cut words before adding signed BaseVertexLocation, reset strip parity after
each cut and preserve unsigned address wrapping/OOB defaults. All-ones list indices
are ordinary vertex indices. Zero counts emit no work. Adjacency/patch topologies
and shader stages outside the declared VS/PS subset fail explicitly.

Synthetic public-contract GPU probes verify the assembled draw path. Broader x64
E-mote integration and UI registration remain. CPU coordination tests and planar-byte
oracles provide separate assembly evidence; no final performance claim is made for
CPU-expanded input staging.

`tools/probe-d3d11-textures.mjs` checks generated texture bytes and numeric readback,
including every format/mip, independent ranges, cache pressure, pinned bindings,
unbound resources, clears, native CPU shadows, partial updates, dynamic discard,
staging-map readiness, depth/stencil upload, final ownership and context loss. It
captures no screenshots and loads no game assets. This is resource coverage, not
full draw-command or performance acceptance.

Map behavior follows [D3D11_MAP_FLAG](https://learn.microsoft.com/en-us/windows/win32/api/d3d11/ne-d3d11-d3d11_map_flag).
Storage conventions follow [DXGI formats](https://learn.microsoft.com/en-us/windows/win32/api/dxgiformat/ne-dxgiformat-dxgi_format)
and the [WebGL2 specification](https://registry.khronos.org/webgl/specs/2.0.0/).

Resource rules follow Microsoft's [Map values](https://learn.microsoft.com/en-us/windows/win32/api/d3d11/ne-d3d11-d3d11_map),
[UpdateSubresource](https://learn.microsoft.com/en-us/windows/win32/api/d3d11/nf-d3d11-id3d11devicecontext-updatesubresource)
and [block compression](https://learn.microsoft.com/en-us/windows/uwp/graphics-concepts/block-compression)
documentation. No Windows graphics binaries execute in this implementation.

## Library and device

`d3d11WebGl2Library(createContext)` implements the D3D11 contract for the existing
Native library loader's system identity. The UI supplies a synchronous prepared-GL
context provider; the public D3D11CreateDevice arguments remain native SDK values.
SDK7, default hardware selection, supported creation flags and ordered feature
levels11_0/10_1/10_0 are validated before host creation. Explicit adapters, other
rasterizer drivers and unsupported flag modes fail. Debug-layer requests return
SDK-component-missing; an unavailable context returns unsupported.

`webgl2/device.ts` provides the device's factories, capabilities, owned immediate
context and common child lifetime. Each successful creation output owns one caller
reference. Child/getter references can keep the device/context alive after their
original callers release them. Final lifetime release clears bindings, vertex storage,
output attachments, programs, samplers and textures, attempting every cleanup action.

Format queries describe the implemented texture/input/index subset. Resource creation
uses the host texture-dimension limit and returns device-removed after context loss.
Static feature/flag queries and context ownership remain available while an interface
is alive. The library factory is ready for UI registration; Artemis/x64 E-mote UI
wiring and full model/route/performance verification remain separate work.

Device-creation and format-query behavior follow [D3D11CreateDevice](https://learn.microsoft.com/en-us/windows/win32/api/d3d11/nf-d3d11-d3d11createdevice)
and [CheckFormatSupport](https://learn.microsoft.com/en-us/windows/win32/api/d3d11/nf-d3d11-id3d11device-checkformatsupport).

`tools/probe-d3d11-device.mjs` loads the system library and uses only public native
interfaces for creation, binding, rendering, updates and staging readback. Synthetic
cases cover packed BGRA input,16/32-bit indices with signed bases and strip cuts,
dynamic buffers, constant updates/unbinding, sparse resource/sampler slots, private
texture-decoder state changes, mip-view aliases and16input-register planes. It binds
and verifies the complete compiled file set as well as source/fixture hashes. These
checks load no game assets and capture no screenshots.

The concrete device caches fixed raster, depth/stencil and blend writes within its
owned Native command batch. It snapshots mutable viewport, scissor, blend-factor and
stencil-reference values; immutable Native state descriptions are borrowed. Attachment
and unsupported-state validation still runs on every draw. Private texture operations
that disturb output state advance an invalidation epoch. Flush, shared-texture
publication and retirement of an attached resource discard the snapshot before external context use.
The standalone output helper remains uncached unless its owner opts into this batch
and immutable-description discipline. Cached state retains no Native caller reference.
