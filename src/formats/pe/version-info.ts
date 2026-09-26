import {parsePeResources} from './resources.js';

export interface PeVersionStrings {
  readonly language: number;
  readonly table: string;
  readonly values: Readonly<Record<string, string>>;
}

/** VS_VERSION_INFO string tables. Resource and block bounds remain file-backed. */
export function readPeVersionStrings(executable: Uint8Array): PeVersionStrings[] {
  const result: PeVersionStrings[] = [];
  for (const resource of parsePeResources(executable, [16])) {
    const bytes = resource.bytes;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const align = (value: number): number => Math.ceil(value / 4) * 4;
    const decoder = new TextDecoder('utf-16le', {fatal: true});
    interface Block {
      key: string;
      value: string;
      children: Block[];
    }
    let count = 0;
    function block(start: number, limit: number, depth: number): Block {
      if (depth > 4 || ++count > 4096 || start + 6 > limit)
        throw new Error('Invalid PE version-info block');
      const end = start + view.getUint16(start, true);
      const valueLength = view.getUint16(start + 2, true);
      const type = view.getUint16(start + 4, true);
      if (end <= start + 6 || end > limit || type > 1)
        throw new Error('Invalid PE version-info block range');
      let cursor = start + 6;
      while (cursor + 2 <= end && view.getUint16(cursor, true) !== 0) cursor += 2;
      if (cursor + 2 > end) throw new Error('Unterminated PE version-info key');
      const key = decoder.decode(bytes.subarray(start + 6, cursor));
      cursor = align(cursor + 2);
      const valueEnd = cursor + valueLength * (type === 1 ? 2 : 1);
      if (valueLength !== 0 && valueEnd > end) throw new Error('Invalid PE version-info value');
      const value =
        type === 1 && valueLength !== 0
          ? decoder.decode(bytes.subarray(cursor, valueEnd)).replace(/\0+$/, '')
          : '';
      cursor = align(valueEnd);
      const children: Block[] = [];
      while (cursor + 6 <= end) {
        children.push(block(cursor, end, depth + 1));
        cursor = align(cursor + view.getUint16(cursor, true));
      }
      return {key, value, children};
    }
    const root = block(0, bytes.length, 0);
    if (root.key !== 'VS_VERSION_INFO') throw new Error('Invalid PE version-info root');
    for (const info of root.children.filter((child) => child.key === 'StringFileInfo'))
      for (const table of info.children) {
        const values: Record<string, string> = Object.create(null);
        for (const entry of table.children) values[entry.key] = entry.value;
        result.push({language: resource.language, table: table.key, values});
      }
  }
  return result;
}
