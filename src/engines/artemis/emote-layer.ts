import type {EmotePlayer} from '../../native/emotedriver/player.js';

const f32 = Math.fround;
/** 0x14040cde0: milliseconds to 60 fps frames. */
const FRAMES_PER_MILLISECOND = f32(0.06);

/**
 * The surface size of an E-mote layer (CEmoteLayer load 0x14001a5b0). A zero `width` or
 * `height` takes the inclusive rectangle of the chara profiles `boundsLeft`, `boundsTop`,
 * `boundsRight` and `boundsBottom` (TRect<float> setters 0x14000aaa0..0x14000aa00: width =
 * right − left + 1), rounded up; an empty rectangle falls back to `stage`.
 */
export function artemisEmoteLayerSize(
  player: Pick<EmotePlayer, 'countCharaProfiles' | 'getCharaProfileLabelAt' | 'getCharaProfile'>,
  width: number,
  height: number,
  stage: {readonly width: number; readonly height: number},
): {width: number; height: number} {
  if (width !== 0 && height !== 0) return {width, height};
  let left = 0,
    top = 0,
    right = 0,
    bottom = 0,
    w = 0,
    h = 0;
  for (let i = 0; i < player.countCharaProfiles(); i++) {
    const label = player.getCharaProfileLabelAt(i);
    const value = f32(player.getCharaProfile(label));
    if (label === 'boundsLeft') w = f32(f32(right - (left = value)) + 1);
    else if (label === 'boundsTop') h = f32(f32(bottom - (top = value)) + 1);
    else if (label === 'boundsRight') w = f32(f32((right = value) - left) + 1);
    else if (label === 'boundsBottom') h = f32(f32((bottom = value) - top) + 1);
  }
  return w > 0 && h > 0 ? {width: Math.ceil(w), height: Math.ceil(h)} : {...stage};
}

/**
 * CEmoteLayer (Rev.3258): an IEmotePlayer drawn into a `width`×`height` render target. With
 * `progress` the layer advances its player by the elapsed wall time each time it is drawn
 * (0x14001adf0).
 */
export class ArtemisEmoteLayer {
  /** +0x84: `timeGetTime` of the previous draw; 0 before the first. */
  private last = 0;
  constructor(
    readonly player: EmotePlayer,
    readonly width: number,
    readonly height: number,
    /** +0x80. */
    readonly progress: boolean,
  ) {}

  /** The draw-time advance of 0x14001adf0 at millisecond clock `now`: progress(0) on the
   * first draw, then the elapsed time (at most 1000 ms) as 60 fps frames. */
  advance(now: number): void {
    if (!this.progress) return;
    const time = Math.trunc(now) >>> 0;
    if (this.last === 0) this.player.progress(0);
    else
      this.player.progress(f32(Math.min((time - this.last) >>> 0, 1000) * FRAMES_PER_MILLISECOND));
    this.last = time;
  }
}
