/** Neutral RGBA: grey 0x80 is 1.0 in the doubled RGB product, alpha 0xff. */
export const EMOTE_NEUTRAL_COLOR = 0x808080ff;

/** 0x1002b1c0 / 0x180030810: saturated RGB product /128, alpha product /255. */
export function modulateColor(a: number, b: number): number {
  a >>>= 0;
  b >>>= 0;
  if (b === EMOTE_NEUTRAL_COLOR) return a;
  if (a === EMOTE_NEUTRAL_COLOR) return b;
  let out = Math.trunc(((a & 0xff) * (b & 0xff)) / 255);
  for (let s = 8; s < 32; s += 8) {
    const v = (((a >>> s) & 0xff) * ((b >>> s) & 0xff)) >> 7;
    out |= Math.min(255, v) << s;
  }
  return out >>> 0;
}
