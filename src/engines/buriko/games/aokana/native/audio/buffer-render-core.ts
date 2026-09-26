import type {
  AokanaAudioBufferCommand,
  AokanaAudioBufferFormat,
  AokanaAudioBufferNotification,
  AokanaAudioBufferStatus,
} from './buffer-protocol.js';

/** Actual mutable PCM consumer shared by the browser worklet and ordinary memory rendering.
 * Selected host DSP: rational-phase linear interpolation, front-channel attenuation pan.
 * PCM bytes remain undefined until written; stopped output is actual silence, not an error fallback.
 */
export class AokanaAudioBufferRenderCore {
  readonly bytes: Uint8Array;
  readonly initialized: Uint8Array;
  readonly outputChannels: number;
  private readonly frameBytes: number;
  private cursor = 0;
  private phase = 0;
  private frame = 0;
  private playing = false;
  private looping = false;
  private disposed = false;
  private volume = 1;
  private left = 1;
  private right = 1;
  private offsets: number[] = [];
  private orderedOffsets: number[] = [];
  private events: AokanaAudioBufferNotification[] = [];

  constructor(
    readonly format: AokanaAudioBufferFormat,
    readonly outputRate: number,
  ) {
    if (
      !Number.isInteger(format.sampleRate) ||
      format.sampleRate <= 0 ||
      format.sampleRate > 0xffffffff ||
      !Number.isInteger(outputRate) ||
      outputRate <= 0 ||
      outputRate > 0xffffffff ||
      !Number.isInteger(format.channels) ||
      format.channels < 1 ||
      format.channels > 8 ||
      ![8, 16, 24].includes(format.bits)
    )
      throw new RangeError('Unsupported Aokana browser PCM format');
    this.format = {...format};
    this.frameBytes = format.channels * (format.bits >>> 3);
    if (
      !Number.isInteger(format.byteLength) ||
      format.byteLength <= 0 ||
      format.byteLength > 0xffffffff ||
      format.byteLength % this.frameBytes !== 0
    )
      throw new RangeError('Aokana browser buffer requires complete PCM frames');
    this.bytes = new Uint8Array(format.byteLength);
    this.initialized = new Uint8Array(format.byteLength);
    this.outputChannels = Math.max(2, format.channels);
  }
  status(): AokanaAudioBufferStatus {
    return {playing: this.playing, byteCursor: this.cursor, renderFrame: this.frame};
  }
  takeNotifications(): AokanaAudioBufferNotification[] {
    const events = this.events;
    this.events = [];
    return events;
  }
  private notify(offset: number): void {
    this.offsets.forEach((value, index) => {
      if (value === offset) this.events.push({index, offset, renderFrame: this.frame});
    });
  }
  private stop(): void {
    if (this.playing) {
      this.playing = false;
      this.notify(0xffffffff);
    }
  }
  command(command: AokanaAudioBufferCommand): AokanaAudioBufferStatus {
    if (this.disposed) throw new Error('Aokana browser audio buffer is disposed');
    switch (command.kind) {
      case 'write': {
        const {offset, bytes, initialized} = command;
        if (
          !Number.isInteger(offset) ||
          offset < 0 ||
          offset >= this.bytes.length ||
          bytes.length > this.bytes.length ||
          initialized.length !== bytes.length
        )
          throw new RangeError('Aokana browser audio write exceeds ring storage');
        // A native lock can split at the ring end; copy both spans in source order.
        const first = Math.min(bytes.length, this.bytes.length - offset);
        this.bytes.set(bytes.subarray(0, first), offset);
        this.initialized.set(initialized.subarray(0, first), offset);
        this.bytes.set(bytes.subarray(first), 0);
        this.initialized.set(initialized.subarray(first), 0);
        break;
      }
      case 'notifications':
        for (const offset of command.offsets)
          if (
            !Number.isInteger(offset) ||
            offset < 0 ||
            (offset >= this.bytes.length && offset !== 0xffffffff)
          )
            throw new RangeError('Aokana browser notification is outside buffer');
        this.offsets = [...command.offsets];
        this.orderedOffsets = [...new Set(this.offsets)].sort((a, b) => a - b);
        break;
      case 'play':
        this.looping = command.loop;
        if (!this.playing) {
          this.playing = true;
          this.notify(this.cursor);
        }
        break;
      case 'stop':
        this.stop();
        break;
      case 'seek':
        if (
          !Number.isInteger(command.byteOffset) ||
          command.byteOffset < 0 ||
          command.byteOffset >= this.bytes.length
        )
          throw new RangeError('Aokana browser seek exceeds buffer');
        this.cursor = command.byteOffset;
        this.phase = 0;
        break;
      case 'volume':
        if (
          !Number.isInteger(command.decibels) ||
          command.decibels < -10000 ||
          command.decibels > 0
        )
          throw new RangeError('Aokana browser attenuation is outside DirectSound range');
        this.volume = command.decibels <= -10000 ? 0 : Math.pow(10, command.decibels / 2000);
        break;
      case 'pan':
        if (
          !Number.isInteger(command.decibels) ||
          command.decibels < -10000 ||
          command.decibels > 10000
        )
          throw new RangeError('Aokana browser pan is outside DirectSound range');
        this.left =
          command.decibels >= 10000
            ? 0
            : command.decibels > 0
              ? Math.pow(10, -command.decibels / 2000)
              : 1;
        this.right =
          command.decibels <= -10000
            ? 0
            : command.decibels < 0
              ? Math.pow(10, command.decibels / 2000)
              : 1;
        break;
      case 'status':
        break;
      case 'dispose':
        this.stop();
        this.disposed = true;
        break;
    }
    return this.status();
  }
  private sample(offset: number): number {
    const width = this.format.bits >>> 3;
    let value = 0;
    for (let i = 0; i < width; i++) {
      let at = offset + i;
      if (this.looping) at %= this.bytes.length;
      if (at < 0 || at >= this.bytes.length || this.initialized[at] === 0)
        throw new Error('Aokana audio render consumes unwritten or out-of-range PCM');
      value |= this.bytes[at]! << (i * 8);
    }
    if (width === 1) return (value - 128) / 128;
    return width === 2 ? ((value << 16) >> 16) / 32768 : ((value << 8) >> 8) / 8388608;
  }
  private advance(distance: number): void {
    while (distance > 0 && this.playing) {
      const step = Math.min(distance, this.bytes.length - this.cursor),
        next = this.cursor + step;
      for (const offset of this.orderedOffsets)
        if (offset > this.cursor && offset <= next && offset < this.bytes.length)
          this.notify(offset);
      distance -= step;
      this.cursor = next;
      if (this.cursor === this.bytes.length) {
        this.cursor = 0;
        if (this.looping) this.notify(0);
        else {
          this.phase = 0;
          this.stop();
        }
      }
    }
  }
  /** Called by the actual render host, never by a status getter or VM instruction. */
  render(output: readonly Float32Array[]): void {
    if (this.disposed) throw new Error('Aokana browser audio buffer is disposed');
    if (
      output.length !== this.outputChannels ||
      output.some((channel) => channel.length !== output[0]!.length)
    )
      throw new RangeError('Aokana audio render output layout mismatch');
    const count = output[0]!.length;
    for (let frame = 0; frame < count; frame++) {
      for (let channel = 0; channel < output.length; channel++) {
        let value = 0;
        if (this.playing) {
          const sourceChannel = this.format.channels === 1 ? 0 : channel,
            at = this.cursor + sourceChannel * (this.format.bits >>> 3),
            first = this.sample(at);
          value = first;
          if (this.phase !== 0) {
            const next = this.cursor + this.frameBytes;
            const second =
              next < this.bytes.length || this.looping
                ? this.sample(next + sourceChannel * (this.format.bits >>> 3))
                : first;
            value += ((second - first) * this.phase) / this.outputRate;
          }
          value *= this.volume * (channel === 0 ? this.left : channel === 1 ? this.right : 1);
        }
        output[channel]![frame] = value;
      }
      this.frame++;
      if (this.playing) {
        this.phase += this.format.sampleRate;
        const frames = Math.floor(this.phase / this.outputRate);
        this.phase %= this.outputRate;
        this.advance(frames * this.frameBytes);
      }
    }
  }
}
