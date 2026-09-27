import type {PcmClip} from '../../../audio/pcm.js';
import {decodeVorbis} from '../../../audio/vorbis-decoder.js';
import {parseWave, waveOggStream, wavePcmPlanes} from '../../../formats/riff/wave.js';

/** DirectSound attenuation floor used by the native fades (hundredths of a decibel). */
const FADE_FLOOR = -5000;
/** Stream fade timer period (0x471240 with the delay set in 0x46B970). */
export const FADE_STEP_MS = 100;
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
 * one step per 100 ms, so they map onto exponential gain ramps.
 */
export class RScriptSoundChannel {
  private readonly output: GainNode;
  private readonly panner: StereoPannerNode;
  private clip: Promise<AudioBuffer | null> = Promise.resolve(null);
  private node: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  private generation = 0;
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
    this.path = path;
    const cached = this.cache?.get(path);
    if (cached) {
      this.clip = cached;
      return;
    }
    const clip = this.decode(path);
    this.clip = clip;
    if (this.cache) {
      this.cache.set(path, clip);
      if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value!);
    }
  }
  private async decode(path: string): Promise<AudioBuffer | null> {
    try {
      const bytes = await this.env.read(path);
      if (!bytes) {
        this.env.diagnostic?.(`Missing sound ${path}`);
        return null;
      }
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
      this.env.diagnostic?.(`Sound ${path}: ${error instanceof Error ? error.message : error}`);
      return null;
    }
  }

  /** vtable +16 (0x46A8B0). Playback starts once the clip is decoded. */
  play(fade: boolean, loops: number): void {
    this.detach();
    const generation = ++this.generation;
    this.endedPromise = new Promise((resolve) => (this.ended = resolve));
    void this.clip.then((buffer) => {
      if (generation !== this.generation) return;
      if (!buffer) return this.finish();
      const context = this.context,
        now = context.currentTime;
      const node = context.createBufferSource(),
        gain = context.createGain();
      node.buffer = buffer;
      node.loop = loops !== 0;
      node.connect(gain).connect(this.output);
      const target = attenuationGain(this.attenuation);
      if (fade) {
        gain.gain.setValueAtTime(attenuationGain(FADE_FLOOR), now);
        gain.gain.exponentialRampToValueAtTime(target, now + this.fadeSeconds);
      } else gain.gain.setValueAtTime(target, now);
      node.onended = () => {
        if (this.node === node) this.finish();
      };
      this.node = node;
      this.gain = gain;
      node.start(now);
      if (loops > 0) node.stop(now + buffer.duration * (loops + 1));
    });
  }

  private get fadeSeconds(): number {
    return (this.fadeSteps * FADE_STEP_MS) / 1000;
  }

  /** vtable +20 (0x46A940): stops at once, or after fading out. */
  stop(fade: boolean): void {
    const node = this.node,
      gain = this.gain;
    if (fade && node && gain) {
      this.node = null;
      this.gain = null;
      this.generation++;
      const now = this.context.currentTime,
        end = now + this.fadeSeconds;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(Math.max(gain.gain.value, 1e-4), now);
      gain.gain.exponentialRampToValueAtTime(attenuationGain(FADE_FLOOR), end);
      node.onended = () => node.disconnect();
      node.stop(end);
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
    const node = this.node;
    this.node = null;
    this.gain = null;
    if (!node) return;
    node.onended = null;
    try {
      node.stop();
    } catch {
      // Not started yet.
    }
    node.disconnect();
  }
  private finish(): void {
    this.node = null;
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
    this.music = [
      new RScriptSoundChannel(env, destination),
      new RScriptSoundChannel(env, destination),
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
  /** sub_455F90: stops every channel and fades the BGM out over one second. */
  stopAll(): void {
    for (const channel of this.channels.slice(1)) channel.stop(false);
    this.stopMusic(true, 10);
  }

  dispose(): void {
    for (const channel of [...this.channels, ...this.music]) channel.dispose();
  }
}
