import {ArtemisPcmCursor, type ArtemisPcmResource} from './pcm-resource.js';
import {ArtemisRollingSoundBuffer} from './rolling-sound-buffer.js';

export interface ArtemisRollingAudioOptions {
  readonly hash: string;
  readonly resource: ArtemisPcmResource;
  readonly bufferMode: number;
}
export type ArtemisRollingAudioCommand =
  | {readonly kind: 'start'; readonly loop: boolean}
  | {readonly kind: 'pause'; readonly paused: boolean}
  /** Progressive Vorbis PCM after the resource snapshot (`ArtemisPcmCursor.append`). */
  | {readonly kind: 'append'; readonly bytes: Uint8Array}
  | {readonly kind: 'pump' | 'stop' | 'status' | 'dispose' | 'end'};
export interface ArtemisRollingAudioRequest {
  readonly id: number;
  readonly command: ArtemisRollingAudioCommand;
}
export type ArtemisRollingAudioResponse =
  | {
      readonly kind: 'state';
      readonly id?: number;
      readonly position: number;
      readonly playing: boolean;
      readonly finished: boolean;
    }
  | {readonly kind: 'error'; readonly id?: number; readonly message: string};

/** Device-driven real PCM output. Native refills are explicit scheduler pump
 * commands; render advances the device cursor, never the source or engine clock.
 * Fractional rate conversion is a browser linear interpolation adaptation.
 * A pump whose progressive source has not decoded a whole half yet refills nothing;
 * a later pump refills once the PCM arrived (native decodes synchronously).
 */
export class ArtemisRollingAudioProcessor {
  private readonly ring: ArtemisRollingSoundBuffer;
  private readonly cursor: ArtemisPcmCursor;
  private bytes: Uint8Array;
  private view: DataView;
  private phase = 0;
  private paused = true;
  private started = false;
  private finished = false;
  private closed = false;
  private failed = false;
  constructor(
    private readonly options: ArtemisRollingAudioOptions,
    private readonly outputRate: number,
    private readonly send: (response: ArtemisRollingAudioResponse) => void,
  ) {
    const format = options.resource.format;
    if (
      !Number.isInteger(outputRate) ||
      outputRate <= 0 ||
      (format.bitsPerSample !== 8 && format.bitsPerSample !== 16) ||
      (format.channels !== 1 && format.channels !== 2)
    )
      throw Error('Unsupported Artemis rolling audio device format');
    this.cursor = new ArtemisPcmCursor(options.resource);
    this.ring = new ArtemisRollingSoundBuffer(options.hash, this.cursor, options.bufferMode);
    this.bytes = this.ring.snapshot();
    this.view = new DataView(this.bytes.buffer);
  }
  private state(id?: number): void {
    this.send({
      kind: 'state',
      id,
      position: Math.floor(this.phase),
      playing: this.ring.playing,
      finished: this.finished,
    });
  }
  receive({id, command}: ArtemisRollingAudioRequest): void {
    try {
      if (this.closed || this.failed) throw Error('Artemis rolling processor unavailable');
      switch (command.kind) {
        case 'start': {
          if (!this.ring.start(command.loop))
            throw Error('Artemis rolling source has no initial PCM');
          // Prefill the other half before audible output. Native's first engine
          // tick performs this while the first half is being played.
          this.ring.tick(0);
          this.bytes = this.ring.snapshot();
          this.view = new DataView(this.bytes.buffer);
          this.phase = 0;
          this.paused = false;
          this.started = true;
          this.finished = false;
          break;
        }
        case 'pause':
          this.paused = command.paused;
          break;
        case 'append':
          this.cursor.append(command.bytes);
          break;
        case 'end':
          this.cursor.end();
          break;
        case 'pump': {
          if (!this.cursor.ready(this.ring.halfSize)) break;
          const cursor =
            (Math.floor(this.phase) * this.options.resource.format.blockAlign) % this.bytes.length;
          const update = this.ring.tick(cursor);
          if (update) {
            this.bytes.set(update.bytes, update.half * this.ring.halfSize);
            if (update.stopped) {
              this.finished = true;
              this.paused = true;
            }
          }
          break;
        }
        case 'stop':
          this.ring.stop();
          this.phase = 0;
          this.paused = true;
          this.started = false;
          this.finished = false;
          break;
        case 'status':
          break;
        case 'dispose':
          this.ring.stop();
          this.closed = true;
          break;
        default:
          throw Error('Unsupported Artemis rolling audio command');
      }
      this.state(id);
    } catch (error) {
      this.failed = true;
      this.ring.stop();
      this.paused = true;
      this.send({
        kind: 'error',
        id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  render(output: Float32Array[]): boolean {
    for (const plane of output) plane.fill(0);
    if (this.closed || this.failed) return false;
    if (this.paused || !this.started || !this.ring.playing) return true;
    const format = this.options.resource.format,
      frames = this.bytes.length / format.blockAlign,
      step = format.sampleRate / this.outputRate,
      count = output[0]?.length ?? 0;
    const sample = (frame: number, channel: number) => {
      const offset =
        (frame % frames) * format.blockAlign +
        (format.channels === 1 ? 0 : channel) * (format.bitsPerSample >> 3);
      return format.bitsPerSample === 8
        ? (this.bytes[offset]! - 128) / 128
        : this.view.getInt16(offset, true) / 32768;
    };
    for (let i = 0; i < count; i++) {
      const frame = Math.floor(this.phase),
        fraction = this.phase - frame;
      for (let channel = 0; channel < Math.min(2, output.length); channel++) {
        const first = sample(frame, channel);
        output[channel]![i] = first + (sample(frame + 1, channel) - first) * fraction;
      }
      this.phase += step;
    }
    this.state();
    return true;
  }
}
