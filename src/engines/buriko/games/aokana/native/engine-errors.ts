import type {AokanaBpPointer} from '../bp/memory.js';
import type {AokanaBpThread} from '../bp/state.js';
import type {AokanaBpDiagnostics} from './diagnostics.js';
import {AokanaEngineDialogs, AokanaNativeExit} from './engine-dialogs.js';
import {AokanaProgramFiles, terminatedNativeBytes} from './program-files.js';
import {copyText, textBytes, textLength} from './text.js';

/** 1400b8f00/1400b9570 fatal dialog, first-error capture, BGIError.txt, and native unwind code. */
export class AokanaEngineErrors {
  captureEnabled = 0;
  captured: Uint8Array | null = null;
  constructor(
    readonly files: AokanaProgramFiles,
    readonly dialogs: AokanaEngineDialogs,
    public errorDirectory: Uint8Array,
    public workingDirectory: Uint8Array,
  ) {}

  async show(message: Uint8Array): Promise<void> {
    await this.dialogs.show(message, Uint8Array.of(69, 114, 114, 111, 114, 33, 33, 0), 0x1010);
  }

  /** B9070 stores the complete incoming DWORD without normalizing it to a Boolean. */
  setCaptureEnabled(value: number): void {this.captureEnabled = value >>> 0;}

  /** B9060 returns the same raw capture-enable DWORD. */
  getCaptureEnabled(): number {return this.captureEnabled >>> 0;}

  /** B8F80 keeps only the first message and owns its terminating NUL. */
  captureFirst(message: Uint8Array): number {
    if (this.captured !== null) return 0;
    this.captured = terminatedNativeBytes(message).slice();
    return 1;
  }

  /** B8FE0 optionally copies the first captured message and includes NUL in its length. */
  readCaptured(output: AokanaBpPointer | null): number {
    if (this.captured === null) return 0;
    const source = {bytes: this.captured, offset: 0}, length = (textLength(source) + 1) >>> 0;
    if (output !== null) copyText(output, source);
    return length;
  }

  /** B9030 clears the single captured-message owner. */
  clearCaptured(): void {this.captured = null;}

  async fatal(message: Uint8Array): Promise<never> {
    if (this.readCaptured(null) === 0) await this.show(message);
    if (this.getCaptureEnabled() !== 0) this.captureFirst(message);
    throw new AokanaNativeExit(0x7fffffff, this.files.path(message));
  }

  async threadFatal(thread: AokanaBpThread, diagnostics: AokanaBpDiagnostics, message: Uint8Array): Promise<never> {
    const formatted = diagnostics.formatThreadMessage(thread, textBytes({bytes: terminatedNativeBytes(message), offset: 0}));
    const root = this.files.text.convertEncoding({bytes: terminatedNativeBytes(this.errorDirectory), offset: 0}, 1);
    const name = new TextEncoder().encode('BGIError.txt\0');
    let path: Uint8Array = new Uint8Array(root.length - 1 + name.length);
    path.set(root.subarray(0, -1));
    path.set(name, root.length - 1);
    if (path.length > 784) throw new RangeError('Aokana error path exceeds native scratch');
    if (path[0] !== 92 && path[1] !== 58) {
      const prefix = this.files.path(this.workingDirectory);
      path = this.files.text.encodeWide(prefix + this.files.path(path), 1);
    }
    await this.files.write(path, formatted);
    return this.fatal(formatted);
  }
}
