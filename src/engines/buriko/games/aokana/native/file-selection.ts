import {pointerView, type AokanaBpPointer} from '../bp/memory.js';
import type {
  WindowsFileDialogHost,
  WindowsFileDialogRequest,
} from '../../../../../platform/windows-picker.js';
import type {AokanaNativeClock} from './clock.js';
import type {AokanaEngineDialogs} from './engine-dialogs.js';
import {terminatedNativeBytes} from './program-files.js';
import {textBytes} from './text.js';

export type AokanaFileDialogRequest = WindowsFileDialogRequest;
export type AokanaFileDialogHost = WindowsFileDialogHost;

function writableBytes(pointer: AokanaBpPointer | null, length: number): Uint8Array {
  const view = pointerView(pointer!, length);
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

/** BAF00's shared ANSI file picker with its narrower display/clock modal barriers. */
export class AokanaFileSelectionService {
  constructor(
    readonly dialogs: AokanaEngineDialogs,
    readonly clock: AokanaNativeClock,
    readonly mainWindowIdentity: object,
    readonly host: AokanaFileDialogHost,
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

  /** BAE50 formats original ANSI bytes before entering the shared modal picker. */
  selectExtension(
    output: AokanaBpPointer | null,
    description: AokanaBpPointer | null,
    extension: AokanaBpPointer | null,
    title: AokanaBpPointer | null,
    initialDirectory: AokanaBpPointer | null,
    mode: number,
  ): Promise<0 | 4 | 7 | 0xffffffff> {
    if (extension === null) throw new RangeError('Aokana file extension consumed a null string');
    const suffix = textBytes(extension),
      pattern = new Uint8Array(suffix.length + 3);
    if (pattern.length > 1024)
      throw new RangeError('Aokana extension pattern exceeds native scratch');
    pattern.set([42, 46]);
    pattern.set(suffix, 2);
    if (description === null)
      throw new RangeError('Aokana file description consumed a null string');
    const label = textBytes(description),
      combined = new Uint8Array(label.length + pattern.length + 2);
    if (combined.length > 1024)
      throw new RangeError('Aokana extension description exceeds native scratch');
    combined.set(label);
    combined[label.length] = 40;
    combined.set(pattern.subarray(0, -1), label.length + 1);
    combined[combined.length - 2] = 41;
    return this.select(
      output,
      1,
      [{bytes: combined, offset: 0}],
      [{bytes: pattern, offset: 0}],
      title,
      initialDirectory,
      mode,
    );
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
          defaultExtension: Uint8Array.of(0),
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
