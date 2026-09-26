import type {ByteSource} from '../../core/source.js';
import {Mpeg1Decoder} from '../mpeg1/decoder.js';
import {Mp2Decoder} from '../mp2/decoder.js';
import type {YuvFrame} from '../../video/frame.js';
import type {
  MovieBatch,
  MovieFrame,
  MovieInfo,
  MoviePcm,
  MovieStream,
} from '../../video/movie-types.js';
import {MpegPsReader} from './demux.js';
import {indexMpegPs, type MpegPsIndex} from './index.js';

/** Program-stream orchestration. Metadata indexing and elementary decoding use
 * separate bounded passes so duration/track presence are known before playback. */
export class MpegPsMovie implements MovieStream {
  readonly info: MovieInfo;
  private readonly video = new Mpeg1Decoder();
  private readonly audio = new Mp2Decoder();
  private readonly reader: MpegPsReader;
  private ended = false;
  private videoCount = 0;
  private audioCount = 0;
  private constructor(
    readonly source: ByteSource,
    private readonly index: MpegPsIndex,
    signal?: AbortSignal,
  ) {
    this.info = index.info;
    this.reader = new MpegPsReader(source, signal);
  }
  static async open(source: ByteSource, signal?: AbortSignal): Promise<MpegPsMovie> {
    return new MpegPsMovie(source, await indexMpegPs(source, signal), signal);
  }
  private timed(frames: YuvFrame[]): MovieFrame[] {
    return frames.map((frame) => {
      if (frame.index !== this.videoCount || frame.index >= this.index.videoTimes.length)
        throw new Error('MPEG decoded video count disagrees with index');
      this.videoCount++;
      return {
        ...frame,
        timestamp: this.index.videoTimes[frame.index]!,
        duration: this.index.videoDurations[frame.index]!,
      };
    });
  }
  async next(): Promise<MovieBatch> {
    if (this.ended) throw new Error('Movie already ended');
    const packet = await this.reader.next();
    let frames: MovieFrame[] = [];
    const audio: MoviePcm[] = [];
    if (packet === null) {
      frames = this.timed(this.video.flush());
      this.audio.flush();
      if (
        this.videoCount !== this.info.frameCount ||
        this.audioCount * 1152 !== this.info.sampleCount
      )
        throw new Error('MPEG decoded movie count disagrees with index');
      this.ended = true;
    } else if (packet.streamId === this.index.videoStreamId)
      frames = this.timed(this.video.push(packet.payload));
    else if (packet.streamId === this.index.audioStreamId) {
      for (const frame of this.audio.push(packet.payload)) {
        const timestamp = this.index.audioTimes[this.audioCount++];
        if (timestamp === undefined)
          throw new Error('MPEG decoded audio count disagrees with index');
        audio.push({start: frame.startSample, channels: frame.channels, timestamp});
      }
    } else throw new Error('MPEG track changed after indexing');
    return {
      frames,
      audio,
      info: this.info,
      done: this.ended,
      progress: this.reader.position / this.source.size,
    };
  }
}
