import type {AokanaBpPointer} from '../bp/memory.js';
import type {AokanaAudioLoaderQueues} from './audio/loader-queues.js';
import type {AokanaNativeClock} from './clock.js';
import {AokanaProcedure, type AokanaProcedureState} from './procedure.js';
import type {AokanaResourceLoadingState, AokanaResourceResult} from './resource-loading.js';
import type {AokanaBpOpcodeContext} from './types.js';

const literal = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/../g)!, (value) => parseInt(value, 16));

/** Raw CP932 diagnostics at 17F750, 17F780 and 17F7C8, including native spelling. */
const invalidWave = literal(
  '8e7792e882b382ea82bd8366815b835e82cd42578c608eae82c582cd82c882a282e682a482c582b700',
);
const nonMono = literal(
  '8e7792e882b382ea82bd42578c608eae8366815b835e82cd8382836d8389838b82c582cd82c882a282cc82c58cf889ca89b982c682b582c48e67977082c582ab82dc82b982f100',
);
const registrationFailed = literal(
  '8e7792e882b382ea82bd42578c608eae82cc8366815b835e82cc936f985e928682c9927696bd934982c883478389815b82aa94ad90b682dc82b582bd00',
);

/** DCProcRgstrSound 09D7B0/09D6C0/09D770: borrowed source, static FIFO, shared count. */
export class AokanaRegisterSoundProcess extends AokanaProcedure {
  /** Native result storage at +64 is not written until FE330's first enqueue. */
  readonly result = {} as AokanaResourceResult;
  private phase = 0;
  private readonly actor: object;
  private readonly source: AokanaBpPointer | null;

  constructor(
    private readonly context: AokanaBpOpcodeContext,
    procedures: AokanaProcedureState,
    clock: AokanaNativeClock,
    private readonly loading: AokanaResourceLoadingState,
    private readonly queues: AokanaAudioLoaderQueues,
    private readonly channel: number,
    source: AokanaBpPointer | null,
    private readonly fade: number,
    private readonly gain: number,
    private readonly speed: number,
    private readonly initialized?: Uint8Array,
  ) {
    super(context.thread, procedures, clock);
    if (queues.loading !== loading)
      throw new Error('Aokana register-sound process must share the actual loading count');
    this.actor = context.actor ?? queues.metadata.allocator.currentActor;
    this.source = source === null ? null : {bytes: source.bytes, offset: source.offset};
    loading.enterProcedure();
  }

  poll(): number | Promise<number> {
    if (this.phase === 0) {
      this.queues.enqueueStatic(
        this.result,
        this.channel,
        this.source,
        this.fade,
        this.gain,
        this.speed,
        this.initialized,
        this.actor,
      );
      this.phase = 1;
      return 0;
    }
    const value = this.result.value >>> 0;
    if (value === 0) return 1;
    if (value === 0x80000002)
      return this.loading.resources.errors.threadFatal(
        this.thread,
        this.context.diagnostics,
        invalidWave,
      );
    if (value === 0xffff0101)
      return this.loading.resources.errors.threadFatal(
        this.thread,
        this.context.diagnostics,
        nonMono,
      );
    if (value === 0xffffffff)
      return this.loading.resources.errors.threadFatal(
        this.thread,
        this.context.diagnostics,
        registrationFailed,
      );
    return 0;
  }

  override dispose(): void {
    this.loading.leaveProcedure();
    super.dispose();
  }
}
