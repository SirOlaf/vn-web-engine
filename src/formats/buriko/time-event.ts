import {checkRange} from '../../core/binary.js';
import {signature, view} from './binary.js';
export interface TimeEvent {
  value: number;
  text?: string;
}
/** timeevent._bp +0x202: 64-byte header, type 0 u32 records or type 1 u32/NUL-string records. */
export function readTimeEvents(bytes: Uint8Array): {
  version: number;
  type: number;
  events: TimeEvent[];
} {
  checkRange(bytes.length, 0, 64);
  if (!signature(bytes, 'BurikoTimeEvent\0')) throw new Error('Not BurikoTimeEvent');
  const data = view(bytes),
    version = data.getUint32(16, true),
    type = data.getUint32(20, true),
    count = data.getUint32(24, true);
  if (version !== 0x10000 || type > 1) throw new Error('Invalid BurikoTimeEvent header');
  const events: TimeEvent[] = [];
  let p = 64;
  const decoder = new TextDecoder('shift-jis', {fatal: true});
  for (let i = 0; i < count; i++) {
    checkRange(bytes.length, p, 4);
    const value = data.getUint32(p, true);
    p += 4;
    if (type === 0) events.push({value});
    else {
      const end = bytes.indexOf(0, p);
      if (end < 0) throw new Error('Unterminated time-event string');
      events.push({value, text: decoder.decode(bytes.subarray(p, end))});
      p = end + 1;
    }
  }
  if (p !== bytes.length) throw new Error('Trailing time-event data');
  return {version, type, events};
}
