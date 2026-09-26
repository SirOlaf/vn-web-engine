import type {AokanaBpPointer} from '../bp/memory.js';
import type {AokanaLocalizedMessages} from './localized-messages.js';
import {assertAokanaPathDomain} from './path-domain.js';
import type {AokanaProgramResources} from './program-resources.js';

const quitKey: AokanaBpPointer = {
  bytes: new TextEncoder().encode('AREYOUSUREYOUWANTTOQUIT\0'),
  offset: 0,
};

/** BB1C0's blocking file-presence loop over the actual shared media, files and modal owners. */
export class AokanaResourceFilePresence {
  constructor(
    readonly resources: AokanaProgramResources,
    readonly messages: AokanaLocalizedMessages,
  ) {}

  async wait(
    filename: AokanaBpPointer | null,
    title: AokanaBpPointer | null,
    message: AokanaBpPointer | null,
  ): Promise<0 | 1> {
    const {files, dialogs, configuration} = this.resources;
    for (;;) {
      // BC7E0 first copies the current root into its own784-wide-character scratch.
      const root = configuration.nativeFileRoot;
      if (root.length >= 784) throw new RangeError('Aokana media root exceeds native wide scratch');
      if (files.media.isAvailable(root)) {
        if (filename === null)
          throw new RangeError('Aokana file-presence path consumed a null filename');
        const name = files.text.decodeAuto(filename);
        assertAokanaPathDomain(root);
        assertAokanaPathDomain(name);
        // F7DD0 concatenates literally, including qualified-looking filenames. Only caller
        // inputs use the selected-domain guard; the real resolver handles an invalid join.
        const path = root + name;
        if (path.length >= 784)
          throw new RangeError('Aokana file-presence path exceeds native wide scratch');
        if (await files.isFileWide(path)) return 1;
      }
      if ((await dialogs.show(message, title, 0x41)) === 2) {
        const confirmation = this.messages.lookup(quitKey);
        if ((await dialogs.show(confirmation, title, 0x124)) === 6) return 0;
      }
    }
  }
}
