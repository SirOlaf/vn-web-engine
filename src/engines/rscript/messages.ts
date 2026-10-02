import {PeImage} from '../../formats/pe/image.js';
import {decodeCp932} from '../../text/cp932.js';
import type {RScriptRevision} from './revision.js';

/** Message box captions and texts compiled into the executable. */
export interface RScriptMessages {
  readonly confirm: string;
  readonly returnToTitle: string;
  readonly overwrite: string;
  readonly load: string;
  /** Absent from revisions without quick save and quick load. */
  readonly quickLoad: string | null;
  readonly quitCaption: string;
  readonly quit: string;
}

/** Virtual addresses of the message strings in a revision's executable. */
export type RScriptMessageAddresses = {
  readonly [K in keyof RScriptMessages]: RScriptMessages[K] extends string ? number : number | null;
};

/** Reads the revision's message strings from the executable's data section. */
export function readRScriptMessages(
  executable: Uint8Array,
  revision: RScriptRevision,
): RScriptMessages {
  const image = PeImage.parse(executable);
  const text = (address: number): string => decodeCp932(image.cString(address));
  const {messages} = revision;
  return {
    confirm: text(messages.confirm),
    returnToTitle: text(messages.returnToTitle),
    overwrite: text(messages.overwrite),
    load: text(messages.load),
    quickLoad: messages.quickLoad === null ? null : text(messages.quickLoad),
    quitCaption: text(messages.quitCaption),
    quit: text(messages.quit),
  };
}
