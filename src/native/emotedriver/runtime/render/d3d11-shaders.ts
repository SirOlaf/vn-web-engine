import type {ID3D11Device} from '../../../d3d11/contract.js';
import {EmoteD3d11Program} from './d3d11-program.js';
import type {EmoteX64ShaderBlobs} from './shaders.js';

/** Native table coordinates, not SDK strings or driver selectors. */
export type EmoteD3d11TextureKind = 0 | 1 | 2 | 3 | 4;
export type EmoteD3d11ColorMode = 0 | 4 | 8;
export type EmoteD3d11MaskMode = 0 | 1 | 2 | 3;

function coordinate(value: number, count: number): void {
  if (!Number.isInteger(value) || value < 0 || value >= count)
    throw new RangeError('E-mote shader table coordinate outside native range');
}
function sourceIndex(
  kind: EmoteD3d11TextureKind,
  color: EmoteD3d11ColorMode,
  mask: EmoteD3d11MaskMode,
): number {
  coordinate(kind, 5);
  coordinate(color / 4, 3);
  coordinate(mask, 4);
  return kind * 12 + color + mask;
}

/** 0x180063030: 900 basic pixel programs. Filter is 0/3/6/9/12; fixup is 0/1/2. */
export function emoteD3d11BasicShader(
  kind: EmoteD3d11TextureKind,
  color: EmoteD3d11ColorMode,
  mask: EmoteD3d11MaskMode,
  filter: number,
  fixup: number,
): number {
  const source = sourceIndex(kind, color, mask);
  coordinate(filter / 3, 5);
  coordinate(fixup, 3);
  return source * 15 + filter + fixup;
}

/** 0x180063cc0: 1,140 destination-reading pixel programs, including mosaic and blur. */
export function emoteD3d11BufferedShader(
  kind: EmoteD3d11TextureKind,
  color: EmoteD3d11ColorMode,
  mask: EmoteD3d11MaskMode,
  formula: number,
): number {
  const source = sourceIndex(kind, color, mask);
  coordinate(formula, 19);
  return 900 + source * 19 + formula;
}

/** 0x180063780: first intersection, next intersection, subtraction; with/without alpha test. */
export function emoteD3d11MaskShader(
  kind: EmoteD3d11TextureKind,
  alphaTest: boolean,
  pass: 0 | 1 | 2,
): number {
  coordinate(kind, 5);
  coordinate(pass, 3);
  return 2042 + (kind * 2 + +alphaTest) * 3 + pass;
}

/** 0x180063520: the five texture-kind-specific alpha-reference programs. */
export function emoteD3d11AlphaShader(kind: EmoteD3d11TextureKind): number {
  coordinate(kind, 5);
  return 2072 + kind;
}

/**
 * Native fixed shader bank (0x180062580), owned by the x64 motion device. The twelve
 * vertex and 2,077 pixel programs are prepared once; draw selection only indexes it.
 * Pixel entries 2040/2041 are the two separate transition programs.
 */
export class EmoteD3d11Shaders {
  private readonly vertices: (EmoteD3d11Program | null)[] = Array(12).fill(null);
  private readonly pixels: EmoteD3d11Program[] = [];
  private closed = false;

  constructor(device: ID3D11Device, blobs: EmoteX64ShaderBlobs) {
    if (
      blobs.vertex.length !== 12 ||
      blobs.inputLayouts.length !== 12 ||
      blobs.vertexReflection.length !== 12 ||
      blobs.pixel.length !== 2077 ||
      blobs.pixelReflection.length !== 2077
    )
      throw new Error('E-mote shader bank does not match the native table sizes');
    try {
      // Constructor 0x180062580 follows the physical layout rows, then stores by shader index.
      for (const i of [3, 0, 4, 5, 1, 2, 9, 6, 10, 11, 7, 8]) {
        if (blobs.vertexReflection[i]!.stage !== 'vertex')
          throw new Error('E-mote vertex reflection stage mismatch');
        this.vertices[i] = new EmoteD3d11Program(
          device,
          blobs.vertex[i]!,
          blobs.vertexReflection[i]!,
          blobs.inputLayouts[i]!,
        );
      }
      for (let i = 0; i < 2077; i++) {
        if (blobs.pixelReflection[i]!.stage !== 'pixel')
          throw new Error('E-mote pixel reflection stage mismatch');
        this.pixels.push(
          new EmoteD3d11Program(device, blobs.pixel[i]!, blobs.pixelReflection[i]!, null),
        );
      }
    } catch (error) {
      try {
        this.dispose();
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          'E-mote shader bank construction and cleanup failed',
        );
      }
      throw error;
    }
  }

  /** The native shader index is independent of the layout table's row order. */
  vertex(index: number): EmoteD3d11Program {
    this.live();
    coordinate(index, 12);
    return this.vertices[index]!;
  }
  pixel(index: number): EmoteD3d11Program {
    this.live();
    coordinate(index, 2077);
    return this.pixels[index]!;
  }
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    const errors: unknown[] = [];
    for (const list of [this.pixels, this.vertices])
      for (const program of list.splice(0).reverse())
        try {
          program?.dispose();
        } catch (error) {
          errors.push(error);
        }
    if (errors.length) throw new AggregateError(errors, 'E-mote shader bank failed to release');
  }
  private live(): void {
    if (this.closed) throw new Error('E-mote shader bank is released');
  }
}
