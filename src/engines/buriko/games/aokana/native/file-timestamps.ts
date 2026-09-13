import type {AokanaBpPointer} from '../bp/memory.js';
import {aokanaSystemTimeToFileTime, writeAokanaSystemTime} from './file-time.js';
import {AokanaNativeFile} from './native-file.js';
import type {AokanaProgramFiles} from './program-files.js';

function required(pointer: AokanaBpPointer | null): AokanaBpPointer {
  if (pointer === null)
    throw new RangeError('Aokana timestamp service consumed a null native pointer');
  return pointer;
}

/** B9900 opens share-read, snapshots all three FILETIMEs, then converts outputs in native order. */
export async function readAokanaFileTimestamps(
  files: AokanaProgramFiles,
  creation: AokanaBpPointer | null,
  access: AokanaBpPointer | null,
  write: AokanaBpPointer | null,
  path: AokanaBpPointer | null,
): Promise<0 | 1> {
  const file = new AokanaNativeFile(files);
  try {
    if ((await file.openRead(required(path))) === 0) return 0;
    const times = await file.getTimes();
    let result: 0 | 1 = 0;
    if (times !== null) {
      writeAokanaSystemTime(required(creation), times.creationTime);
      writeAokanaSystemTime(required(access), times.accessTime);
      writeAokanaSystemTime(required(write), times.writeTime);
      result = 1;
    }
    file.close();
    return result;
  } finally {
    file.dispose();
  }
}

/** B9840 uses OPEN_ALWAYS, preserving contents and converting creation/access/write before SetFileTime. */
export async function writeAokanaFileTimestamps(
  files: AokanaProgramFiles,
  path: AokanaBpPointer | null,
  creation: AokanaBpPointer | null,
  access: AokanaBpPointer | null,
  write: AokanaBpPointer | null,
): Promise<0 | 1> {
  const file = new AokanaNativeFile(files);
  try {
    if ((await file.openWrite(required(path), 1)) === 0) return 0;
    const creationTime = aokanaSystemTimeToFileTime(required(creation)),
      accessTime = aokanaSystemTimeToFileTime(required(access)),
      writeTime = aokanaSystemTimeToFileTime(required(write));
    // Native ignores conversion failure and then consumes an unwritten local. Static-only boundary.
    if (creationTime === null || accessTime === null || writeTime === null)
      throw new RangeError(
        'Aokana timestamp conversion leaves a native local FILETIME unspecified',
      );
    const result = await file.setTimes({creationTime, accessTime, writeTime});
    file.close();
    return result;
  } finally {
    file.dispose();
  }
}
