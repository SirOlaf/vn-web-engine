import {burikoIsoTime as time, type BurikoIsoRational} from './movie-iso-timeline.js';
import type {BurikoMovieAudioSpan} from './movie-audio-samples.js';
import type {
  BurikoMoviePcmCommand,
  BurikoMoviePcmFormat,
  BurikoMoviePcmStatus,
} from './movie-pcm-protocol.js';
interface Retained {
  span: BurikoMovieAudioSpan;
  ordinal: number;
}
const exact = (value: BurikoIsoRational): BurikoIsoRational =>
  time.fraction(value.numerator, value.denominator);
/** Explicit browser movie output profile, shared unchanged by worklet and memory consumers. */
export class BurikoMoviePcmCore {
  private generation = 0;
  private origin = time.fraction(0n);
  private position = time.fraction(0n);
  private through = time.fraction(0n);
  private stop: BurikoIsoRational | null = null;
  private consumed = 0n;
  private retained = 0;
  private ordinal = 0;
  private spans: Retained[] = [];
  private running = false;
  private ended = false;
  private disposed = false;
  private gain = 1;
  readonly format: BurikoMoviePcmFormat;
  constructor(
    format: BurikoMoviePcmFormat,
    readonly outputRate: number,
  ) {
    if (
      (format.channels !== 1 && format.channels !== 2) ||
      !Number.isSafeInteger(format.capacityFrames) ||
      format.capacityFrames < 1 ||
      !Number.isSafeInteger(outputRate) ||
      outputRate < 1
    )
      throw new RangeError('Unsupported movie PCM output format');
    this.format = {...format};
  }
  status(result: BurikoMoviePcmStatus['result'] = 'ok'): BurikoMoviePcmStatus {
    return {
      result,
      generation: this.generation,
      position: {...this.position},
      committedThrough: {...this.through},
      stop: this.stop === null ? null : {...this.stop},
      consumedFrames: this.consumed,
      retainedFrames: this.retained,
      availableFrames: this.format.capacityFrames - this.retained,
      running: this.running,
      ended: this.ended,
    };
  }
  command(command: BurikoMoviePcmCommand): BurikoMoviePcmStatus {
    if (this.disposed) throw new Error('Movie PCM output is disposed');
    if (command.kind === 'status') return this.status();
    if (!Number.isSafeInteger(command.generation) || command.generation < 0)
      throw new RangeError('Invalid movie PCM generation');
    if (command.kind === 'flush') {
      if (command.generation <= this.generation) return this.status('stale');
      const position = exact(command.position);
      this.generation = command.generation;
      this.origin = this.position = this.through = position;
      this.spans = [];
      this.retained = 0;
      this.ordinal = 0;
      this.consumed = 0n;
      this.stop = null;
      this.ended = false;
      this.running = false;
      return this.status();
    }
    if (command.generation !== this.generation) return this.status('stale');
    switch (command.kind) {
      case 'enqueue': {
        const span = command.span,
          start = exact(span.start),
          end = exact(span.end);
        if (
          !Number.isSafeInteger(span.frameCount) ||
          span.frameCount < 1 ||
          !Number.isSafeInteger(span.sampleRate) ||
          span.sampleRate < 1 ||
          !Number.isSafeInteger(span.editIndex) ||
          span.editIndex < 0 ||
          span.planes.length !== this.format.channels ||
          span.planes.some((p) => p.length !== span.frameCount) ||
          time.compare(
            time.subtract(end, start),
            time.fraction(BigInt(span.frameCount), BigInt(span.sampleRate)),
          ) !== 0
        )
          throw new RangeError('Inconsistent movie PCM span');
        if (span.frameCount > this.format.capacityFrames)
          throw new RangeError('Movie PCM whole span exceeds supported retained capacity');
        if (
          time.compare(this.through, this.origin) > 0 &&
          time.compare(start, this.through) < 0 &&
          time.compare(end, this.origin) > 0
        )
          throw new Error('Movie PCM enqueue intersects immutable committed prefix');
        if (span.frameCount > this.format.capacityFrames - this.retained)
          return this.status('would-block');
        this.spans.push({
          span: {...span, start, end, planes: span.planes.map((p) => p.slice())},
          ordinal: this.ordinal++,
        });
        this.retained += span.frameCount;
        break;
      }
      case 'commit': {
        const through = exact(command.through);
        if (time.compare(through, this.through) < 0)
          throw new Error('Movie PCM commitment moves backward');
        this.through = through;
        break;
      }
      case 'end': {
        const stop = exact(command.position);
        if (time.compare(stop, this.position) < 0)
          throw new Error('Movie PCM end precedes current position');
        // The producer asserts complete coverage through stop in this same atomic command.
        if (time.compare(stop, this.through) > 0) this.through = stop;
        this.stop = stop;
        break;
      }
      case 'run':
        this.running = true;
        break;
      case 'pause':
        this.running = false;
        break;
      case 'gain':
        if (!Number.isFinite(command.decibels) || command.decibels < -10000 || command.decibels > 0)
          throw new RangeError('Invalid movie PCM attenuation');
        this.gain = command.decibels === -10000 ? 0 : 10 ** (command.decibels / 2000);
        break;
      case 'dispose':
        this.spans = [];
        this.retained = 0;
        this.running = false;
        this.disposed = true;
        break;
    }
    return this.status();
  }
  render(output: readonly Float32Array[]): BurikoMoviePcmStatus {
    if (output.length !== 2 || output[0]!.length !== output[1]!.length)
      throw new RangeError('Movie PCM output requires two equally sized planes');
    output.forEach((plane) => plane.fill(0));
    if (!this.disposed && this.running && !this.ended) {
      for (let frame = 0; frame < output[0]!.length; frame++) {
        if (this.stop !== null && time.compare(this.position, this.stop) >= 0) {
          this.position = this.stop;
          this.ended = true;
          this.running = false;
          break;
        }
        if (time.compare(this.position, this.through) >= 0) break;
        let chosen: Retained | undefined;
        for (const entry of this.spans) {
          const s = entry.span;
          if (time.compare(this.position, s.start) < 0 || time.compare(this.position, s.end) >= 0)
            continue;
          if (
            chosen === undefined ||
            s.editIndex > chosen.span.editIndex ||
            (s.editIndex === chosen.span.editIndex && entry.ordinal < chosen.ordinal)
          )
            chosen = entry;
        }
        if (chosen !== undefined) {
          const s = chosen.span,
            at = time.scale(time.subtract(this.position, s.start), BigInt(s.sampleRate));
          const index = Number(at.numerator / at.denominator),
            fraction = Number(at.numerator % at.denominator) / Number(at.denominator),
            next = Math.min(index + 1, s.frameCount - 1);
          for (let channel = 0; channel < 2; channel++) {
            const plane = s.planes[this.format.channels === 1 ? 0 : channel]!;
            output[channel]![frame] =
              (plane[index]! + (plane[next]! - plane[index]!) * fraction) * this.gain;
          }
        }
        this.consumed++;
        this.position = time.add(
          this.origin,
          time.fraction(this.consumed, BigInt(this.outputRate)),
        );
        if (this.stop !== null && time.compare(this.position, this.stop) >= 0) {
          this.position = this.stop;
          this.ended = true;
          this.running = false;
          break;
        }
      }
    }
    this.spans = this.spans.filter(({span}) => {
      if (time.compare(span.end, this.position) > 0) return true;
      this.retained -= span.frameCount;
      return false;
    });
    return this.status();
  }
}
