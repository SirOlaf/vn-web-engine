import type {PcmClip} from '../../../audio/pcm.js';
import {decodeVorbis, streamVorbis, type VorbisStream} from '../../../audio/vorbis-decoder.js';
import {parseWave, waveOggStream, wavePcmPlanes} from '../../../formats/riff/wave.js';

/** DirectSound attenuation floor used by the native fades (hundredths of a decibel). */
const FADE_FLOOR = -5000;
/**
 * Stream fade timer period (0x471240). The stream object starts with 100 ms (0x46B970),
 * but loading a clip sets 20 ms (0x46BAF0), so every fade runs at 20 ms per step.
 */
export const FADE_STEP_MS = 20;
/** Default number of fade steps until a caller sets another (0x46B970, 0x46AC40). */
export const DEFAULT_FADE_STEPS = 150;

/** DirectSound volume or pan attenuation in hundredths of a decibel, as a linear gain. */
export function attenuationGain(hundredths: number): number {
  return 10 ** (Math.min(0, hundredths) / 2000);
}
/** Configuration volume 0..255 as the native channel attenuation (0x455BA0, 0x455E70). */
export function volumeAttenuation(volume: number): number {
  return Math.trunc((3000 * (volume - 255)) / 255);
}
/** Script repeat count as native plays: 0 once, 999 forever, otherwise `n` times (0x428D50). */
export function scriptLoops(repeat: number): number {
  return repeat === 999 ? -1 : repeat ? repeat - 1 : 0;
}

/** Decodes an RScript WAVE: integer PCM or a Vorbis ACM stream that keeps its Ogg pages. */
export async function decodeRScriptWave(bytes: Uint8Array): Promise<PcmClip> {
  const wave = parseWave(bytes);
  const ogg = waveOggStream(wave);
  if (ogg) {
    const pcm = await decodeVorbis(ogg);
    return {sampleRate: pcm.sampleRate, channels: [...pcm.planes], sampleCount: pcm.frames};
  }
  const channels = wavePcmPlanes(wave);
  return {sampleRate: wave.sampleRate, channels, sampleCount: channels[0]?.length ?? 0};
}

/** Frames in the first streamed chunk and in each later one. */
export interface StreamChunking {
  readonly firstFrames: number;
  readonly chunkFrames: number;
  /** Frames made playable before the whole clip is ready; later chunks only feed `whole`. */
  readonly playableFrames: number;
}
/** One second to start, then four-second chunks, at the 44.1 kHz of every music track. */
export const MUSIC_CHUNKING: StreamChunking = {
  firstFrames: 44100,
  chunkFrames: 4 * 44100,
  // Decoding runs hundreds of times faster than playback, so the whole clip is ready long
  // before 20 seconds have played. Buffering every chunk as well would hold the track twice.
  playableFrames: 20 * 44100,
};

/**
 * A Vorbis track decoded by `streamVorbis`. The native stream starts playing its first
 * buffer at once; decoding a long track whole first delayed the music by up to half a second.
 * Chunks become playable as they arrive, then `whole` holds the complete track for looping.
 */
class StreamingClip {
  chunks: AudioBuffer[] = [];
  whole: AudioBuffer | null = null;
  failed = false;
  private readonly listeners = new Set<() => void>();
  private readonly stream: VorbisStream;

  constructor(
    context: BaseAudioContext,
    ogg: Uint8Array,
    {firstFrames, chunkFrames, playableFrames}: StreamChunking,
    onError: (error: unknown) => void,
  ) {
    let sampleRate = 0,
      limit = Infinity,
      decoded = 0;
    const planes: Float32Array[][] = [];
    this.stream = streamVorbis(ogg, firstFrames, chunkFrames, {
      onOpen: (open) => {
        sampleRate = open.sampleRate;
        limit = open.finalGranule ?? Infinity;
      },
      onChunk: (chunk, frames) => {
        planes.push(chunk);
        // The EOS granule trims the encoder's last overlap; it never adds samples.
        const kept = Math.max(0, Math.min(frames, limit - decoded));
        const playable = decoded < playableFrames;
        decoded += frames;
        if (!kept || !playable) return;
        const buffer = context.createBuffer(chunk.length, kept, sampleRate);
        chunk.forEach((c, i) =>
          buffer.copyToChannel(c.subarray(0, kept) as Float32Array<ArrayBuffer>, i),
        );
        this.chunks.push(buffer);
        this.notify();
      },
    });
    this.stream.done.then(
      ({frames, channels}) => {
        if (frames) {
          const whole = context.createBuffer(channels, frames, sampleRate);
          for (let channel = 0; channel < channels; channel++) {
            const plane = whole.getChannelData(channel);
            let at = 0;
            for (const chunk of planes) {
              if (at >= frames) break;
              const part = chunk[channel]!.subarray(0, frames - at);
              plane.set(part, at);
              at += part.length;
            }
          }
          this.whole = whole;
        } else this.failed = true;
        // Later plays start from `whole`; buffers already scheduled stay referenced by their nodes.
        this.chunks = [];
        planes.length = 0;
        this.notify();
      },
      (error: unknown) => {
        this.failed = true;
        if (!(error instanceof DOMException && error.name === 'AbortError')) onError(error);
        this.notify();
      },
    );
  }

