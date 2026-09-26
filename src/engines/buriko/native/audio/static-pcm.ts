export interface BurikoPcmStorage {
  readonly bytes: Uint8Array;
  readonly initialized: Uint8Array;
}
export interface BurikoStaticPcm extends BurikoPcmStorage {
  readonly allocatedFrames: number;
  readonly writtenLength: number;
}
const cvtt32 = (value: number): number => {
  const result = Math.trunc(value);
  return !Number.isFinite(result) || result < -2147483648 || result > 2147483647
    ? -2147483648
    : result;
};
const cvtt64Low32 = (value: number): number => {
  const result = Math.trunc(value);
  return !Number.isFinite(result) || result < -9223372036854775808 || result >= 9223372036854775808
    ? 0
    : Number(BigInt.asUintN(32, BigInt(result)));
};
function requireRange(
  storage: BurikoPcmStorage,
  at: number,
  length: number,
  reading: boolean,
): void {
  if (
    !Number.isSafeInteger(at) ||
    !Number.isSafeInteger(length) ||
    at < 0 ||
    length < 0 ||
    at + length > storage.bytes.length
  ) {
    throw new RangeError('Buriko static sound crosses its native PCM allocation');
  }
  if (reading && storage.initialized.subarray(at, at + length).includes(0)) {
    throw new Error('Buriko static sound reads unwritten native PCM bytes');
  }
}
function copyPcm(
  destination: BurikoPcmStorage,
  output: number,
  source: BurikoPcmStorage,
  input: number,
  length: number,
): void {
  if (length === 0) return;
  requireRange(source, input, length, true);
  requireRange(destination, output, length, false);
  destination.bytes.set(source.bytes.subarray(input, input + length), output);
  destination.initialized.fill(1, output, output + length);
}
function sample(source: BurikoPcmStorage, at: number, bits: 8 | 16 | 24): number {
  const size = bits >>> 3;
  requireRange(source, at, size, true);
  if (bits === 8) return source.bytes[at]!;
  const low = source.bytes[at]! | (source.bytes[at + 1]! << 8);
  return bits === 16 ? (low << 16) >> 16 : ((low | (source.bytes[at + 2]! << 16)) << 8) >> 8;
}
function store(destination: BurikoPcmStorage, at: number, bits: 8 | 16 | 24, value: number): void {
  const size = bits >>> 3;
  requireRange(destination, at, size, false);
  for (let byte = 0; byte < size; byte++)
    destination.bytes[at + byte] = (value >> (byte * 8)) & 255;
  destination.initialized.fill(1, at, at + size);
}

/** 117190/117360/1174d0; native 8-bit crossfades have a different window and source-index rule. */
export function crossfadeBurikoStaticPcm(
  destination: BurikoPcmStorage,
  output: number,
  source: BurikoPcmStorage,
  first: number,
  second: number,
  frames: number,
  sampleRate: number,
  channels: number,
  bits: 8 | 16 | 24,
): void {
  frames >>>= 0;
  sampleRate >>>= 0;
  channels >>>= 0;
  if (channels === 0 && frames !== 0)
    throw new RangeError('Buriko PCM crossfade has no channel progress');
  if (bits === 8) {
    const blended = Math.floor(frames / 10);
    let at = 0;
    while (at < blended) {
      const ratio = at / (frames - 1);
      for (let channel = 0; channel < channels; channel++) {
        const left = sample(source, first + ((channel - blended + at + frames) >>> 0), 8);
        const right = sample(source, second + at + channel, 8);
        store(
          destination,
          output + at + channel,
          8,
          Math.min(255, cvtt32(left * (1 - ratio) + right * ratio)),
        );
      }
      at = (at + channels) >>> 0;
    }
    // The native tail starts at floor(frames/10), even if the preceding channel group crossed it.
    for (at = blended; at < frames; at = (at + channels) >>> 0) {
      for (let channel = 0; channel < channels; channel++)
        copyPcm(destination, output + at + channel, source, second + at + channel, 1);
    }
    return;
  }
  const bytesPerSample = bits >>> 3,
    nominalFrames = cvtt64Low32(sampleRate * 0.005);
  const nominalUnits = Math.imul(nominalFrames, bits === 16 ? channels : channels * 3) >>> 0;
  const totalUnits = Math.imul(frames, bits === 16 ? channels : channels * 3) >>> 0;
  const blendedFrames = totalUnits < nominalUnits ? frames : nominalFrames;
  const scale = bits === 16 ? 32768 : 8388608;
  for (let frame = 0; frame < blendedFrames; frame++) {
    const unit = Math.imul(frame, bits === 16 ? channels : channels * 3) >>> 0;
    const divisor = (nominalUnits - (bits === 16 ? channels : channels * 3)) >>> 0;
    const ratio = unit / divisor;
    for (let channel = 0; channel < channels; channel++) {
      const at = (frame * channels + channel) * bytesPerSample;
      const value = cvtt32(
        sample(source, first + at, bits) * (1 - ratio) + sample(source, second + at, bits) * ratio,
      );
      store(destination, output + at, bits, Math.max(-scale, Math.min(scale - 1, value)));
    }
  }
  const blendedBytes = blendedFrames * channels * bytesPerSample;
  const totalBytes = frames * channels * bytesPerSample;
  if (blendedBytes < totalBytes)
    copyPcm(
      destination,
      output + blendedBytes,
      source,
      second + blendedBytes,
      totalBytes - blendedBytes,
    );
}

