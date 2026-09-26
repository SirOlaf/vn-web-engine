import {BURIKO_BP_ABI_172, type BurikoBpAbi} from '../../bp/abi.js';
import type {BurikoProgramFiles} from '../program-files.js';
import {BurikoAudioArchiveCache} from './archive-cache.js';
import {BurikoArchiveFileStorage} from './archive-storage.js';
import type {BurikoAudioChannels} from './channel-registry.js';
import {BurikoFileStorage} from './file-storage.js';
import {BurikoLegacy169ArchiveFileStorage} from './legacy-169-archive-storage.js';
import type {BurikoLiveAudioStorage} from './live-storage.js';
import {createBurikoLiveOggWaveStream} from './live-ogg-stream.js';
import {createBurikoLiveOggExchangeWaveStream} from './ogg-exchange-stream.js';
import {BurikoWaveBoxError} from './wavebox-header.js';
import {createBurikoLiveWaveStream} from './wave-stream.js';
import {audioPathTerminated} from './wide-path.js';

/**115280/115310 actual resource admission over the same27CC70/27CCD0 owners. */
export class BurikoAudioResourceStreams {
  constructor(
    readonly channels: BurikoAudioChannels,
    readonly cache: BurikoAudioArchiveCache,
    readonly files: BurikoProgramFiles,
    readonly abi: BurikoBpAbi = BURIKO_BP_ABI_172,
  ) {
    if (cache.channels !== channels || cache.files !== files)
      throw new Error('Buriko audio resource owners must share actual channels and files');
  }
  private validate(index: number, actor: object): number {
    if (this.channels.section.owner !== actor)
      throw new Error('Buriko raw audio resource load requires actual27CC70 admission');
    if ((this.channels.flags & 3) !== 3) return 20;
    return index >>> 0 < this.channels.stream.length ? 0 : 21;
  }
  /** Typed .K handler: active clears; an existing or already-published model stays intact. */
  private nativeFailure(index: number, error: unknown): number {
    if (!(error instanceof BurikoWaveBoxError)) throw error;
    const record = this.channels.stream[index >>> 0];
    if (record === undefined) throw new RangeError('Buriko audio typed catch exceeds registry');
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
  /**1153B0: two wide loose names share one model only when they compare equal. */
  loadPairLoose(
    index: number,
    pathA: string,
    pathB: string,
    rawMode: number,
    volume: number,
    pan: number,
    gain: number,
    actor = this.channels.actors.currentActor,
  ): Promise<number> {
    return this.section(actor, () =>
      this.pairLooseRaw(index, pathA, pathB, rawMode, volume, pan, gain, actor),
    );
  }
  /**115450: the same cached DCArchive owns both independent member cursors. */
  loadPairArchive(
    index: number,
    path: string,
    memberA: string,
    memberB: string,
    rawMode: number,
    volume: number,
    pan: number,
    gain: number,
    actor = this.channels.actors.currentActor,
  ): Promise<number> {
    return this.section(actor, () =>
      this.pairArchiveRaw(index, path, memberA, memberB, rawMode, volume, pan, gain, actor),
    );
  }
  private async publishPair(
    index: number,
    first: BurikoLiveAudioStorage,
    second: BurikoLiveAudioStorage | undefined,
    rawMode: number,
    volume: number,
    pan: number,
    gain: number,
    actor: object,
  ): Promise<number> {
    if (second === undefined)
      return this.initializeRaw(index, first, volume, pan, gain, actor, rawMode === 0 ? 1 : 3);
    const wave = await createBurikoLiveOggExchangeWaveStream(
      first,
      second,
      rawMode,
      {gain, prefer24Bit: this.channels.output.prefer24Bit, abi: this.channels.context.abi},
      () => this.channels.ticks.getTickCount(),
      this.channels.actors,
      actor,
      this.channels.output.offlineContext,
    );
    const status = await this.channels.publishInitializedStream(index, wave, volume, pan);
    if (status !== 0)
      throw new BurikoWaveBoxError(22, 'Buriko paired stream speaker attachment failed');
    return 0;
  }
  private async pairLooseRaw(
    index: number,
    pathA: string,
    pathB: string,
    rawMode: number,
    volume: number,
    pan: number,
    gain: number,
    actor: object,
  ): Promise<number> {
    const status = this.validate(index, actor);
    if (status !== 0) return status;
    pathA = audioPathTerminated(pathA);
    pathB = audioPathTerminated(pathB);
    const sameName = pathA === pathB;
    let first: BurikoLiveAudioStorage | undefined,
      second: BurikoLiveAudioStorage | undefined,
      handedOff = false;
    try {
      const firstPath = await this.cache.resolveLoosePath(pathA, actor),
        firstInput = new BurikoFileStorage(this.files);
      if (!(await firstInput.open(firstPath))) {
        firstInput.dispose();
        throw new BurikoWaveBoxError(12, 'Buriko paired stream could not open first loose file');
      }
      first = firstInput;
      if (!sameName) {
        const secondPath = await this.cache.resolveLoosePath(pathB, actor),
          secondInput = new BurikoFileStorage(this.files);
        if (!(await secondInput.open(secondPath))) {
          secondInput.dispose();
          throw new BurikoWaveBoxError(12, 'Buriko paired stream could not open second loose file');
        }
        second = secondInput;
      }
      handedOff = true;
      return await this.publishPair(index, first, second, rawMode, volume, pan, gain, actor);
    } catch (error) {
      if (!handedOff) {
        try {
          await first?.dispose();
        } catch {
          // Preserve the acquisition or typed model failure.
        }
        try {
          await second?.dispose();
        } catch {
          // Preserve the acquisition or typed model failure.
        }
      }
      return this.nativeFailure(index, error);
    }
  }
  private async pairArchiveRaw(
    index: number,
    path: string,
    memberA: string,
    memberB: string,
    rawMode: number,
    volume: number,
    pan: number,
    gain: number,
    actor: object,
  ): Promise<number> {
    const status = this.validate(index, actor);
    if (status !== 0) return status;
    memberA = audioPathTerminated(memberA);
    memberB = audioPathTerminated(memberB);
    const sameName = memberA === memberB;
    let first: BurikoLiveAudioStorage | undefined,
      second: BurikoLiveAudioStorage | undefined,
      handedOff = false;
    try {
      if (this.abi.compatibility === '1.69') {
        // 46fc80: two embedded PackFile owners; the later audio cache is not consulted.
        const firstInput = new BurikoLegacy169ArchiveFileStorage(this.files);
        first = firstInput;
        if (!(await firstInput.open(path, memberA)))
          throw new BurikoWaveBoxError(12, 'Buriko paired stream could not open first member');
        if (!sameName) {
          const secondInput = new BurikoLegacy169ArchiveFileStorage(this.files);
          second = secondInput;
          if (!(await secondInput.open(path, memberB)))
            throw new BurikoWaveBoxError(12, 'Buriko paired stream could not open second member');
        }
        handedOff = true;
        return await this.publishPair(index, first, second, rawMode, volume, pan, gain, actor);
      }
      if (
        this.cache.searchDirectories !== null &&
        (await this.pairLooseRaw(index, memberA, memberB, rawMode, volume, pan, gain, actor)) === 0
      )
        return 0;
      const found = await this.cache.find(path, memberA, actor);
      if (found.status !== 0)
        throw new BurikoWaveBoxError(12, 'Buriko paired stream archive lookup failed');
      if (found.archive === undefined)
        throw new Error('Buriko successful paired audio cache result has no actual archive');
      const secondFound = sameName ? undefined : await this.cache.find(path, memberB, actor);
      if (secondFound !== undefined && secondFound.status !== 0)
        throw new BurikoWaveBoxError(12, 'Buriko paired stream second member lookup failed');
      const secondArchive = secondFound?.archive;
      if (secondFound !== undefined && secondArchive === undefined)
        throw new Error('Buriko successful second audio cache result has no actual archive');
      const firstInput = new BurikoArchiveFileStorage();
      if (!(await firstInput.open(found.archive, memberA, actor))) {
        firstInput.dispose();
        throw new BurikoWaveBoxError(12, 'Buriko paired stream could not open first member');
      }
      first = firstInput;
      if (secondArchive !== undefined) {
        const secondInput = new BurikoArchiveFileStorage();
        if (!(await secondInput.open(secondArchive, memberB, actor))) {
          secondInput.dispose();
          throw new BurikoWaveBoxError(12, 'Buriko paired stream could not open second member');
        }
        second = secondInput;
      }
      handedOff = true;
      return await this.publishPair(index, first, second, rawMode, volume, pan, gain, actor);
    } catch (error) {
      if (!handedOff) {
        try {
          await first?.dispose();
        } catch {
          // Preserve the acquisition or typed model failure.
        }
        try {
          await second?.dispose();
        } catch {
          // Preserve the acquisition or typed model failure.
        }
      }
      return this.nativeFailure(index, error);
    }
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
      const input = new BurikoFileStorage(this.files);
      if (!(await input.open(resolved))) {
        input.dispose();
        throw new BurikoWaveBoxError(12, 'Buriko stream resource could not open loose file');
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
      if (this.abi.compatibility === '1.69') {
        // 46fa30: a single legacy stream embeds the same load-once PackFile reader.
        const input = new BurikoLegacy169ArchiveFileStorage(this.files);
        if (!(await input.open(path, member))) {
          input.dispose();
          throw new BurikoWaveBoxError(12, 'Buriko stream resource could not open archive member');
        }
        return await this.initializeRaw(index, input, volume, pan, gain, actor);
      }
      if (
        this.cache.searchDirectories !== null &&
        (await this.looseRaw(index, member, volume, pan, gain, actor)) === 0
      )
        return 0;
      const found = await this.cache.find(path, member, actor);
      if (found.status !== 0)
        throw new BurikoWaveBoxError(12, 'Buriko stream resource archive lookup failed');
      if (found.archive === undefined)
        throw new Error('Buriko successful audio cache result has no actual archive');
      const input = new BurikoArchiveFileStorage();
      if (!(await input.open(found.archive, member, actor))) {
        input.dispose();
        throw new BurikoWaveBoxError(12, 'Buriko stream resource could not open archive member');
      }
      return await this.initializeRaw(index, input, volume, pan, gain, actor);
    } catch (error) {
      return this.nativeFailure(index, error);
    }
  }
  /**1140A0: selector scratch is not the model's separately initialized second header. */
  private async initializeRaw(
    index: number,
    input: BurikoLiveAudioStorage,
    volume: number,
    pan: number,
    gain: number,
    actor: object,
    loopFlags = 0,
  ): Promise<number> {
    let inputHandedOff = false;
    try {
      const scratch = new Uint8Array(64),
        initialized = new Uint8Array(64);
      const count =
        (await input.readInto({bytes: scratch, offset: 0}, 64, actor, initialized)) >>> 0;
      if (count < 64)
        throw new BurikoWaveBoxError(14, 'Buriko stream selector read a short header');
      for (let offset = 48; offset < 52; offset++)
        if (initialized[offset] === 0)
          throw new Error('Buriko stream selector reads unwritten codec');
      const codec = new DataView(scratch.buffer).getUint32(48, true);
      if (codec > 3) throw new BurikoWaveBoxError(14, 'Buriko stream selector has unknown codec');
      const prefer24Bit = this.channels.output.prefer24Bit;
      await input.seek(0, actor);
      inputHandedOff = true;
      const wave =
        codec === 3
          ? await createBurikoLiveOggWaveStream(
              input,
              {gain, prefer24Bit, abi: this.channels.context.abi},
              () => this.channels.ticks.getTickCount(),
              this.channels.actors,
              actor,
              this.channels.output.offlineContext,
            )
          : await createBurikoLiveWaveStream(
              input,
              codec as 0 | 1 | 2,
              {gain, abi: this.channels.context.abi},
              () => this.channels.ticks.getTickCount(),
              this.channels.actors,
              actor,
            );
      const status = await this.channels.publishInitializedStream(
        index,
        wave,
        volume,
        pan,
        loopFlags,
      );
      if (status !== 0) throw new BurikoWaveBoxError(22, 'Buriko stream speaker attachment failed');
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
