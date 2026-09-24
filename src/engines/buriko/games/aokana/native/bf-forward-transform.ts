import {aokanaMovieAanScale} from '../../../../../formats/buriko/movie-idct.js';

const f = Math.fround;
const luma = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113,
  92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];
const chroma = [
  17,
  18,
  24,
  47,
  99,
  99,
  99,
  99,
  18,
  21,
  26,
  66,
  99,
  99,
  99,
  99,
  24,
  26,
  56,
  99,
  99,
  99,
  99,
  99,
  47,
  66,
  99,
  99,
  99,
  99,
  99,
  99,
  ...Array<number>(32).fill(99),
];

/** 108670: quantization bytes and float reciprocals of double-scaled AAN products. */
export function aokanaBfEncoderQuantization(quality: number): {
  bytes: Uint8Array;
  multipliers: Float32Array;
} {
  const bytes = new Uint8Array(128),
    multipliers = new Float32Array(128);
  const ratio = quality < 50 ? (quality * 2) / 100 : (200 - quality * 2) / 100;
  for (let component = 0; component < 2; component++)
    for (let index = 0; index < 64; index++) {
      const base = (component === 0 ? luma : chroma)[index]!;
      let q = Math.trunc(quality < 50 ? 255 - (255 - base) * ratio : base * ratio) & 255;
      if (quality >= 50 && q === 0) q = 1;
      bytes[component * 64 + index] = q;
      multipliers[component * 64 + index] = f(1 / (f(q * aokanaMovieAanScale[index]!) * 8));
    }
  return {bytes, multipliers};
}

/** 1092E0 initializes lookup entries in double before storing each float. */
const tables = Array.from({length: 9}, () => new Float32Array(256));
for (let n = 0; n < 256; n++) {
  tables[0]![n] = n * 0.299;
  tables[1]![n] = n * 0.587;
  tables[2]![n] = n * 0.114 + 0.5;
  tables[3]![n] = n * -0.16874;
  tables[4]![n] = n * -0.33126;
  tables[5]![n] = n * 0.5 + 128.5;
  tables[6]![n] = n * 0.5;
  tables[7]![n] = n * -0.41869;
  tables[8]![n] = 128 - n * 0.08131 + 0.5;
}

/** 104AF0's separately rounded table additions and saturating lookup. */
export function aokanaBfEncoderComponents(
  b: number,
  g: number,
  r: number,
): readonly [number, number, number] {
  const at = (base: number) =>
    Math.max(
      0,
      Math.min(
        255,
        Math.trunc(
          f(f(f(tables[base + 1]![g]! + tables[base]![r]!) + tables[base + 2]![b]!) + 256),
        ) - 256,
      ),
    );
  return [at(0), at(3), at(6)];
}

/** 104350: float additions, double constant products, then float stores. */
function aan(input: readonly number[], center: boolean): number[] {
  const a0 = f(input[0]! + input[7]! - (center ? 256 : 0)),
    a1 = f(input[1]! + input[6]! - (center ? 256 : 0)),
    a2 = f(input[2]! + input[5]! - (center ? 256 : 0)),
    a3 = f(input[3]! + input[4]! - (center ? 256 : 0));
  const d0 = f(input[0]! - input[7]!),
    d1 = f(input[1]! - input[6]!),
    d2 = f(input[2]! - input[5]!),
    d3 = f(input[3]! - input[4]!);
  const e0 = f(a3 + a0),
    e1 = f(a2 + a1),
    e2 = f(a0 - a3),
    e3 = f(a1 - a2),
    z1 = f(f(e3 + e2) * 0.707106781);
  const t0 = f(d3 + d2),
    t1 = f(d2 + d1),
    t2 = f(d1 + d0),
    z5 = f(f(t0 - t2) * 0.382683433),
    z2 = f(t0 * 0.5411961 + z5),
    z4 = f(t2 * 1.306562965 + z5),
    z3 = f(t1 * 0.707106781),
    z11 = f(z3 + d0),
    z13 = f(d0 - z3);
  return [
    f(e1 + e0),
    f(z11 + z4),
    f(z1 + e2),
    f(z13 - z2),
    f(e0 - e1),
    f(z13 + z2),
    f(e2 - z1),
    f(z11 - z4),
  ];
}

export function aokanaBfForwardBlock(
  samples: readonly number[],
  multipliers: Float32Array,
): Int16Array {
  const rows = Array.from({length: 8}, (_, y) => aan(samples.slice(y * 8, y * 8 + 8), true));
  const result = new Int16Array(64);
  for (let x = 0; x < 8; x++) {
    const column = aan(
      rows.map((row) => row[x]!),
      false,
    );
    for (let y = 0; y < 8; y++) {
      const index = y * 8 + x;
      const value =
        ((Math.trunc(f(column[y]! * multipliers[index]!) + 16384.5) - 16384) << 16) >> 16;
      result[index] = index === 0 ? value : Math.max(-1023, Math.min(1023, value));
    }
  }
  return result;
}
