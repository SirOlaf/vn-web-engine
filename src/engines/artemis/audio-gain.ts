import {artemisRevision} from './revision.js';
const f = Math.fround;
function int32(value: number): void {
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff)
    throw Error('Unsupported Artemis int32 sound gain');
}
/** ae6a0: signed-key order, float32 multiply/divide for every gain layer,
 * then floorf(float32(value+0.5)) before the native integer player setter. */
export function artemisSoundGain(
  hash: string,
  groupGain: number,
  factors: ReadonlyMap<number, number>,
): number {
  artemisRevision(hash);
  int32(groupGain);
  let gain = f(groupGain);
  const sorted = [...factors].sort(([a], [b]) => a - b);
  for (const [key, value] of sorted) {
    int32(key);
    int32(value);
    gain = f(f(f(value) * gain) / 1000);
  }
  const rounded = Math.floor(f(gain + f(0.5)));
  int32(rounded);
  return rounded;
}

/**164760/1647f0 convert linear native units to DirectSound hundredths of dB.
 * Browser adapters apply these attenuations to independent channels, not an
 * equal-power StereoPanner (which redistributes stereo content). */
export function artemisSoundAttenuation(hash: string, gain: number): number {
  artemisRevision(hash);
  int32(gain);
  return gain >= 1000
    ? 0
    : gain < 1
      ? -10000
      : Math.floor(Math.log10(gain / 1000) * 20 * 100 + 0.5);
}
export function artemisSoundBalance(hash: string, pan: number): {left: number; right: number} {
  artemisRevision(hash);
  int32(pan);
  const decibels =
    pan >= 1000
      ? 10000
      : pan < -999
        ? -10000
        : pan === 0
          ? 0
          : Math.floor(
              (pan < 0 ? Math.log10((pan + 1000) / 1000) : -Math.log10((1000 - pan) / 1000)) *
                20 *
                100 +
                0.5,
            );
  return {
    left: decibels > 0 ? 10 ** (-decibels / 2000) : 1,
    right: decibels < 0 ? 10 ** (decibels / 2000) : 1,
  };
}
