// AAN scale products, rounded as in native table 0x1401647a0.
export const aokanaMovieAanScale = [
  1, 1.3870398998260498, 1.3065630197525024, 1.1758755445480347, 1, 0.78569495677948,
  0.5411961078643799, 0.27589938044548035, 1.3870398998260498, 1.9238795042037964,
  1.8122549057006836, 1.6309863328933716, 1.3870398998260498, 1.0897902250289917,
  0.7506605386734009, 0.3826834261417389, 1.3065630197525024, 1.8122549057006836,
  1.7071068286895752, 1.5363554954528809, 1.3065630197525024, 1.0265599489212036,
  0.7071067690849304, 0.3604799211025238, 1.1758755445480347, 1.6309863328933716,
  1.5363554954528809, 1.3826833963394165, 1.1758755445480347, 0.9238795042037964,
  0.6363793015480042, 0.32442334294319153, 1, 1.3870398998260498, 1.3065630197525024,
  1.1758755445480347, 1, 0.78569495677948, 0.5411961078643799, 0.27589938044548035,
  0.78569495677948, 1.0897902250289917, 1.0265599489212036, 0.9238795042037964, 0.78569495677948,
  0.6173165440559387, 0.4252150356769562, 0.21677275002002716, 0.5411961078643799,
  0.7506605386734009, 0.7071067690849304, 0.6363793015480042, 0.5411961078643799,
  0.4252150356769562, 0.2928932309150696, 0.14931567013263702, 0.27589938044548035,
  0.3826834261417389, 0.3604799211025238, 0.32442334294319153, 0.27589938044548035,
  0.21677275002002716, 0.14931567013263702, 0.07612046599388123,
];
const f = Math.fround;
const add = (a: number, b: number) => f(a + b);
const sub = (a: number, b: number) => f(a - b);
const mul = (a: number, b: number) => f(a * f(b));
function aan(a: readonly number[]): number[] {
  const e0 = add(a[0]!, a[4]!),
    e1 = sub(a[0]!, a[4]!);
  const e2 = add(a[2]!, a[6]!),
    e3 = sub(mul(sub(a[2]!, a[6]!), 1.4142135), e2);
  const t0 = add(e0, e2),
    t3 = sub(e0, e2),
    t1 = add(e1, e3),
    t2 = sub(e1, e3);
  const z13 = add(a[5]!, a[3]!),
    z10 = sub(a[5]!, a[3]!);
  const z11 = add(a[1]!, a[7]!),
    z12 = sub(a[1]!, a[7]!);
  const o7 = add(z11, z13),
    z5 = mul(add(z12, z10), 1.847759);
  const o6 = sub(add(mul(z10, -2.613126), z5), o7);
  const o5 = sub(mul(sub(z11, z13), 1.4142135), o6);
  const o4 = add(o5, sub(mul(z12, 1.0823922), z5));
  return [
    add(o7, t0),
    add(o6, t1),
    add(o5, t2),
    sub(t3, o4),
    add(o4, t3),
    sub(t2, o5),
    sub(t1, o6),
    sub(t0, o7),
  ];
}
/** Native SSE path: float32 operations, truncate, saturate to i16, arithmetic >>3, +128. */
export function movieIdct(coefficients: Int16Array, quantization: Uint8Array): Uint8Array {
  const work = new Float32Array(64);
  for (let x = 0; x < 8; x++) {
    const column = Array.from({length: 8}, (_, y) => {
      const i = y * 8 + x;
      return mul(coefficients[i]!, mul(quantization[i]!, aokanaMovieAanScale[i]!));
    });
    const result = aan(column);
    for (let y = 0; y < 8; y++) work[y * 8 + x] = result[y]!;
  }
  const output = new Uint8Array(64);
  for (let y = 0; y < 8; y++) {
    const row = aan(Array.from(work.subarray(y * 8, y * 8 + 8)));
    for (let x = 0; x < 8; x++) {
      const n = Math.max(-32768, Math.min(32767, Math.trunc(row[x]!)));
      output[y * 8 + x] = Math.max(0, Math.min(255, (n >> 3) + 128));
    }
  }
  return output;
}
