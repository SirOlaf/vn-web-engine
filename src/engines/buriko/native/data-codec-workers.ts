import type {BurikoBpPointer} from '../bp/memory.js';
import {decodeBurikoSdcInto, encodeBurikoSdcInto} from './sdc.js';
import {encodeBurikoDcfs} from './dcfs.js';
import type {BurikoStructCodecScratch} from './struct-codec-scratch.js';
import type {BurikoEngineErrors} from './engine-errors.js';
import {codecView, type BurikoCodecPointer} from './codec-storage.js';
import {decodeBurikoResourcePointer} from './resource-decode.js';
import type {BurikoDistributedProcessing} from './distributed-processing.js';

/** FE440's captured native worker record; completion does not dispose the procedure. */
export interface BurikoDataCodecWorker {
  destination: BurikoBpPointer | null;
  initialized?: Uint8Array;
  readonly source: BurikoBpPointer | null;
  readonly count: number;
  readonly completion: Promise<void>;
  done: boolean;
  result: number;
  released: boolean;
}

/** Independent codec tasks, using the same cooperative host profile as native grid workers. */
export class BurikoDataCodecWorkers {
  private readonly pending = new Set<BurikoDataCodecWorker>();
  private failure: {error: unknown} | null = null;
  private closed = false;
  private closing: Promise<void> | null = null;
  constructor(readonly readSystemTime: () => Date = () => new Date()) {}

  get admissionClosed(): boolean {
    return this.closed;
  }

  checkFailure(): void {
    if (this.failure !== null) throw this.failure.error;
  }
  hasPendingWork(): boolean {
    this.checkFailure();
    return this.pending.size !== 0;
  }

  /** The caller closes BP admission first, then joins borrowed pointers before child storage retires. */
  async joinPending(): Promise<void> {
    while (this.pending.size !== 0)
      await Promise.all([...this.pending].map((worker) => worker.completion));
    this.checkFailure();
  }

  /** Final owner shutdown closes worker admission synchronously, before its first await. */
  closeAndJoin(): Promise<void> {
    this.closed = true;
    return (this.closing ??= this.joinPending());
  }

  startEncode(
    destination: BurikoBpPointer | null,
    source: BurikoBpPointer | null,
    count: number,
  ): BurikoDataCodecWorker | null {
    return this.schedule(destination, source, count, (worker) => {
      worker.result = encodeBurikoSdcInto(
        worker.destination,
        worker.source,
        worker.count,
        this.readSystemTime,
      );
      worker.done = true;
    });
  }

  startStructEncode(
    destination: BurikoBpPointer | null,
    source: BurikoBpPointer | null,
    size: number,
    count: number,
    scratch: BurikoStructCodecScratch,
    errors: BurikoEngineErrors,
  ): BurikoDataCodecWorker | null {
    count >>>= 0;
    return this.schedule(destination, source, size, async (worker) => {
      // Each started native thread is also a distinct critical-section actor.
      await scratch.section.enter(worker);
      try {
        if (worker.released)
          throw new Error('Buriko struct worker accesses a released native record');
        const requested = (((Math.imul(Math.imul(worker.count, count), 3) >>> 0) >>> 1) + 24) >>> 0,
          storage = scratch.commit(requested, worker);
        if (storage === null) {
          await errors.show(
            errors.files.text.encodeWide('構造体圧縮に必要なメモリが確保できませんでした', 0),
          );
          worker.result = 0;
        } else {
          const result = {value: worker.result};
          encodeBurikoDcfs(storage, result, worker.source, worker.count, count);
          worker.result = result.value;
          worker.result = encodeBurikoSdcInto(
            worker.destination,
            storage,
            worker.result,
            this.readSystemTime,
          );
          scratch.decommit(worker);
        }
        worker.done = true; // F9620 publishes completion before leaving274588.
      } finally {
        scratch.section.leave(worker);
      }
    });
  }

  startDecode(
    destination: BurikoBpPointer | null,
    source: BurikoBpPointer | null,
    inputLength: number,
    processing: BurikoDistributedProcessing,
  ): BurikoDataCodecWorker | null {
    return this.schedule(destination, source, inputLength, async (worker) => {
      const magic = 'SDC FORMAT 1.00\0';
      let sdc = true;
      for (let index = 0; index < magic.length; index++) {
        if (codecView(worker.source, index, 1).getUint8(0) !== magic.charCodeAt(index)) {
          sdc = false;
          break;
        }
      }
      if (sdc) {
        let output: BurikoCodecPointer | null = worker.destination;
        if (output === null) {
          const extent = codecView(worker.source, 24, 4).getUint32(0, true);
          output = {bytes: new Uint8Array(extent), offset: 0, initialized: new Uint8Array(extent)};
          worker.destination = output;
          worker.initialized = output.initialized;
        }
        worker.result = decodeBurikoSdcInto(output, worker.source);
      } else {
        const decoded = await decodeBurikoResourcePointer(
          worker.source,
          worker.count,
          processing,
          worker.destination,
        );
        if (decoded.status === 0) {
          if (decoded.bytes === null)
            throw new Error('Buriko successful data decode has no output');
          if (worker.destination === null) {
            worker.destination = {bytes: decoded.bytes, offset: 0};
            worker.initialized = decoded.initialized;
          }
          worker.result = decoded.bytes.length >>> 0;
        }
      }
      worker.done = true;
    });
  }

  private schedule(
    destination: BurikoBpPointer | null,
    source: BurikoBpPointer | null,
    count: number,
    operation: (worker: BurikoDataCodecWorker) => void | Promise<void>,
  ): BurikoDataCodecWorker | null {
    this.checkFailure();
    if (this.closed) throw new Error('Buriko data codec workers are closed');
    let notify!: () => void;
    const worker: BurikoDataCodecWorker = {
      destination,
      source,
      count: count >>> 0,
      completion: new Promise<void>((resolve) => {
        notify = resolve;
      }),
      done: false,
      result: 0,
      released: false,
    };
    this.pending.add(worker);
    try {
      setTimeout(async () => {
        try {
          if (worker.released)
            throw new Error('Buriko codec worker accesses a released native record');
          // Snapshotting occurs inside F4900 now, not when the VM captured these pointers.
          await operation(worker);
        } catch (error) {
          this.failure = {error};
        } finally {
          this.pending.delete(worker);
          notify();
        }
      }, 0);
    } catch {
      this.pending.delete(worker);
      notify();
      return null;
    }
    return worker;
  }

  release(worker: BurikoDataCodecWorker): void {
    worker.released = true; // Native destructor does not join or cancel its worker.
  }
}
