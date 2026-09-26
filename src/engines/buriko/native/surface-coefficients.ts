import {nativeWaveSineRadians} from '../bp/opcodes/native-math.js';

export type BurikoSurfaceCoefficientStatus = 0 | 0x10 | 0x11 | 0x12;

export interface BurikoSurfaceCoefficientQuery {
  readonly status: 0 | 0x10 | 0x11;
  readonly available: 0 | 1 | null;
}

export interface BurikoSurfaceCoefficientRecord {
  readonly active: 0 | 1;
  readonly initial: number;
  readonly lower: number;
  readonly span: number;
  readonly end: number;
  readonly coefficients: Uint32Array | null;
}

interface MutableCoefficientRecord {
  active: 0 | 1;
  initial: number;
  lower: number;
  span: number;
  end: number;
  coefficients: Uint32Array | null;
}

function signedWord(value: number): number {
  return (value << 16) >> 16;
}

function truncateInt32(value: number): number {
  if (!Number.isFinite(value) || value < -0x80000000 || value >= 0x80000000) return -0x80000000;
  return Math.trunc(value) | 0;
}

function duplicateLowWord(value: number): number {
  const word = value & 0xffff;
  return (word | (word << 16)) >>> 0;
}

function rotateLeftOne(value: number): number {
  value >>>= 0;
  return (value << 1) | (value >>> 31) | 0;
}

/** The eight native 32-byte records at CSurfaceManager +28..+127. */
export class BurikoSurfaceCoefficientTables {
  readonly capacity = 8;
  private readonly records: MutableCoefficientRecord[] = Array.from(
    {length: this.capacity},
    () => ({
      active: 0,
      initial: 0,
      lower: 0,
      span: 0,
      end: 0,
      coefficients: null,
    }),
  );

  snapshot(index: number): BurikoSurfaceCoefficientRecord | null {
    const record = this.record(index);
    return record === null
      ? null
      : {
          active: record.active,
          initial: record.initial,
          lower: record.lower,
          span: record.span,
          end: record.end,
          coefficients: record.coefficients?.slice() ?? null,
        };
  }

  /** 03E660 retains DWORD arithmetic and its lower+span result for an exact wrap. */
  query(index: number, offset: number, count: number): BurikoSurfaceCoefficientQuery {
    const record = this.record(index);
    if (record === null) return {status: 0x10, available: null};
    if (record.active === 0) return {status: 0x11, available: null};
    const start = this.start(record, offset);
    return {
      status: 0,
      available: Math.imul(count, 4) >>> 0 <= (record.end - start) >>> 0 ? 1 : 0,
    };
  }

  /** 03E6E0 returns 12 when the queried range is unavailable, then expands count*4 words. */
  expand(
    destination: Uint32Array | null,
    index: number,
    offset: number,
    amplitude: number,
    count: number,
  ): BurikoSurfaceCoefficientStatus {
    const query = this.query(index, offset, count);
    if (query.status !== 0) return query.status;
    if (query.available === 0) return 0x12;
    // Unlike the native write-through, the browser host rejects a null output safely.
    if (destination === null)
      throw new Error('Buriko surface coefficient expansion writes through a null output');
    const record = this.records[index >>> 0]!,
      coefficients = record.coefficients;
    if (coefficients === null)
      throw new Error('Buriko active surface coefficient record has no native backing');
    const length = Math.imul(count, 4) >>> 0;
    if (destination.length < length)
      throw new RangeError('Buriko surface coefficient output is smaller than its native count');
    const start = this.start(record, offset);
    for (let output = 0; output < length; output++) {
      const coefficient = coefficients[(start + output) >>> 0];
      if (coefficient === undefined)
        throw new RangeError('Buriko surface coefficient expansion reads outside native backing');
      const product = Math.imul(signedWord(coefficient), amplitude | 0) >>> 8;
      destination[output] = duplicateLowWord(product);
    }
    return 0;
  }

