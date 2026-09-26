import type {BurikoBpPointer} from '../bp/memory.js';
import {BurikoProgramFiles, terminatedNativeBytes} from './program-files.js';
import {assertBurikoPathDomain} from './path-domain.js';
import {textBytes} from './text.js';

/** Shared byte root1E8D70 consumed by errors, GDB and native save slots. */
export class BurikoSaveRoot {
  bytes: Uint8Array;
  constructor(
    readonly files: BurikoProgramFiles,
    bytes: Uint8Array,
  ) {
    this.bytes = bytes.slice();
  }
  /** C1C40 examines original final byte, not an encoding-aware character or normalized path. */
  async set(path: BurikoBpPointer | null): Promise<0 | 1> {
    if (path === null) throw new RangeError('Buriko save root consumed a null path');
    const wide = this.files.text.decodeAuto(path);
    if (wide.length >= 784) throw new RangeError('Buriko save root exceeds native wide scratch');
    assertBurikoPathDomain(wide);
    if (!(await this.files.isDirectoryWide(wide))) return 0;
    const source = textBytes(path);
    if (source.length === 0)
      throw new RangeError('Buriko save root reads before an empty native path');
    const append = source[source.length - 1] !== 92;
    const result = new Uint8Array(source.length + (append ? 2 : 1));
    if (result.length > 784) throw new RangeError('Buriko save root exceeds native byte buffer');
    result.set(source);
    if (append) result[source.length] = 92;
    this.bytes = result;
    return 1;
  }
  /** C1CE0/BD370 concatenate UTF8 root+filename without inserting another separator. */
  path(name: Uint8Array): Uint8Array {
    const first = this.files.text.convertEncoding(
        {bytes: terminatedNativeBytes(this.bytes), offset: 0},
        1,
      ),
      second = this.files.text.convertEncoding({bytes: terminatedNativeBytes(name), offset: 0}, 1),
      result = new Uint8Array(first.length - 1 + second.length);
    if (result.length > 784) throw new RangeError('Buriko save filename exceeds native scratch');
    result.set(first.subarray(0, -1));
    result.set(second, first.length - 1);
    return result;
  }
}
