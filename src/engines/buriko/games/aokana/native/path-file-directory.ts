import {FileError} from '../../../../../platform/filesystem.js';
import {pointerView, type AokanaBpPointer} from '../bp/memory.js';
import type {AokanaMountedFileMetadata} from './file-metadata.js';
import type {AokanaProgramFiles} from './program-files.js';

function required(pointer: AokanaBpPointer | null): AokanaBpPointer {
  if (pointer === null) throw new RangeError('Aokana path service consumed a null native path');
  return pointer;
}

function apiFailure(error: unknown): boolean {
  return error instanceof FileError || error instanceof DOMException;
}

/** E9880–E9640 share the program's mounted paths, encoding and metadata owner. */
export class AokanaPathFileDirectory {
  readonly metadata: AokanaMountedFileMetadata;

  constructor(readonly files: AokanaProgramFiles) {
    if (files.metadata === null)
      throw new Error('Aokana path services require the shared mounted file metadata owner');
    this.metadata = files.metadata;
  }

  private path(pointer: AokanaBpPointer | null): string {
    return this.files.mountedPath(this.files.text.decodeAuto(required(pointer)));
  }

  async createDirectory(path: AokanaBpPointer | null): Promise<number> {
    try {
      await this.metadata.createDirectory(this.path(path));
      return 1;
    } catch (error) {
      if (apiFailure(error)) return 0;
      throw error;
    }
  }

  async removeDirectory(path: AokanaBpPointer | null): Promise<number> {
    try {
      await this.metadata.removeDirectory(this.path(path));
      return 1;
    } catch (error) {
      if (apiFailure(error)) return 0;
      throw error;
    }
  }

  async isDirectory(path: AokanaBpPointer | null): Promise<number> {
    try {
      // The directory bit is structural even when the remaining imported flags are unknown.
      return Number((await this.metadata.stat(this.path(path))).kind === 'directory');
    } catch (error) {
      if (apiFailure(error)) return 0;
      throw error;
    }
  }

  async getAttributes(path: AokanaBpPointer | null): Promise<number> {
    try {
      const attributes = await this.metadata.getAttributes(this.path(path));
      if (attributes === null)
        throw new Error('Aokana imported file attributes are unavailable in the mounted profile');
      return attributes;
    } catch (error) {
      if (apiFailure(error)) return 0xffffffff;
      throw error;
    }
  }

  async setAttributes(path: AokanaBpPointer | null, attributes: number): Promise<number> {
    try {
      await this.metadata.setAttributes(this.path(path), attributes);
      return 1;
    } catch (error) {
      if (apiFailure(error)) return 0;
      throw error;
    }
  }

  /** 069410 → 0693A0 → 08CB60 → 01DF14/01DC64: lexical wide CRT split,
   * then four optional UTF-8 outputs, each with the native 0x30C API capacity. */
  splitPath(
    drive: AokanaBpPointer | null,
    directory: AokanaBpPointer | null,
    filename: AokanaBpPointer | null,
    extension: AokanaBpPointer | null,
    path: AokanaBpPointer | null,
  ): number {
    if (path === null) return 0;
    let wide = this.files.text.decodeAuto(path);
    if (wide.length > 783)
      throw new RangeError('Aokana split path overwrites its native wide stack buffer');
    let driveText = '';
    // The CRT checks only the colon position, not whether the drive character is a letter.
    if (wide.length >= 2 && wide[1] === ':') {
      driveText = wide.slice(0, 2);
      wide = wide.slice(2);
    }
    const start = Math.max(wide.lastIndexOf('/'), wide.lastIndexOf('\\')) + 1;
    const dot = wide.lastIndexOf('.');
    let components = [
      driveText,
      wide.slice(0, start),
      wide.slice(start, dot < start ? wide.length : dot),
      dot < start ? '' : wide.slice(dot),
    ];
    // _wsplitpath always receives all four stack buffers, even for omitted VM outputs.
    // Its ERANGE path resets every buffer; the caller ignores errno and still returns 1.
    if (components.slice(1).some((component) => component.length >= 0x100))
      components = ['', '', '', ''];
    const outputs = [drive, directory, filename, extension];
    for (let index = 0; index < outputs.length; index++) {
      const output = outputs[index];
      if (output == null) continue;
      const encoded = this.files.text.encodeWide(components[index]!, 1);
      const view = pointerView(output, encoded.length);
      new Uint8Array(view.buffer, view.byteOffset, view.byteLength).set(encoded);
    }
    return 1;
  }
}
