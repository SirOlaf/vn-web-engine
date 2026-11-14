import type {AsbTag} from '../../formats/artemis/asb.js';
import type {FullscreenMoviePlayer} from '../../video/fullscreen-movie.js';
import type {ArtemisModes} from './modes.js';
import {artemisSoundAttenuation} from './audio-gain.js';
import {artemisInteger} from './numbers.js';
import {artemisRevision} from './revision.js';

export interface ArtemisFullscreenVideoHost {
  /** Script field +0x3520. */
  debugSkipActive(): boolean;
  /** Variable table vtbl+0x10: `s.videovol` as an integer. */
  videoVolume(): number;
  /** Renderer +0xd8 (0x14015ba00 on the loose path, 0x14015c0a0 close). */
  readonly player: FullscreenMoviePlayer;
  /** c7260 severity 1 with 0x1403724e0 「再生に失敗しました。」. */
  playbackFailed(tag: AsbTag): void;
  /** Unless run mode is 13: c74 = c70, c70 = 7 and scheduler +0x30(0). */
  enterVideoMode(): void;
  /** 0x1400c6480. */
  releaseRunMode(): void;
  /** 0x1400b5690: key role `role` was pushed this frame. */
  rolePushed(role: 0 | 1): boolean;
  /** `s.clickskip = 1`. */
  writeClickSkip(): void;
}

/** Fullscreen branch of the video tag 0x1400e4650 (no `id`) and the run mode 7 branch of
 * frame 0x1400c0560.
 *
 * The tag returns while debug-skipping (+0x3520). Otherwise renderer +0xd8 plays the
 * c3720-converted `file` with `mode` (atoi, default 0) as the renderer selector and
 * `s.videovol` converted to hundredths of a decibel; a failure reports the playback error
 * and returns. Then +0x3eb8 = atoi(`skip`, default 1) and run mode 7 is entered.
 *
 * Each run mode 7 frame first releases the run mode once the player has closed. Skip 1
 * then accepts key role 0 or active skip/debug skip (b5170), skip 2 key role 1: the player
 * closes, the run mode is released (again when it already was) and `s.clickskip` is
 * written. */
export class ArtemisFullscreenVideo {
  /** Script +0x3eb8. */
  private skip = 0;
  constructor(
    private readonly hash: string,
    private readonly modes: ArtemisModes,
    private readonly host: ArtemisFullscreenVideoHost,
  ) {
    artemisRevision(hash);
  }
  /** Script +0x3eb8 as last written by the tag. */
  get skipMode(): number {
    return this.skip;
  }
  /** Native video tag without `id`; other tags return false. */
  accepts(tag: AsbTag): boolean {
    return tag.name === 'video' && !tag.args.has('id');
  }
  async dispatch(tag: AsbTag): Promise<boolean> {
    if (!this.accepts(tag)) return false;
    const host = this.host;
    if (host.debugSkipActive()) return true;
    const args = tag.args;
    const renderer = args.has('mode') ? artemisInteger(args.get('mode')!) : 0;
    const attenuation = artemisSoundAttenuation(this.hash, host.videoVolume());
    // c3720 converts the UTF-8 name to the ANSI code page for the file API.
    const path = args.get('file') ?? '';
    if (!(await host.player.play({path, attenuation, renderer}))) {
      host.playbackFailed(tag);
      return true;
    }
    this.skip = args.has('skip') ? artemisInteger(args.get('skip')!) : 1;
    host.enterVideoMode();
    return true;
  }
  /** One run mode 7 frame. Returns true when the skip branch ended the movie. */
  frame(): boolean {
    const host = this.host;
    if (!host.player.playing) host.releaseRunMode();
    const skipping =
      (this.modes.skipAllowed && (this.modes.commandSkip || this.modes.controlSkip)) ||
      host.debugSkipActive();
    if (
      (this.skip === 1 && (host.rolePushed(0) || skipping)) ||
      (this.skip === 2 && host.rolePushed(1))
    ) {
      host.player.close();
      host.releaseRunMode();
      host.writeClickSkip();
      return true;
    }
    return false;
  }
}
