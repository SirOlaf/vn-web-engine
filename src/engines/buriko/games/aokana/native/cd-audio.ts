import {pop32, push32} from '../bp/state.js';
import type {
  CdAudioTrack,
  CdAudioMedium,
  CdAudioMediumLease,
  CdAudioMediaHost,
} from '../../../../../audio/cd-media.js';
import type {AokanaNativeSlotDefinition} from './types.js';

export type AokanaCdTrack = CdAudioTrack;
export type AokanaCdMedium = CdAudioMedium;
export type AokanaCdMediumLease = CdAudioMediumLease;
export type AokanaCdMediaHost = CdAudioMediaHost;

/** The native 0x1400edc30 mapping of MCI mode constants. */
export function aokanaCdMode(mode: number): number {
  switch (mode) {
    case 0x20c:
      return 0;
    case 0x20d:
      return 3;
    case 0x20e:
      return 2;
    case 0x20f:
      return 6;
    case 0x210:
      return 1;
    case 0x211:
      return 4;
    case 0x212:
      return 5;
    default:
      return 0xffffffff;
  }
}

/** Aokana's optional CD-audio device, with the native successful-notification repeat. */
export class AokanaCdAudio {
  private opened = false;
  private disposed = false;
  private medium: AokanaCdMedium | null;
  private readonly host: AokanaCdMediaHost | null;
  private lease: AokanaCdMediumLease | null = null;
  private mode = 0x20c;
  private positionFrame = 0;
  private endFrame = 0;
  private startedAt = 0;
  private startFrame = 0;
  private repeatOnCompletion = false;
  private paused = false;
  private readonly starts: number[] = [0];
  private sources: AudioBufferSourceNode[] = [];
  private generation = 0;
  private pendingSuccessfulNotification: number | null = null;
  private pendingCompletion: ReturnType<typeof setTimeout> | null = null;
  /** 0x1401eb8c8 is written even when MCI_PLAY rejects an available disc's track. */
  lastRequestedTrack = 0;

  constructor(
    mediumOrHost: AokanaCdMedium | AokanaCdMediaHost | null,
    private readonly postSuccessfulNotification: ((token: number) => void) | null = null,
  ) {
    this.host = mediumOrHost !== null && 'open' in mediumOrHost ? mediumOrHost : null;
    this.medium = this.host === null ? (mediumOrHost as AokanaCdMedium | null) : null;
    if (this.medium !== null) this.validateMedium(this.medium);
  }

  private validateMedium(medium: AokanaCdMedium): void {
    this.starts.length = 1;
    if (medium.tracks.length < 1 || medium.tracks.length > 99) {
      throw new RangeError('Aokana CD medium must contain 1..99 tracks');
    }
    for (const track of medium.tracks) {
      if (!Number.isInteger(track.frames) || track.frames < 1) {
        throw new RangeError('Aokana CD track length must be a positive count of CD frames');
      }
      const pcm = track.pcm;
      if (
        pcm !== null &&
        (pcm.sampleRate !== 44100 ||
          pcm.numberOfChannels !== 2 ||
          pcm.length !== track.frames * 588)
      ) {
        throw new RangeError('Aokana CD audio must be stereo 44100 Hz PCM aligned to CD frames');
      }
      this.starts.push(this.starts[this.starts.length - 1]! + track.frames);
    }
  }

  open(): boolean {
    if (this.opened) return true;
    if (this.disposed) return false;
    if (this.host !== null) {
      const lease = this.host.open();
      if (lease === null) return false;
      try {
        this.validateMedium(lease.medium);
      } catch (error) {
        lease.release();
        throw error;
      }
      this.medium = lease.medium;
      this.lease = lease;
    }
    if (this.medium === null) return false;
    this.opened = true;
    this.mode = 0x20d;
    this.positionFrame = this.startFrame = this.endFrame = 0;
    return true;
  }

