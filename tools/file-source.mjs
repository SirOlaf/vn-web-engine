import {open} from 'node:fs/promises';
import {checkRange} from '../dist/core/binary.js';
export async function openSource(path) {
  const handle = await open(path, 'r'),
    {size} = await handle.stat();
  return {
    size,
    close: () => handle.close(),
    async read(offset, length) {
      checkRange(size, offset, length);
      const bytes = new Uint8Array(length);
      let read = 0;
      while (read < length) {
        const result = await handle.read(bytes, read, length - read, offset + read);
        if (!result.bytesRead) throw new Error('Truncated file');
        read += result.bytesRead;
      }
      return bytes;
    },
  };
}
