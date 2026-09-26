import type {BurikoBpPointer} from '../bp/memory.js';
import type {BurikoNativeClock} from './clock.js';
import type {BurikoDataCodecWorkers} from './data-codec-workers.js';
import {BurikoDataDecodeProcess} from './data-decode-process.js';
import type {BurikoProcedureState} from './procedure.js';
import type {BurikoBpOpcodeContext} from './types.js';
import type {BurikoBitmapRegistration} from './bitmap-registration.js';
import {textBytes} from './text.js';

/** 09D5D0/09D4B0/09D570 extend CF's actual worker and destructor publication. */
export class BurikoRegisterBitmapProcess extends BurikoDataDecodeProcess {
  private archive: Uint8Array | null;
  private name: Uint8Array | null;

  constructor(
    context: BurikoBpOpcodeContext,
    procedures: BurikoProcedureState,
    clock: BurikoNativeClock,
    workers: BurikoDataCodecWorkers,
    private readonly registration: BurikoBitmapRegistration,
    private readonly index: number,
    source: BurikoBpPointer | null,
    count: number,
    archive: BurikoBpPointer | null,
    name: BurikoBpPointer | null,
    private readonly preloadFlag: number,
  ) {
    super(context, procedures, clock, registration.loading, workers, null, source, count);
    this.archive = archive === null ? null : textBytes(archive, true).slice();
    this.name = name === null ? null : textBytes(name, true).slice();
  }

  override poll(): number {
    const result = super.poll();
    if (result !== 1) return result;
    const worker = this.worker!;
    if (worker.result === 0) this.result = 0xffffffff;
    else {
      if (worker.destination === null)
        throw new Error('Buriko registered bitmap has no decoded output');
      const source = {...worker.destination, initialized: worker.initialized};
      const imported = (this.index | 0) === -1 ? 0 : this.registration.import(this.index, source);
      if (imported === 0) {
        if (this.name !== null) {
          if ((this.preloadFlag | 0) !== 0)
            this.registration.preload(this.archive, this.name, source, worker.result);
          else
            this.registration.cache(
              this.archive === null ? null : {bytes: this.archive, offset: 0},
              {bytes: this.name, offset: 0},
              source,
              worker.result,
            );
        }
        this.result = 0;
      } else this.result = imported;
    }
    // Native frees the private output here, before its later procedure destructor.
    worker.destination = null;
    worker.initialized = undefined;
    return result;
  }

  override dispose(): void {
    this.name = null;
    this.archive = null;
    super.dispose();
  }
}