  /** Calls `listener` on every new chunk and on completion; returns the unsubscribe. */
  watch(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
  cancel(): void {
    this.stream.cancel();
  }
}

type Clip = AudioBuffer | StreamingClip;

const bits = new DataView(new ArrayBuffer(8));
/** The adjacent double above (or below) a positive `value`. */
function nextDouble(value: number, up: boolean): number {
  bits.setFloat64(0, value);
  bits.setBigUint64(0, bits.getBigUint64(0) + (up ? 1n : -1n));
  return bits.getFloat64(0);
}
/**
 * The time of `frame` at `rate`, nudged so that `time * rate` is exactly `frame`. Chromium
 * reads a fractional start frame as a sub-sample start and interpolates the first samples,
 * which would blur the joins between streamed chunks.
 */
export function frameTime(frame: number, rate: number): number {
  let time = frame / rate;
  for (let step = 0; step < 8 && time > 0 && time * rate !== frame; step++)
    time = nextDouble(time, time * rate < frame);
  return time;
}

export interface RScriptAudioEnvironment {
  readonly context: BaseAudioContext;
  /** Reads an installation-relative file, or null when it does not exist. */
  read(path: string): Promise<Uint8Array | null>;
  diagnostic?(message: string): void;
}

/**
 * One DirectSound stream (0x46A5C0 behind the 0x46A970 wrapper). `load` replaces the
 * clip, `play` repeats it `loops + 1` times (forever when negative) and optionally fades
 * in from -50 dB, and `stop` optionally fades out first. Fades are linear in decibels,
 * one step per 20 ms, so they map onto exponential gain ramps. A streaming channel plays
 * Vorbis clips while they decode (see `StreamingClip`).
 */
export class RScriptSoundChannel {
  private readonly output: GainNode;
  private readonly panner: StereoPannerNode;
  private clip: Promise<Clip | null> = Promise.resolve(null);
  /** Sources of the current playback: streamed chunks, then the whole clip. */
  private nodes: AudioBufferSourceNode[] = [];
  private gain: GainNode | null = null;
  private generation = 0;
  private unwatch: (() => void) | null = null;
  private ended: (() => void) | null = null;
  private endedPromise: Promise<void> = Promise.resolve();
  /** Channel attenuation set by the configuration (sub_46C120). */
  private attenuation = 0;
  fadeSteps = DEFAULT_FADE_STEPS;
  /** Path of the last loaded clip, for diagnostics and restoring. */
  path: string | null = null;

  constructor(
    private readonly env: RScriptAudioEnvironment,
    destination: AudioNode,
    private readonly cache?: Map<string, Promise<AudioBuffer | null>>,
    /** Streams Vorbis clips in these chunks; others decode whole. */
    private readonly streaming: StreamChunking | null = null,
  ) {
    this.output = env.context.createGain();
    this.panner = env.context.createStereoPanner();
    this.output.connect(this.panner).connect(destination);
  }

  private get context(): BaseAudioContext {
    return this.env.context;
  }

