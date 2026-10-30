import type {PcmClip} from './pcm.js';
import type {AudioVoice} from './transport.js';

/** Memory PCM device/reference renderer. Position advances only by rendering
 * actual sample frames; there is no timer or silent playback stand-in.
 * The host explicitly supplies its output sample rate and consumes the planes.
 */
export class PcmClipRenderer implements AudioVoice {
  readonly sampleRate: number;
  readonly sampleCount: number;
  readonly loopStart: number;
  private readonly loopEnd: number;
  private phase = 0;
  private paused = true;
  private finished = false;
  private disposed = false;
  private looping = false;
  private gain = 0;
  private left = 1;
  private right = 1;
  constructor(
    private readonly clip: PcmClip,
    private readonly outputRate: number,
  ) {
    if (
      !Number.isInteger(outputRate) ||
      outputRate < 1 ||
      !Number.isInteger(clip.sampleRate) ||
      clip.sampleRate < 1 ||
      !Number.isInteger(clip.sampleCount) ||
      clip.sampleCount < 1 ||
      (clip.channels.length !== 1 && clip.channels.length !== 2) ||
      clip.channels.some((plane) => plane.length !== clip.sampleCount)
    )
      throw Error('Invalid memory PCM voice');
    this.sampleRate = clip.sampleRate;
    this.sampleCount = clip.sampleCount;
    this.loopStart = clip.loop?.start ?? 0;
    this.loopEnd = clip.loop?.end ?? clip.sampleCount;
    if (
      !Number.isInteger(this.loopStart) ||
      !Number.isInteger(this.loopEnd) ||
      this.loopStart < 0 ||
      this.loopStart >= this.loopEnd ||
      this.loopEnd > this.sampleCount
    )
      throw Error('Invalid memory PCM loop range');
  }
  position(): number {
    return Math.floor(this.phase);
  }
  ended(): boolean {
    return this.finished;
  }
  pause(value: boolean): void {
    if (!this.disposed) this.paused = value;
  }
  volume(value: number): void {
    if (!Number.isFinite(value)) throw Error('Invalid memory PCM gain');
    if (!this.disposed) this.gain = Math.max(0, Math.min(1, value));
  }
  stereoBalance(a: number, b: number): void {
    if (![a, b].every((value) => Number.isFinite(value) && value >= 0 && value <= 1))
      throw Error('Invalid memory PCM balance');
    if (!this.disposed) {
      this.left = a;
      this.right = b;
    }
  }
  setLoop(value: boolean): void {
    if (typeof value !== 'boolean') throw Error('Invalid memory PCM loop mode');
    if (!this.disposed) this.looping = value;
  }
  stop(): void {
    if (!this.disposed) {
      this.phase = 0;
      this.paused = true;
      this.finished = false;
    }
  }
  dispose(): void {
    this.disposed = true;
    this.paused = true;
  }
  render(output: Float32Array[]): void {
    for (const plane of output) plane.fill(0);
    if (this.disposed || this.paused || this.finished) return;
    const count = output[0]?.length ?? 0,
      step = this.sampleRate / this.outputRate;
    const sample = (frame: number, channel: number) => {
      if (this.looping && frame >= this.loopEnd)
        frame = this.loopStart + ((frame - this.loopStart) % (this.loopEnd - this.loopStart));
      return this.clip.channels[this.clip.channels.length === 1 ? 0 : channel]![frame] ?? 0;
    };
    for (let i = 0; i < count; i++) {
      if (!this.looping && this.phase >= this.sampleCount) {
        this.phase = this.sampleCount;
        this.finished = true;
        break;
      }
      const frame = Math.floor(this.phase),
        fraction = this.phase - frame;
      for (let channel = 0; channel < Math.min(2, output.length); channel++) {
        const first = sample(frame, channel);
        output[channel]![i] =
          (first + (sample(frame + 1, channel) - first) * fraction) *
          this.gain *
          (channel === 0 ? this.left : this.right);
      }
      this.phase += step;
    }
    if (!this.looping && this.phase >= this.sampleCount) {
      this.phase = this.sampleCount;
      this.finished = true;
    }
  }
}
