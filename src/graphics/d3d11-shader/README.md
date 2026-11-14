# Direct3D 11 shader containers

`parseDxbcContainer` reads the DXBC envelope shared by compiled shader containers.
It validates version1.0, the complete input size, the part-offset table, every part
range and overlap, with a4,096-part allocation limit. Returned digest and part payloads borrow the caller's immutable
byte image; table order is retained even when file offsets are not sorted.
Unknown part FourCCs remain opaque. This reader does not validate the stored
checksum or interpret shader instructions.

The envelope follows Microsoft's [container declarations](https://github.com/microsoft/DirectXShaderCompiler/blob/main/include/dxc/DxilContainer/DxilContainer.h).
Native clients verify the identity of their embedded shader data separately.

`parseSm4Program` reads a complete SHDR payload for vertex/pixel Shader Model4.0.
It decodes the declared arithmetic/sample/declaration opcode subset, component masks
and swizzles, operand extensions, immediate bit patterns and indexed register operands.
Relative indices are bounded to16levels;64-bit indices stay as two raw DWORDs. Custom
data uses its own length word and remains opaque. Instructions cannot consume another
instruction's words. Inputs are limited to4MiB and65,536instructions; unknown opcodes,
versions and undefined operand encodings fail explicitly.

Token syntax follows Microsoft's [token-format definitions](https://github.com/microsoft/DirectX-Headers/blob/main/include/directx/D3D12TokenizedProgramFormat.hpp).
Decoding does not validate shader semantics, register declarations or executable
compatibility. A shader backend must validate those separately before accepting a
program for rendering.

`parseSm4Signature` reads the serialized24-byte parameter records in ISGN/OSGN
payloads. It retains semantic spelling/index, serialized system values, component
types, register masks and the input always-reads/output never-writes mask. Registers
must be ordered; parameter tables and NUL-terminated strings are checked within the
payload. Parameter count and individual name length are limited to4,096. Newer
signature record layouts are outside this reader's scope.

The layout and mask meanings follow Microsoft's [SM4 signature reader](https://github.com/microsoft/D3D12TranslationLayer/blob/master/DxbcParser/src/DXBCUtils.cpp).

## GLSL instruction lowering

`translateSm4ToGlsl` lowers the declared SM4 arithmetic and float Texture2D sampling
subset into a callable GLSL ES3 stage function. It validates declarations, register
bounds, instruction controls and supported operand forms. Disjoint component
declarations may share an input/output register. Unsupported effects fail explicitly.
The returned binding records describe raw constant-buffer DWORD arrays and distinct
texture/sampler pairs; the caller supplies stage linkage, positions, texture formats
and sampler state. The function's input and output register arrays end at the highest
declared register (`inputRegisters`/`outputRegisters`), since every access uses a
declared immediate index and full32-entry arrays exhaust GPU registers.

Registers contain raw unsigned words. Moves, masks, sign modifiers and conditional
moves preserve those bits; arithmetic flushes denormals at its boundaries. Helpers
cover NaN selection/saturation and division, logarithm, reciprocal-square-root and
exponential special values. Pixel discard is deferred until return so subsequent
instructions retain their derivative participation. GPU arithmetic retains the
precision limits of the target GLSL implementation. Built-in helper definitions and
their dependency masks are shared per stage. A64-entry LRU per stage caches the
complete helper block for each recently used dependency mask. Each executable includes only the
helpers its instruction body needs, including their transitive dependencies; the
retained helper text and native instruction order stay unchanged.

`tools/probe-sm4-glsl.mjs` executes generated instruction fixtures in an isolated
headless WebGL2 browser and reads an integer framebuffer. Fixtures cover raw words,
arithmetic special values, masked aliasing, discard, short constant buffers and
independent samplers. It serves synthetic data and compiled modules only and captures
no screenshots. This instruction probe does not verify a complete D3D11 rendering
pipeline.

`parseSm4GlslShader` combines the executable plan with owned, immutable ISGN/OSGN
records. Used signature components must have matching declarations, and overlapping
components or duplicate semantics are rejected. The current executable interface
subset uses float registers. `linkSm4GlslPrograms` checks adjacent stages at their
native register locations; semantic names validate compatibility without relocating
compiled registers. It supplies vertex attributes, packed float varyings, pixel
position inputs and render-target outputs. Ordinary linear and centroid inputs are
supported; other generic interpolation modes and extra system values fail explicitly.

The wrapper flips clip Y and maps native depth0..1 to GL clip depth-1..1. GL framebuffer
row0 represents native row0, so texture uploads, render targets, sampling and readback
share the same row order. Presentation outside this backend must honor that convention.
Pixel position comes directly from `gl_FragCoord`, including depth and reciprocal W.
The synthetic probe also checks full packed vertex/pixel linkage and raw float readback.

Stage compatibility follows Microsoft's [signature rules](https://learn.microsoft.com/en-us/windows/win32/direct3dhlsl/dx-graphics-hlsl-signatures)
and [system-value semantics](https://learn.microsoft.com/en-us/windows/win32/direct3dhlsl/dx-graphics-hlsl-semantics).

Instruction behavior follows Microsoft's [floating-point rules](https://learn.microsoft.com/en-us/windows/win32/direct3d11/floating-point-rules),
[conditional moves](https://learn.microsoft.com/en-us/windows/win32/direct3dhlsl/movc--sm4---asm-)
and [discard](https://learn.microsoft.com/en-us/windows/win32/direct3dhlsl/discard--sm4---asm-).

## Constant reflection

`parseSm4Reflection` reads the SM4.0 RDEF payload's resource slots, constant-buffer
sizes and named variable byte spans. It preserves variables sharing one register,
flat float scalar/vector/matrix types, compiler flags and borrowed default bytes.
Buffer table indices do not substitute for resource binding slots. Reflection
without a bound resource has a null slot. Tables, strings, types and variable/default
spans are bounded before use; arrays, structs, other scalar types and other shader
profiles are refused by this subset.

The exact-hash x64 E-mote shader extractor prepares these records alongside the
compiled shaders. Reflection is CPU metadata preparation; it does not load or run a
native compiler or reflection DLL. RDEF field ordering is cross-checked against the
[Wine reflection format reader](https://github.com/wine-mirror/wine/blob/wine-10.0/dlls/d3dcompiler_43/reflection.c).
No native source or binary is bundled by this reader.