  /** vtable +8: stops the current clip and loads another. */
  load(path: string): void {
    this.stop(false);
    void this.clip.then((clip) => {
      if (clip instanceof StreamingClip) clip.cancel();
    });
    this.path = path;
    if (this.streaming) {
      this.clip = this.open(path);
      return;
    }
    const cached = this.cache?.get(path);
    if (cached) {
      this.clip = cached;
      return;
    }
    const clip = this.read(path).then((bytes) => (bytes ? this.decode(path, bytes) : null));
    this.clip = clip;
    if (this.cache) {
      this.cache.set(path, clip);
      if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value!);
    }
  }
  private async read(path: string): Promise<Uint8Array | null> {
    try {
      const bytes = await this.env.read(path);
      if (!bytes) this.env.diagnostic?.(`Missing sound ${path}`);
      return bytes;
    } catch (error) {
      this.report(path, error);
      return null;
    }
  }
  private report(path: string, error: unknown): void {
    this.env.diagnostic?.(`Sound ${path}: ${error instanceof Error ? error.message : error}`);
  }
  /** Streams Vorbis; integer PCM needs no decoding and loads whole. */
  private async open(path: string): Promise<Clip | null> {
    const bytes = await this.read(path);
    if (!bytes) return null;
    try {
      const ogg = waveOggStream(parseWave(bytes));
      if (ogg)
        return new StreamingClip(this.context, ogg, this.streaming!, (error) =>
          this.report(path, error),
        );
    } catch (error) {
      this.report(path, error);
      return null;
    }
    return this.decode(path, bytes);
  }
  private async decode(path: string, bytes: Uint8Array): Promise<AudioBuffer | null> {
    try {
      const pcm = await decodeRScriptWave(bytes);
      if (!pcm.sampleCount) return null;
      const buffer = this.context.createBuffer(
        pcm.channels.length,
        pcm.sampleCount,
        pcm.sampleRate,
      );
      pcm.channels.forEach((c, i) => buffer.copyToChannel(c as Float32Array<ArrayBuffer>, i));
      return buffer;
    } catch (error) {
      this.report(path, error);
      return null;
    }
  }

  /** vtable +16 (0x46A8B0). Playback starts once the clip, or its first chunk, is decoded. */
  play(fade: boolean, loops: number): void {
    this.detach();
    const generation = ++this.generation;
    this.endedPromise = new Promise((resolve) => (this.ended = resolve));
    void this.clip.then((clip) => {
      if (generation !== this.generation) return;
      if (!clip) return this.finish();
      if (clip instanceof StreamingClip) this.playStreaming(clip, fade, loops, generation);
      else this.startWhole(clip, this.begin(fade), 0, loops);
    });
  }

