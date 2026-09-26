import {FileError} from '../../../platform/filesystem.js';
import {pointerView, type BurikoBpPointer} from '../bp/memory.js';
import type {BurikoProgramFiles} from './program-files.js';
import type {BurikoSpecialFolders} from './special-folders.js';
import {writeText} from './text.js';
import type {BurikoNativeRegistry} from './windows-registry.js';

/** The key and query share the same native 8192-byte wide stack buffer. */
class RegistryScratch {
  readonly bytes = new Uint8Array(8192);
  private readonly initialized = new Uint8Array(8192);
  write(offset: number, bytes: Uint8Array): void {
    pointerView({bytes: this.bytes, offset}, bytes.length);
    this.bytes.set(bytes, offset);
    this.initialized.fill(1, offset, offset + bytes.length);
  }
  wide(offset: number, text: string): void {
    for (let i = 0; i <= text.length; i++) {
      const unit = i === text.length ? 0 : text.charCodeAt(i);
      this.write(offset + i * 2, Uint8Array.of(unit & 255, unit >>> 8));
    }
  }
  string(): string {
    let value = '';
    for (let offset = 0; ; offset += 2) {
      const view = pointerView({bytes: this.bytes, offset}, 2);
      if (!this.initialized[offset] || !this.initialized[offset + 1])
        throw new Error('Buriko installer query reads unwritten wide stack scratch');
      const unit = view.getUint16(0, true);
      if (unit === 0) return value;
      value += String.fromCharCode(unit);
    }
  }
}

/** C8060/C7EE0/C7F80 share the real installation registry and mounted shell folders. */
export class BurikoInstallerQueries {
  constructor(
    readonly registry: BurikoNativeRegistry,
    readonly folders: BurikoSpecialFolders,
    readonly files: BurikoProgramFiles,
  ) {
    if (folders.registry !== registry || folders.text !== files.text)
      throw new Error('Buriko installer queries require shared registry/text owners');
  }
  private key(publisher: BurikoBpPointer, product: BurikoBpPointer): RegistryScratch {
    const scratch = new RegistryScratch();
    scratch.wide(0, 'Software\\' + this.files.text.decodeAuto(publisher));
    const length = scratch.string().length;
    scratch.wide(length * 2, '\\');
    scratch.wide((length + 1) * 2, this.files.text.decodeAuto(product));
    return scratch;
  }
  async installedFolder(
    output: BurikoBpPointer | null,
    publisher: BurikoBpPointer | null,
    product: BurikoBpPointer | null,
  ): Promise<0 | 1> {
    if (publisher === null || product === null) return 0;
    const scratch = this.key(publisher, product),
      opened = await this.registry.openKey(0x80000002, scratch.string(), 0x20019);
    if (opened.result !== 0) return 0;
    try {
      const query = await this.registry.queryValue(opened.handle!, 'InstalledFolder');
      if (query.result !== 0 || query.value!.data.length > 8192) return 0;
      scratch.write(0, query.value!.data);
      if (query.value!.type !== 1) return 0;
      let value = scratch.string();
      if (value.startsWith('"') && value.lastIndexOf('"') === value.length - 1 && value.length > 1)
        value = value.slice(1, -1);
      const encoded = this.files.text.encodeWide(value, 1);
      if (output === null) throw new Error('Buriko installed folder writes through null');
      writeText(output, encoded);
      return 1;
    } finally {
      this.registry.closeKey(opened.handle!);
    }
  }
  async deleteInstallation(
    publisher: BurikoBpPointer | null,
    product: BurikoBpPointer | null,
  ): Promise<0 | 1> {
    if (publisher === null || product === null) return 0;
    return (await this.registry.deleteKey(0x80000002, this.key(publisher, product).string())) === 0
      ? 1
      : 0;
  }
  async legacyFolder(
    output: BurikoBpPointer | null,
    filename: BurikoBpPointer | null,
  ): Promise<0 | 1> {
    if (filename === null) return 0;
    const base = {bytes: new Uint8Array(784), offset: 0},
      path = {bytes: new Uint8Array(784), offset: 0};
    if ((await this.folders.query(base, 0)) === 0)
      throw new Error('Buriko legacy folder consumes unwritten special-folder scratch');
    this.folders.combine(path, base, 1, filename);
    const opened = await this.files.open(path.bytes);
    if (opened.source === null) return 0;
    const size = opened.source.size >>> 0;
    let bytes: Uint8Array;
    try {
      bytes = await this.files.read(opened.source, 0, size);
    } catch (error) {
      if (!(error instanceof FileError) && !(error instanceof DOMException)) throw error;
      bytes = new Uint8Array();
    }
    if (bytes.length !== 0) {
      if (output === null) throw new Error('Buriko legacy folder reads a file into null');
      pointerView(output, bytes.length);
      output.bytes.set(bytes, output.offset);
    }
    // CFileDX closes before these reads; ByteSource is the existing opened-file snapshot.
    const at = (relative: number): DataView => {
      if (output === null) throw new Error('Buriko legacy folder reads through null');
      return pointerView({bytes: output.bytes, offset: output.offset + relative}, 1);
    };
    const tail = (size - 2) >>> 0;
    if (at(tail).getUint8(0) !== 92) return 0;
    if (at((size - 1) >>> 0).getUint8(0) !== 0) return 0;
    at(tail).setUint8(0, 0);
    return 1;
  }
}
