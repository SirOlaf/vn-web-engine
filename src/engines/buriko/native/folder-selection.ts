import type {BurikoBpPointer} from '../bp/memory.js';
import type {
  WindowsFolderDialogHost,
  WindowsFolderDialogRequest,
} from '../../../platform/windows-picker.js';
import type {BurikoLocalizedMessages} from './localized-messages.js';
import {writeText} from './text.js';

const selectFolderMessageKey: BurikoBpPointer = {
  bytes: new TextEncoder().encode('PLEASESELECTTHEFOLDER\0'),
  offset: 0,
};

/** Semantic BROWSEINFOW fields retained by the explicit browser/platform boundary. */
export type BurikoFolderDialogRequest = WindowsFolderDialogRequest;
export type BurikoFolderDialogHost = WindowsFolderDialogHost;

/** C9850's shared Shell folder chooser, without the engine modal wrapper's extra state. */
export class BurikoFolderSelectionService {
  constructor(
    readonly localized: BurikoLocalizedMessages,
    readonly mainWindowIdentity: object,
    readonly host: BurikoFolderDialogHost,
  ) {}

  async select(
    output: BurikoBpPointer | null,
    title: Uint8Array | null,
    initialPath: Uint8Array | null,
  ): Promise<0 | 1> {
    const titlePointer =
      title === null ? this.localized.lookup(selectFolderMessageKey) : {bytes: title, offset: 0};
    if (titlePointer === null)
      throw new Error('Buriko folder selection cannot resolve its localized prompt');
    const prompt = this.localized.text.decodeAuto(titlePointer),
      initialFolder =
        initialPath === null
          ? null
          : this.localized.text.decodeAuto({bytes: initialPath, offset: 0});

    const selected = await this.host.selectFolder({
      owner: this.mainWindowIdentity,
      rootItemIdentifier: 0x11,
      displayNameCapacity: 784,
      title: prompt,
      flags: 3,
      initialFolder,
      centerOnInitialize: true,
      image: 0,
    });
    if (selected === null) return 0;
    if (selected.length >= 784)
      throw new RangeError('Buriko selected folder exceeds its native wide display-name buffer');
    if (output === null)
      throw new Error('Buriko folder selection encodes through a null output pointer');
    writeText(output, this.localized.text.encodeWide(selected, 1));
    return 1;
  }
}