  /** Creates the playback gain at the current time, optionally fading in; returns the start. */
  private begin(fade: boolean): number {
    const context = this.context,
      now = context.currentTime;
    const gain = context.createGain();
    gain.connect(this.output);
    const target = attenuationGain(this.attenuation);
    if (fade) {
      gain.gain.setValueAtTime(attenuationGain(FADE_FLOOR), now);
      gain.gain.exponentialRampToValueAtTime(target, now + this.fadeSeconds);
    } else gain.gain.setValueAtTime(target, now);
    this.gain = gain;
    return now;
  }
  /** Context time `frames` after `start` at `rate`, on an exact frame when the rates match. */
  private time(start: number, frames: number, rate: number): number {
    if (rate !== this.context.sampleRate) return start + frames / rate;
    return frameTime(Math.round(start * rate) + frames, rate);
  }
  private source(buffer: AudioBuffer): AudioBufferSourceNode {
    const node = this.context.createBufferSource();
    node.buffer = buffer;
    node.connect(this.gain!);
    this.nodes.push(node);
    return node;
  }
  /**
   * Plays `buffer` from frame `offset` at `start + offset`, repeating from its first frame:
   * `loops + 1` passes in all, counted from `start`, or forever when negative.
   */
  private startWhole(buffer: AudioBuffer, start: number, offset: number, loops: number): void {
    const rate = buffer.sampleRate;
    if (loops === 0 && offset >= buffer.length) {
      // The streamed chunks already hold the whole clip.
      this.endWithLast();
      return;
    }
    const node = this.source(buffer);
    node.loop = loops !== 0;
    node.onended = () => {
      if (this.nodes.includes(node)) this.finish();
    };
    node.start(this.time(start, offset, rate), frameTime(offset % buffer.length, rate));
    if (loops > 0) node.stop(this.time(start, buffer.length * (loops + 1), rate));
  }
  /** Stops and drops one source of the current playback, freeing its buffer. */
  private release(node: AudioBufferSourceNode): void {
    node.onended = null;
    try {
      node.stop();
    } catch {
      // Not started yet.
    }
    node.disconnect();
    this.nodes = this.nodes.filter((other) => other !== node);
  }
  private endWithLast(): void {
    const last = this.nodes[this.nodes.length - 1];
    if (!last) return this.finish();
    last.onended = () => {
      if (this.nodes.includes(last)) this.finish();
    };
  }
  /**
   * Schedules decoded chunks back to back as they arrive. Once the whole clip is decoded,
   * chunks that have not started yet are cancelled and the whole clip continues from the
   * first of them, so the track's PCM is held once rather than twice. With the context at
   * the clip's rate, every boundary falls on a sample and the joins are seamless.
   */
  private playStreaming(
    clip: StreamingClip,
    fade: boolean,
    loops: number,
    generation: number,
  ): void {
    let start: number | null = null,
      scheduled = 0,
      next = 0;
    /** Chunk sources still scheduled or playing, with their first frame. */
    const pending = new Map<AudioBufferSourceNode, number>();
    const update = (): void => {
      if (generation !== this.generation) return stopWatching();
      if (clip.whole) {
        stopWatching();
        start ??= this.begin(fade);
        const rate = clip.whole.sampleRate;
        // Chunks starting within the next 100 ms may already be committed to the device.
        const committed = Math.round((this.context.currentTime - start) * rate + rate / 10);
        for (const [node, first] of pending) {
          if (first < committed) continue;
          scheduled = Math.min(scheduled, first);
          this.release(node);
          pending.delete(node);
        }
        this.startWhole(clip.whole, start, scheduled, loops);
        return;
      }
      if (clip.failed) {
        stopWatching();
        return start === null ? this.finish() : this.endWithLast();
      }
      if (next >= clip.chunks.length) return;
      start ??= this.begin(fade);
      for (; next < clip.chunks.length; next++) {
        const chunk = clip.chunks[next]!;
        const node = this.source(chunk);
        pending.set(node, scheduled);
        node.start(this.time(start, scheduled, chunk.sampleRate));
        scheduled += chunk.length;
        // Without an explicit stop, Chromium keeps rendering a few hundred frames past the
        // end of a buffer, which then overlap the next chunk.
        node.stop(this.time(start, scheduled, chunk.sampleRate));
        // A played chunk is dropped; after a failure `endWithLast` watches the last one.
        node.onended = () => {
          if (pending.delete(node)) this.release(node);
        };
      }
    };
    const stopWatching = (): void => {
      this.unwatch?.();
      this.unwatch = null;
    };
    this.unwatch = clip.watch(update);
    update();
  }

  private get fadeSeconds(): number {
    return (this.fadeSteps * FADE_STEP_MS) / 1000;
  }

  /** vtable +20 (0x46A940): stops at once, or after fading out. */
  stop(fade: boolean): void {
    const nodes = this.nodes,
      gain = this.gain;
    if (fade && nodes.length && gain) {
      this.nodes = [];
      this.gain = null;
      this.generation++;
      this.unwatch?.();
      this.unwatch = null;
      const now = this.context.currentTime,
        end = now + this.fadeSeconds;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(Math.max(gain.gain.value, 1e-4), now);
      gain.gain.exponentialRampToValueAtTime(attenuationGain(FADE_FLOOR), end);
      for (const node of nodes) {
        node.onended = () => node.disconnect();
        try {
          node.stop(end);
        } catch {
          // Already stopped.
        }
      }
      // Waiters see the stream as stopped once the fade completes.
      const ended = this.ended;
      this.ended = null;
      setTimeout(() => ended?.(), this.fadeSeconds * 1000);
      return;
    }
    this.generation++;
    this.detach();
    this.finish();
  }

  private detach(): void {
    this.unwatch?.();
    this.unwatch = null;
    const nodes = this.nodes;
    this.nodes = [];
    this.gain = null;
    for (const node of nodes) {
      node.onended = null;
      try {
        node.stop();
      } catch {
        // Not started yet.
      }
      node.disconnect();
    }
  }
  private finish(): void {
    this.nodes = [];
    this.gain = null;
    const ended = this.ended;
    this.ended = null;
    ended?.();
  }

  get playing(): boolean {
    return this.ended !== null;
  }
  /** vtable +44: resolves when the current playback ends or is stopped. */
  waitEnd(): Promise<void> {
    return this.endedPromise;
  }

