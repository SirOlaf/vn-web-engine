import {BlobSource} from '../../../../../core/source.js';
import {filePath, MountedFileSystem, SourceFileSystem} from '../../../../../platform/filesystem.js';
import type {AokanaBpPointer} from '../bp/memory.js';
import type {AokanaProgramFiles} from './program-files.js';
import {copyText, textLength, writeText} from './text.js';
import type {AokanaWindowMessages} from './window-messages.js';

/** Dedicated browser file namespace; each drop retains its actual Blob backing. */
export class AokanaDroppedFiles {
  readonly bytes = new Uint8Array(780);
  private enabled = 0;
  private sequence = 0;
  private readonly sources = new SourceFileSystem();
  private readonly handles = new Map<number, {count: number; first: string}>();
  private readonly drag = (event: DragEvent): void => {
    if (this.enabled !== 0) event.preventDefault();
  };
  private readonly drop = (event: DragEvent): void => {
    if (this.enabled === 0) return;
    event.preventDefault();
    const target = this.messages.mainTarget(),
      files = event.dataTransfer?.files;
    if (target === null || files === undefined || files.length === 0) return;
    const file = files[0]!;
    if (this.sequence === Number.MAX_SAFE_INTEGER)
      throw new RangeError('Aokana browser drop namespace exhausted');
    const id = ++this.sequence,
      relative = filePath(`/${id}/${file.name}`),
      native = `${this.nativeRoot}\\${id}\\${file.name}`;
    if (this.files.mountedPath(native) !== this.mountedRoot + relative)
      throw new Error('Aokana dropped file escaped its dedicated path mount');
    this.sources.attach(relative, new BlobSource(file));
    this.handles.set(id, {count: files.length, first: native});
    this.messages.send(target, 0x233, id, 0);
  };

  constructor(
    readonly surface: HTMLElement,
    readonly messages: AokanaWindowMessages,
    readonly files: AokanaProgramFiles,
    filesystem: MountedFileSystem,
    readonly mountedRoot: string,
    readonly nativeRoot: string,
  ) {
    if (
      !files.usesFileSystem(filesystem) ||
      files.paths === null ||
      files.mountedPath(nativeRoot) !== mountedRoot
    )
      throw new Error('Aokana dropped files require the actual declared native path mount');
    // mount rejects a pre-existing namespace; the source owner is private and initially empty.
    filesystem.mount(mountedRoot, this.sources);
    surface.addEventListener('dragover', this.drag);
    surface.addEventListener('drop', this.drop);
  }

  /** B8150: store raw enable, update physical acceptance, then clear all shared bytes. */
  setEnabled(value: number): void {
    this.enabled = value | 0;
    this.bytes.fill(0);
  }

  /** B8090: repeated reads do not consume the retained name. */
  copyPath(output: AokanaBpPointer | null): number {
    const source = {bytes: this.bytes, offset: 0};
    if (this.enabled === 0 || textLength(source) === 0) return 0;
    if (output === null) throw new Error('Aokana dropped path writes a null output');
    copyText(output, source);
    return 1;
  }

  /** B80E0: query count, query first wide name, encode UTF8, then DragFinish. */
  receive(handle: number): void {
    const record = this.handles.get(handle);
    if (record === undefined)
      throw new Error('Aokana drop message requires an actual mounted drop handle');
    if (record.count !== 0) {
      if (record.first.length >= 780)
        throw new RangeError('Aokana browser drop path exceeds the native wide-buffer profile');
      const encoded = this.files.text.encodeWide(record.first, 1);
      if (encoded.length > this.bytes.length)
        throw new RangeError('Aokana dropped UTF8 path exceeds native shared storage');
      writeText({bytes: this.bytes, offset: 0}, encoded);
    }
    this.handles.delete(handle);
  }

  dispose(): void {
    this.surface.removeEventListener('dragover', this.drag);
    this.surface.removeEventListener('drop', this.drop);
  }
}
