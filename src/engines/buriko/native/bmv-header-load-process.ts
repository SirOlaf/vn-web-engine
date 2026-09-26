import type {BurikoBpPointer} from '../bp/memory.js';
import {push32} from '../bp/state.js';
import {validateBurikoBmvHeader} from './bmv-frame.js';
import type {BurikoBmvRegistry} from './bmv-registry.js';
import type {BurikoNativeClock} from './clock.js';
import {BurikoProcedure, type BurikoProcedureState} from './procedure.js';
import type {BurikoResourceLoadingState} from './resource-loading.js';
import {BurikoUndefinedResourceRead} from './resource-memory.js';
import {textBytes} from './text.js';
import type {BurikoBpOpcodeContext} from './types.js';

/** 09CCB0/09CA60/09CC40: CProcUsingThread with two direct FIFO range reads. */
export class BurikoBmvHeaderLoadProcess extends BurikoProcedure {
  needsLiveOperandStorageOnDispose(): boolean {
    return true;
  }
  private stage = 0;
  private finalStatus: number | null = null;
  private readonly header = new Uint8Array(0x40);
  private extension: Uint8Array | null = null;
  private readonly result = {value: 0};
  private archive: Uint8Array | null = null;
  private name: Uint8Array | null = null;

  constructor(
    context: BurikoBpOpcodeContext,
    procedures: BurikoProcedureState,
    clock: BurikoNativeClock,
    private readonly loading: BurikoResourceLoadingState,
    private readonly registry: BurikoBmvRegistry,
    private readonly handleOutput: BurikoBpPointer | null,
    private readonly metadataOutput: BurikoBpPointer | null,
    archivePointer: BurikoBpPointer | null,
    namePointer: BurikoBpPointer | null,
  ) {
    super(context.thread, procedures, clock);
    if (namePointer === null) return;
    loading.enterProcedure();
    this.archive = archivePointer === null ? null : textBytes(archivePointer).slice();
    this.name = textBytes(namePointer).slice();
    this.stage = 1;
  }

  private tableLength(): number {
    return (Math.imul(new DataView(this.header.buffer).getUint32(0x28, true), 4) + 0x80) >>> 0;
  }

  override async poll(): Promise<number> {
    // This native override does not consume messages or inspect CProcedure stop/enabled state.
    if (this.stage === 1) {
      this.loading.enqueue(
        null,
        {bytes: this.header, offset: 0},
        this.result,
        null,
        this.archive,
        this.name!,
        0,
        0x40,
      );
      this.stage = 2;
      return 0;
    }
    if (this.stage === 2) {
      if (this.result.value === 0) return 0;
      if (this.result.value === 0x40 && validateBurikoBmvHeader(this.header) === 0) {
        const length = this.tableLength();
        this.extension = new Uint8Array(length);
        this.loading.enqueue(
          null,
          {bytes: this.extension, offset: 0},
          this.result,
          null,
          this.archive,
          this.name!,
          0x40,
          length,
        );
        this.stage = 3;
        return 0;
      }
    } else if (this.stage === 3) {
      if (this.result.value === 0) return 0;
      if (this.result.value === this.tableLength()) {
        const combined = new Uint8Array(this.result.value + 0x40);
        combined.set(this.header);
        combined.set(this.extension!, 0x40);
        const size = await this.loading.ranges.read(null, this.archive, this.name!, 0, 0);
        if (size.size === null)
          throw new BurikoUndefinedResourceRead(
            'Buriko BMV partial loader reads an unwritten stored-size output',
          );
        const status = this.registry.register(
          this.handleOutput,
          this.metadataOutput,
          combined,
          (this.result.value + 0x40) >>> 0,
          {archive: this.archive, name: this.name!, length: size.size},
        );
        this.finalStatus = status === 0 ? 0 : 2;
        return 1;
      }
    } else {
      this.finalStatus = 1;
      return 1;
    }
    this.finalStatus = 2;
    return 1;
  }

  override dispose(): void {
    if (this.finalStatus === null)
      throw new BurikoUndefinedResourceRead(
        'Buriko BMV partial loader reads an unwritten completion status',
      );
    push32(this.thread, this.finalStatus);
    this.extension = null;
    // The null-name constructor leaves native name pointers unwritten; do not invent safe frees.
    if (this.name === null)
      throw new BurikoUndefinedResourceRead(
        'Buriko BMV partial loader frees unwritten native name pointers',
      );
    this.archive = null;
    this.name = null;
    this.loading.leaveProcedure();
    super.dispose();
  }
}
