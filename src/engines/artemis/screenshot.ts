import type {AsbTag} from '../../formats/artemis/asb.js';
import {encodePng} from '../../formats/png/encode.js';
import {artemisInteger} from './numbers.js';
import {artemisRevision, type ArtemisRevision} from './revision.js';

export interface ArtemisScreenshotHost {
  /** Engine +0x108/+0x10c, the stage size. */
  stageSize(): {readonly width: number; readonly height: number};
  /** Rev.3179 0x1400e1cf0: renders the scene into the engine screenshot surface +0x1c0. */
  take(): void;
  /** Rev.3139 0x1400e1cf0: copies the frame presented last into the screenshot surface,
   * cropped to the stage (the margins +0x74/+0x78 become the crop +0x1d0/+0x1d4). */
  takePresented(): void;
  /** 0x14014fc10: the screenshot scaled to `width` x `height` as RGBA rows, top row first;
   * null while the screenshot surface is empty. */
  read(width: number, height: number): Uint8Array | null;
  /** fopen/fwrite of `name` relative to SaveDataPath. */
  writeSaveFile(name: string, bytes: Uint8Array): void | Promise<void>;
  /** CSurfaceManager slot +0x28: the image cache forgets `name`. */
  evictSurface(name: string): void;
  /** c7260 severity 1 with 0x1403724b8 「不正なパラメータです。」. */
  invalidSize(tag: AsbTag): void;
  /** c7260 severity 1 with 0x140372480
   * 「takessタグを実行せずにsavessタグが実行されました。」. */
  missingScreenshot(tag: AsbTag): void;
}

/** `takess` (0x1400e1cf0) and `savess` (0x1400e1d90, Rev.3139 0x1400e1d50).
 *
 * takess fills the screenshot surface, which keeps it until the next takess: Rev.3179
 * renders the committed scene, Rev.3139 copies the presented frame (`ArtemisRevision.screenshot`). savess reads `width` and `height` (atoi; absent, the stage size); either below
 * 1 reports invalid parameters. The screenshot scales into that size (no screenshot
 * reports the missing takess), encodes as PNG and is written as `file` in the save
 * directory, with `.png` appended when the name has no extension. Finally the image cache
 * forgets the unextended `file` name. */
export class ArtemisScreenshots {
  private readonly source: ArtemisRevision['screenshot'];
  constructor(
    hash: string,
    private readonly host: ArtemisScreenshotHost,
  ) {
    this.source = artemisRevision(hash).screenshot;
  }
  /** takess completes at once; savess settles once the file is written. */
  dispatch(tag: AsbTag): boolean | Promise<boolean> {
    if (tag.name === 'takess') {
      if (this.source === 'scene') this.host.take();
      else this.host.takePresented();
      return true;
    }
    return tag.name === 'savess' && this.save(tag);
  }
  private async save(tag: AsbTag): Promise<boolean> {
    const stage = this.host.stageSize();
    const size = (key: string, fallback: number) => {
      const value = tag.args.get(key);
      return value === undefined ? fallback : artemisInteger(value);
    };
    const width = size('width', stage.width),
      height = size('height', stage.height);
    if (width < 1 || height < 1) {
      this.host.invalidSize(tag);
      return true;
    }
    const pixels = this.host.read(width, height);
    if (!pixels) {
      this.host.missingScreenshot(tag);
      return true;
    }
    const file = tag.args.get('file') ?? '';
    // CFileName with the '\' separator: the extension follows the last '.' of the last
    // component and must not be empty.
    const name = /\.[^.\\]+$/.test(file) ? file : `${file}.png`;
    await this.host.writeSaveFile(name, await encodePng(width, height, pixels));
    this.host.evictSurface(file);
    return true;
  }
}
