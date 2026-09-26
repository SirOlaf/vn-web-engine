import {BlobSource} from '../../../core/source.js';
import {filePath, MountedFileSystem, SourceFileSystem} from '../../../platform/filesystem.js';
import type {BurikoBpPointer} from '../bp/memory.js';
import type {BurikoProgramFiles} from './program-files.js';
import {BurikoMountedFileMetadata} from './file-metadata.js';
import {copyText, textLength, writeText} from './text.js';
import type {BurikoWindowMessages} from './window-messages.js';

/** Dedicated browser file namespace; each drop retains its actual Blob backing. */
export class BurikoDroppedFiles {
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
      throw new RangeError('Buriko browser drop namespace exhausted');
    const id = ++this.sequence,
      relative = filePath(`/${id}/${file.name}`),
      native = `${this.nativeRoot}\\${id}\\${file.name}`;
    if (this.files.mountedPath(native) !== this.mountedRoot + relative)
      throw new Error('Buriko dropped file escaped its dedicated path mount');
    // Metadata canonicalizes the full path before delegating to this private source.
    // Its relative key must match that lookup while the reported native spelling stays intact.
    const canonical = this.files.metadata?.canonical(this.mountedRoot + relative) ?? null;
    if (canonical !== null && !canonical.startsWith(this.mountedRoot + '/'))
      throw new Error('Buriko dropped file canonical path escaped its dedicated mount');
    const sourcePath =
      canonical === null ? relative : filePath(canonical.slice(this.mountedRoot.length));
    this.sources.attach(sourcePath, new BlobSource(file));
    this.handles.set(id, {count: files.length, first: native});
    this.messages.send(target, 0x233, id, 0);
  };

  constructor(
    readonly surface: HTMLElement,
    readonly messages: BurikoWindowMessages,
    readonly files: BurikoProgramFiles,
    filesystem: MountedFileSystem | BurikoMountedFileMetadata,
    readonly mountedRoot: string,
    readonly nativeRoot: string,
  ) {
    if (
      !files.usesFileSystem(filesystem) ||
      files.paths === null ||
      files.mountedPath(nativeRoot) !== mountedRoot
    )
      throw new Error('Buriko dropped files require the actual declared native path mount');
    // mount rejects a pre-existing namespace; the source owner is private and initially empty.
    if (filesystem instanceof BurikoMountedFileMetadata)
      filesystem.mountSource(mountedRoot, this.sources);
    else filesystem.mount(mountedRoot, this.sources);
    surface.addEventListener('dragover', this.drag);
    surface.addEventListener('drop', this.drop);
  }

  /** B8150: store raw enable, update physical acceptance, then clear all shared bytes. */
  setEnabled(value: number): void {
    this.enabled = value | 0;
    this.bytes.fill(0);
  }

  /** B8090: repeated reads do not consume the retained name. */
  copyPath(output: BurikoBpPointer | null): number {
    const source = {bytes: this.bytes, offset: 0};
    if (this.enabled === 0 || textLength(source) === 0) return 0;
    if (output === null) throw new Error('Buriko dropped path writes a null output');
    copyText(output, source);
    return 1;
  }

  /** B80E0: query count, query first wide name, encode UTF8, then DragFinish. */
  receive(handle: number): void {
    const record = this.handles.get(handle);
    if (record === undefined)
      throw new Error('Buriko drop message requires an actual mounted drop handle');
    if (record.count !== 0) {
      if (record.first.length >= 780)
        throw new RangeError('Buriko browser drop path exceeds the native wide-buffer profile');
      const encoded = this.files.text.encodeWide(record.first, 1);
      if (encoded.length > this.bytes.length)
        throw new RangeError('Buriko dropped UTF8 path exceeds native shared storage');
      writeText({bytes: this.bytes, offset: 0}, encoded);
    }
    this.handles.delete(handle);
  }

  /** B8040's bounded raw-byte publication after the separate WM_9000 mapping read. */
  publishMappedPath(bytes: Uint8Array): void {
    const end = bytes.indexOf(0);
    if (end < 0 || end >= this.bytes.length) return;
    this.bytes.set(bytes.subarray(0, end + 1));
  }

  dispose(): void {
    this.surface.removeEventListener('dragover', this.drag);
    this.surface.removeEventListener('drop', this.drop);
  }
}
