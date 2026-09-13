import type {AokanaBpThread} from '../bp/state.js';
import type {AokanaBpDiagnostics} from './diagnostics.js';
import {AokanaEngineDialogs, AokanaNativeExit} from './engine-dialogs.js';
import {AokanaProgramFiles, terminatedNativeBytes} from './program-files.js';
import {textBytes} from './text.js';

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

  async fatal(message: Uint8Array): Promise<never> {
    if (this.captured === null) await this.show(message);
    if (this.captureEnabled !== 0 && this.captured === null) this.captured = terminatedNativeBytes(message).slice();
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
