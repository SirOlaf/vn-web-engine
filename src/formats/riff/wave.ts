import {byteDataView, checkRange} from '../../core/binary.js';

export const WAVE_FORMAT_PCM = 1;
/** Vorbis ACM codec tags ("Og"/"Pg"/"Qg"/"og"/"pg"/"qg"). */
export const WAVE_FORMAT_VORBIS_ACM = [0x674f, 0x6750, 0x6751, 0x676f, 0x6770, 0x6771] as const;

export interface WaveFile {
  readonly formatTag: number;
  readonly channels: number;
  readonly sampleRate: number;
  readonly blockAlign: number;
  readonly bitsPerSample: number;
  /** The `fact` chunk's frame count, when present. */
  readonly sampleFrames: number | null;
  readonly data: Uint8Array;
}

function tag(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + 4));
}

/** Minimal RIFF WAVE reader: first `fmt `, optional `fact`, first `data`. */
export function parseWave(bytes: Uint8Array): WaveFile {
  if (bytes.length < 12 || tag(bytes, 0) !== 'RIFF' || tag(bytes, 8) !== 'WAVE')
    throw new Error('Not a RIFF WAVE file');
  const view = byteDataView(bytes);
  const riffEnd = Math.min(bytes.length, 8 + view.getUint32(4, true));
  let format: Omit<WaveFile, 'sampleFrames' | 'data'> | undefined;
  let sampleFrames: number | null = null;
  let data: Uint8Array | undefined;
  for (let cursor = 12; cursor + 8 <= riffEnd;) {
    const id = tag(bytes, cursor);
    const size = view.getUint32(cursor + 4, true);
    const body = cursor + 8;
    if (id === 'data') {
      // Some encoders leave the data size unfinalized; clamp only an overlong final chunk.
      data = bytes.subarray(body, Math.min(riffEnd, body + size));
      break;
    }
    checkRange(riffEnd, body, size);
    if (id === 'fmt ' && !format) {
      if (size < 16) throw new Error('Truncated WAVE format chunk');
      format = {
        formatTag: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        blockAlign: view.getUint16(body + 12, true),
        bitsPerSample: view.getUint16(body + 14, true),
      };
    } else if (id === 'fact' && size >= 4) sampleFrames = view.getUint32(body, true);
    cursor = body + size + (size & 1);
  }
  if (!format) throw new Error('WAVE file has no format chunk');
  if (!data) throw new Error('WAVE file has no data chunk');
  if (!format.channels || !format.sampleRate) throw new Error('Invalid WAVE format');
  return {...format, sampleFrames, data};
}

function isOggPage(d: Uint8Array, offset: number): boolean {
  return (
    offset + 27 <= d.length &&
    d[offset] === 0x4f &&
    d[offset + 1] === 0x67 &&
    d[offset + 2] === 0x67 &&
    d[offset + 3] === 0x53
  );
}

/**
 * Returns the embedded Ogg stream of a Vorbis ACM WAVE whose data keeps Ogg framing. The
 * ACM encoder interleaves empty pages of a second logical stream and may pad the chunk,
 * so only the pages of the first logical stream are kept.
 */
export function waveOggStream(wave: WaveFile): Uint8Array | null {
  if (!(WAVE_FORMAT_VORBIS_ACM as readonly number[]).includes(wave.formatTag)) return null;
  const d = wave.data;
  if (!isOggPage(d, 0)) return null;
  const view = byteDataView(d);
  const serial = view.getUint32(14, true);
  const pages: [number, number][] = [];
  let kept = 0,
    offset = 0;
  while (isOggPage(d, offset)) {
    const segments = d[offset + 26]!;
    let size = 27 + segments;
    if (offset + size > d.length) break;
    for (let i = 0; i < segments; i++) size += d[offset + 27 + i]!;
    if (offset + size > d.length) break;
    if (view.getUint32(offset + 14, true) === serial) {
      pages.push([offset, size]);
      kept += size;
    }
    offset += size;
  }
  if (kept === d.length) return d;
  const stream = new Uint8Array(kept);
  let cursor = 0;
  for (const [start, size] of pages) {
    stream.set(d.subarray(start, start + size), cursor);
    cursor += size;
  }
  return stream;
}

/** Converts integer PCM WAVE data to planar floats. */
export function wavePcmPlanes(wave: WaveFile): Float32Array[] {
  if (wave.formatTag !== WAVE_FORMAT_PCM) throw new Error('WAVE data is not integer PCM');
  const {channels, bitsPerSample} = wave;
  if (bitsPerSample !== 8 && bitsPerSample !== 16)
    throw new Error(`Unsupported PCM sample size ${bitsPerSample}`);
  const bytesPerSample = bitsPerSample / 8;
  const frames = Math.floor(wave.data.length / (bytesPerSample * channels));
  const planes = Array.from({length: channels}, () => new Float32Array(frames));
  const view = byteDataView(wave.data);
  for (let frame = 0; frame < frames; frame++)
    for (let channel = 0; channel < channels; channel++) {
      const offset = (frame * channels + channel) * bytesPerSample;
      planes[channel]![frame] =
        bytesPerSample === 1
          ? (wave.data[offset]! - 128) / 128
          : view.getInt16(offset, true) / 32768;
    }
  return planes;
}