  /** 03EAE0 places one sine period before each span's trailing zero periods. */
  configureRipple(
    index: number,
    quarterPeriod: number,
    amplitude: number,
    spacing: number,
    repetitions: number,
  ): 0 | 0x10 {
    const record = this.record(index);
    if (record === null) return 0x10;
    const period = ((quarterPeriod >>> 0 || 1) * 4) >>> 0,
      span = Math.imul(period, spacing >>> 0 || 1) >>> 0,
      end = Math.imul(span, repetitions >>> 0 || 1) >>> 0;
    const coefficients = this.replace(record, span, end);
    let output = 0;
    for (let repetition = repetitions >>> 0 || 1; repetition !== 0; repetition--) {
      output = this.writeSine(coefficients, output, period, amplitude, 1);
      output = this.skip(coefficients, output, (span - period) >>> 0);
    }
    return 0;
  }

  /** 03E7D0 places leading zero spans before a faded-in/full/faded-out sine envelope. */
  configureRippleEnvelope(
    index: number,
    quarterPeriod: number,
    amplitude: number,
    fadeInPeriods: number,
    fadeOutPeriods: number,
    spacing: number,
    repetitions: number,
  ): 0 | 0x10 {
    const record = this.record(index);
    if (record === null) return 0x10;
    const period = ((quarterPeriod >>> 0 || 1) * 4) >>> 0,
      envelopePeriods = (fadeInPeriods + 1 + fadeOutPeriods) >>> 0,
      envelopeLength = Math.imul(envelopePeriods, period) >>> 0,
      span = Math.imul(envelopeLength, spacing >>> 0 || 1) >>> 0,
      end = Math.imul(span, repetitions >>> 0 || 1) >>> 0;
    const coefficients = this.replace(record, span, end);
    let output = 0;
    for (let repetition = repetitions >>> 0 || 1; repetition !== 0; repetition--) {
      output = this.skip(coefficients, output, (span - envelopeLength) >>> 0);
      for (let level = 0; level < fadeInPeriods >>> 0; level++) {
        const divisor = 1 << ((fadeInPeriods - level) & 31);
        output = this.writeSine(coefficients, output, period, amplitude, divisor);
      }
      output = this.writeSine(coefficients, output, period, amplitude, 1);
      let divisor = 1;
      for (let level = 0; level < fadeOutPeriods >>> 0; level++) {
        divisor = rotateLeftOne(divisor);
        output = this.writeSine(coefficients, output, period, amplitude, divisor);
      }
    }
    return 0;
  }

  /** 03ECA0 frees and zeroes every active record during surface-manager teardown. */
  clear(): void {
    for (const record of this.records) {
      if (record.active === 0) continue;
      record.active = 0;
      record.initial = 0;
      record.lower = 0;
      record.span = 0;
      record.end = 0;
      record.coefficients = null;
    }
  }

  private record(index: number): MutableCoefficientRecord | null {
    return index >>> 0 < this.capacity ? this.records[index >>> 0]! : null;
  }

  private start(record: MutableCoefficientRecord, offset: number): number {
    let start = (record.initial - Math.imul(offset, 4)) | 0;
    if (start < (record.lower | 0)) {
      const distance = (record.lower - start) >>> 0;
      if (record.span === 0)
        throw new RangeError('Buriko surface coefficient wrapping divides by a zero span');
      start = (record.lower + record.span - (distance % record.span)) | 0;
    }
    return start;
  }

  private replace(record: MutableCoefficientRecord, span: number, end: number): Uint32Array {
    // Native replacement releases the old allocation before publishing the new fields/allocation.
    if (record.active !== 0) record.coefficients = null;
    record.active = 1;
    record.initial = 0;
    record.lower = 0;
    record.span = span >>> 0;
    record.end = end >>> 0;
    const coefficients = new Uint32Array(record.end);
    record.coefficients = coefficients;
    return coefficients;
  }

  private writeSine(
    coefficients: Uint32Array,
    output: number,
    period: number,
    amplitude: number,
    divisor: number,
  ): number {
    for (let phase = 0; phase < period; phase++) {
      if (output >= coefficients.length)
        throw new RangeError('Buriko ripple producer writes outside its native backing');
      const radians = (phase * 6.283185307179586) / period;
      coefficients[output++] = duplicateLowWord(
        truncateInt32((nativeWaveSineRadians(radians) * (amplitude >>> 0)) / divisor),
      );
    }
    return output;
  }

  private skip(coefficients: Uint32Array, output: number, count: number): number {
    const next = output + count;
    if (!Number.isSafeInteger(next) || next > coefficients.length)
      throw new RangeError('Buriko ripple padding writes outside its native backing');
    return next;
  }
}