  close(): boolean {
    if (!this.opened) return false;
    this.stop();
    this.opened = false;
    this.mode = 0x20c;
    const lease = this.lease;
    this.lease = null;
    if (lease !== null) {
      this.medium = null;
      lease.release();
    }
    return true;
  }

  /** The VM owner calls this after native dispatch has quiesced, including abnormal exit. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.close();
  }

  get status(): number | null {
    return this.opened ? aokanaCdMode(this.mode) : null;
  }

  /** Track is the low byte, followed by minute, second, and 1/75-second frame. */
  private unpackTmsf(value: number): number | null {
    if (this.medium === null) return null;
    const track = value & 0xff;
    const minute = (value >>> 8) & 0xff;
    const second = (value >>> 16) & 0xff;
    const frame = value >>> 24;
    if (track < 1 || track > this.medium.tracks.length || minute > 99 || second > 59 || frame > 74)
      return null;
    const withinTrack = (minute * 60 + second) * 75 + frame;
    let absolute = this.starts[track - 1]! + withinTrack;
    if (absolute >= this.starts[this.starts.length - 1]!) return null;
    let index = track - 1;
    while (index + 1 < this.medium.tracks.length && this.starts[index + 1]! <= absolute) index++;
    while (index < this.medium.tracks.length && this.medium.tracks[index]!.pcm === null) {
      absolute = this.starts[++index]!;
    }
    return index === this.medium.tracks.length ? null : absolute;
  }

  private currentFrame(): number {
    if (this.mode !== 0x20e || this.medium === null) return this.positionFrame;
    return Math.min(
      this.endFrame,
      this.startFrame + Math.floor((this.medium.context.currentTime - this.startedAt) * 75),
    );
  }

  private cancelSources(): void {
    this.generation++;
    this.pendingSuccessfulNotification = null;
    if (this.pendingCompletion !== null) {
      clearTimeout(this.pendingCompletion);
      this.pendingCompletion = null;
    }
    for (const source of this.sources) {
      source.onended = null;
      source.stop();
      source.disconnect();
    }
    this.sources = [];
  }

  private startRange(from: number, to: number, repeat: boolean): boolean {
    const medium = this.medium;
    if (medium === null || !this.opened || from > to) return false;
    this.cancelSources();
    this.startFrame = this.positionFrame = from;
    this.endFrame = to;
    this.startedAt = medium.context.currentTime;
    this.repeatOnCompletion = repeat;
    this.paused = false;
    this.mode = 0x20e;
    const generation = this.generation;
    for (let i = 0; i < medium.tracks.length; i++) {
      const first = Math.max(from, this.starts[i]!);
      const last = Math.min(to, this.starts[i + 1]!);
      if (first >= last) continue;
      const source = medium.context.createBufferSource();
      const pcm = medium.tracks[i]!.pcm;
      source.buffer = pcm;
      if (source.buffer === null) {
        source.buffer = medium.context.createBuffer(2, 1, 44100);
        source.loop = true;
      }
      source.connect(medium.destination);
      source.start(
        this.startedAt + (first - from) / 75,
        pcm === null ? 0 : (first - this.starts[i]!) / 75,
        (last - first) / 75,
      );
      this.sources.push(source);
    }
    const lastSource = this.sources[this.sources.length - 1];
    const finish = () => {
      if (this.generation !== generation) return;
      this.positionFrame = to;
      this.mode = 0x20d;
      this.cancelSources();
      // WndProc 0x140100458 handles MM_MCINOTIFY only for MCI_NOTIFY_SUCCESSFUL.
      if (repeat) {
        const token = this.generation;
        this.pendingSuccessfulNotification = token;
        if (this.postSuccessfulNotification === null) this.deliverSuccessfulNotification(token);
        else this.postSuccessfulNotification(token);
      }
    };
    if (lastSource) lastSource.onended = finish;
    else this.pendingCompletion = setTimeout(finish, 0);
    return true;
  }

