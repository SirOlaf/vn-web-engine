const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const tag = (bytes: Uint8Array, offset: number) =>
  String.fromCharCode(...bytes.subarray(offset, offset + 4));

/** CPng virtual +0x18 (0x1401841b0), the comment reader behind Lua `loadPngComments`.
 *
 * After the 8-byte signature it walks chunks without checking CRCs or chunk order: each
 * `tEXt` chunk stores its NUL-terminated keyword and the NUL-terminated text after it in
 * a std::map (a repeated keyword keeps the last text), other chunks are skipped, and the
 * first `IEND` ends the walk successfully. A short read anywhere returns null, as does a
 * missing signature. Keywords are returned as ASCII strings; other keyword bytes and a
 * `tEXt` chunk without a keyword terminator (native reads past its buffer) refuse. */
export function readArtemisPngComments(bytes: Uint8Array): Map<string, Uint8Array> | null {
  if (bytes.length < 8 || signature.some((byte, index) => bytes[index] !== byte)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const comments = new Map<string, Uint8Array>();
  let offset = 8;
  for (;;) {
    if (offset + 8 > bytes.length) return null;
    const length = view.getUint32(offset),
      type = tag(bytes, offset + 4);
    offset += 8;
    if (type === 'tEXt') {
      if (offset + length > bytes.length) return null;
      const data = bytes.subarray(offset, offset + length);
      const end = data.indexOf(0);
      if (end < 0) throw Error('Unsupported Artemis PNG comment without a keyword terminator');
      const keyword = data.subarray(0, end);
      if (keyword.some((byte) => byte > 0x7f))
        throw Error('Unsupported non-ASCII Artemis PNG comment keyword');
      const text = data.subarray(end + 1);
      const textEnd = text.indexOf(0);
      comments.set(
        String.fromCharCode(...keyword),
        text.slice(0, textEnd < 0 ? text.length : textEnd),
      );
      offset += length + 4;
    } else if (type === 'IEND') return comments;
    // The skip adds 4 to the uint32 length in 32 bits before seeking.
    else offset += (length + 4) >>> 0;
  }
}
