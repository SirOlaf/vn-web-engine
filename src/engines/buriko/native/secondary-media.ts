import type {BurikoBpPointer} from '../bp/memory.js';
import type {WindowsLogicalDriveHost} from '../../../platform/windows-drives.js';
import type {BurikoProgramResources} from './program-resources.js';
import type {
  BurikoExternalProcessHost,
  BurikoExternalProcessWindowHost,
} from './external-process.js';
import type {BurikoLocalizedMessages} from './localized-messages.js';
import {BurikoNativeText, textByte, textBytes} from './text.js';
import {assertBurikoPathDomain} from './path-domain.js';

/** Title-specific media search uses the shared project-level logical-drive primitive. */
export type BurikoLogicalDriveHost = WindowsLogicalDriveHost;
function required(pointer: BurikoBpPointer | null): BurikoBpPointer {
  if (pointer === null)
    throw new RangeError('Buriko media discovery consumed a null native string');
  return pointer;
}
function boundedWide(path: string): string {
  if (path.length >= 784) throw new RangeError('Buriko media path exceeds native wide storage');
  return path;
}
/** BC6F0 writes whole encoded characters, preserving its index-dependent terminator position. */
function componentPrefix(
  text: BurikoNativeText,
  output: Uint8Array,
  source: BurikoBpPointer,
  index: number,
): number {
  const mode = text.detectEncoding(source.bytes, source.offset);
  let cursor = source.offset,
    target = 0,
    remaining = index >>> 0;
  const write = (offset: number, value: number): void => {
    if (offset < 0 || offset >= output.length)
      throw new RangeError('Buriko media prefix exceeds native scratch');
    output[offset] = value;
  };
  if ((remaining | 0) >= 0) {
    while (textByte(source.bytes, cursor) !== 0) {
      if (textByte(source.bytes, cursor) === 92 && textByte(source.bytes, cursor + 1) !== 0)
        remaining = (remaining - 1) >>> 0;
      const length = text.readCharacter(source.bytes, cursor, mode).length;
      if (length === 0)
        throw new RangeError('Buriko media prefix character has no native advancement');
      for (let i = 0; i < length; i++) write(target++, textByte(source.bytes, cursor++));
      if (textByte(source.bytes, cursor) === 0) remaining = (remaining - 1) >>> 0;
      if ((remaining | 0) < 0) break;
    }
  }
  if ((remaining | 0) < 0)
    write((index | 0) < 1 || textByte(source.bytes, cursor) === 0 ? target : target - 1, 0);
  return remaining >>> 31;
}
/** BC680 selects successful component count minus two, without normalizing its separator. */
export function burikoMediaDirectoryPrefix(
  text: BurikoNativeText,
  source: BurikoBpPointer,
): Uint8Array {
  const scratch = new Uint8Array(784);
  let count = 0;
  while (componentPrefix(text, scratch, source, count) !== 0) count = (count + 1) >>> 0;
  componentPrefix(text, scratch, source, (count - 2) >>> 0);
  return textBytes({bytes: scratch, offset: 0}, true).slice();
}
const quitKey = {bytes: new TextEncoder().encode('AREYOUSUREYOUWANTTOQUIT\0'), offset: 0};
/** BC440/BC3C0 shares secondary configuration with real resource fallback and retry. */
export class BurikoSecondaryMediaDiscovery {
  private closed = false;
  private readonly active = new Set<Promise<0 | 1>>();

  constructor(
    readonly resources: BurikoProgramResources,
    readonly localized: BurikoLocalizedMessages,
    readonly drives: BurikoLogicalDriveHost,
    readonly timing: Pick<BurikoExternalProcessHost, 'sleep'>,
    readonly window: Pick<BurikoExternalProcessWindowHost, 'pumpMessages'>,
  ) {}
  private async discover(
    marker: BurikoBpPointer,
    title: BurikoBpPointer | null,
    message: BurikoBpPointer | null,
    retry: number,
  ): Promise<string | null> {
    const files = this.resources.files,
      text = files.text,
      prefix = text.decodeAuto({bytes: burikoMediaDirectoryPrefix(text, marker), offset: 0});
    // Caller forms outside the existing selected path domain are explicit composition boundaries.
    assertBurikoPathDomain(text.decodeAuto(marker));
    for (;;) {
      if (this.closed) return null;
      for (let scan = 0; scan < 10; scan++) {
        if (this.closed) return null;
        const eligible: string[] = [];
        for (const root of this.drives.readLogicalDriveStrings()) {
          if (!/^[A-Za-z]:\\$/.test(root))
            throw new Error(
              'Buriko logical-drive host must supply actual terminated-root equivalents',
            );
          const type = this.drives.readDriveType(root) >>> 0;
          if (type === 5 || type === 2) {
            if (eligible.length === 32)
              throw new RangeError('Buriko media drive list exceeds native pointer scratch');
            eligible.push(root);
          }
        }
        for (const root of eligible) {
          if (!files.media.isAvailable(root)) continue;
          const path = boundedWide(root + text.decodeAuto(marker));
          if (await files.hasPathWide(path)) {
            if (this.closed) return null;
            return boundedWide(root + prefix);
          }
        }
        await this.timing.sleep(100);
        if (this.closed) return null;
        if ((await this.window.pumpMessages()) < 0) return null;
      }
      if (this.closed) return null;
      if (retry >>> 0 === 0) return null;
      if ((await this.resources.dialogs.show(message, title, 0x41)) !== 1) {
        if ((await this.resources.dialogs.show(this.localized.lookup(quitKey), title, 0x124)) === 6)
          return null;
      }
    }
  }
  select(
    marker: BurikoBpPointer | null,
    title: BurikoBpPointer | null,
    message: BurikoBpPointer | null,
    retry: number,
  ): Promise<0 | 1> {
    if (this.closed) throw new Error('Buriko secondary-media admission is closed');
    const work = this.selectAccepted(marker, title, message, retry);
    this.active.add(work);
    void work.then(
      () => this.active.delete(work),
      () => this.active.delete(work),
    );
    return work;
  }

  private async selectAccepted(
    marker: BurikoBpPointer | null,
    title: BurikoBpPointer | null,
    message: BurikoBpPointer | null,
    retry: number,
  ): Promise<0 | 1> {
    const selectedPath = await this.discover(required(marker), title, message, retry);
    if (this.closed) return 0;
    if (selectedPath !== null) {
      const config = this.resources.configuration,
        encoded = this.resources.files.text.encodeWide(selectedPath, 1);
      if (encoded.length > 784)
        throw new RangeError('Buriko secondary root exceeds native byte storage');
      config.secondaryMediaPath = selectedPath;
      config.secondaryRoot = encoded;
      const titleBytes = textBytes(required(title), true);
      if (titleBytes.length > 784)
        throw new RangeError('Buriko media retry title exceeds native byte storage');
      config.retryTitle = titleBytes.slice();
      const messageBytes = textBytes(required(message), true);
      if (messageBytes.length > 784)
        throw new RangeError('Buriko media retry message exceeds native byte storage');
      config.retryMessage = messageBytes.slice();
    }
    return selectedPath === null ? 0 : 1;
  }

  /** Accepted discovery keeps the queued pump and borrowed BP strings live through settlement. */
  closeAndJoin(): Promise<void> {
    this.closed = true;
    return Promise.allSettled([...this.active]).then(() => undefined);
  }
}
