import {BurikoCrtRandom} from './system-timing.js';

/** 14007e4f0 consumes sixteen CRT draws, retaining each signed IDIV and DWORD addition. */
export function burikoShakeRandom(random: BurikoCrtRandom, amplitude: number): number {
  const divisor = (amplitude + 1) | 0;
  let sum = 0;
  for (let index = 0; index < 8; index++) {
    const first = random.next(),
      second = random.next();
    const numerator = (first << 15) | second;
    if (divisor === 0 || (numerator === -2147483648 && divisor === -1))
      throw new Error('Buriko shake random native IDIV fault');
    sum = (sum + (numerator % divisor)) | 0;
  }
  return sum >> 3;
}

/** 14007e450 leaves the output pair untouched outside mode three. */
export function burikoShakeTarget(
  random: BurikoCrtRandom,
  mode: number,
  amplitude: number,
  quadrant: number,
  previous: readonly [number, number],
): readonly [number, number] {
  if ((mode | 0) !== 3) return previous;
  if ((amplitude | 0) < 1) return [0, 0];
  const x = burikoShakeRandom(random, amplitude),
    y = burikoShakeRandom(random, amplitude);
  switch (quadrant | 0) {
    case 0:
      return [x, -y | 0];
    case 1:
      return [x, y];
    case 2:
      return [-x | 0, y];
    case 3:
      return [-x | 0, -y | 0];
    default:
      return previous;
  }
}
