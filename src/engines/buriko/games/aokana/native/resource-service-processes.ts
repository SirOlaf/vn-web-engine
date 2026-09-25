import type {AokanaBpPointer} from '../bp/memory.js';
import {push32} from '../bp/state.js';
import type {AokanaNativeClock} from './clock.js';
import {updateNativeChecksum} from './group-81-hash.js';
import {AokanaLoadProcedure} from './load-procedure.js';
import type {AokanaProcedureState} from './procedure.js';
import type {AokanaResourceLoadingState} from './resource-loading.js';
import type {AokanaBpOpcodeContext} from './types.js';

/** DCProcReadBinary 09D2A0/09D210 shares CProcLoad, its cache, and the resource FIFO. */
export class AokanaReadBinaryProcess extends AokanaLoadProcedure {
  private constructor(
    context: AokanaBpOpcodeContext,
    procedures: AokanaProcedureState,
    clock: AokanaNativeClock,
    loading: AokanaResourceLoadingState,
    private readonly destination: AokanaBpPointer | null,
    archive: Uint8Array | null,
    name: Uint8Array,
  ) {
    super(context, procedures, clock, loading, archive, name, {
      cacheEligible: false,
      deferCacheLookup: true,
      silentFailures: true,
    });
  }

  static async create(
    context: AokanaBpOpcodeContext,
    procedures: AokanaProcedureState,
    clock: AokanaNativeClock,
    loading: AokanaResourceLoadingState,
    destination: AokanaBpPointer | null,
    archive: Uint8Array | null,
    name: Uint8Array,
    offset: number,
    length: number,
  ): Promise<AokanaReadBinaryProcess> {
    const actor = context.actor ?? loading.metadata.allocator.currentActor;
    const process = new AokanaReadBinaryProcess(
      context,
      procedures,
      clock,
      loading,
      destination,
      archive,
      name,
    );
    offset >>>= 0;
    length >>>= 0;
    const wholeStoredResource = offset === 0 && length === 0;
    let queuedLength = length;
    if (wholeStoredResource)
      queuedLength = await loading.ranges.size(process.archiveName, process.name);
    if (!(await loading.ranges.isAvailable(process.archiveName, process.name))) {
      process.result.value = 0xffffffff;
      return process;
    }
    if (offset !== 0 && length === 0) {
      process.result.value = 0xffffffff;
      return process;
    }
    if (wholeStoredResource && process.selectCache(true)) return process;
    loading.enqueueOwned(
      process.output,
      process.result,
      process.archiveName,
      process.name,
      offset,
      queuedLength,
      actor,
    );
    return process;
  }

  protected complete(): number {
    const bytes = this.output.bytes;
    if (bytes === null)
      throw new Error('Aokana asynchronous binary read has no successful resource bytes');
    if (this.destination === null)
      throw new Error('Aokana asynchronous binary read dereferences a null destination');
    const count = this.result.value >>> 0;
    this.destination.bytes.set(bytes.subarray(0, count), this.destination.offset);
    this.failure = 0;
    return 1;
  }
}

/** DCProcExamineHealthOfFile 09B4B0 retains queued bytes and metadata until disposal. */
export class AokanaExamineFileHealthProcess extends AokanaLoadProcedure {
  private readonly metadata = {value: 0n};

  constructor(
    context: AokanaBpOpcodeContext,
    procedures: AokanaProcedureState,
    clock: AokanaNativeClock,
    loading: AokanaResourceLoadingState,
    archive: Uint8Array,
    name: Uint8Array,
    actor: object,
  ) {
    super(context, procedures, clock, loading, archive, name, {
      cacheEligible: false,
      silentFailures: true,
    });
    this.failure = 0;
    loading.enqueue(
      this.output,
      null,
      this.result,
      this.metadata,
      this.archiveName,
      this.name,
      0,
      0,
      actor,
    );
  }

  protected complete(): number {
    if (this.metadata.value === 0n) {
      this.failure = 10;
      return 1;
    }
    const bytes = this.output.bytes;
    if (bytes === null)
      throw new Error('Aokana file-health process has no successful stored resource bytes');
    const checksum = new Uint8Array(8);
    updateNativeChecksum({bytes: checksum, offset: 0}, {bytes, offset: 0}, this.result.value);
    const expected = new Uint8Array(8);
    new DataView(expected.buffer).setBigUint64(0, BigInt.asUintN(64, this.metadata.value), true);
    this.failure = checksum.every((value, index) => value === expected[index]) ? 0 : 11;
    return 1;
  }

  override dispose(): void {
    push32(this.thread, this.failure === 3 ? 0xffffffff : (this.failure ?? 0));
    super.dispose();
  }
}
