import type {OpcodeExecution} from './types.js';

/** 140054530: forward word copy between native context-local banks. */
export function copyContext(h: OpcodeExecution): void {
  const s = h.state,
    c = h.context;
  h.skip(2);
  const source = h.expression(),
    destination = h.expression(),
    start = h.expression(),
    count = h.expression();
  const region = s.regions.find(
    (r) =>
      r.bytes.buffer === c.buffer &&
      c.byteOffset >= r.bytes.byteOffset &&
      c.byteOffset + c.byteLength <= r.bytes.byteOffset + r.bytes.length,
  );
  if (!region) throw new Error('Context is outside Noah state');
  const current = region.address + c.byteOffset - region.bytes.byteOffset;
  const resolve = (id: number) => (id === 0 ? current : 0x17a2f00 + (id & 0x7fffffff) * 0x160);
  const from = resolve(source),
    to = resolve(destination);
  for (let i = 0; i < count; i++) {
    const offset = 0xbc + ((start + i) | 0) * 4;
    s.put(to + offset, s.get(from + offset));
  }
}