  /** vtable +32 (sub_46C120): channel attenuation, -5000..0. */
  setAttenuation(hundredths: number): void {
    this.attenuation = Math.max(FADE_FLOOR, Math.min(0, hundredths));
    const gain = this.gain;
    if (!gain) return;
    const now = this.context.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(attenuationGain(this.attenuation), now);
  }
  /** vtable +36 (sub_46C150): DirectSound pan, -5000 (left) .. 5000 (right). */
  setPan(hundredths: number): void {
    const pan = Math.max(-5000, Math.min(5000, hundredths));
    // DirectSound attenuates the opposite side; approximate it with an equal-power pan.
    this.panner.pan.value = Math.sign(pan) * (1 - attenuationGain(-Math.abs(pan)));
  }

  dispose(): void {
    this.stop(false);
    void this.clip.then((clip) => {
      if (clip instanceof StreamingClip) clip.cancel();
    });
    this.output.disconnect();
    this.panner.disconnect();
  }
}

/** Native audio channel indexes (application +428). */
export const AudioChannel = {system: 0, voice: 1, effect: 2} as const;

/**
 * Application sound objects: five channels (system SE, voice, three script SE channels)
 * and the BGM pair that alternates to crossfade tracks (0x455B40..0x455F90).
 */
export class RScriptAudio {
  readonly channels: readonly RScriptSoundChannel[];
  private readonly music: readonly [RScriptSoundChannel, RScriptSoundChannel];
  private current = 0;
  /** Playing BGM track, 0 when none. */
  track = 0;
  private readonly effects = new Map<string, Promise<AudioBuffer | null>>();

  constructor(
    env: RScriptAudioEnvironment,
    private readonly bgmDirectory: string,
  ) {
    const destination = env.context.destination;
    this.channels = Array.from(
      {length: 5},
      (_, i) =>
        new RScriptSoundChannel(
          env,
          destination,
          i === AudioChannel.voice ? undefined : this.effects,
        ),
    );
    // BGM streams: long tracks start on their first decoded chunk, as the native stream does.
    this.music = [
      new RScriptSoundChannel(env, destination, undefined, MUSIC_CHUNKING),
      new RScriptSoundChannel(env, destination, undefined, MUSIC_CHUNKING),
    ];
  }

  channel(index: number): RScriptSoundChannel {
    return this.channels[index] ?? this.channels[0]!;
  }
  /** sub_455B40 / sub_455B60 / sub_455B80 */
  load(channel: number, path: string): void {
    this.channel(channel).load(path);
  }
  play(channel: number, loops: number, fade: boolean): void {
    this.channel(channel).play(fade, loops);
  }
  stop(channel: number, fade: boolean): void {
    this.channel(channel).stop(fade);
  }
  /** sub_455BA0: configuration volume 0..255. */
  setVolume(channel: number, volume: number): void {
    this.channel(channel).setAttenuation(volumeAttenuation(volume));
  }
  /** sub_455BF0: script pan -100..100. */
  setPan(channel: number, pan: number): void {
    this.channel(channel).setPan(50 * pan);
  }
  /** sub_455C10 */
  waitEnd(channel: number): Promise<void> {
    return this.channel(channel).waitEnd();
  }

  /** sub_455C30: plays `Track%02d`, fading the previous track out on the other stream. */
  playMusic(track: number, fade: boolean, fadeSteps: number): void {
    if (!track || track === this.track) return;
    if (this.track) this.stopMusic(fade, fadeSteps);
    const stream = this.music[this.current]!;
    this.track = track;
    stream.load(`${this.bgmDirectory}\\Track${String(track).padStart(2, '0')}.wav`);
    if (fadeSteps) stream.fadeSteps = fadeSteps;
    stream.play(fade, -1);
  }
  /** sub_455DE0 */
  stopMusic(fade: boolean, fadeSteps: number): void {
    if (!this.track) return;
    const stream = this.music[this.current]!;
    if (fadeSteps) stream.fadeSteps = fadeSteps;
    stream.stop(fade);
    this.current = (this.current + 1) % 2;
    this.track = 0;
  }
  /** sub_455E70 */
  setMusicVolume(volume: number): void {
    for (const stream of this.music) stream.setAttenuation(volumeAttenuation(volume));
  }
  /** sub_455F90: stops every channel and fades the BGM out in ten steps. */
  stopAll(): void {
    for (const channel of this.channels.slice(1)) channel.stop(false);
    this.stopMusic(true, 10);
  }

  dispose(): void {
    for (const channel of [...this.channels, ...this.music]) channel.dispose();
  }
}
