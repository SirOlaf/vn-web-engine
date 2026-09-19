import {pointerView, type AokanaBpPointer} from '../bp/memory.js';
import type {AokanaNativeClock} from './clock.js';
import type {AokanaEngineDialogs} from './engine-dialogs.js';
import {terminatedNativeBytes} from './program-files.js';
import {textBytes} from './text.js';

export interface AokanaFileDialogRequest {
  readonly structureSize: 0x98;
  /** Opaque identity of the title's current shared main window. */
  readonly owner: object;
  /** Raw ANSI description/pattern pairs ending in a second NUL. */
  readonly filter: Uint8Array;
  readonly filterIndex: 1;
  readonly fileCapacity: 0x30c;
  readonly initialDirectory: Uint8Array | null;
  readonly title: Uint8Array | null;
  readonly defaultExtension: null;
  readonly flags: number;
}

/** Explicit GetOpenFileNameA/GetSaveFileNameA boundary returning a raw ANSI path. */
export interface AokanaFileDialogHost {
  selectOpenFile(request: AokanaFileDialogRequest): Promise<Uint8Array | null>;
  selectSaveFile(request: AokanaFileDialogRequest): Promise<Uint8Array | null>;
}

function writableBytes(pointer: AokanaBpPointer | null, length: number): Uint8Array {
  const view = pointerView(pointer!, length);
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

/** BAF00's shared ANSI file picker with its narrower display/clock modal barriers. */
export class AokanaFileSelectionService {
  constructor(
    private readonly dialogs: AokanaEngineDialogs,
    private readonly clock: AokanaNativeClock,
    private readonly mainWindowIdentity: object,
    private readonly host: AokanaFileDialogHost,
  ) {}

  private packFilters(
    count: number,
    descriptions: readonly (AokanaBpPointer | null)[],
    patterns: readonly (AokanaBpPointer | null)[],
  ): Uint8Array {
    const storage = new Uint8Array(1024);
    let offset = 0;
    for (let index = 0; index < count; index++) {
      const description = textBytes(descriptions[index]!),
        pattern = textBytes(patterns[index]!);
      if (offset + description.length + pattern.length + 3 > storage.length)
        throw new RangeError('Aokana ANSI file filter overwrites its native stack buffer');
      storage.set(description, offset);
      offset += description.length;
      storage[offset++] = 0;
      storage.set(pattern, offset);
      offset += pattern.length;
      storage[offset++] = 0;
    }
    storage[offset++] = 0;
    return storage.slice(0, offset);
  }

  async select(
    output: AokanaBpPointer | null,
    count: number,
    descriptions: readonly (AokanaBpPointer | null)[],
    patterns: readonly (AokanaBpPointer | null)[],
    title: AokanaBpPointer | null,
    initialDirectory: AokanaBpPointer | null,
    mode: number,
  ): Promise<0 | 4 | 7 | 0xffffffff> {
    count >>>= 0;
    if (count === 0) return 7;

    this.dialogs.transition(true);
    this.clock.beginSuspension(true);
    try {
      writableBytes(output, 0x30c).fill(0);
      const filter = this.packFilters(count, descriptions, patterns);
      mode >>>= 0;
      if (mode !== 0 && mode !== 1) return 4;

      const request: AokanaFileDialogRequest = {
          structureSize: 0x98,
          owner: this.mainWindowIdentity,
          filter,
          filterIndex: 1,
          fileCapacity: 0x30c,
          initialDirectory:
            initialDirectory === null ? null : textBytes(initialDirectory, true).slice(),
          title: title === null ? null : textBytes(title, true).slice(),
          defaultExtension: null,
          flags: mode === 0 ? 0x1804 : 0x806,
        },
        selected = await (mode === 0
          ? this.host.selectOpenFile(request)
          : this.host.selectSaveFile(request));
      if (selected === null) return 0xffffffff;
      const path = terminatedNativeBytes(selected).slice();
      if (path.length > 0x30c)
        throw new RangeError('Aokana selected ANSI path exceeds its native file buffer');
      writableBytes(output, 0x30c).set(path);
      return 0;
    } finally {
      this.clock.endSuspension();
      this.dialogs.transition(false);
    }
  }
}
