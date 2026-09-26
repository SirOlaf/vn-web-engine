import type {AokanaBpPointer} from '../bp/memory.js';
import {push32, type AokanaBpThread} from '../bp/state.js';
import type {AokanaNativeClock} from './clock.js';
import {AokanaBrowserMfMovieSession} from './movie-mf-browser-session.js';
import {AokanaProcedure, type AokanaProcedureState} from './procedure.js';
import {textBytes} from './text.js';

/** DCProcPlayMovieByMF 09D020/09CF00 with independently owned C-string operands. */
export class AokanaMfMovieProcess extends AokanaProcedure {
  private phase = 0;
  private result = -1;
  private readonly archive: Uint8Array | null;
  private readonly name: Uint8Array | null;

  constructor(
    thread: AokanaBpThread,
    procedures: AokanaProcedureState,
    clock: AokanaNativeClock,
    readonly session: AokanaBrowserMfMovieSession,
    archive: AokanaBpPointer | null,
    name: AokanaBpPointer | null,
    private readonly volume: number,
  ) {
    super(thread, procedures, clock);
    this.archive = archive === null ? null : textBytes(archive, true).slice();
    this.name = name === null ? null : textBytes(name, true).slice();
  }

  needsLiveOperandStorageOnDispose(): boolean {
    return true;
  }

  async poll(): Promise<number> {
    this.consumeMessages();
    if (this.phase === 0) {
      if (this.name === null) {
        this.result = -3;
        return 1;
      }
      const archive = this.archive === null ? null : {bytes: this.archive, offset: 0};
      const name = {bytes: this.name, offset: 0};
      const status = await this.session.start(archive, name, this.volume);
      if (status === 0) {
        this.phase = 1;
        return 0;
      }
      this.result =
        status === 0x80000001
          ? -1
          : status === 0x80000003
            ? -3
            : status === 0x80000004
              ? -4
              : status;
      return 1;
    }
    const status = this.session.pollStatus();
    if (status === 0) return 0;
    if (status === 2 || status === 0x80000002) {
      this.result = 0;
      return 1;
    }
    throw new Error('Aokana MF process reads an unwritten controller poll status');
  }

  override dispose(): void {
    push32(this.thread, this.result);
    super.dispose();
  }
}
