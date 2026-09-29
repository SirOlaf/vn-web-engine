import {decodeVorbisChunks, VorbisDecodeError} from './vorbis-codec.js';
import type {VorbisStreamMessage, VorbisStreamRequest} from './vorbis-decoder.js';

declare const self: {
  onmessage: ((event: MessageEvent<VorbisStreamRequest>) => void) | null;
  postMessage(message: VorbisStreamMessage, transfer?: Transferable[]): void;
};
// One stream at a time; the host reuses an idle worker for the next stream.
self.onmessage = async ({data: {bytes, firstFrames, chunkFrames}}) => {
  try {
    const summary = await decodeVorbisChunks(bytes, firstFrames, chunkFrames, {
      onOpen: (open) => self.postMessage({kind: 'open', open}),
      onChunk: (planes, frames) =>
        self.postMessage({kind: 'chunk', planes, frames}, [
          ...new Set(planes.map((plane) => plane.buffer as ArrayBuffer)),
        ]),
    });
    self.postMessage({kind: 'done', summary});
  } catch (error) {
    self.postMessage({
      kind: 'error',
      error: error instanceof Error ? error.message : String(error),
      encodedDataError: error instanceof VorbisDecodeError,
    });
  }
};