/** 117920 buffer sizing and117620's native30ms block skip/repeat with5ms joins. */
export function timeScaleBurikoStaticPcm(
  source: BurikoPcmStorage,
  frameCount: number,
  sampleRate: number,
  channels: number,
  bits: 8 | 16 | 24,
  speed: number,
): BurikoStaticPcm {
  frameCount >>>= 0;
  sampleRate >>>= 0;
  channels >>>= 0;
  const bytesPerFrame = Math.imul(channels, bits >>> 3) >>> 0;
  const sourceBytes = Math.imul(frameCount, bytesPerFrame) >>> 0;
  requireRange(source, 0, sourceBytes, false);
  if (speed === 1)
    return {
      bytes: source.bytes.slice(0, sourceBytes),
      initialized: source.initialized.slice(0, sourceBytes),
      allocatedFrames: frameCount,
      writtenLength: sourceBytes,
    };
  const stepFrames = cvtt64Low32(sampleRate * 0.03);
  if (stepFrames === 0) throw new RangeError('Buriko static sound divides by zero30ms frame count');
  const estimate = cvtt64Low32(frameCount / speed + 0.9);
  const allocatedFrames = (estimate - (estimate % stepFrames) + stepFrames) >>> 0;
  const allocatedBytes = Math.imul(allocatedFrames, bytesPerFrame) >>> 0;
  const destination = {
    bytes: new Uint8Array(allocatedBytes),
    initialized: new Uint8Array(allocatedBytes),
  };
  const chunkBytes = Math.imul(stepFrames, bytesPerFrame) >>> 0;
  const skipBytes = Math.imul(cvtt32(stepFrames * speed - stepFrames), bytesPerFrame);
  let output = 0,
    input = 0;
  while (sourceBytes !== 0 && output < allocatedBytes) {
    const previous = (input - skipBytes) | 0;
    const chunk = Math.min(chunkBytes, (sourceBytes - input) >>> 0);
    const overlap = Math.min(chunk, (sourceBytes - previous) >>> 0);
    if (previous < 0 || previous >= (sourceBytes | 0))
      copyPcm(destination, output, source, input, chunk);
    else {
      if (bytesPerFrame === 0)
        throw new RangeError('Buriko static sound divides by zero PCM frame size');
      crossfadeBurikoStaticPcm(
        destination,
        output,
        source,
        previous,
        input,
        Math.floor(overlap / bytesPerFrame),
        sampleRate,
        channels,
        bits,
      );
      if (overlap < chunk)
        copyPcm(destination, output + overlap, source, input + overlap, chunk - overlap);
    }
    output = (output + chunk) >>> 0;
    const next = (input + chunk + skipBytes) >>> 0;
    if (next === input && output === 0)
      throw new Error('Buriko static sound time scaling makes no native progress');
    input = next;
    if ((previous >= 0 && previous >= (sourceBytes | 0)) || input >= sourceBytes) break;
  }
  return {...destination, allocatedFrames, writtenLength: output};
}
