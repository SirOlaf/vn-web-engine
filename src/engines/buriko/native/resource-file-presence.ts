import type {BurikoBpPointer} from '../bp/memory.js';
import type {BurikoLocalizedMessages} from './localized-messages.js';
import {assertBurikoPathDomain} from './path-domain.js';
import type {BurikoProgramResources} from './program-resources.js';

const quitKey: BurikoBpPointer = {
  bytes: new TextEncoder().encode('AREYOUSUREYOUWANTTOQUIT\0'),
  offset: 0,
};

/** BB1C0's blocking file-presence loop over the actual shared media, files and modal owners. */
export class BurikoResourceFilePresence {
  constructor(
    readonly resources: BurikoProgramResources,
    readonly messages: BurikoLocalizedMessages,
  ) {}

  async wait(
    filename: BurikoBpPointer | null,
    title: BurikoBpPointer | null,
    message: BurikoBpPointer | null,
  ): Promise<0 | 1> {
    const {files, dialogs, configuration} = this.resources;
    for (;;) {
      // BC7E0 first copies the current root into its own784-wide-character scratch.
      const root = configuration.nativeFileRoot;
      if (root.length >= 784) throw new RangeError('Buriko media root exceeds native wide scratch');
      if (files.media.isAvailable(root)) {
        if (filename === null)
          throw new RangeError('Buriko file-presence path consumed a null filename');
        const name = files.text.decodeAuto(filename);
        assertBurikoPathDomain(root);
        assertBurikoPathDomain(name);
        // F7DD0 concatenates literally, including qualified-looking filenames. Only caller
        // inputs use the selected-domain guard; the real resolver handles an invalid join.
        const path = root + name;
        if (path.length >= 784)
          throw new RangeError('Buriko file-presence path exceeds native wide scratch');
        if (await files.isFileWide(path)) return 1;
      }
      if ((await dialogs.show(message, title, 0x41)) === 2) {
        const confirmation = this.messages.lookup(quitKey);
        if ((await dialogs.show(confirmation, title, 0x124)) === 6) return 0;
      }
    }
  }
}
