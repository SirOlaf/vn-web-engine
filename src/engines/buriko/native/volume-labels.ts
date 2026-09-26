import type {BurikoBpPointer} from '../bp/memory.js';
import {terminatedNativeBytes} from './program-files.js';
import {textByte, writeText} from './text.js';

/** Synchronous SetErrorMode/GetVolumeInformationA boundary; native hosts restore the prior mode. */
export interface BurikoVolumeLabelHost {
  readVolumeLabel(root: Uint8Array, output: BurikoBpPointer | null, capacity: number): number;
}

/** Concrete selected ANSI labels; no mounted-directory or drive-type label is inferred. */
export class BurikoVolumeLabelProfile implements BurikoVolumeLabelHost {
  private readonly labels = new Map<number, Uint8Array>();
  constructor(entries: Iterable<readonly [number, Uint8Array]>) {
    for (const [driveByte, source] of entries) {
      if (!Number.isInteger(driveByte) || driveByte < 0 || driveByte > 0xff)
        throw new RangeError('Buriko volume-label drive keys must be bytes');
      const label = terminatedNativeBytes(source).slice();
      if (label.length > 0x30c)
        throw new RangeError('Buriko configured volume label exceeds the native ANSI capacity');
      this.labels.set(driveByte, label);
    }
  }

  readVolumeLabel(root: Uint8Array, output: BurikoBpPointer | null, capacity: number): number {
    if (
      root.length !== 4 ||
      root[1] !== 58 ||
      root[2] !== 92 ||
      root[3] !== 0 ||
      capacity !== 0x30c
    )
      throw new RangeError('Buriko volume-label profile requires the native ANSI root contract');
    const label = this.labels.get(root[0]!);
    if (label === undefined) return 0;
    if (output !== null) writeText(output, label);
    return 1;
  }
}

export class BurikoVolumeLabels {
  constructor(readonly host: BurikoVolumeLabelHost) {}

  /** B9A70 uses only the first input byte and formats exactly "%c:\\". */
  read(output: BurikoBpPointer | null, drive: BurikoBpPointer): number {
    const first = textByte(drive.bytes, drive.offset);
    return this.host.readVolumeLabel(Uint8Array.of(first, 58, 92, 0), output, 0x30c) >>> 0;
  }
}
