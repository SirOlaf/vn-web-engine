import {nativeParticleSineCosine} from '../bp/opcodes/native-math.js';

export interface AokanaSpriteBoundsInput {
  width: number;
  height: number;
  extraWidth: number;
  centerX: number;
  centerY: number;
  angle: number;
  scaleX: number;
  scaleY: number;
  phaseX: number;
  phaseY: number;
}
export interface AokanaSpriteBounds {
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
}

const truncate = (value: number): number => {
  const result = Math.trunc(value);
  return !Number.isFinite(result) || result < -0x80000000 || result > 0x7fffffff
    ? -0x80000000 : result;
};
const fraction = (value: number): number => ((truncate(value * 65536) & 65535) + 65535) >>> 16;
const lower = (value: number): number => (truncate(value) - (value < 0 ? fraction(value) : 0)) | 0;
const upper = (value: number): number => (truncate(value) + (value >= 0 ? fraction(value) : 0)) | 0;
const phase = (scale: number, offset: number): number =>
  Number((BigInt(scale >>> 0) * BigInt(offset >>> 0) >> 16n) & 65535n) / 65536;

/** 0626A0 retains DWORD width expansion, binary64 corner order, seeded extrema,
 * unsigned Q16 scale and the CRT's separate low-WORD boundary conversions. */
export function aokanaSpriteBounds(input: AokanaSpriteBoundsInput): AokanaSpriteBounds {
  const width = input.width >>> 0,
    height = input.height >>> 0,
    expandedWidth = (Math.imul((input.extraWidth + 65536) | 0, width) >>> 0) / 65536,
    pivotX = (expandedWidth - width) * 0.5 + (input.centerX | 0) / 65536,
    pivotY = (input.centerY | 0) / 65536,
    {cosine, sine} = nativeParticleSineCosine(input.angle),
    scaleX = (input.scaleX >>> 0) / 65536,
    scaleY = (input.scaleY >>> 0) / 65536;
  const xs = [-pivotX, expandedWidth - pivotX - 1],
    ys = [pivotY, pivotY - height + 1];
  let minimumX = 1000000000,
    maximumX = -1000000000,
    minimumY = 1000000000,
    maximumY = -1000000000;
  for (const y of ys)
    for (const x of xs) {
      const scaledX = x * scaleX,
        scaledY = y * scaleY,
        rotatedX = scaledX * cosine - scaledY * sine,
        rotatedY = scaledY * cosine + scaledX * sine;
      minimumX = Math.min(minimumX, rotatedX);
      maximumX = Math.max(maximumX, rotatedX);
      minimumY = Math.min(minimumY, rotatedY);
      maximumY = Math.max(maximumY, rotatedY);
    }
  const left = lower(minimumX),
    right = lower(maximumX + phase(input.scaleX, input.phaseX)),
    top = upper(maximumY),
    bottom = upper(minimumY - phase(input.scaleY, input.phaseY));
  return {offsetY: top, offsetX: -left | 0, width: (right - left + 1) >>> 0, height: (top - bottom + 1) >>> 0};
}
