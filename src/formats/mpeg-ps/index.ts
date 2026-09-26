import type {ByteSource} from '../../core/source.js';
import {readMp2Header, type Mp2Header} from '../mp2/decoder.js';
import {MpegPsReader} from './demux.js';
import type {MovieInfo} from '../../video/movie-types.js';

const RATES = [0, 24000 / 1001, 24, 25, 30000 / 1001, 30, 50, 60000 / 1001, 60];
interface TimedUnit {
  pts: number | null;
}
interface Picture extends TimedUnit {
  type: number;
}
class Anchors {
  private readonly pending: {offset: number; pts: number}[] = [];
  add(offset: number, pts: number | null): void {
    if (pts !== null) this.pending.push({offset, pts});
    if (this.pending.length > 1024) throw new Error('MPEG timestamp queue exceeds limit');
  }
  take(offset: number): number | null {
    let result: number | null = null;
    while (this.pending.length && this.pending[0]!.offset <= offset) {
      const next = this.pending.shift()!.pts;
      if (result !== null && result !== next)
        throw new Error('Ambiguous MPEG access-unit timestamp');
      result = next;
    }
    return result;
  }
}

/** Scans only start-code headers, retaining at most seven carry bytes. Its
 * I/P/B release order mirrors the independent MPEG-1 decoder's presentation order. */
class VideoIndex {
  readonly anchors = new Anchors();
  readonly pictures: Picture[] = [];
  sequence?: {width: number; height: number; frameRate: number};
  private carry = new Uint8Array();
  private offset = 0;
  private lastCode = -1;
  private unitStart: number | null = null;
  private current: Picture | null = null;
  private future: Picture | null = null;
  push(payload: Uint8Array, pts: number | null): void {
    this.anchors.add(this.offset, pts);
    const bytes = new Uint8Array(this.carry.length + payload.length);
    bytes.set(this.carry);
    bytes.set(payload, this.carry.length);
    const base = this.offset - this.carry.length;
    this.offset += payload.length;
    for (let at = 0; at + 4 <= bytes.length; at++) {
      if (bytes[at] || bytes[at + 1] || bytes[at + 2] !== 1 || base + at <= this.lastCode) continue;
      const code = bytes[at + 3]!;
      if ((code === 0xb3 && at + 8 > bytes.length) || (code === 0 && at + 6 > bytes.length)) break;
      this.lastCode = base + at;
      if (code === 0xb3) {
        this.finishPicture();
        this.unitStart ??= base + at;
        const width = bytes[at + 4]! * 16 + (bytes[at + 5]! >>> 4);
        const height = (bytes[at + 5]! & 15) * 256 + bytes[at + 6]!;
        const frameRate = RATES[bytes[at + 7]! & 15];
        if (!width || width > 4096 || !height || height > 2160 || !frameRate)
          throw new Error('Unsupported MPEG movie sequence');
        if (
          this.sequence &&
          (width !== this.sequence.width ||
            height !== this.sequence.height ||
            frameRate !== this.sequence.frameRate)
        )
          throw new Error('MPEG movie sequence changed');
        this.sequence = {width, height, frameRate};
      } else if (code === 0) {
        this.finishPicture();
        const type = (bytes[at + 5]! >>> 3) & 7;
        if (!this.sequence || type < 1 || type > 3)
          throw new Error('Unsupported MPEG movie picture');
        // An access unit includes its preceding sequence/GOP headers. A PES
        // timestamp arriving after those headers belongs to the next unit,
        // even if this picture_start_code is in the new packet.
        this.current = {type, pts: this.anchors.take(this.unitStart ?? base + at)};
        this.unitStart = null;
      } else if (code === 0xb8) {
        this.finishPicture();
        this.unitStart ??= base + at;
      } else if (code === 0xb7) {
        this.finish();
        this.unitStart = null;
      } else if (code === 0xb5) throw new Error('MPEG-2 video extensions are unsupported');
      at += 3;
    }
    this.carry = bytes.slice(-7);
  }
  private emit(picture: Picture): void {
    if (this.pictures.length >= 1024 * 1024) throw new Error('MPEG picture index exceeds limit');
    this.pictures.push(picture);
  }
  private finishPicture(): void {
    if (this.current === null) return;
    if (this.current.type === 3) this.emit(this.current);
    else {
      if (this.future !== null) this.emit(this.future);
      this.future = this.current;
    }
    this.current = null;
  }
  finish(): void {
    this.finishPicture();
    if (this.future !== null) this.emit(this.future);
    this.future = null;
  }
}

