import type {NoahState} from './noah-state.js';
import {KEY_MASKS, KEY_BINDINGS} from './noah-reset-data.js';
import {readCatalog} from './save-data-tables.js';

/** 14001d789–14001db68: application state after archive/graphics creation.
 * Separate from 14005f920 and script reset selectors; holes are preserved.
 * Native scratch allocations in 140010ee0 are owned by the renderer. */
export function initializeApplicationState(s: NoahState): void {
  for (const a of [0x5a70d4, 0x5a70d0, 0x5a6f74]) s.put(a, 0);
  for (const [a, n] of [
    [0x5a70b0, 32],
    [0x5a6f78, 32],
    [0x5a6e70, 256],
    [0x5a6fb0, 256],
  ])
    s.zero(a!, n!);
  s.put(0x587348, 255);
  for (const [a, w, v] of KEY_MASKS) s.put(a, v, w);
  s.zero(0x872140, 0xc80);
  for (const [a, w, v] of KEY_BINDINGS) s.put(a, v, w);
  s.put(0x543836, 0, 1);
  s.zero(0x586a58, 8);
  for (let i = 0; i < 8; i++) s.put(0x57aad0 + i * 4, i);
  s.put(0x5b10b5, 3, 1);
  s.put(0x5c2a39, 4, 1);
  s.put(0x5d43bd, 5, 1);
  for (let i = 0; i < 10; i++) s.resetText(i);
  s.zero(0x80c4d0, 80);
  s.zero(0x80cff0, 80);
  for (const a of [0x6610c8, 0x737988, 0x7fbf60, 0x719a04, 0x810074, 0x732a1c, 0x73799c])
    s.put(a, 0);
  // 14001d990 uses (id & ~1)*4, whereas 140049750 uses id*8.
  // Retain that native difference: this is NOT the sum of readCatalog counts.
  const counts = [691, 1756, 0, 85, 257, 1000, 0, 48, 0, ...readCatalog.map(([, count]) => count)];
  let lines = 0;
  for (const [id] of readCatalog) lines = (lines + counts[(id & 0xfffffffe) >>> 1]!) | 0;
  s.put(0x17add48, lines);
  s.zero(0x873290, 0x3d5e40);
  s.zero(0xc4dc10, 0x3d5e40);
  for (let i = 0; i < 48; i++) s.put(0x179cc20 + i * 4, i);
  s.zero(0x1762020, 0xc508);
  // Engine save descriptors use the same virtual address convention as surfaces.
  for (const [descriptor, entry, data, size, name] of [
    [0x873070, 0x1023a50, 0x1762020, 0xc508, 'syssave'],
    [0x873180, 0xc490d0, 0x873290, 0x3d5e40, 'msave'],
    [0x872f60, 0x179cb10, 0xc4dc10, 0x3d5e40, 'fsave'],
  ] as const) {
    s.bytes(descriptor, name.length).set(new TextEncoder().encode(name));
    s.put(entry, 0x61746164);
    s.put(descriptor + 0x100, 1);
    s.put(descriptor + 0x108, 0x140000000 + entry, 8);
    s.put(entry + 0x100, 0x140000000 + data, 8);
    s.put(entry + 0x108, size);
  }
}

/** 14001dc30: all four channel records are cleared, even without a movie host. */
export function initializeMovieState(s: NoahState): void {
  for (const a of [0x5a6e20, 0x5a6e60, 0x5a6e40, 0x5a6e10, 0x5a6e30]) s.zero(a, 16);
}

/** 14001de16: SysFrame +24 is (CONFIG +34 == 0), +28 is CONFIG +38. */
export function initializeDisplaySettings(s: NoahState, configuration: Uint8Array): void {
  const v = new DataView(configuration.buffer, configuration.byteOffset, configuration.byteLength);
  s.put(0x17abc08, v.getInt32(0x34, true) === 0 ? 0 : 1);
  s.put(0x17abdac, (2 - v.getInt32(0x38, true)) | 0);
}
