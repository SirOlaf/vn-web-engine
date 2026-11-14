# Outline fonts

This directory reproduces the glyphs and metrics of FreeType 2.4.8 for the fonts and load
options that Artemis games use. `src/text/freetype.ts` exposes it with the FreeType library,
face and glyph interface, and `src/text/freetype-worker.ts` runs it in a worker. Engines own
layout, spacing, effects and painting; this code only turns font bytes into coverage
bitmaps and metrics.

## Scope

Only these FreeType paths exist, each with FreeType's arithmetic, limits and error codes:

| File          | FreeType source                         | Covers                                                                                                                                        |
| ------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `sfnt.ts`     | `sfobjs.c`, `ttload.c`, `ttmtx.c`       | sfnt and TrueType collection headers, `head`, `maxp`, `hhea`/`hmtx`, `vhea`/`vmtx`, `post`, `OS/2` metrics                                    |
| `cmap.ts`     | `ttcmap.c`, `ftobjs.c`                  | cmap subtable validation, the default Unicode charmap, formats 4 and 12 (format 14 maps nothing)                                              |
| `truetype.ts` | `ttgload.c`, `ttpload.c`                | unhinted simple and composite `glyf` outlines, both `loca` formats, `head.flags` bit 3 integer ppem                                           |
| `cff.ts`      | `cffload.c`, `cffparse.c`, `cffgload.c` | CID-keyed CFF in OpenType: INDEX, DICT, FDArray/FDSelect, font matrices, Type 2 charstrings without hinting                                   |
| `fixed.ts`    | `ftcalc.c`                              | 16.16 and 26.6 arithmetic                                                                                                                     |
| `outline.ts`  | `ftgloadr.c`, `ftoutln.c`               | glyph loader limits, `FT_Outline_Check`                                                                                                       |
| `raster.ts`   | `ftgrays.c`, `ftbitmap.c`               | the smooth renderer (nonzero fill, 8-bit coverage), `FT_Bitmap_Embolden`                                                                      |
| `face.ts`     | `ftobjs.c`, `ftsynth.c`                 | driver selection, `FT_Request_Size` with zero resolution, `FT_Load_Char` with `FT_LOAD_NO_HINTING \| FT_LOAD_RENDER`, `FT_GlyphSlot_Embolden` |

Not implemented: hinting and load flags other than `NO_HINTING | RENDER` (refused by
`freetype.ts`), embedded bitmap strikes (the outline is rendered instead), name-keyed CFF
and `seac` accents, bare CFF and Type 1 files, cmap formats 0, 2, 6, 8, 10 and 13 as the
default charmap, and FreeType's tricky-font list, on which no supported font appears. The
unimplemented paths fail with FreeType's `Unimplemented_Feature` or `Unknown_File_Format`
error. A shear is accepted and has no effect, as in FreeType, because the render load
leaves a bitmap in the slot.

## Rasterization

`face.ts` loads the outline in TypeScript and hands it to an `OutlineRasterizer`:

- `raster-wasm.ts` runs `wasm/outline-raster` (Rust, WebAssembly SIMD), which renders and
  emboldens in its own memory. One instance per thread is shared by all faces.
- `JsOutlineRasterizer` in `raster.ts` runs the same algorithm with typed arrays. It is
  used when WebAssembly SIMD is unavailable, for glyphs beyond the module's 64 MiB memory
  bound, and when a face is opened with `{wasm: false}`.

Both produce identical bytes. The cell accumulation keeps dense per-row cover and area
arrays instead of FreeType's banded cell lists and visits cells in the same order, so
every coverage value matches.

`tools/benchmark-outline-font.mjs <font> [baseline dist]` compares both rasterizers with a
baseline build and checks that every glyph is identical.

## License

These files are derived from FreeType 2.4.8. Portions of this software are copyright ©
2011 The FreeType Project (www.freetype.org). All rights reserved. They are distributed
under the FreeType License in `LICENSE`, which the website build emits as
`assets/freetype.LICENSE.txt`.
