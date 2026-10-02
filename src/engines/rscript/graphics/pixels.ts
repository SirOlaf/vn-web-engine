/**
 * Native 32-bit pixels, read as little-endian words: `B | G << 8 | R << 16 | T << 24`,
 * where T is transparency (0 opaque, 255 invisible). Browsers and Node run little-endian,
 * so word views over decoded images keep the native byte order.
 */
export interface RScriptSurface {
  readonly width: number;
  readonly height: number;
  readonly data: Uint32Array;
}

export function createSurface(width: number, height: number, fill = 0): RScriptSurface {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 0 || height < 0)
    throw new Error(`Invalid surface size ${width}x${height}`);
  const data = new Uint32Array(width * height);
  if (fill) data.fill(fill >>> 0);
  return {width, height, data};
}

export function surfaceFromImage(image: {
  width: number;
  height: number;
  pixels: Uint8Array;
}): RScriptSurface {
  if (image.pixels.byteOffset & 3) throw new Error('Unaligned RScript image pixels');
  return {
    width: image.width,
    height: image.height,
    data: new Uint32Array(image.pixels.buffer, image.pixels.byteOffset, image.width * image.height),
  };
}

/**
 * CMath::Init (0x4489E0). `add[t][c] = c * (256 - t) / 256` darkens by t;
 * `del[t][c] = (256 - c) * t / 256 + c` brightens by t. Rows are indexed `t << 8 | c`.
 */
function blendTable(brighten: boolean): Uint8Array {
  const table = new Uint8Array(65536);
  for (let t = 0; t < 256; t++)
    for (let c = 0; c < 256; c++)
      table[(t << 8) | c] = brighten
        ? Math.trunc(((256 - c) * t) / 256 + c)
        : Math.trunc((c * (256 - t)) / 256);
  return table;
}
export const ADD_TABLE = blendTable(false);
export const DEL_TABLE = blendTable(true);

/** 256-step fixed-point tables scaled by 65535 (CMath::m_pSinTable / m_pCosTable). */
export const SIN_TABLE = Int32Array.from({length: 256}, (_, i) =>
  Math.trunc(Math.sin(i * 0.00390625 * 6.283185308) * 65535),
);
export const COS_TABLE = Int32Array.from({length: 256}, (_, i) =>
  Math.trunc(Math.cos(i * 0.00390625 * 6.283185308) * 65535),
);

/** Scales the three colour channels through one table row; transparency becomes 0. */
export function scaleRgb(table: Uint8Array, row: number, pixel: number): number {
  const base = row << 8;
  return (
    table[base | (pixel & 0xff)]! |
    (table[base | ((pixel >>> 8) & 0xff)]! << 8) |
    (table[base | ((pixel >>> 16) & 0xff)]! << 16)
  );
}

/** `add[t][src] + add[255 - t][dst]` per channel: the native transparency blend. */
export function mixRgb(src: number, dst: number, t: number): number {
  const a = t << 8,
    b = (255 - t) << 8;
  return (
    ((ADD_TABLE[a | (src & 0xff)]! + ADD_TABLE[b | (dst & 0xff)]!) |
      ((ADD_TABLE[a | ((src >>> 8) & 0xff)]! + ADD_TABLE[b | ((dst >>> 8) & 0xff)]!) << 8) |
      ((ADD_TABLE[a | ((src >>> 16) & 0xff)]! + ADD_TABLE[b | ((dst >>> 16) & 0xff)]!) << 16)) >>>
    0
  );
}

export interface RScriptRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export const emptyRect = (): RScriptRect => ({left: 0, top: 0, right: 0, bottom: 0});

export function isEmptyRect(r: RScriptRect): boolean {
  return r.right <= r.left || r.bottom <= r.top;
}

/** UnionRect (sub_44F1B0), treating empty rectangles as absent. */
export function unionRect(a: RScriptRect, b: RScriptRect): RScriptRect {
  if (isEmptyRect(a)) return {...b};
  if (isEmptyRect(b)) return {...a};
  return {
    left: Math.min(a.left, b.left),
    top: Math.min(a.top, b.top),
    right: Math.max(a.right, b.right),
    bottom: Math.max(a.bottom, b.bottom),
  };
}

export function intersectRect(a: RScriptRect, b: RScriptRect): RScriptRect {
  return {
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  };
}
