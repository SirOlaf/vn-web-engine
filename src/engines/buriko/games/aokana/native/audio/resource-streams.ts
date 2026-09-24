import type {AokanaProgramFiles} from '../program-files.js';
import {AokanaAudioArchiveCache} from './archive-cache.js';
import {AokanaArchiveFileStorage} from './archive-storage.js';
import type {AokanaAudioChannels} from './channel-registry.js';
import {AokanaFileStorage} from './file-storage.js';
import type {AokanaLiveAudioStorage} from './live-storage.js';
import {createAokanaLiveOggWaveStream} from './live-ogg-stream.js';
import {AokanaWaveBoxError} from './wavebox-header.js';
import {createAokanaLiveWaveStream} from './wave-stream.js';

/**115280/115310 actual resource admission over the same27CC70/27CCD0 owners. */
export class AokanaAudioResourceStreams {
  constructor(
    readonly channels: AokanaAudioChannels,
    readonly cache: AokanaAudioArchiveCache,
    readonly files: AokanaProgramFiles,
  ) {
    if (cache.channels !== channels || cache.files !== files)
      throw new Error('Aokana audio resource owners must share actual channels and files');
  }
  private validate(index: number, actor: object): number {
    if (this.channels.section.owner !== actor)
      throw new Error('Aokana raw audio resource load requires actual27CC70 admission');
    if ((this.channels.flags & 3) !== 3) return 20;
    return index >>> 0 < this.channels.stream.length ? 0 : 21;
  }
  /** Typed .K handler: active clears; an existing or already-published model stays intact. */
  private nativeFailure(index: number, error: unknown): number {
    if (!(error instanceof AokanaWaveBoxError)) throw error;
    const record = this.channels.stream[index >>> 0];
    if (record === undefined) throw new RangeError('Aokana audio typed catch exceeds registry');
    record.active = 0;
    return error.nativeCode >>> 0;
  }
  private async section<T>(actor: object, operation: () => Promise<T>): Promise<T> {
    await this.channels.section.enter(actor);
    try {
      return await operation();
    } finally {
      //115280/115310 catch-all leaves then rethrows, without translating exceptions.
      this.channels.section.leave(actor);
    }
  }
  loadLoose(
    index: number,
    path: string,
    volume: number,
    pan: number,
    gain: number,
    actor = this.channels.actors.currentActor,
  ): Promise<number> {
    return this.section(actor, () => this.looseRaw(index, path, volume, pan, gain, actor));
  }
  loadArchive(
    index: number,
    path: string,
    member: string,
    volume: number,
    pan: number,
    gain: number,
    actor = this.channels.actors.currentActor,
  ): Promise<number> {
    return this.section(actor, () =>
      this.archiveRaw(index, path, member, volume, pan, gain, actor),
    );
  }
  /**1144F0. */
  private async looseRaw(
    index: number,
    path: string,
    volume: number,
    pan: number,
    gain: number,
    actor: object,
  ): Promise<number> {
    const status = this.validate(index, actor);
    if (status !== 0) return status;
    try {
      const resolved = await this.cache.resolveLoosePath(path, actor);
      const input = new AokanaFileStorage(this.files);
      if (!(await input.open(resolved))) {
        input.dispose();
        throw new AokanaWaveBoxError(12, 'Aokana stream resource could not open loose file');
      }
      return await this.initializeRaw(index, input, volume, pan, gain, actor);
    } catch (error) {
      return this.nativeFailure(index, error);
    }
  }
  /**114360: a present search vector enables the real loose-first attempt. */
  private async archiveRaw(
    index: number,
    path: string,
    member: string,
    volume: number,
    pan: number,
    gain: number,
    actor: object,
  ): Promise<number> {
    const status = this.validate(index, actor);
    if (status !== 0) return status;
    try {
      if (
        this.cache.searchDirectories !== null &&
        (await this.looseRaw(index, member, volume, pan, gain, actor)) === 0
      )
        return 0;
      const found = await this.cache.find(path, member, actor);
      if (found.status !== 0)
        throw new AokanaWaveBoxError(12, 'Aokana stream resource archive lookup failed');
      if (found.archive === undefined)
        throw new Error('Aokana successful audio cache result has no actual archive');
      const input = new AokanaArchiveFileStorage();
      if (!(await input.open(found.archive, member, actor))) {
        input.dispose();
        throw new AokanaWaveBoxError(12, 'Aokana stream resource could not open archive member');
      }
      return await this.initializeRaw(index, input, volume, pan, gain, actor);
    } catch (error) {
      return this.nativeFailure(index, error);
    }
  }
  /**1140A0: selector scratch is not the model's separately initialized second header. */
  private async initializeRaw(
    index: number,
    input: AokanaLiveAudioStorage,
    volume: number,
    pan: number,
    gain: number,
    actor: object,
  ): Promise<number> {
    let inputHandedOff = false;
    try {
      const scratch = new Uint8Array(64),
        initialized = new Uint8Array(64);
      const count =
        (await input.readInto({bytes: scratch, offset: 0}, 64, actor, initialized)) >>> 0;
      if (count < 64)
        throw new AokanaWaveBoxError(14, 'Aokana stream selector read a short header');
      for (let offset = 48; offset < 52; offset++)
        if (initialized[offset] === 0)
          throw new Error('Aokana stream selector reads unwritten codec');
      const codec = new DataView(scratch.buffer).getUint32(48, true);
      if (codec > 3) throw new AokanaWaveBoxError(14, 'Aokana stream selector has unknown codec');
      const prefer24Bit = this.channels.output.prefer24Bit;
      await input.seek(0, actor);
      inputHandedOff = true;
      const wave =
        codec === 3
          ? await createAokanaLiveOggWaveStream(
              input,
              {gain, prefer24Bit},
              () => this.channels.ticks.getTickCount(),
              this.channels.actors,
              actor,
              this.channels.output.offlineContext,
            )
          : await createAokanaLiveWaveStream(
              input,
              codec as 0 | 1 | 2,
              {gain},
              () => this.channels.ticks.getTickCount(),
              this.channels.actors,
              actor,
            );
      const status = await this.channels.publishInitializedStream(index, wave, volume, pan);
      if (status !== 0) throw new AokanaWaveBoxError(22, 'Aokana stream speaker attachment failed');
      return 0;
    } catch (error) {
      if (!inputHandedOff) {
        try {
          await input.dispose();
        } catch {
          /* Preserve original selector failure. */
        }
      }
      return this.nativeFailure(index, error);
    }
  }
}
