import {wavePcmPlanes} from '../formats/riff/wave.js';
import type {PcmClip} from './pcm.js';

export interface IntegerPcmFormat {
  readonly sampleRate: number;
  readonly channels: number;
  readonly bitsPerSample: 8 | 16;
}
export interface IntegerPcmRequest {
  readonly format: IntegerPcmFormat;
  readonly bytes: Uint8Array;
}
export type IntegerPcmResponse = {readonly clip: PcmClip} | {readonly error: string};

/** Convert actual interleaved integer bytes, without resampling or padding. */
export function integerPcmClip({format, bytes}: IntegerPcmRequest): PcmClip {
  const {sampleRate, channels, bitsPerSample} = format;
  if (
    !Number.isInteger(sampleRate) ||
    sampleRate <= 0 ||
    sampleRate > 0xffffffff ||
    !Number.isInteger(channels) ||
    channels < 1 ||
    channels > 8 ||
    (bitsPerSample !== 8 && bitsPerSample !== 16)
  )
    throw Error('Unsupported integer PCM format');
  const blockAlign = channels * (bitsPerSample >> 3);
  if (bytes.length % blockAlign !== 0) throw Error('Incomplete integer PCM frame');
  const planes = wavePcmPlanes({
    formatTag: 1,
    ...format,
    blockAlign,
    sampleFrames: null,
    data: bytes,
  });
  return {sampleRate, channels: planes, sampleCount: bytes.length / blockAlign};
}
