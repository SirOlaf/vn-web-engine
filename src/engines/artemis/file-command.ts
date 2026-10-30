import type {AsbTag} from '../../formats/artemis/asb.js';

export interface ArtemisFileCommandHost {
  /** A CArtemisPackFile opened on `path` (0x1401193d0) and read whole (0x14017f7c0): loose
   * and save-directory files, then the mounted archives. Null when it does not open. */
  readPackFile(path: string): Uint8Array | null | Promise<Uint8Array | null>;
  /** 0x140165bb0 creates each missing directory of `path` and opens it for writing, then
   * the tag writes it in 1 MiB fwrite chunks. False when the file cannot be created. */
  writeFile(path: string, bytes: Uint8Array): boolean | Promise<boolean>;
  /** 0x140165e50: CRT remove (_wremove in text mode 2), whose failure is ignored. */
  removeFile(path: string): void;
  /** Drops the opened archive indexes (map 0x14046e088) and directory entries (map
   * 0x14046e058) under mutex 0x1404859c0, so later opens read them again. */
  clearArchiveCache(): void;
  /** c7260 severity 1 with 0x140372a18 「ファイルが見つかりません。」. */
  sourceNotFound(tag: AsbTag): void;
  /** c7260 severity 1 with 0x140372a48 「書き込み先ファイルが作成できません。」. */
  destinationNotCreated(tag: AsbTag): void;
}

/** The `file` tag (0x1400ea0b0). `command` compares exactly; others do nothing.
 *
 * `copy` opens `src` as a pack file (not found reports and returns) and writes it to `dst`
 * (an uncreatable file reports). `delete` removes `target`. `clear_cache` empties the archive
 * caches. Absent arguments read as empty strings. */
export class ArtemisFileCommand {
  constructor(private readonly host: ArtemisFileCommandHost) {}

  /** `copy` settles once the copy is written; the other commands complete at once. */
  dispatch(tag: AsbTag): boolean | Promise<boolean> {
    if (tag.name !== 'file') return false;
    const p = tag.args;
    switch (p.get('command') ?? '') {
      case 'copy':
        return this.copy(tag);
      case 'delete':
        this.host.removeFile(p.get('target') ?? '');
        break;
      case 'clear_cache':
        this.host.clearArchiveCache();
        break;
    }
    return true;
  }
  private async copy(tag: AsbTag): Promise<boolean> {
    const bytes = await this.host.readPackFile(tag.args.get('src') ?? '');
    if (bytes === null) this.host.sourceNotFound(tag);
    else if (!(await this.host.writeFile(tag.args.get('dst') ?? '', bytes)))
      this.host.destinationNotCreated(tag);
    return true;
  }
}
