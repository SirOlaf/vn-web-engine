import type {AsbTag} from '../../formats/artemis/asb.js';
import {artemisInteger} from './numbers.js';
import {artemisRevision} from './revision.js';

export interface ArtemisMusicHost {
  /** Script field +0x3520; nonzero bypasses splay/sxfade audio work but not history. */
  debugSkipActive(): boolean;
  /** Music manager (script +0x3d60) primitives; index 0 is never a sound. */
  stopMusic(index: number, milliseconds: number): void;
  /** Loader 0x140190920; resolves 0 on native load failure. */
  prepareMusic(file: string, bufferMode: number): Promise<number>;
  discardPreparedMusic(index: number): void;
  setMusicGain(index: number, scope: 0, gain: number, milliseconds: number): void;
  setMusicPan(index: number, pan: number, milliseconds: number): void;
  startMusic(index: number, milliseconds: number, loop: boolean): void;
  /** c7260(script, 1, tag, "指定されたファイルは見つからないか、非対応形式で…"). */
  musicLoadFailed(tag: AsbTag): void;
}

/** Save-object (+0xd0) BGM replay record: +0x88 loop flag, +0x90 copied tag. */
export interface ArtemisMusicHistory {
  readonly playing: boolean;
  readonly tag: AsbTag;
}

type Block = Omit<AsbTag, 'args'> & {args: Map<string, string>};
const emptyBlock = (): Block => ({kind: 'tag', name: '', sourceLine: 0, args: new Map()});
function index(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff)
    throw Error('Unsupported Artemis sound index');
}
function integer(tag: AsbTag, name: string): number {
  return tag.args.has(name) ? artemisInteger(tag.args.get(name)!) : 0;
}

/** BGM commands: e2390 splay/sfadein, e29e0 sxfade, e28a0 sstop/sfadeout, e2f00 sfade and e3140 span.
 * The current slot is script +0x3d70; sxfade moves it to the fading slot +0x3d74. */
export class ArtemisMusic {
  private current = 0;
  private fading = 0;
  private playing = false;
  private block: Block = emptyBlock();
  private pending = false;
  private generation = 0;
  constructor(
    hash: string,
    private readonly host: ArtemisMusicHost,
  ) {
    artemisRevision(hash);
  }
  /** Script +0x3d70, the slot used by setonsoundfinish without an id. */
  get currentIndex(): number {
    return this.current;
  }
  get fadingIndex(): number {
    return this.fading;
  }
  get history(): ArtemisMusicHistory {
    return {playing: this.playing, tag: {...this.block, args: new Map(this.block.args)}};
  }
  /** Save restore of +0x88/+0x90. */
  restoreHistory(history: ArtemisMusicHistory): void {
    this.playing = history.playing;
    this.block = {...history.tag, args: new Map(history.tag.args)};
  }
  /** Fresh save object: no loop record and an empty block. */
  clearHistory(): void {
    this.playing = false;
    this.block = emptyBlock();
  }
  /** A new music manager replaces every voice; the slot fields restart at 0. */
  reset(): void {
    this.generation++;
    this.pending = false;
    this.current = 0;
    this.fading = 0;
  }
  /** Loading commands return a promise; the others complete synchronously. */
  dispatch(input: AsbTag, recordHistory = true): boolean | Promise<boolean> {
    switch (input.name) {
      case 'splay':
      case 'sfadein':
        return this.play(input, false, recordHistory);
      case 'sxfade':
        return this.play(input, true, recordHistory);
      case 'sstop':
      case 'sfadeout':
        this.host.stopMusic(this.current, integer(input, 'time'));
        if (recordHistory) this.playing = false;
        return true;
      case 'sfade': {
        const tag = {...input, args: new Map(input.args)},
          time = integer(tag, 'time');
        // std::map operator[] inserts an empty gain, which atoi reads as 0.
        if (!tag.args.has('gain')) tag.args.set('gain', '');
        this.host.setMusicGain(this.current, 0, artemisInteger(tag.args.get('gain')!), time);
        if (recordHistory) this.block.args.set('gain', tag.args.get('gain')!);
        return true;
      }
      case 'span': {
        // e3140: pan comes from operator[] (absent reads as 0); time defaults to 0.
        const tag = {...input, args: new Map(input.args)},
          time = integer(tag, 'time');
        if (!tag.args.has('pan')) tag.args.set('pan', '');
        this.host.setMusicPan(this.current, artemisInteger(tag.args.get('pan')!), time);
        if (recordHistory) this.block.args.set('pan', tag.args.get('pan')!);
        return true;
      }
      default:
        return false;
    }
  }
  private async play(input: AsbTag, crossfade: boolean, recordHistory: boolean): Promise<boolean> {
    if (this.pending) throw Error('Overlapping Artemis music preparation');
    const tag = {...input, args: new Map(input.args)},
      // Only an exact "0" disables looping; an absent loop loops.
      loop = tag.args.get('loop') !== '0';
    if (!this.host.debugSkipActive()) {
      if (crossfade) {
        this.host.stopMusic(this.fading, 0);
        this.fading = this.current;
      } else {
        this.host.stopMusic(this.current, 0);
        this.host.stopMusic(this.fading, 0);
      }
      const buffer = integer(tag, 'buffer');
      if (!tag.args.has('file')) tag.args.set('file', '');
      this.pending = true;
      const generation = this.generation;
      let prepared: number;
      try {
        prepared = await this.host.prepareMusic(tag.args.get('file')!, buffer);
        index(prepared);
        if (generation !== this.generation) {
          if (prepared) this.host.discardPreparedMusic(prepared);
          throw Error('Artemis music preparation cancelled');
        }
      } finally {
        if (generation === this.generation) this.pending = false;
      }
      this.current = prepared;
      if (crossfade) this.host.stopMusic(this.fading, integer(tag, 'time'));
      else this.fading = 0;
      if (!prepared) {
        this.host.musicLoadFailed(tag);
        return true;
      }
      if (tag.args.has('gain'))
        this.host.setMusicGain(prepared, 0, artemisInteger(tag.args.get('gain')!), 0);
      if (tag.args.has('pan'))
        this.host.setMusicPan(prepared, artemisInteger(tag.args.get('pan')!), 0);
      this.host.startMusic(prepared, integer(tag, 'time'), loop);
    }
    if (recordHistory) {
      this.playing = loop;
      if (loop) this.block = tag;
    }
    return true;
  }
}
