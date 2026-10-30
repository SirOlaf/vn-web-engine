import {ByteView, checkRange} from '../../core/binary.js';

export interface AsbTag {
  readonly kind: 'tag';
  readonly name: string;
  readonly sourceLine: number;
  readonly args: ReadonlyMap<string, string>;
  /** Exact argument bytes of Lua-built tags (native arguments are byte strings, NULs
   * included). Owners that store data read these; `args` holds their text form. */
  readonly bytes?: ReadonlyMap<string, Uint8Array>;
}
export interface AsbLabel {
  readonly kind: 'label';
  readonly name: string;
  readonly tagIndex: number;
}
export interface AsbProgram {
  readonly reservedByte: number;
  readonly records: readonly (AsbTag | AsbLabel)[];
  readonly tags: readonly AsbTag[];
  readonly labels: ReadonlyMap<string, number>;
}

/** Rev.3179 loader 0x1400c4ad0: ASB v0 serializes tags and labels, not Lua bytecode. */
export function parseAsb(bytes: Uint8Array): AsbProgram {
  checkRange(bytes.length, 0, 9);
  if (bytes[0] !== 65 || bytes[1] !== 83 || bytes[2] !== 66 || bytes[4] !== 0)
    throw new Error('Unsupported ASB signature/revision');
  const view = new ByteView(bytes, {littleEndian: true});
  const decoder = new TextDecoder('utf-8', {fatal: true});
  let p = 5;
  const u32 = () => {
    const value = view.u32(p);
    p += 4;
    return value;
  };
  const string = () => {
    const length = u32();
    checkRange(bytes.length, p, length + 1);
    const raw = bytes.subarray(p, p + length);
    if (bytes[p + length] !== 0 || raw.includes(0))
      throw new Error('Invalid ASB string terminator');
    p += length + 1;
    return decoder.decode(raw);
  };
  const count = u32();
  if (count > Math.floor((bytes.length - p) / 9)) throw new Error('Invalid ASB record count');
  const records: (AsbTag | AsbLabel)[] = [],
    tags: AsbTag[] = [];
  const labels = new Map<string, number>();
  for (let i = 0; i < count; i++) {
    const kind = u32();
    if (kind !== 0 && kind !== 1) throw new Error(`Unsupported ASB record kind ${kind}`);
    const name = string();
    if (kind === 1) {
      const tagIndex = tags.length;
      labels.set(name, tagIndex);
      records.push({kind: 'label', name, tagIndex});
    } else {
      const sourceLine = u32(),
        argc = u32();
      if (argc > Math.floor((bytes.length - p) / 10)) throw new Error('Invalid ASB argument count');
      const args = new Map<string, string>();
      for (let j = 0; j < argc; j++) {
        const key = string();
        args.set(key, string());
      }
      const tag: AsbTag = {kind: 'tag', name, sourceLine, args};
      records.push(tag);
      tags.push(tag);
    }
  }
  if (p !== bytes.length) throw new Error('Trailing ASB data');
  return {reservedByte: bytes[3]!, records, tags, labels};
}
