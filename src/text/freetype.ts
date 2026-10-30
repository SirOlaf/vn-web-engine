import {OutlineFace, type SizeRequestType} from './outline-font/face.js';
import {FontError} from './outline-font/sfnt.js';

export interface FreeTypeMetrics {
  readonly unitsPerEm: number;
  readonly ascender: number;
  readonly descender: number;
  readonly height: number;
  readonly maxAdvanceWidth: number;
  readonly maxAdvanceHeight: number;
  readonly glyphCount: number;
  readonly faceCount: number;
  readonly xPpem: number;
  readonly yPpem: number;
  readonly scaledAscender: number;
  readonly scaledDescender: number;
  readonly scaledHeight: number;
  readonly scaledMaxAdvance: number;
  readonly underlinePosition: number;
  readonly underlineThickness: number;
}
export interface FreeTypeSizeRequest {
  readonly type: 0 | 1 | 2 | 3 | 4;
  readonly width: number;
  readonly height: number;
}
export interface FreeTypeRasterOptions {
  readonly flags?: number;
  readonly bold?: boolean;
  readonly shear?: number;
  /** Apply the size immediately before loading this glyph, including in worker jobs. */
  readonly size?: FreeTypeSizeRequest;
}
export interface FreeTypeGlyph {
  readonly glyphIndex: number;
  readonly bitmapMode: number;
  readonly width: number;
  readonly height: number;
  readonly left: number;
  readonly top: number;
  readonly advanceX: number;
  readonly advanceY: number;
  /** Packed top-down grayscale coverage, owned by the caller. */
  readonly pixels: Uint8Array;
}
/** `FT_LOAD_NO_HINTING | FT_LOAD_RENDER`, the only load the Artemis font providers issue. */
const LOAD_FLAGS = 6;
/** `FT_PIXEL_MODE_GRAY`. */
const PIXEL_MODE_GRAY = 2;
function int(value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw Error('Invalid FreeType integer');
  return value;
}
/** FreeType's numeric error for a font failure; anything else is a programming error. */
function code(error: unknown): number {
  if (error instanceof FontError) return error.code;
  throw error;
}
/** The observable behavior of memory-only FreeType 2.4.8 for the features Artemis fonts use
 * (`src/text/outline-font/`). Each instance owns its faces and their copied bytes.
 */
export class FreeType {
  private readonly faces = new Set<FreeTypeFace>();
  private closed = false;
  /** `wasm: false` rasterizes in JavaScript instead of WebAssembly; output is identical. */
  constructor(private readonly options: {wasm?: boolean} = {}) {}
  get version(): readonly number[] {
    this.assertOpen();
    return [2, 4, 8];
  }
  open(bytes: Uint8Array, faceIndex = 0): FreeTypeFace {
    this.assertOpen();
    int(bytes.byteLength, 1, 64 * 1024 * 1024);
    int(faceIndex, 0, 0x7fffffff);
    if (this.faces.size >= 16) throw Error('FreeType face budget exceeded');
    let outline: OutlineFace;
    try {
      outline = new OutlineFace(bytes.slice(), faceIndex, this.options);
    } catch (error) {
      throw Error('FreeType font error ' + code(error));
    }
    const face = new FreeTypeFace(this, outline);
    this.faces.add(face);
    return face;
  }
  /** Internal owner operation; callers use FreeTypeFace.close(). */
  release(face: FreeTypeFace): void {
    this.faces.delete(face);
  }
  private assertOpen(): void {
    if (this.closed) throw Error('FreeType closed or interrupted');
  }
  close(): void {
    if (this.closed) return;
    for (const face of [...this.faces]) face.close();
    this.closed = true;
  }
}
/** Pixel size requests use native 26.6 units, independent of CSS or platform font
 * substitution.
 */
export class FreeTypeFace {
  private closed = false;
  private assertOpen(): void {
    if (this.closed) throw Error('FreeType face closed');
  }
  constructor(
    private readonly owner: FreeType,
    private readonly face: OutlineFace,
  ) {}
  get metrics(): FreeTypeMetrics {
    this.assertOpen();
    return this.face.metrics;
  }
  requestSize(type: 0 | 1 | 2 | 3 | 4, width: number, height: number): void {
    this.assertOpen();
    int(type, 0, 4);
    int(width, 0, 4096 * 64);
    int(height, 1, 4096 * 64);
    try {
      this.face.requestSize(type as SizeRequestType, width, height);
    } catch (error) {
      throw Error('FreeType size error ' + code(error));
    }
  }
  /** `FT_Load_Char` with `FT_LOAD_NO_HINTING | FT_LOAD_RENDER`, optionally followed by
   * `FT_GlyphSlot_Embolden`. A shear only transforms an outline slot, and a rendered slot holds
   * a bitmap, so it never changes the result.
   */
  rasterize(codePoint: number, options: FreeTypeRasterOptions = {}): FreeTypeGlyph {
    this.assertOpen();
    if (options.size) this.requestSize(options.size.type, options.size.width, options.size.height);
    const flags = options.flags ?? LOAD_FLAGS,
      shear = options.shear ?? 0;
    int(codePoint, 0, 0x10ffff);
    int(flags, 0, 0x7fffffff);
    int(shear, -0x10000, 0x10000);
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) throw Error('Invalid FreeType Unicode scalar');
    if (!(flags & 4)) throw Error('FreeType raster glyph requires render flag');
    if (flags !== LOAD_FLAGS) throw Error('Unsupported FreeType load flags ' + flags);
    let glyph;
    try {
      glyph = this.face.render(codePoint, options.bold ?? false, (width, height) => {
        int(width, 0, 4096);
        int(height, 0, 4096);
        if (width * height > 4 * 1024 * 1024) throw Error('FreeType glyph pixel budget exceeded');
      });
    } catch (error) {
      throw Error('FreeType glyph error ' + code(error));
    }
    return {
      glyphIndex: glyph.glyphIndex,
      bitmapMode: PIXEL_MODE_GRAY,
      width: glyph.width,
      height: glyph.height,
      left: glyph.left,
      top: glyph.top,
      advanceX: glyph.advanceX,
      advanceY: 0,
      pixels: glyph.pixels,
    };
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.owner.release(this);
  }
}
