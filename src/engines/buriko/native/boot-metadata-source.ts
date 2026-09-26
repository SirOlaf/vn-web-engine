import type {ByteSource} from '../../../core/source.js';
import {Arc20Archive} from '../../../formats/buriko/arc20.js';
import {PackFileArchive} from '../../../formats/buriko/pack-file.js';
import {signature} from '../../../formats/buriko/binary.js';
import {decodeBse} from '../../../formats/buriko/bse.js';
import {decodeDsc} from '../../../formats/buriko/dsc.js';
import type {BurikoBpAbi} from '../bp/abi.js';
import {inferBurikoBootProductIdentity} from './boot-metadata.js';

/** Optional static metadata from the conventional boot member, without running it. */
export async function readBurikoBootProductIdentity(
  source: ByteSource,
  abi: BurikoBpAbi,
): Promise<Uint8Array | null> {
  if (source.size < 16) return null;
  const header = await source.read(0, 16);
  const archive = signature(header, 'PackFile    ')
    ? await PackFileArchive.open(source)
    : signature(header, 'BURIKO ARC20')
      ? await Arc20Archive.open(source)
      : null;
  if (archive === null) return null;
  const entry = archive.entries.find(({name}) => name.toLowerCase() === 'ipl._bp');
  if (entry === undefined || entry.size > 0x4000000) return null;
  let program = await archive.read(entry.index);
  if (signature(program, 'BSE 1.1\0')) program = decodeBse(program);
  if (signature(program, 'DSC FORMAT 1.00\0')) program = decodeDsc(program);
  return inferBurikoBootProductIdentity(program, abi);
}
