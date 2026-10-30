import type {ByteSource} from '../../core/source.js';
import type {
  MovieBatch,
  MovieFrame,
  MovieInfo,
  MoviePcm,
  MovieStream,
} from '../../video/movie-types.js';
import {WindowsMediaDecoder} from '../../video/windows-media.js';
import {
  AsfDemuxer,
  AsfPrerollQueue,
  readAsfLayout,
  type AsfLayout,
  type AsfMediaObject,
  type AsfStream,
} from './demux.js';

/** Packets per read. */
const PACKETS = 64;
/** Reads kept in flight ahead of demuxing (about 3 MB of 1080p movie, two seconds), so a
 * slow read of the file (a spinning external drive) overlaps decoding. */
const READS_AHEAD = 4;
/** Video objects decoded per batch. A read of a low-bitrate stretch releases a hundred or
 * more pictures, and the held preroll is released at the end of the data; decoding them in
 * one batch would keep the worker busy past the decoded video ahead of the clock. */
const VIDEO_OBJECTS = 8;

/** ASF movie with one Windows Media video stream and at most one audio stream. Frames carry
 * their presentation times; audio is contiguous from the first audio object's time. Packets
 * are read a preroll ahead of video decoding (`AsfPrerollQueue`): audio is decoded as it is
 * read and video waits compressed, so each batch carries the audio for its frames. Released
 * video objects are decoded a bounded number per batch. */
export class AsfMovie implements MovieStream {
  readonly info: MovieInfo;
  private readonly demuxer: AsfDemuxer;
  private readonly video: WindowsMediaDecoder;
  private readonly audio: WindowsMediaDecoder | null;
  private packet = 0;
  /** Packets requested by the reads in flight. */
  private requested = 0;
  private reads: Promise<{bytes: Uint8Array; count: number}>[] = [];
  private readonly order: AsfPrerollQueue;
  /** Released video objects in decoding order. */
  private ready: AsfMediaObject[] = [];
  /** First audio object time, then the first decoded audio time (the decoder's own
   * presentation time when it reports one) that all later audio follows contiguously. */
  private audioObject: number | null = null;
  private audioOrigin: number | null = null;
  private audioSamples = 0;
  private done = false;

  private constructor(
    private readonly source: ByteSource,
    private readonly layout: AsfLayout,
    private readonly videoStream: AsfStream & {kind: 'video'},
    private readonly audioStream: (AsfStream & {kind: 'audio'}) | undefined,
  ) {
    if (layout.duration === null) throw Error('Unsupported broadcast ASF movie');
    const duration = layout.duration / 1000,
      frameRate = videoStream.frameTime ? 1e7 / videoStream.frameTime : 30;
    this.info = {
      width: videoStream.width,
      height: videoStream.height,
      frameRate,
      frameCount: Math.ceil(duration * frameRate),
      duration,
      sampleRate: audioStream?.sampleRate ?? 0,
      channels: audioStream?.channels ?? 0,
      sampleCount: audioStream ? Math.ceil(duration * audioStream.sampleRate) : 0,
    };
    this.demuxer = new AsfDemuxer(layout);
    this.order = new AsfPrerollQueue(Number(layout.preroll), videoStream.number);
    this.video = new WindowsMediaDecoder(videoStream);
    try {
      this.audio = audioStream ? new WindowsMediaDecoder(audioStream) : null;
    } catch (error) {
      this.video.close();
      throw error;
    }
  }

  static async open(source: ByteSource, signal?: AbortSignal): Promise<AsfMovie> {
    if (source.size < 30) throw Error('Truncated ASF header object');
    const prefix = await source.read(0, 30, signal);
    const size = Number(new DataView(prefix.buffer, prefix.byteOffset, 30).getBigUint64(16, true));
    if (size < 30 || size + 50 > source.size) throw Error('Invalid ASF header object size');
    const layout = readAsfLayout(await source.read(0, size + 50, signal));
    const video = layout.streams.find((s) => s.kind === 'video');
    if (!video) throw Error('ASF movie without a video stream');
    if (layout.dataOffset + layout.packetCount * layout.packetSize > source.size)
      throw Error('Truncated ASF data object');
    return new AsfMovie(
      source,
      layout,
      video,
      layout.streams.find((s) => s.kind === 'audio'),
    );
  }

  async next(): Promise<MovieBatch> {
    const frames: MovieFrame[] = [],
      audio: MoviePcm[] = [];
    if (this.done) return {frames, audio, info: this.info, done: true, progress: 1};
    const {packetSize, packetCount, dataOffset} = this.layout;
    // Demuxes until video is released, so a batch is empty only while the first preroll loads.
    while (!this.ready.length && this.packet < packetCount) {
      while (this.reads.length < READS_AHEAD && this.requested < packetCount) {
        const at = this.requested,
          count = Math.min(PACKETS, packetCount - at);
        this.requested += count;
        const read = this.source
          .read(dataOffset + at * packetSize, count * packetSize)
          .then((bytes) => ({bytes, count}));
        read.catch(() => {}); // Rejections surface where the read is awaited.
        this.reads.push(read);
      }
      const {bytes, count} = await this.reads.shift()!;
      this.packet += count;
      for (let i = 0; i < count; i++)
        for (const object of this.order.push(
          this.demuxer.packet(bytes.subarray(i * packetSize, (i + 1) * packetSize)),
        ))
          if (object.stream === this.videoStream.number) this.ready.push(object);
          else if (this.audio && object.stream === this.audioStream!.number) {
            this.audioObject ??= object.time;
            this.samples(this.audio.decode(object.data, object.time, object.key), audio);
          }
    }
    if (this.packet >= packetCount) this.ready.push(...this.order.flush());
    for (const object of this.ready.splice(0, VIDEO_OBJECTS))
      this.pictures(this.video.decode(object.data, object.time, object.key), frames);
    if (this.packet >= packetCount && !this.ready.length) {
      this.pictures(this.video.decode(null), frames);
      if (this.audio) this.samples(this.audio.decode(null), audio);
      this.video.close();
      this.audio?.close();
      this.done = true;
    }
    return {frames, audio, info: this.info, done: this.done, progress: this.packet / packetCount};
  }

  private pictures(output: ReturnType<WindowsMediaDecoder['decode']>, frames: MovieFrame[]) {
    for (const o of output)
      if ('frame' in o)
        frames.push({
          ...o.frame,
          timestamp: o.time >= 0 ? o.time / 1000 : o.frame.index / this.info.frameRate,
        });
  }
  private samples(output: ReturnType<WindowsMediaDecoder['decode']>, audio: MoviePcm[]) {
    for (const o of output)
      if ('channels' in o) {
        this.audioOrigin ??= Math.max(0, o.time >= 0 ? o.time : (this.audioObject ?? 0));
        const start = this.audioSamples;
        this.audioSamples += o.channels[0]!.length;
        audio.push({
          start,
          channels: o.channels,
          timestamp: this.audioOrigin / 1000 + start / this.info.sampleRate,
        });
      }
  }
}