class AudioIndex {
  readonly anchors = new Anchors();
  readonly frames: TimedUnit[] = [];
  header?: Mp2Header;
  private carry = new Uint8Array();
  private offset = 0;
  push(payload: Uint8Array, pts: number | null): void {
    this.anchors.add(this.offset, pts);
    const bytes = new Uint8Array(this.carry.length + payload.length);
    bytes.set(this.carry);
    bytes.set(payload, this.carry.length);
    const base = this.offset - this.carry.length;
    this.offset += payload.length;
    let at = 0;
    while (at < bytes.length) {
      const header = readMp2Header(bytes, at);
      if (header === null || at + header.frameBytes > bytes.length) break;
      if (
        this.header &&
        (header.sampleRate !== this.header.sampleRate || header.channels !== this.header.channels)
      )
        throw new Error('MPEG movie audio format changed');
      this.header = header;
      if (this.frames.length >= 1024 * 1024) throw new Error('MPEG audio index exceeds limit');
      this.frames.push({pts: this.anchors.take(base + at)});
      at += header.frameBytes;
    }
    this.carry = bytes.slice(at);
  }
  finish(): void {
    if (this.carry.length || !this.header) throw new Error('Truncated MPEG movie audio frame');
  }
}

function times(
  units: readonly TimedUnit[],
  step: number,
  fallback: number,
  audio: boolean,
): number[] {
  const first = units.findIndex((unit) => unit.pts !== null);
  let anchor = first < 0 ? fallback : units[first]!.pts! - first * step;
  let index = 0;
  return units.map((unit, i) => {
    const predicted = anchor + (i - index) * step;
    if (unit.pts !== null && (!audio || Math.abs(unit.pts - predicted) > 1)) {
      anchor = unit.pts;
      index = i;
    }
    return anchor + (i - index) * step;
  });
}

export interface MpegPsIndex {
  readonly info: MovieInfo;
  readonly videoStreamId: number;
  readonly audioStreamId: number | null;
  readonly videoTimes: readonly number[];
  readonly videoDurations: readonly number[];
  readonly audioTimes: readonly number[];
}

/** Builds bounded access-unit/timestamp metadata; never invokes either codec. */
export async function indexMpegPs(source: ByteSource, signal?: AbortSignal): Promise<MpegPsIndex> {
  const reader = new MpegPsReader(source, signal),
    video = new VideoIndex(),
    audio = new AudioIndex();
  let videoStreamId: number | null = null,
    audioStreamId: number | null = null;
  let firstClock: number | null = null;
  const lastClock = new Map<number, number>();
  for (;;) {
    const packet = await reader.next();
    if (packet === null) break;
    let pts = packet.pts;
    if (pts !== null) {
      const reference = lastClock.get(packet.streamId) ?? firstClock ?? pts;
      pts += Math.round((reference - pts) / 2 ** 33) * 2 ** 33;
      firstClock ??= pts;
      lastClock.set(packet.streamId, pts);
    }
    if (packet.streamId >= 0xe0 && packet.streamId <= 0xef) {
      videoStreamId ??= packet.streamId;
      if (packet.streamId !== videoStreamId)
        throw new Error('Multiple MPEG video tracks require explicit selection');
      video.push(packet.payload, pts);
    } else if (packet.streamId >= 0xc0 && packet.streamId <= 0xdf) {
      audioStreamId ??= packet.streamId;
      if (packet.streamId !== audioStreamId)
        throw new Error('Multiple MPEG audio tracks require explicit selection');
      audio.push(packet.payload, pts);
    } else throw new Error('Unsupported MPEG private stream codec');
  }
  video.finish();
  if (videoStreamId === null || !video.sequence || !video.pictures.length)
    throw new Error('Missing MPEG movie video');
  if (audioStreamId !== null) audio.finish();
  const sampleRate = audio.header?.sampleRate ?? 0;
  const videoTimes = times(
    video.pictures,
    90000 / video.sequence.frameRate,
    firstClock ?? 0,
    false,
  );
  const audioTimes =
    audioStreamId === null
      ? []
      : times(audio.frames, (90000 * 1152) / sampleRate, firstClock ?? 0, true);
  const origin = Math.min(videoTimes[0]!, audioTimes[0] ?? Infinity);
  for (const track of [videoTimes, audioTimes])
    for (let i = 0; i < track.length; i++) {
      track[i] = (track[i]! - origin) / 90000;
      if (i && track[i]! <= track[i - 1]!)
        throw new Error('Non-increasing MPEG presentation timestamps');
    }
  const videoDurations = videoTimes.map((at, i) =>
    i + 1 < videoTimes.length ? videoTimes[i + 1]! - at : 1 / video.sequence!.frameRate,
  );
  const videoEndTime = videoTimes.at(-1)! + videoDurations.at(-1)!;
  const audioEndTime = audioTimes.length ? audioTimes.at(-1)! + 1152 / sampleRate : 0;
  return {
    info: {
      ...video.sequence,
      frameCount: videoTimes.length,
      sampleRate,
      channels: audio.header?.channels ?? 0,
      sampleCount: audioTimes.length * 1152,
      duration: Math.max(videoEndTime, audioEndTime),
      videoEndTime,
      audioStartTime: audioTimes[0] ?? 0,
      audioEndTime,
    },
    videoStreamId,
    audioStreamId,
    videoTimes,
    videoDurations,
    audioTimes,
  };
}
