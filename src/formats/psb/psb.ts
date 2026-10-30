import {PsbFile as SharedPsbFile} from '../kirikiri/psb.js';
import {EMOTE_DRIVER_X64_SHA256} from '../kirikiri/psb-filter.js';

export {PsbResource, type PsbValue, type PsbObject} from '../kirikiri/psb.js';
export {applyPsbKeystream} from '../kirikiri/psb-filter.js';

/** Compatibility constructor for the exact x64 E-mote PSB layout. */
export class PsbFile extends SharedPsbFile {
  constructor(bytes: Uint8Array, key?: number) {
    super(bytes, {driverSha256: EMOTE_DRIVER_X64_SHA256, headerKey: key});
  }
}
