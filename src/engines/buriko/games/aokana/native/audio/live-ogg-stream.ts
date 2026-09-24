import type {AokanaLockActors} from '../exclusion-locks.js';
import type {AokanaLiveAudioStorage} from './live-storage.js';
import {AokanaWaveBoxError, requireAokanaWaveHeaderBytes} from './wavebox-header.js';
import {AokanaWaveBoxOggDecoder, createAokanaWaveBoxOggDecoder} from './wavebox-ogg.js';
import {AokanaWaveStream} from './wave-stream.js';

/** Selected browser Vorbis profile: PCM is materialized, actual input ownership is retained. */
class OwnedBrowserOggDecoder extends AokanaWaveBoxOggDecoder {
  constructor(
    decoder: AokanaWaveBoxOggDecoder,
    private readonly input: AokanaLiveAudioStorage,
  ) {
    super(decoder.header, decoder.links, decoder.outputBits, decoder.gain);
  }
  override readFrameBytes(
    count: number,
    _actor?: object,
    publish?: (bytes: Uint8Array) => void,
  ): Uint8Array {
    const bytes = super.readFrameBytes(count);
    if (publish === undefined) return bytes;
    publish(bytes);
    return new Uint8Array(0);
  }
  dispose(): void | Promise<void> {
    return this.input.dispose();
  }
}

/**118940 header order with explicit complete-link browser decoding, not native callback timing. */
export async function createAokanaLiveOggWaveStream(
  input: AokanaLiveAudioStorage,
  options: {readonly gain: number; readonly prefer24Bit: boolean},
  rawMilliseconds: () => number,
  actors: AokanaLockActors,
  actor: object,
  Context?: typeof OfflineAudioContext,
): Promise<AokanaWaveStream> {
  let stream: AokanaWaveStream | undefined;
  try {
    const decoded = await materializeAokanaLiveOgg(input, options, actor, Context);
    const decoder = new OwnedBrowserOggDecoder(decoded, input);
    stream = new AokanaWaveStream(decoder, rawMilliseconds, actors);
    await stream.initialize(actor);
    return stream;
  } catch (error) {
    try {
      await (stream === undefined ? input.dispose() : stream.dispose());
    } catch {
      // Preserve the actual typed codec or explicit platform/storage failure.
    }
    throw error;
  }
}

/** Actual second header/payload reads. Caller retains input cleanup ownership. */
export async function materializeAokanaLiveOgg(
  input: AokanaLiveAudioStorage,
  options: {readonly gain: number; readonly prefer24Bit: boolean},
  actor: object,
  Context?: typeof OfflineAudioContext,
): Promise<AokanaWaveBoxOggDecoder> {
  if (input.size >>> 0 < 64)
    throw new AokanaWaveBoxError(0x10000003, 'Aokana Ogg input is shorter than model header');
  const header = new Uint8Array(64),
    headerMask = new Uint8Array(64).fill(1);
  await input.readInto({bytes: header, offset: 0}, 64, actor, headerMask);
  const view = new DataView(header.buffer);
  requireAokanaWaveHeaderBytes(headerMask, 4, 4);
  if (view.getUint32(4, true) !== 0x20207762)
    throw new AokanaWaveBoxError(0x11000001, 'Aokana Ogg bw marker does not match');
  requireAokanaWaveHeaderBytes(headerMask, 48, 4);
  if (view.getUint32(48, true) !== 3)
    throw new AokanaWaveBoxError(0x11000004, 'Aokana Ogg model rejects selected codec');
  requireAokanaWaveHeaderBytes(headerMask, 0, 64);
  // Native Vorbis origin is physical64, independently of resetDataOffset.
  await input.seek(64, actor);
  const length = (input.size - 64) >>> 0;
  const payload = new Uint8Array(length),
    mask = new Uint8Array(length);
  const transferred =
    (await input.readInto({bytes: payload, offset: 0}, length, actor, mask)) >>> 0;
  if (transferred > length)
    throw new RangeError('Aokana browser Vorbis read count exceeds actual payload storage');
  for (let index = 0; index < transferred; index++)
    if (mask[index] === 0) throw new Error('Aokana browser Vorbis consumes unwritten input');
  const bytes = new Uint8Array(64 + transferred);
  bytes.set(header);
  bytes.set(payload.subarray(0, transferred), 64);
  return createAokanaWaveBoxOggDecoder(bytes, options, Context);
}
