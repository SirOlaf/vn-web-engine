/** Synthetic Artemis `.rft` rendered font files. */
const shiftJis = (thirdStart) => [
  [0x21, 0x7e],
  [0xa1, 0xdf],
  [thirdStart, 0x9ffc],
  [0xe040, 0xeaa4],
  [0xf040, 0xf9fc],
];
const unicode = [
  [0, 0],
  [0x21, 0x7e],
  [0x80, 0xd7ff],
  [0xe000, 0xffff],
];

/** `entries` maps codes to entry bytes; `rft3` files take their settings as `ini` (code 0)
 * and use the Unicode ranges when `unicodeRanges` is set. */
export function rft({version = 3, ini = '', unicodeRanges = true, entries = new Map()}) {
  const ranges =
    version === 0
      ? shiftJis(0x8141)
      : version < 3
        ? shiftJis(0x8140)
        : unicodeRanges
          ? unicode
          : [[0, 0], ...shiftJis(0x8140)];
  const all = new Map(entries);
  if (version === 3) all.set(0, Buffer.from(ini));
  const count = ranges.reduce((sum, [start, end]) => sum + end - start + 1, 0);
  const index = Buffer.alloc(4 + count * 8);
  index.write(`rft${version}`, 0, 'latin1');
  const data = [];
  let offset = index.length;
  for (const [code, bytes] of all) {
    let position = 4,
      found = false;
    for (const [start, end] of ranges) {
      if (code >= start && code <= end) {
        position += (code - start) * 8;
        found = true;
        break;
      }
      position += (end - start + 1) * 8;
    }
    if (!found) throw new Error('rft fixture code outside the ranges');
    index.writeUInt32LE(offset, position);
    index.writeUInt32LE(bytes.length, position + 4);
    data.push(bytes);
    offset += bytes.length;
  }
  return new Uint8Array(Buffer.concat([index, ...data]));
}
