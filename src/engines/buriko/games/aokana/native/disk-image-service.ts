import type {AokanaBpPointer} from '../bp/memory.js';
import type {WindowsGdiImageCodecHost} from '../../../../../platform/windows-gdi-image.js';
import {AokanaDiskImagePixels, type AokanaGdiLockedPixels} from './disk-image-pixels.js';
import type {AokanaProgramFiles} from './program-files.js';
import type {AokanaNativeText} from './text.js';

const outputMimes = ['image/bmp', 'image/jpeg', 'image/gif', 'image/tiff', 'image/png'] as const;

/** C0040/BFD40's file, codec, and surface transaction over selected owners. */
export class AokanaDiskImageService {
  constructor(
    readonly pixels: AokanaDiskImagePixels,
    readonly files: AokanaProgramFiles,
    readonly text: AokanaNativeText,
    readonly codec: WindowsGdiImageCodecHost,
  ) {}

  private filename(pointer: AokanaBpPointer): string {
    const name = this.text.decodeAuto(pointer);
    if (name.length > 783)
      throw new RangeError('Aokana disk image filename exceeds native wide scratch');
    return name;
  }

  /** Returns the exact lower status; the native wrapper maps it to script values. */
  async import(index: number, filename: AokanaBpPointer, mode: number): Promise<number> {
    const name = this.filename(filename);
    const opened = await this.files.openWide(name);
    if (opened.source === null)
      return (await this.files.hasPathWide(name)) ? 0x80000002 : 0x80000001;
    const source = opened.source;
    const bytes = new Uint8Array(source.size);
    try {
      for (let at = 0; at < bytes.length;) {
        const chunk = await this.files.read(source, at, Math.min(0x20000, bytes.length - at));
        if (chunk.length === 0) return 0x80000002;
        bytes.set(chunk, at);
        at += chunk.length;
      }
    } catch (error) {
      if (error instanceof DOMException) return 0x80000002;
      throw error;
    }
    const image = await this.codec.decode(bytes);
    if (image === null) return (await this.files.hasPathWide(name)) ? 0x80000002 : 0x80000001;
    try {
      const selected = this.pixels.selectImport(mode, image.pixelFormat);
      if (selected === null) return (await this.files.hasPathWide(name)) ? 0x80000002 : 0x80000001;
      const locked = image.lockBits(selected.lockPixelFormat);
      if (locked === null) return 0xffffffff;
      if (locked.width !== image.width || locked.height !== image.height)
        throw new Error('Aokana GDI+ LockBits changed image dimensions');
      return this.pixels.importLocked(index, selected, locked as AokanaGdiLockedPixels) === 0
        ? 0xffffffff
        : 0;
    } finally {
      image.dispose();
    }
  }

  /** BFD40 snapshots the live Scan0 before MIME lookup and file creation. */
  async export(
    filename: AokanaBpPointer,
    format: number,
    quality: number,
    index: number,
  ): Promise<number> {
    const descriptor = this.pixels.surfaces.snapshot(index);
    if (descriptor === null) return 0x80000003;
    const scan0 = this.pixels.prepareScan0(index);
    if (scan0 === null) return 0x80000004;
    const mime = outputMimes[format >>> 0];
    if (mime === undefined) return 0x80000004;
    // GDI+ scans encoder metadata in enumeration order for an exact MIME.
    const encoder = this.codec.encoders().find((candidate) => candidate.mime === mime);
    if (encoder === undefined) throw new Error('Aokana GDI+ save has no initialized encoder CLSID');
    const bytes = await this.codec.encode(
      {
        bytes: scan0.storage.bytes,
        scan0Offset: scan0.scan0Offset,
        scan0Stride: scan0.scan0Stride,
        width: descriptor.width,
        height: descriptor.height,
        pixelFormat: scan0.pixelFormat,
      },
      encoder,
      mime === 'image/jpeg' ? quality >>> 0 : null,
    );
    if (bytes === null) return 0x80000005;
    const name = this.filename(filename);
    return (await this.files.writeWide(name, bytes)) === bytes.length ? 0 : 0x80000005;
  }
}
