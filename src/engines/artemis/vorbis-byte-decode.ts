import {decodeVorbisFile, VorbisDecodeError} from '../../audio/vorbis-codec.js';
import type {SseRounding} from '../../core/sse-integer.js';
import type {ArtemisVorbisBytes} from './vorbis-source.js';
import {artemisVorbisPcm16} from './vorbis-pcm.js';
import {artemisRevision} from './revision.js';

export interface ArtemisVorbisRequest {
  readonly hash: string;
  readonly rounding: SseRounding;
  readonly bytes: Uint8Array;
}
export type ArtemisVorbisResponse =
  {readonly pcm: ArtemisVorbisBytes | null} | {readonly error: string};

/** Shared libvorbis decoding and native PCM16 conversion; runs inside a worker. */
export async function decodeArtemisVorbisBytes(
  request: ArtemisVorbisRequest,
): Promise<ArtemisVorbisBytes | null> {
  const revision = artemisRevision(request.hash);
  try {
    const pcm = await decodeVorbisFile(request.bytes, {
      firstPageSearchBoundary: revision.vorbisHeaderSyncBoundary ?? undefined,
    });
    return {
      sampleRate: pcm.sampleRate,
      channels: pcm.planes.length,
      bytes: artemisVorbisPcm16(request.hash, pcm, request.rounding),
    };
  } catch (error) {
    if (error instanceof VorbisDecodeError) return null;
    throw error;
  }
}
