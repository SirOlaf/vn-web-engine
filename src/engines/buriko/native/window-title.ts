import {pointerView, type BurikoBpPointer} from '../bp/memory.js';
import type {BurikoBrowserMainWindow} from './browser-main-window.js';
import type {BurikoEngineDialogs} from './engine-dialogs.js';
import type {BurikoChildWindows} from './child-windows.js';
import type {BurikoPropertyEditors} from './property-editor.js';
import type {BurikoNativeText} from './text.js';

/** The fixed original-encoding global1E8BE0, shared by every default-title consumer. */
export class BurikoWindowTitle {
  readonly bytes = new Uint8Array(256);

  constructor(initial: Uint8Array = Uint8Array.of(0)) {
    this.copy({bytes: initial, offset: 0});
  }

  validateConsumers(
    dialogs: BurikoEngineDialogs,
    children: BurikoChildWindows,
    properties: BurikoPropertyEditors,
  ): void {
    if (
      dialogs.fallbackTitle !== this.bytes ||
      children.nativeWindowTitle !== this.bytes ||
      properties.nativeWindowTitle !== this.bytes
    )
      throw new Error('Buriko main-window title requires shared default-title storage');
  }

  set(source: BurikoBpPointer | null, text: BurikoNativeText, host: BurikoBrowserMainWindow): void {
    if (source === null) throw new RangeError('Buriko window title dereferences a null string');
    const decoded = text.decodeAuto(source);
    if (host.setCaption(decoded)) this.copy(source);
  }

  /** C1110 scans first, then copies forward, retaining bytes beyond the new terminator. */
  private copy(source: BurikoBpPointer): void {
    const read = (index: number) =>
      pointerView({bytes: source.bytes, offset: source.offset + index}, 1).getUint8(0);
    let length = 0;
    while (read(length) !== 0) length++;
    if (length >>> 0 < 256) {
      for (let index = 0; ; index++) {
        const value = read(index);
        this.bytes[index] = value;
        if (value === 0) break;
      }
    } else {
      for (let index = 0; index < 255; index++) this.bytes[index] = read(index);
      this.bytes[255] = 0;
    }
  }
}
