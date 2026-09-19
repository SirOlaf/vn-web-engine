import type {AokanaBpInterpreter} from '../bp/interpreter.js';
import {AokanaBpSharedThread, validCodeAddress, type AokanaBpThread} from '../bp/state.js';
import type {AokanaBitmapCompositor} from './bitmap-compositor.js';
import type {AokanaBpDiagnostics} from './diagnostics.js';
import type {AokanaDistributedProcessing} from './distributed-processing.js';
import type {AokanaEngineErrors} from './engine-errors.js';
import type {AokanaNativeLocks} from './exclusion-locks.js';
import type {AokanaVmControlState} from './group-80-threads.js';

export type AokanaSharedInterpreterResult = 0 | 0x80000001 | 0x80000002 | 0x80000003;

interface SharedInterpreterRecord {
  child: AokanaBpSharedThread | null;
  message: Uint8Array | null;
}

/** 1400B7550 and 1400B77B0: mode-one BP children over the global indexed work pool. */
export class AokanaSharedInterpreters {
  constructor(
    private readonly control: AokanaVmControlState,
    private readonly processing: AokanaDistributedProcessing,
    private readonly compositor: AokanaBitmapCompositor,
    private readonly locks: AokanaNativeLocks,
    private readonly interpreter: AokanaBpInterpreter,
    readonly errors: AokanaEngineErrors,
  ) {}

  private message(value: string): Uint8Array {
    return this.errors.files.text.encodeWide(value, 0);
  }

  private async runWorker(records: SharedInterpreterRecord[], worker: number): Promise<0> {
    const record = records[worker >>> 0];
    if (record === undefined)
      throw new RangeError('Aokana shared-interpreter worker index exceeds its record array');
    const child = record.child;
    if (child === null) return 0;

    let count = 0,
      opcode = 0,
      result = 0,
      released = 0;
    try {
      while (count < 0x10000000) {
        const dispatched = this.interpreter.dispatchNext(child);
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
      released = this.locks.releaseScriptCurrentActor();
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
    parent: AokanaBpThread,
    diagnostics: AokanaBpDiagnostics,
    operandCapacity: number,
    moduleSize: number,
    frameSize: number,
    initialIp: number,
  ): Promise<AokanaSharedInterpreterResult> {
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
      constructionResult: AokanaSharedInterpreterResult = 0;
    try {
      for (let worker = 0; worker < records.length; worker++) {
        const child = new AokanaBpSharedThread({
          id: this.control.allocateThreadId(),
          operandCapacity,
          mode: 1,
        });
        const result = child.initialize(parent, moduleSize, frameSize, initialIp, () => {
          throw new Error('Aokana mode-one shared interpreter entered the scheduler list');
        });
        if (result !== 0) {
          child.disposeStorage();
          if (result === 0x80000002) constructionResult = 0x80000001;
          else if (result === 0x80000003) constructionResult = 0x80000002;
          else
            throw new Error(
              `Aokana shared-interpreter initialization returned 0x${(result >>> 0).toString(16)}`,
            );
          break;
        }
        child.interpreterNumber = worker;
        records[worker]!.child = child;
        successful++;
      }

      if (successful === 0) return constructionResult;
      await this.processing.runWorkerCallbackAsync(
        (context, worker) => this.runWorker(context, worker),
        records,
        1,
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
