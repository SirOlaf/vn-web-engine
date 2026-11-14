import type {PcmClip} from './pcm.js';
import {BrowserAudioContextHost} from './browser-audio-context-host.js';

/** Playback capabilities shared by engines. Positions count played samples, including repeated loops; PCM is trimmed. */
export interface AudioVoice {
  readonly sampleRate: number;
  readonly sampleCount: number;
  readonly loopStart: number;
  position(): number;
  ended(): boolean;
  pause(paused: boolean): void;
  volume(gain: number): void;
  /** Optional reusable-source controls for engines that prepare before choosing loops. */
  setLoop?(loop: boolean): void;
  stop?(): void;
  /** Scheduler-driven refill for device buffers; ordinary cached voices need no pump. */
  pump?(): void;
  /** Independent stereo attenuation, including mono duplication; no crossfeed/pan law. */
  stereoBalance?(leftGain: number, rightGain: number): void;
  dispose(): void;
}
export interface AudioTransport {
  prepare(bank: number, id: number, loop: boolean): Promise<AudioVoice>;
}

/** A prepared voice starts paused; replacing or pausing it preserves sample position. */
export class BrowserAudioTransport implements AudioTransport {
  private readonly context: AudioContext | OfflineAudioContext;
  private readonly contextHost: BrowserAudioContextHost | null;
  private readonly voices = new Set<AudioVoice>();
  private disposed = false;
  constructor(
    private readonly decode: (bank: number, id: number) => Promise<PcmClip>,
    context?: AudioContext | OfflineAudioContext,
  ) {
    this.context = context ?? new AudioContext();
    const graph = this.context;
    this.contextHost =
      typeof document === 'undefined' || 'startRendering' in graph
        ? null
        : new BrowserAudioContextHost(graph, document);
  }
  async unlock(): Promise<void> {
    if (!this.disposed && !('startRendering' in this.context))
      await (this.contextHost?.resume() ?? this.context.resume());
  }
  async prepare(bank: number, id: number, loop: boolean): Promise<AudioVoice> {
    if (this.disposed) throw new Error('Audio transport is disposed');
    const clip = await this.decode(bank, id);
    const {sampleRate, sampleCount, loop: loopRange} = clip;
    if (this.disposed) throw new Error('Audio transport was disposed during decoding');
    if (
      !Number.isInteger(sampleRate) ||
      sampleRate <= 0 ||
      !Number.isInteger(sampleCount) ||
      sampleCount <= 0 ||
      !clip.channels.length ||
      clip.channels.some((c) => c.length !== sampleCount)
    )
      throw new Error('Invalid decoded audio');
    if (
      loopRange &&
      (!Number.isInteger(loopRange.start) ||
        !Number.isInteger(loopRange.end) ||
        loopRange.start < 0 ||
        loopRange.end > sampleCount ||
        loopRange.start >= loopRange.end)
    )
      throw new Error('Invalid audio loop');
    const context = this.context,
      buffer = context.createBuffer(clip.channels.length, sampleCount, sampleRate),
      gain = context.createGain();
    clip.channels.forEach((c, i) => buffer.copyToChannel(c as Float32Array<ArrayBuffer>, i));
    gain.gain.value = 0;
    gain.connect(context.destination);
    let node: AudioBufferSourceNode | undefined,
      offset = 0,
      started = 0,
      finished = false,
      disposed = false;
    let leftBalance: GainNode | undefined,
      rightBalance: GainNode | undefined,
      splitter: ChannelSplitterNode | undefined,
      merger: ChannelMergerNode | undefined;
    const start = loopRange?.start ?? 0,
      end = loopRange?.end ?? sampleCount;
    const position = () => {
      const samples = Math.max(
        0,
        Math.floor(offset + (node ? (context.currentTime - started) * sampleRate : 0)),
      );
      return loop ? samples : Math.min(sampleCount, samples);
    };
    const detach = () => {
      if (node) {
        const old = node;
        node = undefined;
        old.onended = null;
        old.stop();
        old.disconnect();
      }
    };
    const voice: AudioVoice = {
      sampleRate: sampleRate,
      sampleCount: sampleCount,
      loopStart: loopRange?.start ?? 0,
      position,
      ended: () => finished,
      pause(paused) {
        if (disposed) return;
        if (paused) {
          offset = position();
          detach();
          return;
        }
        if (node || finished) return;
        const next = context.createBufferSource();
        next.buffer = buffer;
        next.loop = loop;
        next.loopStart = start / sampleRate;
        next.loopEnd = end / sampleRate;
        next.connect(gain);
        next.onended = () => {
          if (node !== next) return;
          next.disconnect();
          node = undefined;
          offset = sampleCount;
          finished = true;
        };
        node = next;
        started = context.currentTime;
        next.start(
          0,
          (loop && offset >= end ? start + ((offset - start) % (end - start)) : offset) /
            sampleRate,
        );
      },
      volume(value) {
        if (!Number.isFinite(value)) throw new Error('Invalid audio gain');
        if (!disposed)
          gain.gain.setValueAtTime(Math.max(0, Math.min(1, value)), context.currentTime);
      },
      setLoop(value) {
        if (typeof value !== 'boolean') throw Error('Invalid audio loop mode');
        if (disposed) return;
        loop = value;
        if (node) node.loop = loop;
      },
      stop() {
        if (disposed) return;
        detach();
        offset = 0;
        finished = false;
      },
      stereoBalance(left, right) {
        if (![left, right].every((value) => Number.isFinite(value) && value >= 0 && value <= 1))
          throw Error('Invalid stereo attenuation');
        if (disposed) return;
        if (
          clip.channels.length > 2 ||
          typeof context.createChannelSplitter !== 'function' ||
          typeof context.createChannelMerger !== 'function'
        )
          throw Error('Stereo balance requires a mono/stereo audio graph');
        if (!leftBalance) {
          splitter = context.createChannelSplitter(clip.channels.length);
          merger = context.createChannelMerger(2);
          leftBalance = context.createGain();
          rightBalance = context.createGain();
          gain.disconnect();
          gain.connect(splitter);
          splitter.connect(leftBalance, 0);
          splitter.connect(rightBalance, clip.channels.length === 1 ? 0 : 1);
          leftBalance.connect(merger, 0, 0);
          rightBalance.connect(merger, 0, 1);
          merger.connect(context.destination);
        }
        leftBalance.gain.setValueAtTime(left, context.currentTime);
        rightBalance!.gain.setValueAtTime(right, context.currentTime);
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        detach();
        gain.disconnect();
        splitter?.disconnect();
        merger?.disconnect();
        leftBalance?.disconnect();
        rightBalance?.disconnect();
        this.voices.delete(voice);
      },
    };
    this.voices.add(voice);
    return voice;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const voice of this.voices) voice.dispose();
    this.contextHost?.dispose();
    if ('close' in this.context) void this.context.close();
  }
}
