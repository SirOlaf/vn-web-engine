import {BurikoBpInterpreter} from '../bp/interpreter.js';
import {BurikoBpSharedThread, validCodeAddress, type BurikoBpThread} from '../bp/state.js';
import type {BurikoBitmapCompositor} from './bitmap-compositor.js';
import type {BurikoBpDiagnostics} from './diagnostics.js';
import type {BurikoDistributedProcessing} from './distributed-processing.js';
import type {BurikoEngineErrors} from './engine-errors.js';
import type {BurikoNativeLocks} from './exclusion-locks.js';
import type {BurikoVmControlState} from './group-80-threads.js';

export type BurikoSharedInterpreterResult = 0 | 0x80000001 | 0x80000002 | 0x80000003;

interface SharedInterpreterRecord {
  child: BurikoBpSharedThread | null;
  message: Uint8Array | null;
}

/** 1400B7550 and 1400B77B0: mode-one BP children over the global indexed work pool. */
export class BurikoSharedInterpreters {
  constructor(
    private readonly control: BurikoVmControlState,
    private readonly processing: BurikoDistributedProcessing,
    private readonly compositor: BurikoBitmapCompositor,
    private readonly locks: BurikoNativeLocks,
    private interpreter: BurikoBpInterpreter | null,
    readonly errors: BurikoEngineErrors,
  ) {
    if (interpreter !== null && !(interpreter instanceof BurikoBpInterpreter))
      throw new TypeError('Buriko shared interpreters require an actual BP interpreter');
  }

  /** The full native bank includes 81:48, so its interpreter is bound once after bank construction. */
  bindInterpreter(interpreter: BurikoBpInterpreter): void {
    if (this.interpreter !== null)
      throw new Error('Buriko shared interpreters already have an interpreter');
    if (!(interpreter instanceof BurikoBpInterpreter))
      throw new TypeError('Buriko shared interpreters require an actual BP interpreter');
    this.interpreter = interpreter;
  }

  private message(value: string): Uint8Array {
    return this.errors.files.text.encodeWide(value, 0);
  }

  private async runWorker(
    records: SharedInterpreterRecord[],
    worker: number,
    actor: object,
  ): Promise<0> {
    const interpreter = this.interpreter;
    if (interpreter === null)
      throw new Error('Buriko shared interpreters have no bound interpreter');
    const record = records[worker >>> 0];
    if (record === undefined)
      throw new RangeError('Buriko shared-interpreter worker index exceeds its record array');
    const child = record.child;
    if (child === null) return 0;

    let count = 0,
      opcode = 0,
      result = 0,
      released = 0;
    try {
      while (count < 0x10000000) {
        const dispatched = this.processing.allocator.withActor(actor, () =>
          interpreter.dispatchNext(child, actor),
        );
        opcode = dispatched.opcode;
        if (!dispatched.defined) {
          result = 7;
          break;
        }
        result = await dispatched.result;
        count++;
        if ((result | 0) !== 0) break;
      }
    } finally {
      released = this.locks.releaseScriptCurrentActor(actor);
    }

    if (result === 4 && released === 0) return 0;
    if (result === 0) {
      record.message = this.message(
        `分散処理時におけるスレッド [ ${worker | 0} ] の処理は無限ループに陥っている可能性が高いと判断されました`,
      );
    } else if (result === 4) {
      record.message = this.message(
        `分散処理時におけるスレッド [ ${worker | 0} ] の終了時点で予期しない錠前のアンロック（${released | 0}回）が検出されました`,
      );
    } else if (result === 7) {
      record.message = this.message(
        `未定義の基本命令 $${opcode.toString(16).toUpperCase().padStart(2, '0')} を検出しました`,
      );
    } else {
      record.message = this.message('使用が禁止されている命令を検出しました');
    }
    return 0;
  }

  async run(
    parent: BurikoBpThread,
    diagnostics: BurikoBpDiagnostics,
    operandCapacity: number,
    moduleSize: number,
    frameSize: number,
    initialIp: number,
    actor = this.processing.allocator.currentActor,
  ): Promise<BurikoSharedInterpreterResult> {
    if (this.interpreter === null)
      throw new Error('Buriko shared interpreters have no bound interpreter');
    operandCapacity >>>= 0;
    moduleSize >>>= 0;
    frameSize >>>= 0;
    initialIp >>>= 0;
    if (!validCodeAddress(parent, initialIp)) return 0x80000003;

    const detachBitmapProcessing = this.control.distributedBitmapProcessingEnabled !== 0;
    if (detachBitmapProcessing) this.compositor.processing = null;
    const records: SharedInterpreterRecord[] = Array.from(
      {length: this.processing.capacity},
      () => ({child: null, message: null}),
    );
    let successful = 0,
      constructionResult: BurikoSharedInterpreterResult = 0;
    try {
      for (let worker = 0; worker < records.length; worker++) {
        const child = new BurikoBpSharedThread({
          id: this.control.allocateThreadId(),
          operandCapacity,
          mode: 1,
        });
        const result = child.initialize(parent, moduleSize, frameSize, initialIp, () => {
          throw new Error('Buriko mode-one shared interpreter entered the scheduler list');
        });
        if (result !== 0) {
          child.disposeStorage();
          if (result === 0x80000002) constructionResult = 0x80000001;
          else if (result === 0x80000003) constructionResult = 0x80000002;
          else
            throw new Error(
              `Buriko shared-interpreter initialization returned 0x${(result >>> 0).toString(16)}`,
            );
          break;
        }
        child.interpreterNumber = worker;
        records[worker]!.child = child;
        successful++;
      }

      if (successful === 0) return constructionResult;
      await this.processing.runWorkerCallbackAsync(
        (context, worker, workerActor) => this.runWorker(context, worker, workerActor),
        records,
        1,
        actor,
      );
      for (let worker = 0; worker < successful; worker++) {
        const record = records[worker]!,
          child = record.child!;
        if (record.message !== null) {
          const formatted = diagnostics.formatThreadMessage(child, record.message);
          await this.errors.show(formatted);
          record.message = null;
        }
        child.disposeStorage();
        record.child = null;
      }
      return 0;
    } finally {
      for (const record of records) {
        record.message = null;
        if (record.child !== null) {
          record.child.disposeStorage();
          record.child = null;
        }
      }
      if (detachBitmapProcessing) this.compositor.processing = this.processing;
    }
  }
}
