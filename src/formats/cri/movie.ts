import type {ByteSource} from '../../core/source.js';
import {Mpeg1Decoder} from '../mpeg1/decoder.js';
import type {YuvFrame} from '../../video/frame.js';
import {HcaDecoder} from './hca/decoder.js';
import {hcaHeaderSize, parseHcaHeader} from './hca/header.js';
import type {HcaHeader} from './hca/header.js';
import {UsmReader, usmTable} from './usm.js';
export interface MovieInfo {
  width: number;
  height: number;
  frameRate: number;
  frameCount: number;
  duration: number;
  sampleRate: number;
  channels: number;
  sampleCount: number;
}
export interface MoviePcm {
  start: number;
  channels: Float32Array[];
}
export interface MovieBatch {
  frames: YuvFrame[];
  audio: MoviePcm[];
  info?: MovieInfo;
  done: boolean;
  progress: number;
}
/** Demultiplexing/orchestration only; both elementary codecs remain independent of USM. */
export class CriMovie {
  readonly video = new Mpeg1Decoder();
  readonly reader: UsmReader;
  info?: MovieInfo;
  audioHeader?: HcaHeader;
  private videoHeader?: {width: number; height: number; frameRate: number; frameCount: number};
  private audioMetadata?: {sampleRate: number; channels: number; sampleCount: number};
  private audio?: HcaDecoder;
  private packed = new Uint8Array();
  private audioStarted = false;
  private block = 0;
  private frameCount = 0;
  private ended = false;
  private readonly streamEnds = new Set<string>();
  constructor(readonly source: ByteSource) {
    this.reader = new UsmReader(source);
  }
  async next(): Promise<MovieBatch> {
    if (this.ended) throw new Error('Movie already ended');
    const packet = await this.reader.next(),
      frames: YuvFrame[] = [],
      audio: MoviePcm[] = [];
    if (!packet) {
      frames.push(...this.video.flush());
      this.frameCount += frames.length;
      if (
        !this.info ||
        !this.audioHeader ||
        this.packed.length ||
        this.block !== this.audioHeader.blockCount ||
        this.frameCount !== this.info.frameCount ||
        !this.streamEnds.has('@SFV') ||
        !this.streamEnds.has('@SFA')
      )
        throw new Error('Truncated movie or metadata count mismatch');
      this.ended = true;
      return {frames, audio, info: this.info, done: true, progress: 1};
    }
    if (packet.tag !== 'CRID' && (!['@SFV', '@SFA'].includes(packet.tag) || packet.channel !== 0))
      throw new Error('Unsupported USM track (expected one video and one HCA stream)');
    if (packet.type === 1 && packet.tag !== 'CRID') {
      const row = usmTable(packet).rows[0];
      if (!row) throw new Error('Empty USM header');
      const num = (key: string): number => {
        const n = row[key];
        if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0)
          throw new Error(`Invalid movie ${key}`);
        return n;
      };
      if (packet.tag === '@SFV') {
        if (this.videoHeader) throw new Error('Duplicate movie video header');
        if (num('mpeg_codec') !== 1 || num('alpha_type') !== 0 || num('color_space') !== 0)
          throw new Error('Unsupported movie video format');
        const width = num('width'),
          height = num('height'),
          frameRate = num('framerate_n') / num('framerate_d'),
          frameCount = num('total_frames');
        if (
          width < 1 ||
          width > 4096 ||
          height < 1 ||
          height > 2160 ||
          !Number.isFinite(frameRate) ||
          frameRate < 1 ||
          frameRate > 60 ||
          !frameCount
        )
          throw new Error('Invalid movie dimensions');
        this.videoHeader = {width, height, frameRate, frameCount};
      } else {
        if (this.audioMetadata) throw new Error('Duplicate movie audio header');
        if (num('audio_codec') !== 4) throw new Error('Unsupported movie audio codec');
        this.audioMetadata = {
          sampleRate: num('sampling_rate'),
          channels: num('num_channels'),
          sampleCount: num('total_samples'),
        };
      }
    } else if (packet.type === 3 && packet.tag === '@SFA') {
      if (this.audioHeader) throw new Error('Duplicate movie HCA metadata');
      const header = usmTable(packet).rows[0]?.hca_header;
      if (!(header instanceof Uint8Array)) throw new Error('Missing HCA movie header');
      this.audioHeader = parseHcaHeader(header);
      this.audio = new HcaDecoder(this.audioHeader);
    } else if (packet.type === 2) {
      const marker = new TextDecoder().decode(packet.payload);
      if (marker.startsWith('#CONTENTS END')) this.streamEnds.add(packet.tag);
    } else if (packet.type === 0 && packet.tag !== 'CRID') {
      if (this.streamEnds.has(packet.tag)) throw new Error('Data follows movie stream end');
      if (packet.tag === '@SFV') {
        frames.push(...this.video.push(packet.payload));
        const seq = this.video.sequence,
          vh = this.videoHeader;
        if (
          seq &&
          (!vh ||
            seq.width !== vh.width ||
            seq.height !== vh.height ||
            Math.abs(seq.frameRate - vh.frameRate) > 0.01)
        )
          throw new Error('USM and MPEG sequence disagree');
        this.frameCount += frames.length;
      } else {
        const h = this.audioHeader;
        if (!h || !this.audio) throw new Error('Audio data precedes HCA metadata');
        const combined = new Uint8Array(this.packed.length + packet.payload.length);
        combined.set(this.packed);
        combined.set(packet.payload, this.packed.length);
        let offset = 0;
        if (!this.audioStarted) {
          if (combined.length < 8 || combined.length < hcaHeaderSize(combined)) {
            this.packed = combined;
            return {frames, audio, done: false, progress: packet.nextOffset / this.source.size};
          }
          const actual = parseHcaHeader(combined);
          if (JSON.stringify(actual) !== JSON.stringify(h))
            throw new Error('Embedded and streaming HCA headers differ');
          offset = h.headerSize;
          this.audioStarted = true;
        }
        while (offset + h.blockSize <= combined.length) {
          const pcm = this.audio.decodeBlock(combined.subarray(offset, offset + h.blockSize));
          offset += h.blockSize;
          const start = this.block++ * 1024 - h.encoderDelay,
            from = Math.max(0, -start),
            to = Math.min(1024, h.sampleCount - start);
          if (to > from)
            audio.push({
              start: start + from,
              channels: pcm.map((ch) =>
                Float32Array.from(ch.subarray(from, to), (v) => v * h.volume),
              ),
            });
        }
        this.packed = combined.slice(offset);
      }
    }
    if (!this.info && this.videoHeader && this.audioMetadata && this.audioHeader) {
      const v = this.videoHeader,
        a = this.audioMetadata,
        h = this.audioHeader;
      if (
        a.channels !== h.channels ||
        a.sampleRate !== h.sampleRate ||
        a.sampleCount !== h.sampleCount
      )
        throw new Error('USM and HCA metadata disagree');
      this.info = {
        ...v,
        ...a,
        duration: Math.max(v.frameCount / v.frameRate, a.sampleCount / a.sampleRate),
      };
    }
    return {
      frames,
      audio,
      ...(this.info ? {info: this.info} : {}),
      done: false,
      progress: packet.nextOffset / this.source.size,
    };
  }
}
