import {FileError} from '../../../platform/filesystem.js';
import {pointerView, type BurikoBpPointer} from '../bp/memory.js';
import type {BurikoProgramResources} from './program-resources.js';
import {updateNativeChecksum} from './group-81-hash.js';
import {textByte, textBytes} from './text.js';
import {assertBurikoPathDomain} from './path-domain.js';
import {BurikoUndefinedResourceRead} from './resource-memory.js';

/** E69A0/032240 streams raw file bytes into the canonical032320 checksum. */
export class BurikoFileChecksum {
  constructor(readonly resources: BurikoProgramResources) {}
  async calculate(output: BurikoBpPointer | null, name: BurikoBpPointer | null): Promise<0 | 1> {
    if (name === null) throw new RangeError('Buriko file checksum consumed a null filename');
    const qualified =
        textByte(name.bytes, name.offset) === 92 || textByte(name.bytes, name.offset + 1) === 58,
      original = textBytes(name, true),
      files = this.resources.files;
    assertBurikoPathDomain(files.text.decodeAuto(name));
    const path = qualified
      ? original.slice()
      : this.resources.loosePath(this.resources.configuration.primaryRoot, original);
    if (path.length > 784) throw new RangeError('Buriko file checksum path exceeds native scratch');
    if (files.path(path).length >= 784)
      throw new RangeError('Buriko file checksum path exceeds native wide scratch');
    const opened = await files.open(path);
    if (opened.source === null) return 0;
    let remaining = opened.source.size >>> 0,
      cursor = 0;
    const scratch = new Uint8Array(65536),
      initialized = new Uint8Array(65536);
    if (output === null) throw new RangeError('Buriko file checksum consumed a null output');
    const state = pointerView(output, 8);
    new Uint8Array(state.buffer, state.byteOffset, 8).fill(0);
    while (remaining !== 0) {
      const requested = Math.min(remaining, 65536);
      let bytes: Uint8Array;
      try {
        bytes = await files.read(opened.source, cursor, requested);
      } catch (error) {
        if (!(error instanceof FileError || error instanceof DOMException)) throw error;
        bytes = new Uint8Array();
      }
      if (bytes.length > requested)
        throw new RangeError('Buriko file host returned more bytes than requested');
      scratch.set(bytes);
      initialized.fill(1, 0, bytes.length);
      cursor += bytes.length;
      let written = 0;
      while (written < requested && initialized[written] !== 0) written++;
      updateNativeChecksum(output, {bytes: scratch, offset: 0}, written);
      if (written !== requested)
        throw new BurikoUndefinedResourceRead(
          'Buriko file checksum consumes unwritten retained scratch',
        );
      remaining = (remaining - requested) >>> 0;
    }
    return 1;
  }
}
