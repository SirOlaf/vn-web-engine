import type {VorbisPcm} from '../../audio/vorbis-codec.js';
import {sseInt32, type SseRounding} from '../../core/sse-integer.js';
import {artemisRevision} from './revision.js';

/** Rev.3179 ov_read88340: MULSS32768, promote toF64, CVTSD2SI, saturate PCM16.
 * The source owner supplies its rounding mode; no global FPU state is inferred.
 * Planes retain encoded Vorbis order. Output is little-endian interleaved bytes.
 */
export function artemisVorbisPcm16(
  hash: string,
  pcm: VorbisPcm,
  rounding: SseRounding,
): Uint8Array {
  artemisRevision(hash);
  if (
    !Number.isInteger(pcm.frames) ||
    pcm.frames < 0 ||
    pcm.planes.length < 1 ||
    pcm.planes.some((plane) => plane.length !== pcm.frames)
  )
    throw Error('Invalid Artemis Vorbis PCM planes');
  // Validate the rounding selector even for an empty decoder result.
  sseInt32(0, rounding);
  const bytes = new Uint8Array(pcm.frames * pcm.planes.length * 2),
    view = new DataView(bytes.buffer);
  for (let frame = 0; frame < pcm.frames; frame++)
    for (let channel = 0; channel < pcm.planes.length; channel++) {
      const value = sseInt32(Math.fround(pcm.planes[channel]![frame]! * 32768), rounding),
        sample = Math.max(-32768, Math.min(32767, value));
      view.setInt16((frame * pcm.planes.length + channel) * 2, sample, true);
    }
  return bytes;
}
