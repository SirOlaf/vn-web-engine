import type {BurikoLockActors} from '../exclusion-locks.js';
import type {BurikoLiveAudioStorage} from './live-storage.js';
import {BurikoWaveBoxError, requireBurikoWaveHeaderBytes} from './wavebox-header.js';
import {
  BurikoWaveBoxOggDecoder,
  createBurikoWaveBoxOggDecoder,
  type BurikoWaveBoxOggOptions,
} from './wavebox-ogg.js';
import {BurikoWaveStream} from './wave-stream.js';

/** Selected browser Vorbis profile: PCM is materialized, actual input ownership is retained. */
class OwnedBrowserOggDecoder extends BurikoWaveBoxOggDecoder {
  constructor(
    decoder: BurikoWaveBoxOggDecoder,
    private readonly input: BurikoLiveAudioStorage,
  ) {
    super(decoder.header, decoder.links, decoder.outputBits, decoder.gain, decoder.abi);
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
export async function createBurikoLiveOggWaveStream(
  input: BurikoLiveAudioStorage,
  options: BurikoWaveBoxOggOptions,
  rawMilliseconds: () => number,
  actors: BurikoLockActors,
  actor: object,
  Context?: typeof OfflineAudioContext,
): Promise<BurikoWaveStream> {
  let stream: BurikoWaveStream | undefined;
  try {
    const decoded = await materializeBurikoLiveOgg(input, options, actor, Context);
    const decoder = new OwnedBrowserOggDecoder(decoded, input);
    stream = new BurikoWaveStream(decoder, rawMilliseconds, actors, options.abi);
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
export async function materializeBurikoLiveOgg(
  input: BurikoLiveAudioStorage,
  options: BurikoWaveBoxOggOptions,
  actor: object,
  Context?: typeof OfflineAudioContext,
): Promise<BurikoWaveBoxOggDecoder> {
  if (input.size >>> 0 < 64)
    throw new BurikoWaveBoxError(0x10000003, 'Buriko Ogg input is shorter than model header');
  const header = new Uint8Array(64),
    headerMask = new Uint8Array(64).fill(1);
  await input.readInto({bytes: header, offset: 0}, 64, actor, headerMask);
  const view = new DataView(header.buffer);
  requireBurikoWaveHeaderBytes(headerMask, 4, 4);
  if (view.getUint32(4, true) !== 0x20207762)
    throw new BurikoWaveBoxError(0x11000001, 'Buriko Ogg bw marker does not match');
  requireBurikoWaveHeaderBytes(headerMask, 48, 4);
  if (view.getUint32(48, true) !== 3)
    throw new BurikoWaveBoxError(0x11000004, 'Buriko Ogg model rejects selected codec');
  requireBurikoWaveHeaderBytes(headerMask, 0, 64);
  // Native Vorbis origin is physical64, independently of resetDataOffset.
  await input.seek(64, actor);
  const length = (input.size - 64) >>> 0;
  const payload = new Uint8Array(length),
    mask = new Uint8Array(length);
  const transferred =
    (await input.readInto({bytes: payload, offset: 0}, length, actor, mask)) >>> 0;
  if (transferred > length)
    throw new RangeError('Buriko browser Vorbis read count exceeds actual payload storage');
  for (let index = 0; index < transferred; index++)
    if (mask[index] === 0) throw new Error('Buriko browser Vorbis consumes unwritten input');
  const bytes = new Uint8Array(64 + transferred);
  bytes.set(header);
  bytes.set(payload.subarray(0, transferred), 64);
  return createBurikoWaveBoxOggDecoder(bytes, options, Context);
}
