import type {NoahState} from './noah-state.js';
import {systemFields, readCatalog} from './save-data-tables.js';
export const SYSTEM_SAVE = 0x1762020,
  SYSTEM_SIZE = 0xc508,
  SLOT_SIZE = 0x1474c,
  SLOT_BANK_SIZE = 0x3d5e40;
const word = (s: NoahState, a: number) => s.view(a, 2).getUint16(0, true);
function checksum(
  s: NoahState,
  address: number,
  length: number,
  sum = 0,
  xor = 0,
): [number, number] {
  for (let i = 0; i < length; i += 2) {
    const v = word(s, address + i);
    sum += v;
    xor ^= v;
  }
  return [sum, xor];
}
/** 140049750 / 14004a340: preserve reserved bytes, exact bit packing and checksum extent. */
export function packSystem(s: NoahState): void {
  s.put(SYSTEM_SAVE + 4, 0x100, 2);
  for (const [packed, source, width] of systemFields) s.put(packed, s.get(source), width);
  for (const [dest, source, length] of [
    [0x17620a0, 100, 50],
    [0x17620d2, 0x1cc, 40],
  ])
    s.bytes(dest!, length!).set(s.flags.subarray(source!, source! + length!));
  s.bytes(0x17620fc, 0x640).set(s.variableBytes.subarray(0x1900, 0x1f40));
  s.bytes(0x176273c, 400).set(s.variableBytes.subarray(8000, 8400));
  for (let i = 0; i < 48; i++) s.put(0x1762bee + i, s.get(0x179cc20 + i * 4), 1);
  for (const [dest, source, length] of [
    [0x1762c2e, s.galleryUnlocks, 1200],
    [0x1762cc4, s.bytes(0x17acbd0, 200), 200],
  ] as const) {
    for (let i = 0; i < length / 8; i++) {
      let value = 0;
      for (let bit = 0; bit < 8; bit++) if (source[i * 8 + bit]) value |= 1 << bit;
      s.put(dest + i, value, 1);
    }
  }
  s.bytes(0x1762d28, 0xb400).set(s.readFlags);
  s.bytes(0x1762994, 0x258).set(s.bytes(0x5a9840, 0x258));
  s.put(0x1762bec, s.get(0x5b0a3c), 2);
  s.bytes(0x176e128, 0x400).set(s.auxiliary);
  const [sum, xor] = checksum(s, SYSTEM_SAVE + 4, 0xc500);
  s.put(SYSTEM_SAVE, sum, 2);
  s.put(SYSTEM_SAVE + 2, xor, 2);
}
export function unpackSystem(s: NoahState): boolean {
  const [sum, xor] = checksum(s, SYSTEM_SAVE + 4, 0xc500);
  if (word(s, SYSTEM_SAVE) !== (sum & 65535) || word(s, SYSTEM_SAVE + 2) !== xor) return false;
  for (const [packed, dest, width] of systemFields)
    s.put(dest, width === 2 ? word(s, packed) : s.bytes(packed, 1)[0]!);
  s.flags.set(s.bytes(0x17620a0, 50), 100);
  s.flags.set(s.bytes(0x17620d2, 40), 0x1cc);
  s.variableBytes.set(s.bytes(0x17620fc, 0x640), 0x1900);
  s.variableBytes.set(s.bytes(0x176273c, 400), 8000);
  for (let i = 0; i < 48; i++) s.put(0x179cc20 + i * 4, s.bytes(0x1762bee + i, 1)[0]!);
  for (const [source, dest, length] of [
    [0x1762c2e, s.galleryUnlocks, 1200],
    [0x1762cc4, s.bytes(0x17acbd0, 200), 200],
  ] as const)
    for (let i = 0; i < length; i++) dest[i] = (s.bytes(source + (i >>> 3), 1)[0]! >>> (i & 7)) & 1;
  s.readFlags.set(s.bytes(0x1762d28, 0xb400));
  s.bytes(0x5a9840, 0x258).set(s.bytes(0x1762994, 0x258));
  s.put(0x5b0a3c, word(s, 0x1762bec));
  s.auxiliary.set(s.bytes(0x176e128, 0x400));
  let total = 0;
  for (let i = 0; i < readCatalog.length; i++) {
    const [id, count] = readCatalog[i]!;
    let read = 0;
    for (let n = 0; n < count; n++) {
      const bit = i * 1024 + n;
      read += (s.readFlags[bit >>> 3]! >>> (bit & 7)) & 1;
    }
    s.put(0x17ac3a0 + i * 4, id);
    s.put(0x17accc0 + i * 4, read);
    s.put(0x17ad490 + i * 4, count);
    total += read;
  }
  s.setVariable(0x1f4c / 4, total);
  return true;
}
export function saveSlotAddress(bank: number, index: number): number {
  if (bank === 0) return 0xc491e0;
  if ((bank !== 1 && bank !== 2) || !Number.isInteger(index) || index < 0 || index >= 48)
    throw new Error('Native save slot address outside mapped buffers');
  return (bank === 1 ? 0xc4dc10 : 0x873290) + index * SLOT_SIZE;
}
export function stampSaveSlot(s: NoahState, bank: number, index: number): void {
  const a = saveSlotAddress(bank, index);
  s.put(a + 8, s.get(0x17adc94), 2);
  s.put(a + 10, s.get(0x17acb88) * 256 + s.get(0x17adc98), 2);
  s.put(a + 12, (s.get(0x17acb98) * 256 + s.get(0x17acba4)) * 256 + s.get(0x17acb9c));
}
export function checksumSaveSlot(s: NoahState, bank: number, index: number, value: number): void {
  const a = saveSlotAddress(bank, index);
  s.put(a + 0x24, value);
  const [sum, xor] = checksum(s, a + 6, 0x4a26, 0x4716, 0x1482);
  s.put(a, ((word(s, a + 0x1c) & 2) << 6) | 1, 2);
  s.put(a + 2, sum, 2);
  s.put(a + 4, xor, 2);
}
export function validateSaveSlot(s: NoahState, bank: number, index: number): number {
  const a = saveSlotAddress(bank, index),
    [sum, xor] = checksum(s, a + 6, 0x4a26, 0x4716, 0x1482);
  if (word(s, a + 2) !== (sum & 65535) || word(s, a + 4) !== xor)
    s.put(
      a,
      word(s, a + 2) === 0 && word(s, a + 4) === 0 && sum === 0x4716 && xor === 0x1482 ? 0 : 2,
      2,
    );
  return word(s, a);
}
export function encodeThumbnail(s: NoahState, bank: number, index: number): void {
  if (bank === 0) throw new Error('Native thumbnail destination is null for bank zero');
  const a = saveSlotAddress(bank, index) + 0x4a2c,
    p = s.bytes(0x587350, 240 * 135 * 4);
  for (let i = 0; i < 240 * 135; i++)
    s.put(
      a + i * 2,
      ((p[i * 4]! >> 3) << 11) | ((p[i * 4 + 1]! >> 2) << 5) | (p[i * 4 + 2]! >> 3),
      2,
    );
}
export function decodeThumbnail(s: NoahState, bank: number, index: number): Uint8Array {
  if (bank === 0) throw new Error('Native thumbnail source is null for bank zero');
  const a = saveSlotAddress(bank, index) + 0x4a2c,
    p = s.bytes(0x587350, 240 * 135 * 4);
  for (let i = 0; i < 240 * 135; i++) {
    const v = word(s, a + i * 2);
    s.put(0x587350 + i * 4, (((v << 14) | (v & 0x7e0)) << 5) | ((v >>> 8) & 0xf8) | 0xff000000);
  }
  return p.slice();
}
