import type {AokanaBpPointer} from '../bp/memory.js';
import type {AokanaAudioLoaderQueues} from './audio/loader-queues.js';
import {formatAokanaAudioNames} from './audio/resource-music.js';
import type {AokanaNativeClock} from './clock.js';
import {AokanaLoadProcedure} from './load-procedure.js';
import type {AokanaProcedureState} from './procedure.js';
import type {AokanaResourceLoadingState, AokanaResourceResult} from './resource-loading.js';
import {textBytes} from './text.js';
import type {AokanaBpOpcodeContext} from './types.js';

const literal = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/../g)!, (value) => parseInt(value, 16));

/** Raw CP932 templates at 17E658, 17E5B0 and 17E610, with archive/member placeholders. */
const invalidWave = literal(
  '8e7792e882b382ea82bd837483408343838b205b202573203a202573205d2082cd4257837483408343838b82c582cd82c882a282e682a482c582b700',
);
const nonMono = literal(
  '8e7792e882b382ea82bd4257837483408343838b205b202573203a202573205d2082cd8382836d8389838b82c582cd82c882a282cc82c58cf889ca89b982c682b582c48e67977082c582ab82dc82b982f100',
);
const registrationFailed = literal(
  '8e7792e882b382ea82bd837483408343838b205b202573203a202573205d2082cc936f985e928682c9927696bd934982c883478389815b82aa94ad90b682b582dc82b582bd00',
);
const nullName = literal(
  '837483408343838b96bc82d682cc837c83438393835e82c94e554c4c82aa8e7792e882b382ea82c482a282dc82b700',
);

/** CProcLoadSound 07B660/07B500: owned resource phase followed by borrowed static registration. */
export class AokanaLoadSoundProcess extends AokanaLoadProcedure {
  /** Native +694 is unwritten until the first FE330 enqueue. */
  readonly staticResult = {} as AokanaResourceResult;
  private phase = 0;
  private readonly actor: object;
  private readonly queues: AokanaAudioLoaderQueues;
  private readonly channel: number;
  private readonly fade: number;
  private readonly gain: number;
  private readonly speed: number;

  private constructor(
    context: AokanaBpOpcodeContext,
    procedures: AokanaProcedureState,
    clock: AokanaNativeClock,
    loading: AokanaResourceLoadingState,
    queues: AokanaAudioLoaderQueues,
    channel: number,
    fade: number,
    gain: number,
    speed: number,
    archive: Uint8Array | null,
    name: Uint8Array,
  ) {
    if (queues.loading !== loading)
      throw new Error('Aokana load-sound process must share the actual loading count');
    // 07B180 creates the owned FE400 job before 07B660 publishes derived fields.
    super(context, procedures, clock, loading, archive, name, {cacheEligible: false});
    const actor = context.actor ?? queues.metadata.allocator.currentActor;
    loading.enqueueOwned(this.output, this.result, this.archiveName, this.name, 0, 0, actor);
    this.actor = actor;
    this.queues = queues;
    this.channel = channel >>> 0;
    this.fade = fade | 0;
    this.gain = gain;
    this.speed = speed;
  }

  /** The null-name diagnostic precedes the base constructor's shared-count increment. */
  static async create(
    context: AokanaBpOpcodeContext,
    procedures: AokanaProcedureState,
    clock: AokanaNativeClock,
    loading: AokanaResourceLoadingState,
    queues: AokanaAudioLoaderQueues,
    channel: number,
    fade: number,
    gain: number,
    speed: number,
    archivePointer: AokanaBpPointer | null,
    namePointer: AokanaBpPointer | null,
  ): Promise<AokanaLoadSoundProcess> {
    if (namePointer === null)
      return loading.resources.errors.threadFatal(context.thread, context.diagnostics, nullName);
    const archive = archivePointer === null ? null : textBytes(archivePointer).slice();
    return new AokanaLoadSoundProcess(
      context,
      procedures,
      clock,
      loading,
      queues,
      channel,
      fade,
      gain,
      speed,
      archive,
      textBytes(namePointer).slice(),
    );
  }

  protected complete(): number | Promise<number> {
    if (this.phase === 0) {
      const bytes = this.output.bytes;
      this.queues.enqueueStatic(
        this.staticResult,
        this.channel,
        bytes === null ? null : {bytes, offset: 0},
        this.fade,
        this.gain,
        this.speed,
        this.output.initialized,
        this.actor,
      );
      this.phase = 1;
      return 0;
    }
    const value = this.staticResult.value >>> 0;
    if (value === 1) return 0;
    if (value === 0x80000002) return this.fatal(invalidWave);
    if (value === 0xffff0101) return this.fatal(nonMono);
    if (value === 0xffffffff) return this.fatal(registrationFailed);
    return 1;
  }

  private fatal(template: Uint8Array): Promise<never> {
    return this.loading.resources.errors.threadFatal(
      this.thread,
      this.context.diagnostics,
      formatAokanaAudioNames(template, [this.archive, this.name], 256),
    );
  }
}
