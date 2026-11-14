/**
 * Inflates a zlib stream (RFC 1950) whose decompressed size is known in advance, as stored
 * by archive formats. Throws when the output is longer or shorter than `expected`.
 */
export async function inflateZlib(compressed: Uint8Array, expected: number): Promise<Uint8Array> {
  const output = new Uint8Array(expected),
    reader = new Blob([compressed as Uint8Array<ArrayBuffer>])
      .stream()
      .pipeThrough(new DecompressionStream('deflate'))
      .getReader();
  let filled = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (filled + chunk.value.length > expected)
        throw new Error(`zlib data inflates past ${expected} bytes`);
      output.set(chunk.value, filled);
      filled += chunk.value.length;
    }
  } catch (error) {
    await reader.cancel(error);
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (filled !== expected) throw new Error(`zlib data inflates to ${filled}, expected ${expected}`);
  return output;
}

/** Adler-32 per RFC 1950 §8.2. */
export function adler32(bytes: Uint8Array): number {
  let a = 1,
    b = 0;
  for (let i = 0; i < bytes.length;) {
    const end = Math.min(bytes.length, i + 5552);
    for (; i < end; i++) {
      a += bytes[i]!;
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}
