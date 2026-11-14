import type {AsbTag} from '../../formats/artemis/asb.js';
import {artemisRevision} from './revision.js';

export interface ArtemisScriptEventHost {
  /** Actual native run mode c70; the producer owns its lifecycle/mapping. */
  nativeMode(): number;
  disabled(): boolean;
  /** b73e0 latches30/31; the frame/control owner decides when they clear. */
  latched(mode: 0 | 1): boolean;
  latch(mode: 0 | 1): void;
  /** The event filter's status, or 'held' when the owner holds the filter on resource work
   * (native loads synchronously inside it) and later finishes the dispatch through `resume`
   * with the status or the filter's failure. */
  filter(command: AsbTag, resume: (result: ArtemisEventFilterResume) => void): number | 'held';
  report(kind: 'filter' | 'default', command: AsbTag, error: unknown): void;
  /** Default event transfers return the native failed flag, not consumed status. */
  jump(file: string, label: string): boolean;
  call(file: string, label: string): boolean;
  /** Save caret, install empty caret and push a fresh local variable scope. */
  enterHandlerScope(): void;
  /** Priority script queue, sourceLine0; never invoke a Lua handler directly. */
  enqueueHandler(command: AsbTag): void;
}
export type ArtemisEventFilterResume = {readonly status: number} | {readonly error: unknown};
export type ArtemisScriptEventResult =
  | {readonly status: 'suppressed' | 'queued'}
  | {readonly status: 'delivered'; readonly failed: boolean};
const copy = (command: AsbTag): AsbTag => ({...command, args: new Map(command.args)});

/** b73e0 deferred event queue and c6730 default dispatcher. Native mode/latches,
 * transfer effects and local-scope storage remain required concrete owners.
 */
export class ArtemisScriptEvents {
  private pending: AsbTag[] = [];
  constructor(
    hash: string,
    private readonly host: ArtemisScriptEventHost,
  ) {
    artemisRevision(hash);
  }
  get queuedEvents(): number {
    return this.pending.length;
  }
  private immediate(): boolean {
    const mode = this.host.nativeMode();
    if (!Number.isInteger(mode) || mode < -0x80000000 || mode > 0x7fffffff)
      throw Error('Unsupported Artemis native event mode');
    return mode === 0 || mode === 1 || mode === 3 || mode === 4;
  }
  emit(command: AsbTag, mode: number, force: boolean): ArtemisScriptEventResult {
    if (!Number.isInteger(mode) || mode < -0x80000000 || mode > 0x7fffffff)
      throw Error('Unsupported Artemis native event latch mode');
    if (this.host.disabled()) return {status: 'suppressed'};
    if (!force && (mode === 0 || mode === 1)) {
      if (this.host.latched(mode)) return {status: 'suppressed'};
      this.host.latch(mode);
    }
    const captured = copy(command);
    if (this.immediate()) return {status: 'delivered', failed: this.dispatch(captured)};
    if (this.pending.length >= 10000) throw Error('Artemis deferred event queue limit exceeded');
    this.pending.push(captured);
    return {status: 'queued'};
  }
  /** c6480: after restoring the previous mode, dispatch the captured queue from
   * back to front, ignoring failed flags, then clear it. No eligibility/latch test
   * is repeated. Registrations added during this pass are cleared with the queue.
   */
  releasePending(): readonly boolean[] {
    const commands = this.pending.slice();
    const results: boolean[] = [];
    for (let index = commands.length - 1; index >= 0; index--)
      results.push(this.dispatch(commands[index]!));
    this.pending = [];
    return results;
  }
  clear(): void {
    this.pending = [];
  }
  /** A held filter reports a delivered, not failed, event; its default dispatch follows when
   * the owner resumes it. */
  dispatch(input: AsbTag): boolean {
    const command = copy(input);
    if (!command.name) return true;
    let status: number | 'held';
    try {
      status = this.host.filter(command, (result) => {
        if ('error' in result) {
          this.host.report('filter', command, result.error);
          this.dispatchDefault(command);
        } else this.filtered(command, result.status);
      });
    } catch (error) {
      this.host.report('filter', command, error);
      return this.dispatchDefault(command);
    }
    return status === 'held' ? false : this.filtered(command, status);
  }
  private filtered(command: AsbTag, status: number): boolean {
    if (!Number.isInteger(status) || status < -0x80000000 || status > 0x7fffffff) {
      this.host.report('filter', command, Error('Unsupported Artemis event filter result'));
      return this.dispatchDefault(command);
    }
    return status !== 0 ? status === 2 : this.dispatchDefault(command);
  }
  private dispatchDefault(command: AsbTag): boolean {
    const args = command.args;
    try {
      if (args.has('file') || args.has('label')) {
        const file = args.get('file') ?? '',
          label = args.get('label') ?? '';
        const failed =
          args.has('call') && args.get('call') !== '0'
            ? this.host.call(file, label)
            : this.host.jump(file, label);
        if (failed) return true;
      } else if (args.has('handler')) this.host.enterHandlerScope();
      if (args.has('handler'))
        this.host.enqueueHandler({
          kind: 'tag',
          name: args.get('handler')!,
          sourceLine: 0,
          args: new Map(args),
        });
      return false;
    } catch (error) {
      this.host.report('default', command, error);
      return true;
    }
  }
}

/** Actual Lua filter + script cursor/queue/scope adapter. The application must
 * supply native mode/latches; no ready/waiting enum is silently guessed here. A `filter` in
 * `control` replaces the synchronous Lua filter, for owners that hold it on resource work.
 */
export function createArtemisScriptEvents(
  hash: string,
  lua: import('./lua.js').ArtemisLua,
  script: import('./script.js').ArtemisScript,
  control: Pick<
    ArtemisScriptEventHost,
    'nativeMode' | 'disabled' | 'latched' | 'latch' | 'report'
  > &
    Partial<Pick<ArtemisScriptEventHost, 'filter'>>,
): ArtemisScriptEvents {
  return new ArtemisScriptEvents(hash, {
    filter: (command) => lua.filterEvent(command),
    ...control,
    jump: (file, label) => {
      script.jump(file, label);
      return false;
    },
    call: (file, label) => {
      script.call(file, label);
      return false;
    },
    enterHandlerScope: () => script.enterEventHandlerScope(),
    enqueueHandler: (command) => script.enqueue(command),
  });
}
