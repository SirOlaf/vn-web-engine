/** Artemis rendered font files (`.rft`, CRenderedFontFile 0x14018ab60).
 *
 * A file starts with a 4-byte magic `rft0`..`rft3`, followed by an index of 8-byte entries
 * (u32 offset, u32 size, little-endian) for consecutive character codes. Each version
 * indexes fixed code ranges, in order; an entry's index position is 4 plus 8 times the
 * number of codes in earlier ranges and earlier codes of its own range.
 *
 * - `rft0`: Shift-JIS ranges 21-7E, A1-DF, 8141-9FFC, E040-EAA4, F040-F9FC.
 * - `rft1`, `rft2`: the same with 8140 as the third range's start. `rft2` marks 32-bit
 *   glyph images.
 * - `rft3`: code 0 first. Its entry holds INI text whose `[FONT] CHARSET` selects the
 *   ranges: exactly `UTF-8` uses Unicode 0, 21-7E, 80-D7FF, E000-FFFF; anything else the
 *   `rft1` ranges after code 0. The header's bytes 4-11 are that entry.
 */

export interface ArtemisRftEntry {
  readonly offset: number;
  readonly size: number;
}
type Range = readonly [start: number, end: number];

const shiftJis = (thirdStart: number): readonly Range[] => [
  [0x21, 0x7e],
  [0xa1, 0xdf],
  [thirdStart, 0x9ffc],
  [0xe040, 0xeaa4],
  [0xf040, 0xf9fc],
];
const unicode: readonly Range[] = [
  [0, 0],
  [0x21, 0x7e],
  [0x80, 0xd7ff],
  [0xe000, 0xffff],
];

/** The magic's version (0-3), or undefined for any other start. */
export function artemisRftVersion(bytes: Uint8Array): 0 | 1 | 2 | 3 | undefined {
  if (bytes.length < 4 || bytes[0] !== 0x72 || bytes[1] !== 0x66 || bytes[2] !== 0x74)
    return undefined;
  const version = bytes[3]! - 0x30;
  return version >= 0 && version <= 3 ? (version as 0 | 1 | 2 | 3) : undefined;
}

/** The `rft3` code-0 entry (its INI text), read from the header. */
export function artemisRftSettingsEntry(bytes: Uint8Array): ArtemisRftEntry {
  if (artemisRftVersion(bytes) !== 3) throw new Error('Artemis rft settings need rft3');
  return checkedEntry(bytes, 4);
}

/** The entry of `code`, or undefined when the version's ranges do not hold it. `unicode`
 * is the `rft3` CHARSET choice and is ignored by the other versions. */
export function artemisRftEntry(
  bytes: Uint8Array,
  code: number,
  unicodeRanges: boolean,
): ArtemisRftEntry | undefined {
  const version = artemisRftVersion(bytes);
  if (version === undefined) throw new Error('Invalid Artemis rft magic');
  const ranges =
    version === 0
      ? shiftJis(0x8141)
      : version < 3
        ? shiftJis(0x8140)
        : unicodeRanges
          ? unicode
          : [[0, 0] as const, ...shiftJis(0x8140)];
  let position = 4;
  for (const [start, end] of ranges) {
    if (code >= start && code <= end) return checkedEntry(bytes, position + (code - start) * 8);
    position += (end - start + 1) * 8;
  }
  return undefined;
}

function checkedEntry(bytes: Uint8Array, position: number): ArtemisRftEntry {
  if (position + 8 > bytes.length) throw new Error('Artemis rft index exceeds the file');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offset = view.getUint32(position, true),
    size = view.getUint32(position + 4, true);
  if (offset + size > bytes.length) throw new Error('Artemis rft entry exceeds the file');
  return {offset, size};
}