  /** The main HWND consumes only the completion still owned by this open playback. */
  deliverSuccessfulNotification(token: number): void {
    if (this.pendingSuccessfulNotification !== token || !this.opened || this.disposed) return;
    this.pendingSuccessfulNotification = null;
    this.playTrack(this.lastRequestedTrack, true);
  }

  playTrack(track: number, notify: boolean): boolean {
    if (!this.opened || this.medium === null) return false;
    const from = this.unpackTmsf(track & 0xff);
    const to = this.unpackTmsf((track + 1) & 0xff);
    const result = from !== null && to !== null && this.startRange(from, to, notify);
    this.lastRequestedTrack = track >>> 0;
    return result;
  }

  playTmsf(from: number, to: number): boolean {
    const first = this.unpackTmsf(from);
    const last = this.unpackTmsf(to);
    return first !== null && last !== null && this.startRange(first, last, false);
  }

  stop(): boolean {
    if (!this.opened) return false;
    this.positionFrame = this.currentFrame();
    this.cancelSources();
    this.repeatOnCompletion = false;
    this.paused = false;
    this.mode = 0x20d;
    return true;
  }

  pause(): boolean {
    if (!this.opened || this.mode !== 0x20e) return false;
    this.positionFrame = this.currentFrame();
    this.cancelSources();
    this.repeatOnCompletion = false;
    this.paused = true;
    this.mode = 0x20d;
    return true;
  }

  resume(): boolean {
    return (
      this.paused && this.startRange(this.positionFrame, this.endFrame, this.repeatOnCompletion)
    );
  }

  seekTmsf(position: number): boolean {
    const frame = this.unpackTmsf(position);
    if (!this.opened || frame === null) return false;
    this.stop();
    this.positionFrame = frame;
    return true;
  }

  get positionTmsf(): number | null {
    if (!this.opened || this.medium === null) return null;
    const absolute = this.currentFrame();
    let index = 0;
    while (index + 1 < this.starts.length && this.starts[index + 1]! <= absolute) index++;
    if (index === this.medium.tracks.length) return (index + 1) & 0xff;
    const frame = absolute - this.starts[index]!;
    return (
      ((index + 1) |
        (Math.floor(frame / 4500) << 8) |
        ((Math.floor(frame / 75) % 60) << 16) |
        ((frame % 75) << 24)) >>>
      0
    );
  }
}

/** The five populated A0 CD slots; these may be combined with the other A0 services. */
export function createAokanaCdSlots(cd: AokanaCdAudio): readonly AokanaNativeSlotDefinition[] {
  return [
    {
      primary: 0xa0,
      secondary: 0x80,
      nativeAddress: 0x1400e50d0,
      name: 'OpenCdAudio',
      execute: () => {
        cd.open();
        return 0;
      },
    },
    {
      primary: 0xa0,
      secondary: 0x81,
      nativeAddress: 0x1400e50b0,
      name: 'CloseCdAudio',
      execute: () => {
        cd.close();
        return 0;
      },
    },
    {
      primary: 0xa0,
      secondary: 0x84,
      nativeAddress: 0x1400e5070,
      name: 'PlayCdTrack',
      execute: ({thread}) => {
        const notify = pop32(thread);
        const track = pop32(thread);
        push32(thread, Number(cd.playTrack(track, notify !== 0)));
        return 0;
      },
    },
    {
      primary: 0xa0,
      secondary: 0x85,
      nativeAddress: 0x1400e5050,
      name: 'StopCdAudio',
      execute: () => {
        cd.stop();
        return 0;
      },
    },
    {
      primary: 0xa0,
      secondary: 0x86,
      nativeAddress: 0x1400e5020,
      name: 'GetCdMode',
      execute: ({thread, memory}) => {
        const address = pop32(thread);
        memory.resolve(thread, address);
        const status = cd.status;
        if (status !== null) memory.writeU32(thread, address, status);
        push32(thread, Number(status !== null));
        return 0;
      },
    },
  ];
}
