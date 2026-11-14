/**
 * The core log (krkrz `utils/DebugIntf.cpp`): timestamped lines kept for `Debug.getLastLog`,
 * important lines kept for the log file, script logging handlers, and `krkr.console.log` in
 * the log location once logging to file has started.
 */
import {closureFuncCall} from '../tjs2/runtime/dispatch.js';
import {obj, str, type ObjectVariant} from '../tjs2/runtime/variant.js';
import type {Suspender} from '../tjs2/runtime/suspension.js';

const LOG_MAX_LINES = 2048;
const LOG_TO_FILE_ROLL_BACK = 100;

export interface LogClock {
  /** Seconds since 1970 (`time`). */
  time(): number;
  /** Local time of day for a `time()` value (`localtime`). */
  localTime(seconds: number): {hours: number; minutes: number; seconds: number};
}

export interface LogFile {
  /** Appends text to `krkr.console.log` in the log location (UTF-16LE, BOM on a new file). */
  append(text: string): void;
  /** Truncates the log file. */
  clear(): void;
}

export class TvpLog {
  readonly #lines: {log: string; time: string}[] = [];
  #important = '';
  #handlers: (ObjectVariant | null)[] = [];
  #inDeliver = false;
  #prevTime = -1;
  #timeBuf = '';
  #loggingToFile = false;
  autoLogToFileOnError = true;
  autoClearLogOnError = false;

  constructor(
    private readonly clock: LogClock,
    private readonly suspender: Suspender,
    /** Receives every formatted line (`TVP_LOG_TO_COMMANDLINE_CONSOLE`, debugger output). */
    private readonly output: (line: string, important: boolean) => void,
    public file: LogFile | null = null,
  ) {}

  /** `TVPAddLog` / `TVPAddImportantLog`. */
  add(line: string, important = false): void {
    const now = this.clock.time();
    if (now !== this.#prevTime) {
      const t = this.clock.localTime(now);
      const two = (n: number) => String(n).padStart(2, '0');
      this.#timeBuf = `${two(t.hours)}:${two(t.minutes)}:${two(t.seconds)}`;
      this.#prevTime = now;
    }
    this.#lines.push({log: line, time: this.#timeBuf});
    if (important) this.#important += `${this.#timeBuf} ! ${line}\r\n`;
    while (this.#lines.length >= LOG_MAX_LINES + 100) this.#lines.splice(0, 100);
    const buf = `${this.#timeBuf} ${line}`;
    if (this.#handlers.length) this.#deliver(buf);
    this.output(buf, important);
    if (this.#loggingToFile) this.file?.append(buf + '\r\n');
  }

  /** `_TVPDeliverLoggingEvent`: calls each handler; a failing handler is dropped. */
  #deliver(line: string): void {
    if (this.#inDeliver) return;
    this.#inDeliver = true;
    try {
      let empty = false;
      for (let i = 0; i < this.#handlers.length; i++) {
        const h = this.#handlers[i];
        if (!h) {
          empty = true;
          continue;
        }
        let er: number;
        try {
          er = this.suspender.nonSuspending(() =>
            closureFuncCall(h, 0, null, null, [str(line)], null),
          );
        } catch (e) {
          this.#drop(i);
          throw e;
        }
        if (er < 0) {
          this.#drop(i);
          empty = true;
        }
      }
      if (empty) this.#handlers = this.#handlers.filter((h) => h !== null);
    } finally {
      this.#inDeliver = false;
    }
  }

  #drop(i: number): void {
    const h = this.#handlers[i];
    if (!h) return;
    h.object?.release();
    h.objthis?.release();
    this.#handlers[i] = null;
  }

  /** `TVPAddLoggingHandler`: adds a closure once. */
  addHandler(closure: ObjectVariant): void {
    if (
      this.#handlers.some((h) => h && h.object === closure.object && h.objthis === closure.objthis)
    )
      return;
    closure.object?.addRef();
    closure.objthis?.addRef();
    this.#handlers.push(obj(closure.object, closure.objthis));
  }

  /** `TVPRemoveLoggingHandler`. */
  removeHandler(closure: ObjectVariant): void {
    const i = this.#handlers.findIndex(
      (h) => h && h.object === closure.object && h.objthis === closure.objthis,
    );
    if (i >= 0) this.#drop(i);
    if (!this.#inDeliver) this.#handlers = this.#handlers.filter((h) => h !== null);
  }

  /** `TVPGetLastLog`: the last n lines with their times, CR LF terminated. */
  lastLog(n = LOG_MAX_LINES + 100): string {
    const lines = this.#lines.slice(Math.max(0, this.#lines.length - n));
    return lines.map((l) => `${l.time} ${l.log}\r\n`).join('');
  }

  get importantLog(): string {
    return this.#important;
  }

  /** `TVPStartLogToFile`. */
  startLogToFile(clear: boolean): void {
    if (this.#loggingToFile) return;
    if (clear) this.file?.clear();
    this.file?.append(this.#important + '\r\n');
    this.file?.append(
      '\r\n------------------------------------------------------------------------------\r\n\r\n',
    );
    this.file?.append(this.lastLog(LOG_TO_FILE_ROLL_BACK) + '\r\n');
    this.#loggingToFile = true;
  }

  /** `TVPOnError`. */
  onError(): void {
    if (this.autoLogToFileOnError) this.startLogToFile(this.autoClearLogOnError);
  }

  /** Releases the handlers (`TVPDestroyLoggingHandlerVector`). */
  dispose(): void {
    for (let i = 0; i < this.#handlers.length; i++) this.#drop(i);
    this.#handlers = [];
  }
}
