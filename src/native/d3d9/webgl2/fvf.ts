/**
 * Flexible vertex format layouts. An FVF expands to the vertex declaration Direct3D 9 derives
 * from it (D3DDECLUSAGE and index per element), which binds both the fixed-function pipeline
 * and vertex shader inputs (`dcl_<usage><index>`).
 */

/** D3DDECLUSAGE values used by FVF elements. */
export const Usage = {
  POSITION: 0,
  BLENDWEIGHT: 1,
  BLENDINDICES: 2,
  NORMAL: 3,
  PSIZE: 4,
  TEXCOORD: 5,
  POSITIONT: 9,
  COLOR: 10,
} as const;

export type FvfElementType = 'float' | 'color' | 'ubyte4';

export interface FvfElement {
  readonly usage: number;
  readonly usageIndex: number;
  readonly offset: number;
  /** Float components, or 4 for `color`/`ubyte4`. */
  readonly components: number;
  readonly type: FvfElementType;
}

export interface FvfLayout {
  readonly fvf: number;
  readonly stride: number;
  readonly elements: readonly FvfElement[];
  /** XYZRHW: positions are already transformed to screen space. */
  readonly pretransformed: boolean;
  /** Number of texture coordinate sets. */
  readonly textureSets: number;
  /** Byte offsets of D3DCOLOR elements, which the device swizzles BGRA → RGBA. */
  readonly colorOffsets: readonly number[];
}

const POSITION_MASK = 0x400e;
const XYZ = 0x002;
const XYZRHW = 0x004;
const XYZW = 0x4002;
const NORMAL = 0x010;
const PSIZE = 0x020;
const DIFFUSE = 0x040;
const SPECULAR = 0x080;
const LASTBETA_UBYTE4 = 0x1000;
const LASTBETA_D3DCOLOR = 0x8000;

/** Floats per texture-coordinate set for `D3DFVF_TEXCOORDSIZEn` codes 0..3. */
const textureSizes = [2, 3, 4, 1];

/** Expands an FVF. Returns null for an FVF without a position. */
export function fvfLayout(fvf: number): FvfLayout | null {
  const elements: FvfElement[] = [];
  const colorOffsets: number[] = [];
  let offset = 0;
  const push = (
    usage: number,
    usageIndex: number,
    components: number,
    type: FvfElementType = 'float',
  ) => {
    elements.push({usage, usageIndex, offset, components, type});
    if (type === 'color') colorOffsets.push(offset);
    offset += type === 'float' ? components * 4 : 4;
  };
  const position = fvf & POSITION_MASK;
  let pretransformed = false;
  if (position === XYZ) push(Usage.POSITION, 0, 3);
  else if (position === XYZRHW) {
    push(Usage.POSITIONT, 0, 4);
    pretransformed = true;
  } else if (position === XYZW) push(Usage.POSITION, 0, 4);
  else if (position >= 0x006 && position <= 0x00e && (position & 1) === 0) {
    // XYZB1..XYZB5: blend weights follow the position; the last beta may hold indices.
    push(Usage.POSITION, 0, 3);
    let betas = (position - 0x004) / 2;
    const indices = (fvf & (LASTBETA_UBYTE4 | LASTBETA_D3DCOLOR)) !== 0;
    if (indices) betas--;
    if (betas > 0) push(Usage.BLENDWEIGHT, 0, betas);
    if (indices) push(Usage.BLENDINDICES, 0, 4, fvf & LASTBETA_D3DCOLOR ? 'color' : 'ubyte4');
  } else return null;
  if (fvf & NORMAL) push(Usage.NORMAL, 0, 3);
  if (fvf & PSIZE) push(Usage.PSIZE, 0, 1);
  if (fvf & DIFFUSE) push(Usage.COLOR, 0, 4, 'color');
  if (fvf & SPECULAR) push(Usage.COLOR, 1, 4, 'color');
  const textureSets = Math.min((fvf >>> 8) & 0xf, 8);
  for (let i = 0; i < textureSets; i++)
    push(Usage.TEXCOORD, i, textureSizes[(fvf >>> (16 + i * 2)) & 3]!);
  return {fvf, stride: offset, elements, pretransformed, textureSets, colorOffsets};
}

export function findElement(
  layout: FvfLayout,
  usage: number,
  usageIndex: number,
): FvfElement | undefined {
  // A vertex shader reading POSITION from a pretransformed stream gets POSITIONT.
  return layout.elements.find(
    (e) =>
      e.usageIndex === usageIndex &&
      (e.usage === usage ||
        (usage === Usage.POSITION && e.usage === Usage.POSITIONT && usageIndex === 0)),
  );
}

/**
 * Copies `vertexCount` vertices of `stride` bytes into `out`, swapping bytes 0 and 2 of each
 * D3DCOLOR (B, G, R, A in memory) so GL reads normalized R, G, B, A.
 */
export function copyVertices(
  source: Uint8Array,
  stride: number,
  vertexCount: number,
  colorOffsets: readonly number[],
  out: Uint8Array,
): void {
  const length = stride * vertexCount;
  out.set(source.subarray(0, length));
  if (colorOffsets.length === 0) return;
  for (let base = 0; base < length; base += stride)
    for (const offset of colorOffsets) {
      const at = base + offset;
      if (at + 3 > length) continue;
      const b = out[at]!;
      out[at] = out[at + 2]!;
      out[at + 2] = b;
    }
}
