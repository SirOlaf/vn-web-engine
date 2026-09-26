import type {BurikoBpPointer} from '../bp/memory.js';
import {burikoSystemTimeToFileTime, writeBurikoSystemTime} from './file-time.js';
import {BurikoNativeFile} from './native-file.js';
import type {BurikoProgramFiles} from './program-files.js';

function required(pointer: BurikoBpPointer | null): BurikoBpPointer {
  if (pointer === null)
    throw new RangeError('Buriko timestamp service consumed a null native pointer');
  return pointer;
}

/** B9900 opens share-read, snapshots all three FILETIMEs, then converts outputs in native order. */
export async function readBurikoFileTimestamps(
  files: BurikoProgramFiles,
  creation: BurikoBpPointer | null,
  access: BurikoBpPointer | null,
  write: BurikoBpPointer | null,
  path: BurikoBpPointer | null,
): Promise<0 | 1> {
  const file = new BurikoNativeFile(files);
  try {
    if ((await file.openRead(required(path))) === 0) return 0;
    const times = await file.getTimes();
    let result: 0 | 1 = 0;
    if (times !== null) {
      writeBurikoSystemTime(required(creation), times.creationTime);
      writeBurikoSystemTime(required(access), times.accessTime);
      writeBurikoSystemTime(required(write), times.writeTime);
      result = 1;
    }
    file.close();
    return result;
  } finally {
    file.dispose();
  }
}

/** B9840 uses OPEN_ALWAYS, preserving contents and converting creation/access/write before SetFileTime. */
export async function writeBurikoFileTimestamps(
  files: BurikoProgramFiles,
  path: BurikoBpPointer | null,
  creation: BurikoBpPointer | null,
  access: BurikoBpPointer | null,
  write: BurikoBpPointer | null,
): Promise<0 | 1> {
  const file = new BurikoNativeFile(files);
  try {
    if ((await file.openWrite(required(path), 1)) === 0) return 0;
    const creationTime = burikoSystemTimeToFileTime(required(creation)),
      accessTime = burikoSystemTimeToFileTime(required(access)),
      writeTime = burikoSystemTimeToFileTime(required(write));
    // Native ignores conversion failure and then consumes an unwritten local. Static-only boundary.
    if (creationTime === null || accessTime === null || writeTime === null)
      throw new RangeError(
        'Buriko timestamp conversion leaves a native local FILETIME unspecified',
      );
    const result = await file.setTimes({creationTime, accessTime, writeTime});
    file.close();
    return result;
  } finally {
    file.dispose();
  }
}
