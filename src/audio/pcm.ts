export interface PcmLoop {
  /** Sample indices into the trimmed clip. End is exclusive. */ start: number;
  end: number;
}
export interface PcmClip {
  sampleRate: number;
  channels: Float32Array[];
  sampleCount: number;
  loop?: PcmLoop;
}
/** Integer PCM WAV export, interleaved and explicitly saturated to [-1, 1]. */
export function encodeWav(clip: PcmClip): Uint8Array {
  const {sampleRate, channels, sampleCount} = clip;
  if (
    !Number.isInteger(sampleRate) ||
    sampleRate < 1 ||
    !Number.isInteger(sampleCount) ||
    sampleCount < 1 ||
    channels.length < 1 ||
    channels.length > 8 ||
    channels.some((c) => c.length !== sampleCount)
  )
    throw new Error('Invalid PCM clip');
  const dataSize = sampleCount * channels.length * 2;
  if (dataSize > 0xffffffff - 36) throw new Error('PCM exceeds WAV size limit');
  const bytes = new Uint8Array(44 + dataSize),
    view = new DataView(bytes.buffer);
  function tag(offset: number, name: string): void {
    for (let i = 0; i < 4; i++) bytes[offset + i] = name.charCodeAt(i);
  }
  tag(0, 'RIFF');
  view.setUint32(4, dataSize + 36, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels.length, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels.length * 2, true);
  view.setUint16(32, channels.length * 2, true);
  view.setUint16(34, 16, true);
  tag(36, 'data');
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let i = 0; i < sampleCount; i++)
    for (const channel of channels) {
      const sample = channel[i]!;
      if (!Number.isFinite(sample)) throw new Error('Non-finite PCM sample');
      const v = Math.max(-1, Math.min(1, sample));
      view.setInt16(offset, Math.round(v < 0 ? v * 32768 : v * 32767), true);
      offset += 2;
    }
  return bytes;
}
