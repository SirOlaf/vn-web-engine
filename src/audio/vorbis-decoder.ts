import {decodeVorbisFile, VorbisDecodeError, type VorbisPcm} from './vorbis-codec.js';
export {VorbisDecodeError};
export type {VorbisPcm};

export type VorbisDecodeResponse = {pcm: VorbisPcm} | {error: string; encodedDataError: boolean};

/** Each job owns a decoder worker; no browser codec, device sample rate or audio graph. */
export async function decodeVorbis(bytes: Uint8Array): Promise<VorbisPcm> {
  if (typeof Worker === 'undefined') return decodeVorbisFile(bytes);
  const worker = new Worker(new URL('./vorbis-worker.js', import.meta.url), {type: 'module'});
  try {
    return await new Promise<VorbisPcm>((resolve, reject) => {
      worker.onerror = (event) => {
        event.preventDefault();
        reject(new Error(event.message || 'Vorbis decoder worker failed'));
      };
      worker.onmessageerror = () =>
        reject(new Error('Vorbis decoder result could not be transferred'));
      worker.onmessage = ({data}: MessageEvent<VorbisDecodeResponse>) => {
        if ('pcm' in data) resolve(data.pcm);
        else
          reject(data.encodedDataError ? new VorbisDecodeError(data.error) : new Error(data.error));
      };
      // Keep the caller's encoded bytes intact, as with other asynchronous decoders.
      const input = bytes.slice();
      worker.postMessage(input, [input.buffer]);
    });
  } finally {
    worker.terminate();
  }
}
