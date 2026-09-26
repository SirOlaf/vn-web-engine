import {requireDeterminateMemory} from '../../../core/indeterminate-memory.js';
import {FileError} from '../../../platform/filesystem.js';
import {pointerView, type BurikoBpPointer} from '../bp/memory.js';
import {BurikoProgramOutputFile} from './program-files.js';
import type {BurikoProgramResources, BurikoArchiveName} from './program-resources.js';
import {assertBurikoPathDomain} from './path-domain.js';
import {textBytes} from './text.js';

function required(pointer: BurikoBpPointer | null): BurikoBpPointer {
  if (pointer === null)
    throw new RangeError('Buriko resource file service consumed a null native name');
  return pointer;
}
function bounded(path: string, capacity = 784): string {
  if (path.length >= capacity)
    throw new RangeError('Buriko resource file path exceeds native wide scratch');
  assertBurikoPathDomain(path);
  return path;
}
/** BCC10/E93A0/BD950 use the live ProgramResources roots, file, media and archive owners. */
export class BurikoResourceFileServices {
  constructor(readonly resources: BurikoProgramResources) {}
  private qualified(name: BurikoBpPointer): boolean {
    const bytes = textBytes(name, true);
    return bytes[0] === 92 || bytes[1] === 58;
  }
  private decode(name: BurikoBpPointer | null): string {
    return this.resources.files.text.decodeAuto(required(name));
  }
  async write(
    name: BurikoBpPointer | null,
    data: BurikoBpPointer | null,
    length: number,
  ): Promise<number> {
    const files = this.resources.files,
      pointer = required(name);
    const path = bounded(
      (this.qualified(pointer) ? '' : this.resources.configuration.nativeFileRoot) +
        this.decode(pointer),
    );
    length >>>= 0;
    let output: BurikoProgramOutputFile | null;
    // createOutput uses this same mounted owner and CREATE_ALWAYS truncation before writing.
    output = await files.createOutput(files.text.encodeWide(path, 1));
    if (output === null) return 0;
    try {
      if (length === 0) return await output.write(new Uint8Array());
      const view = pointerView(required(data), length);
      requireDeterminateMemory(data!.bytes, data!.offset, length);
      return await output.write(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
    } finally {
      output.close();
    }
  }
  async remove(explicit: BurikoBpPointer | null, name: BurikoBpPointer | null): Promise<number> {
    const files = this.resources.files;
    if (files.metadata === null)
      throw new Error('Buriko resource deletion requires shared metadata owner');
    const path = bounded(
      explicit === null
        ? this.resources.configuration.nativeFileRoot + this.decode(name)
        : this.decode(explicit),
    );
    try {
      await files.metadata.deleteFile(files.mountedPath(path));
      return 1;
    } catch (error) {
      if (error instanceof FileError || error instanceof DOMException) return 0;
      throw error;
    }
  }
  async available(
    archive: BurikoArchiveName | null,
    name: BurikoBpPointer | null,
  ): Promise<number> {
    return this.resources.isAvailable(archive, required(name));
  }
}
