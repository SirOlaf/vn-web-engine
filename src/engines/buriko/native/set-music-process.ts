import type {BurikoBpPointer} from '../bp/memory.js';
import type {BurikoAudioLoaderQueues} from './audio/loader-queues.js';
import {formatBurikoAudioNames} from './audio/resource-music.js';
import type {BurikoNativeClock} from './clock.js';
import {BurikoProcedure, type BurikoProcedureState} from './procedure.js';
import type {BurikoResourceLoadingState, BurikoResourceResult} from './resource-loading.js';
import {textBytes} from './text.js';
import type {BurikoBpOpcodeContext} from './types.js';

const literal = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/../g)!, (value) => parseInt(value, 16));
export const burikoSetMusicMissingDiagnostic = literal(
  '8e7792e882b382ea82bd4257837483408343838b205b202573203a202573205d2082cd91b68ddd82b582dc82b982f100',
);
export const burikoSetMusicInvalidWaveDiagnostic = literal(
  '8e7792e882b382ea82bd837483408343838b205b202573203a202573205d2082cd4257837483408343838b82c582cd82c882a282e682a482c582b700',
);
export const burikoSetMusicGenericFailureDiagnostic = literal(
  '8349815b83668342834983588367838a815b838082cc8dc490b68f8094f582c98eb8947382b582dc82b582bd00',
);
const inlineCapacity = 0x30c;

function inlineName(pointer: BurikoBpPointer | null): Uint8Array {
  if (pointer === null) throw new Error('Buriko asynchronous music constructor reads a null name');
  const source = textBytes(pointer, true);
  if (source.length > inlineCapacity)
    throw new RangeError('Buriko asynchronous music name exceeds its native inline field');
  const inline = new Uint8Array(inlineCapacity);
  inline.set(source);
  return inline;
}

/** DCProcSetMusic 09D960/09D810/09D920, borrowing its two inline name arrays into FDF80. */
export class BurikoSetMusicProcess extends BurikoProcedure {
  /** Native result storage at +660 is unwritten until FDF80 on the first poll. */
  readonly result = {} as BurikoResourceResult;
  readonly archive: Uint8Array;
  readonly name: Uint8Array;
  private firstPoll: boolean;
  private readonly actor: object;
  private readonly channel: number;
  private readonly volume: number;
  private readonly pan: number;

  constructor(
    private readonly context: BurikoBpOpcodeContext,
    procedures: BurikoProcedureState,
    clock: BurikoNativeClock,
    private readonly loading: BurikoResourceLoadingState,
    private readonly queues: BurikoAudioLoaderQueues,
    channel: number,
    archive: BurikoBpPointer | null,
    name: BurikoBpPointer | null,
    volume: number,
    pan: number,
  ) {
    super(context.thread, procedures, clock);
    if (queues.loading !== loading)
      throw new Error('Buriko set-music process must share the actual loading count');
    this.actor = context.actor ?? queues.metadata.allocator.currentActor;
    this.channel = channel >>> 0;
    // Native copies archive before name, forward through each terminator. Null archive is invalid.
    this.archive = inlineName(archive);
    this.name = inlineName(name);
    this.volume = volume | 0;
    this.pan = pan | 0;
    this.firstPoll = true;
    loading.enterProcedure();
  }

  poll(): number | Promise<number> {
    if (this.firstPoll) {
      this.queues.enqueueMusic(
        this.result,
        this.channel,
        this.archive,
        this.name,
        this.volume,
        this.pan,
        this.actor,
      );
      this.firstPoll = false;
      return 0;
    }
    const value = this.result.value >>> 0;
    if (value === 1) return 0;
    if (value === 0) return 1;
    const message =
      value === 0x80000001
        ? formatBurikoAudioNames(burikoSetMusicMissingDiagnostic, [this.archive, this.name], 256)
        : value === 0x80000002
          ? formatBurikoAudioNames(
              burikoSetMusicInvalidWaveDiagnostic,
              [this.archive, this.name],
              256,
            )
          : burikoSetMusicGenericFailureDiagnostic;
    return this.loading.resources.errors.threadFatal(
      this.thread,
      this.context.diagnostics,
      message,
    );
  }

  override dispose(): void {
    this.loading.leaveProcedure();
    super.dispose();
  }
}
