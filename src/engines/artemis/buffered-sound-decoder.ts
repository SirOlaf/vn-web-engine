import type {PcmClip} from '../../audio/pcm.js';
import {IntegerPcmDecoder} from '../../audio/integer-pcm-decoder.js';
import type {SseRounding} from '../../core/sse-integer.js';
import {createArtemisSoundLoader} from './sound-loader.js';
import {ArtemisVorbisPcmDecoder} from './vorbis-pcm-decoder.js';
import {ArtemisVorbisSource} from './vorbis-source.js';
import {ArtemisWaveSource} from './wave-source.js';
import {artemisRevision} from './revision.js';

/** Native buffer=-1: whole source, including paired bytes. Hardware looping
 * repeats the entire cached buffer; B-only resets belong to streaming mode.
 * Progressive buffer0/positive policies require a separate native stream owner.
 */
export function createArtemisBufferedSoundDecoder(
  hash: string,
  readFile: (path: string) => Promise<Uint8Array | null>,
  rounding: SseRounding,
): {decode(file: string, bufferMode: number): Promise<PcmClip | null>; close(): void} {
  artemisRevision(hash);
  const vorbis = new ArtemisVorbisPcmDecoder(hash, rounding),
    pcm = new IntegerPcmDecoder();
  let closed = false;
  const loader = createArtemisSoundLoader<ArtemisWaveSource | ArtemisVorbisSource>(hash, readFile, {
    vorbis: (bytes, _mode, path) =>
      ArtemisVorbisSource.fromBytes(hash, path, bytes, readFile, (data) => vorbis.decode(data)),
    wave: (bytes, _mode, path) => ArtemisWaveSource.fromBytes(hash, path, bytes, readFile),
  });
  return {
    decode: async (file, bufferMode) => {
      if (closed) throw Error('Artemis buffered sound decoder closed');
      if (bufferMode !== -1) throw Error('Unsupported Artemis progressive sound buffer owner');
      const loaded = await loader.load(file, bufferMode);
      if (closed) throw Error('Artemis buffered sound decoder closed during load');
      if (!loaded) return null;
      const source = loaded.sound,
        format = source.format,
        size = source.totalDataSize;
      if (size === 0) return null;
      if (size > 0x7fffffff) throw Error('Unsupported Artemis buffered sound size');
      if (format.bitsPerSample !== 8 && format.bitsPerSample !== 16)
        throw Error('Unsupported Artemis buffered PCM bit depth');
      const data = source.read(size);
      if (data.length !== size) throw Error('Unsupported Artemis truncated buffered sound');
      const clip = await pcm.decode(data, {...format, bitsPerSample: format.bitsPerSample});
      if (closed) throw Error('Artemis buffered sound decoder closed during PCM conversion');
      return clip;
    },
    close: () => {
      if (!closed) {
        closed = true;
        vorbis.close();
        pcm.close();
      }
    },
  };
}
