import {decodeVorbisFile, VorbisDecodeError} from './vorbis-codec.js';
import type {VorbisDecodeResponse} from './vorbis-decoder.js';

declare const self: {
  onmessage: ((event: MessageEvent<Uint8Array>) => void) | null;
  postMessage(response: VorbisDecodeResponse, transfer?: Transferable[]): void;
};
self.onmessage = async ({data}) => {
  try {
    const pcm = await decodeVorbisFile(data);
    self.postMessage({pcm}, [...new Set(pcm.planes.map((plane) => plane.buffer as ArrayBuffer))]);
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : String(error),
      encodedDataError: error instanceof VorbisDecodeError,
    });
  }
};
