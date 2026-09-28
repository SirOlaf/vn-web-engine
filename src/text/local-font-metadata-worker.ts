import {BlobSource, type ByteSource} from '../core/source.js';
import {readSfntFontMetadata, type SfntFontMetadata} from '../formats/sfnt.js';

export interface LocalFontMetadataRequest {
  readonly id: number;
  readonly blob: Blob;
}

/** `faces` is null when the font cannot be read or parsed; `bytes` counts table bytes read. */
export interface LocalFontMetadataResponse {
  readonly id: number;
  readonly faces: readonly SfntFontMetadata[] | null;
  readonly bytes: number;
}

const worker = globalThis as unknown as {
  onmessage: ((event: MessageEvent<LocalFontMetadataRequest>) => void) | null;
  postMessage(message: LocalFontMetadataResponse): void;
};

worker.onmessage = async ({data: {id, blob}}) => {
  const blobSource = new BlobSource(blob);
  let bytes = 0;
  const source: ByteSource = {
    size: blobSource.size,
    async read(offset, length, signal) {
      const read = await blobSource.read(offset, length, signal);
      bytes += read.length;
      return read;
    },
  };
  let faces: readonly SfntFontMetadata[] | null = null;
  try {
    faces = await readSfntFontMetadata(source);
  } catch {
    // Unreadable or invalid installed faces are unavailable to the host.
  }
  worker.postMessage({id, faces, bytes});
};
