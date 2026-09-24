const encode = (value) => new TextEncoder().encode(value);

/** Ordinary literal-only SDC fixture, independent of the new native match encoder. */
export function literalSdc(plain) {
  const count = plain.length + Math.ceil(plain.length / 128),
    bytes = new Uint8Array(32 + count),
    view = new DataView(bytes.buffer);
  bytes.set(encode('SDC FORMAT 1.00\0'));
  view.setUint32(16, 7, true);
  view.setUint32(20, count, true);
  view.setUint32(24, plain.length, true);
  let seed = 7,
    output = 32,
    sum = 0,
    xor = 0;
  const put = (value) => {
    const product = Math.imul(seed, 0x015a4e35) >>> 0;
    seed = (product + 1) >>> 0;
    const stored = (value + ((product >>> 16) & 255)) & 255;
    bytes[output++] = stored;
    sum = (sum + stored) & 65535;
    xor ^= stored;
  };
  for (let start = 0; start < plain.length; start += 128) {
    const length = Math.min(128, plain.length - start);
    put(length - 1);
    for (let i = 0; i < length; i++) put(plain[start + i]);
  }
  view.setUint16(28, sum, true);
  view.setUint16(30, xor, true);
  return bytes;
}

export function shortModernGdb() {
  const bytes = new Uint8Array(48),
    view = new DataView(bytes.buffer);
  bytes.set(encode('BURIKO GDB 3.00\0'));
  view.setUint32(16, bytes.length, true);
  view.setInt32(20, 99999, true);
  view.setInt32(24, 99999, true);
  view.setUint32(28, 2, true);
  bytes.set([7, 8], 32);
  view.setUint32(34, 2, true);
  bytes.set([90, 91], 38);
  // Empty reserved list and packed bit registry are the two final DWORDs.
  return literalSdc(bytes);
}

export function legacyGdb(compact) {
  const records = compact ? 0x60408 : 0xc0408,
    payload = compact ? 0x70408 : 0xd0408,
    bytes = new Uint8Array(payload + 3),
    view = new DataView(bytes.buffer);
  view.setInt32(0, compact ? 100 : 99999, true);
  view.setInt32(4, compact ? 120 : 99999, true);
  bytes.fill(compact ? 0x31 : 0x32, 8, 0x408);
  bytes.fill(compact ? 0x51 : 0x52, 0x408, 0x40408);
  bytes.set(encode('legacy-first\0'), 0x40408);
  bytes.set(encode('legacy-second\0'), 0x40428);
  bytes.set(encode('legacy-flag\0'), records);
  view.setUint32(records + 24, 8, true);
  view.setUint32(records + 28, 0, true);
  bytes.set(encode('legacy-extra\0'), records + 32);
  view.setUint32(records + 56, 9, true);
  view.setUint32(records + 60, 1, true);
  bytes.set([0xa0, 0x40, 0x80], payload);
  return literalSdc(bytes);
}
