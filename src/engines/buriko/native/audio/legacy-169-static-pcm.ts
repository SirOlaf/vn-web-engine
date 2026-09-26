import type {BurikoPcmStorage} from './static-pcm.js';

/** 472880: one extra75ms block after rounding ceil(sourceFrames/2) down to a block. */
export function burikoLegacy169AcceleratedFrames(frames: number, sampleRate: number): number {
  const step = Math.trunc((sampleRate >>> 0) * 0.075) >>> 0;
  if (step === 0) throw new RangeError('Buriko 1.69 sound divides by zero75ms frame count');
  const half = ((frames >>> 1) + (frames & 1)) >>> 0;
  return Math.imul(Math.floor(half / step) + 1, step) >>> 0;
}

/** 472970 copies alternate75ms blocks, without crossfading or initializing the unused tail. */
export function accelerateBurikoLegacy169StaticPcm(
  source: BurikoPcmStorage,
  frames: number,
  sampleRate: number,
  frameBytes: number,
): BurikoPcmStorage {
  const length = Math.imul(frames, frameBytes) >>> 0,
    capacity = Math.imul(burikoLegacy169AcceleratedFrames(frames, sampleRate), frameBytes) >>> 0,
    step = Math.imul(Math.trunc((sampleRate >>> 0) * 0.075), frameBytes) >>> 0;
  if (length > source.bytes.length || length > source.initialized.length)
    throw new RangeError('Buriko 1.69 sound reads beyond its source allocation');
  const bytes = new Uint8Array(capacity),
    initialized = new Uint8Array(capacity);
  let output = 0,
    copy = true;
  if (length !== 0 && step === 0)
    throw new RangeError('Buriko 1.69 accelerated sound has no native byte progress');
  for (let input = 0; input < length; input = (input + step) >>> 0, copy = !copy) {
    if (!copy) continue;
    const count = Math.min(step, length - input);
    if (output + count > capacity)
      throw new RangeError('Buriko 1.69 accelerated sound exceeds its native allocation');
    bytes.set(source.bytes.subarray(input, input + count), output);
    initialized.set(source.initialized.subarray(input, input + count), output);
    output = (output + step) >>> 0;
  }
  return {bytes, initialized};
}
