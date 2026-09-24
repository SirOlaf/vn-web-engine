import type {AokanaBpPointer} from '../../bp/memory.js';
import type {AokanaAudioChannels} from './channel-registry.js';
import {AokanaMemoryAudioStorage} from './memory-storage.js';
import {materializeAokanaLiveOgg} from './live-ogg-stream.js';
import {AokanaWaveStatic, createAokanaLiveWaveStatic} from './wave-static.js';
import {AokanaWaveBoxError, requireAokanaWaveHeaderBytes} from './wavebox-header.js';

/** SSE CVTTSD2SI64 including indefinite, followed by the actual low DWORD consumer. */
function lowConvertedDword(value: number): number {
  if (!Number.isFinite(value) || value < -(2 ** 63) || value >= 2 ** 63) return 0;
  return Number(BigInt.asUintN(32, BigInt(Math.trunc(value))));
}

/** F4D50/115140/114A40: actual encoded-memory registration and persistent metadata. */
export class AokanaAudioStaticResources {
  constructor(readonly channels: AokanaAudioChannels) {}
  private copyBlock(
    source: AokanaBpPointer,
    offset: number,
    target: Uint8Array,
    targetOffset: number,
    targetMask: Uint8Array,
    mask?: Uint8Array,
  ): void {
    const start = source.offset + offset;
    if (
      !Number.isSafeInteger(start) ||
      start < 0 ||
      start + 16 > source.bytes.length ||
      targetOffset + 16 > target.length
    )
      throw new RangeError('Aokana static header copy exceeds actual storage');
    if (mask !== undefined && start + 16 > mask.length)
      throw new RangeError('Aokana static header source mask exceeds backing');
    const bytes = source.bytes.slice(start, start + 16),
      defined = mask?.slice(start, start + 16);
    target.set(bytes, targetOffset);
    if (defined === undefined) targetMask.fill(1, targetOffset, targetOffset + 16);
    else targetMask.set(defined, targetOffset);
  }
  register(
    index: number,
    source: AokanaBpPointer,
    fadeMilliseconds: number,
    gain: number,
    speed: number,
    initialized?: Uint8Array,
    actor = this.channels.actors.currentActor,
  ): Promise<number> {
    index >>>= 0;
    return this.channels.withEngineControl(async (actor) => {
      const offset = index * 64;
      for (let block = 0; block < 64; block += 16)
        this.copyBlock(
          source,
          block,
          this.channels.staticHeaders,
          offset + block,
          this.channels.staticHeadersInitialized,
          initialized,
        );
      new DataView(this.channels.staticHeaders.buffer).setUint32(
        offset + 60,
        lowConvertedDword(65536 / speed),
        true,
      );
      this.channels.staticHeadersInitialized.fill(1, offset + 60, offset + 64);
      await this.channels.section.enter(actor);
      try {
        return await this.registerRaw(
          index,
          source,
          fadeMilliseconds,
          gain,
          speed,
          actor,
          initialized,
        );
      } finally {
        this.channels.section.leave(actor);
      }
    }, actor);
  }
  private async registerRaw(
    index: number,
    source: AokanaBpPointer,
    fade: number,
    gain: number,
    speed: number,
    actor: object,
    initialized?: Uint8Array,
  ): Promise<number> {
    if ((this.channels.flags & 3) !== 3) return 20;
    if (index >= this.channels.static.length) return 21;
    try {
      const header = new Uint8Array(64),
        headerMask = new Uint8Array(64);
      for (let block = 0; block < 64; block += 16)
        this.copyBlock(source, block, header, block, headerMask, initialized);
      requireAokanaWaveHeaderBytes(headerMask, 8, 4);
      requireAokanaWaveHeaderBytes(headerMask, 0, 4);
      const view = new DataView(header.buffer),
        input = new AokanaMemoryAudioStorage(
          (view.getUint32(0, true) + view.getUint32(8, true)) >>> 0,
        );
      input.flags = 3;
      let handedOff = false;
      try {
        input.write(source, input.size, initialized);
        input.seek(0);
        requireAokanaWaveHeaderBytes(headerMask, 48, 4);
        const codec = view.getUint32(48, true);
        if (codec > 3) throw new AokanaWaveBoxError(14, 'Aokana static selector has unknown codec');
        const prefer24Bit = this.channels.output.prefer24Bit;
        let wave: AokanaWaveStatic;
        if (codec === 3) {
          const decoder = await materializeAokanaLiveOgg(
            input,
            {gain, prefer24Bit},
            actor,
            this.channels.output.offlineContext,
          ).catch((error: unknown) => {
            //11BD60 ignores failed native Vorbis open, then consumes invalid state.
            if (error instanceof AokanaWaveBoxError && error.nativeCode === 0x10000000)
              throw new Error('Aokana static Vorbis failed-open native state is unsupported', {
                cause: error,
              });
            throw error;
          });
          const decoded = decoder.readFrameBytes(decoder.sourceFrameCount);
          wave = new AokanaWaveStatic(decoder.header, decoder.outputBits, decoded);
          input.dispose();
          handedOff = true;
        } else {
          handedOff = true;
          wave = await createAokanaLiveWaveStatic(input, codec as 0 | 1 | 2, {gain}, actor);
        }
        const result = await this.channels.publishInitializedStatic(index, wave, fade, speed);
        if (result !== 0) throw new AokanaWaveBoxError(22, 'Aokana static model attachment failed');
        return 0;
      } catch (error) {
        if (!handedOff) {
          try {
            input.dispose();
          } catch {
            /* Preserve primary failure. */
          }
        }
        throw error;
      }
    } catch (error) {
      //14C8DF: unlike stream handlers, this does not clear the record's active field.
      if (error instanceof AokanaWaveBoxError) return error.nativeCode >>> 0;
      throw error;
    }
  }
  /** F5840 reads only persistent metadata published by F4D50. */
  duration(index: number, actor = this.channels.actors.currentActor): Promise<number> {
    return this.channels.withEngineControl(() => {
      const offset = (index >>> 0) * 64;
      if (offset + 64 > this.channels.staticHeaders.length)
        throw new RangeError('Aokana static duration exceeds header backing');
      requireAokanaWaveHeaderBytes(this.channels.staticHeadersInitialized, offset + 16, 4);
      const view = new DataView(this.channels.staticHeaders.buffer),
        rate = view.getUint32(offset + 16, true);
      if (rate === 0) return 0;
      requireAokanaWaveHeaderBytes(this.channels.staticHeadersInitialized, offset + 12, 4);
      requireAokanaWaveHeaderBytes(this.channels.staticHeadersInitialized, offset + 60, 4);
      const duration =
        ((view.getUint32(offset + 12, true) * 1000) / rate) * view.getUint32(offset + 60, true);
      return lowConvertedDword(duration) >>> 16;
    }, actor);
  }
}
