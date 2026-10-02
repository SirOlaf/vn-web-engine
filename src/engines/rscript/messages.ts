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

/** The longest message the revisions store, with room for translated builds. */
const MAX_MESSAGE_BYTES = 256;

function readString(image: PeImage, address: number): string | null {
  try {
    // A string's address follows the previous string's terminator or alignment padding.
    if (image.cString(address - 1).length !== 0) return null;
    const bytes = image.cString(address);
    if (bytes.length === 0 || bytes.length > MAX_MESSAGE_BYTES) return null;
    if (bytes.some((byte) => byte < 0x20 && byte !== 0x0a)) return null;
    return decodeCp932(bytes);
  } catch {
    return null;
  }
}

export interface RScriptMessageSource {
  readonly messages: RScriptMessages;
  /** False when the executable's strings were not where the revision places them. */
  readonly fromExecutable: boolean;
}

/**
 * The revision's message strings as the executable stores them, so builds with other texts
 * keep them. The addresses come from the reference executables; when any of them does not
 * hold a plausible string in this executable, all messages come from the revision's
 * defaults, the reference executables' texts.
 */
export function readRScriptMessages(
  executable: Uint8Array,
  revision: Pick<RScriptRevision, 'messages' | 'messageDefaults'>,
): RScriptMessageSource {
  const fallback = {messages: revision.messageDefaults, fromExecutable: false};
  let image: PeImage;
  try {
    image = PeImage.parse(executable);
  } catch {
    return fallback;
  }
  const result: Record<string, string | null> = {};
  for (const [key, address] of Object.entries(revision.messages)) {
    if (address === null) {
      result[key] = null;
      continue;
    }
    const text = readString(image, address);
    if (text === null) return fallback;
    result[key] = text;
  }
  return {messages: result as unknown as RScriptMessages, fromExecutable: true};
}
