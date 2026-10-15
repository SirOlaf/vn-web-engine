# Direct3D 9 shader bytecode

Engine-independent reader, disassembler and GLSL ES 3.00 translator for compiled
Direct3D 9 shaders (vs/ps 2.0, 2.x and 3.0). Native plugins that draw through
D3D9 ship their shaders as token streams, either as PE resources or embedded in
`.rdata`; this module turns them into WebGL2 programs without running native code.

| File             | Contents                                                                     |
| ---------------- | ---------------------------------------------------------------------------- |
| `bytecode.ts`    | Token-stream parser (`parseD3D9Shader`), opcode/register/usage tables        |
| `ctab.ts`        | `CTAB` constant-table parser (names, register sets, indices, counts, types)  |
| `disassemble.ts` | fxc-style listing (`disassembleD3D9Shader`) for debugging                    |
| `glsl.ts`        | GLSL ES 3.00 translation of one shader or of a vertex/pixel pair             |
| `scan.ts`        | `findEmbeddedD3D9Shaders`: locate token streams inside arbitrary binary data |

`tools/probe-d3d9-shaders.mjs <file...>` inventories every blob in a DLL (RT_RCDATA
resources and embedded streams) with size, SHA-256, profile, instruction count,
CTAB constants and translation status. `--disasm` and `--glsl` print each listing.

## Parsing

`parseD3D9Shader(bytes)` accepts a stream that starts at the version token and
stops at the `0x0000FFFF` end token. Every instruction is checked against its
length field (bits 24..27). Parameters are decoded into register type and index,
write mask, result modifiers (`_sat`, `_pp`, `_centroid`), swizzle, source
modifier and, where the profile allows it, a relative-address token (`a0.c` or
`aL`). Predicated instructions carry their predicate source after the destination.
`dcl`, `def`, `defi` and `defb` keep their usage token or literal values.
Comments are returned by FourCC; the first `CTAB` becomes `constantTable`.
Shader model 1.x and malformed streams throw.

## GLSL binding contract

All D3D registers keep D3D numbering. Prefixes are `vs_` and `ps_` so a program
never has a uniform name in both stages.

| D3D9                       | GLSL                                                                       |
| -------------------------- | -------------------------------------------------------------------------- |
| `c#` / `i#` / `b#`         | `uniform vec4 vs_c[n]`, `ivec4 vs_i[n]`, `bool vs_b[n]` (and `ps_`)        |
| `def` / `defi` / `defb`    | `const dx_def_c#` etc.; they shadow the uniform register, also for `c[a0]` |
| `s#`                       | `uniform sampler2D/samplerCube/sampler3D vs_s#` / `ps_s#`                  |
| vertex `dcl_usageN v#`     | `in vec4 a_<usage><N>` (e.g. `a_texcoord1`)                                |
| `oT#`, `oD#`, `oFog`, `o#` | `out vec4 v_<usage><N>` (`v_texcoord0`, `v_color1`, `v_fog0`)              |
| ps_2 `t#` / `v#`           | `v_texcoord#` / `v_color#`                                                 |
| ps_3 `dcl_usageN v#`       | `in vec4 v_<usage><N>`; `_centroid` → `centroid in`                        |
| `oC#`                      | `layout(location = #) out vec4 dx_oC#`                                     |
| `oDepth` / `oPts`          | `gl_FragDepth` / `gl_PointSize`                                            |

Arrays are sized to cover referenced registers and every `CTAB` range, so the
host uploads a whole register file with one `uniform4fv`. Translation results
list the `CTAB` names with their uniform, attributes by usage, varyings, samplers
and colour outputs. `translateD3D9ProgramToGlsl(vs, ps)` links a pair: pixel inputs
that the vertex shader does not write read `vec4(0)` instead of failing to link,
and centroid qualification is copied to the vertex output.

### Clip and window space

The vertex epilogue converts D3D9 clip space with `uniform vec4 dx_posFixup`:

```
gl_Position.x = p.x * fix.x + fix.z * p.w
gl_Position.y = p.y * fix.y + fix.w * p.w
gl_Position.z = 2 * p.z - p.w        // D3D z ∈ [0, w] → GL z ∈ [-w, w]
gl_Position.w = p.w
```

`fix.zw` is the D3D9 half-pixel offset (pixel centres at integer coordinates).
For the default framebuffer use `(1, 1, 1/W, -1/H)`; when rendering into a texture
that is sampled with D3D texture coordinates (row 0 at the top), flip with
`(1, -1, 1/W, 1/H)`. Set `gl.frontFace(gl.CW)` without a flip and `gl.CCW` with it
so culling and `vFace` keep D3D9's clockwise-front convention. The WebGL2 device
(`src/native/d3d9/webgl2/`) uses a shift of 63/128 pixel instead of 1/2, as Wine does:
with exactly 1/2 the y-flip inverts the browser rasteriser's tie rule, and edges on
pixel centres move by a row instead of following D3D's top-left fill rule. Textures are
uploaded top row first and sampled with the D3D coordinates unchanged.

Fragment shaders that read `vPos` or use `dsy` declare `uniform vec4 dx_screenFixup`:
`vPos.xy = gl_FragCoord.xy * fix.xy + fix.zw` (top-left origin, pixel centre at
integers: `(1, -1, -0.5, H - 0.5)` for the default framebuffer, `(1, 1, -0.5, -0.5)`
when flipped), and `dsy` is multiplied by `fix.y`.

## Instruction semantics

- `rcp`, `rsq`: x = 1 gives exactly 1, x = 0 gives +∞; `rsq` and `log` use |x|,
  `log(0)` = −∞. `pow` is `|x|^y` with `0^y` = 0 / 1 / +∞ for y > 0 / = 0 / < 0.
  ∞ comes from `uintBitsToFloat`, since GLSL leaves division by zero undefined.
- `nrm` of a zero vector is 0. `lit` clamps the power to ±127.9961.
- `mova` rounds to nearest (`floor(x + 0.5)`), as vs_2_0 and later define.
- `cmp`/`cnd`/predication select with boolean `mix`, so the unselected operand
  (which may be NaN) never leaks.
- Scalar instructions read the `.w` selector of the source swizzle (`rcp`, `rsq`,
  `exp`, `log`, `pow`); `sincos`, `dp2add` (third operand) and comparisons read `.x`.
- `texld` uses `.xy` for 2D and `.xyz` for cube/volume; `texldp` divides by `.w`
  (`textureProj`), `texldb` passes `.w` as bias, `texldl` as LOD, `texldd` uses
  `textureGrad`. A sampler swizzle (ps_2_x) applies to the result. `texkill` discards
  when any component in the write mask is negative.
- `loop aL, i#` iterates `i.x` times from `i.y` in steps of `i.z`; nested loops save
  and restore `aL`. `rep` iterates `i.x` times. `label`/`call`/`ret` become functions.
- vs_2_x colour outputs `oD#` are clamped to [0, 1] as the fixed-function
  interpolator does; vs_3_0 outputs are not.
- All arithmetic is `highp`. D3D9 requires at least fp24 (fp16 for `_pp`), so the
  translation is at least as precise; `_pp` is ignored.

Not translated: shader model 1.x opcodes (`tex*` register combiners, `bem`, `phase`),
relative addressing of anything other than float constants, and predicated
flow control other than `if p`/`breakp`/`callnz p`. These throw with the token offset.
