import type {AokanaBpPointer} from '../bp/memory.js';
import type {AokanaLocalizedMessages} from './localized-messages.js';
import {writeText} from './text.js';

const selectFolderMessageKey: AokanaBpPointer = {
  bytes: new TextEncoder().encode('PLEASESELECTTHEFOLDER\0'),
  offset: 0,
};

/** Semantic BROWSEINFOW fields retained by the explicit browser/platform boundary. */
export interface AokanaFolderDialogRequest {
  /** Opaque identity of the title's current shared main window. */
  readonly owner: object;
  readonly rootItemIdentifier: 0x11;
  readonly displayNameCapacity: 784;
  readonly title: string;
  readonly flags: 3;
  readonly initialFolder: string | null;
  readonly centerOnInitialize: true;
  readonly image: 0;
}

/** SHBrowseForFolderW-shaped boundary returning a selected wide path or cancellation. */
export interface AokanaFolderDialogHost {
  selectFolder(request: AokanaFolderDialogRequest): Promise<string | null>;
}

/** C9850's shared Shell folder chooser, without the engine modal wrapper's extra state. */
export class AokanaFolderSelectionService {
  constructor(
    private readonly localized: AokanaLocalizedMessages,
    private readonly mainWindowIdentity: object,
    private readonly host: AokanaFolderDialogHost,
  ) {}

  async select(
    output: AokanaBpPointer | null,
    title: Uint8Array | null,
    initialPath: Uint8Array | null,
  ): Promise<0 | 1> {
    const titlePointer =
      title === null ? this.localized.lookup(selectFolderMessageKey) : {bytes: title, offset: 0};
    if (titlePointer === null)
      throw new Error('Aokana folder selection cannot resolve its localized prompt');
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
      throw new RangeError('Aokana selected folder exceeds its native wide display-name buffer');
    if (output === null)
      throw new Error('Aokana folder selection encodes through a null output pointer');
    writeText(output, this.localized.text.encodeWide(selected, 1));
    return 1;
  }
}
