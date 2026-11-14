import {loadVorbisDecoder} from '../../audio/vorbis-codec.js';
import {
  ArtemisVorbisPcmChunks,
  type ArtemisVorbisStreamInput,
  type ArtemisVorbisStreamOutput,
} from './vorbis-pcm-stream.js';

declare const self: {
  onmessage: ((event: MessageEvent<ArtemisVorbisStreamInput>) => void) | null;
  postMessage(message: ArtemisVorbisStreamOutput, transfer?: Transferable[]): void;
};
// One stream at a time; the host reuses an idle worker for the next stream after `done` or
// `error`. Pushes run in order: each waits for the decode of the previous one.
let stream: ArtemisVorbisPcmChunks | undefined,
  queue = Promise.resolve();
self.onmessage = ({data}) => {
  if (data.kind === 'warm') {
    queue = queue.then(() => loadVorbisDecoder().catch(() => {}));
    return;
  }
  if (data.kind === 'open') {
    stream?.close();
    stream = new ArtemisVorbisPcmChunks(data.options, (output) =>
      self.postMessage(output, output.kind === 'pcm' ? [output.bytes.buffer as ArrayBuffer] : []),
    );
    return;
  }
  const current = stream!;
  queue = queue.then(() => current.push(data.bytes, data.last));
};
