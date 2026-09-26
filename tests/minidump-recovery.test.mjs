import test from 'node:test';
import assert from 'node:assert/strict';
import {recoverMinidumpPeImage} from '../dist/formats/minidump.js';
import {parsePeResources} from '../dist/formats/pe/resources.js';

function snapshot(memory64, plus) {
  const base = plus ? 0x140000000 : 0x400000;
  const imageSize = 0x4000,
    optional = 0x98,
    optionalSize = plus ? 240 : 224;
  const table = optional + optionalSize,
    directory = optional + (plus ? 112 : 96);
  const original = Buffer.alloc(0x400),
    mapped = Buffer.alloc(imageSize);
  original.write('MZ');
  original.writeUInt32LE(0x80, 60);
  original.write('PE\0\0', 0x80);
  original.writeUInt16LE(plus ? 0x8664 : 0x14c, 0x84);
  original.writeUInt16LE(1, 0x86);
  original.writeUInt32LE(0x12345678, 0x88);
  original.writeUInt16LE(optionalSize, 0x94);
  original.writeUInt16LE(plus ? 0x20b : 0x10b, optional);
  original.writeUInt32LE(0x1234, optional + 16);
  if (plus) original.writeBigUInt64LE(BigInt(base), optional + 24);
  else original.writeUInt32LE(base, optional + 28);
  original.writeUInt32LE(0x1000, optional + 32);
  original.writeUInt32LE(0x200, optional + 36);
  original.writeUInt32LE(imageSize, optional + 56);
  original.writeUInt32LE(0x200, optional + 60);
  original.writeUInt32LE(16, directory - 4);
  original.writeUInt32LE(0x1000, directory + 16);
  original.writeUInt32LE(0x1200, directory + 20);
  original.writeUInt32LE(0x380, directory + 32);
  original.writeUInt32LE(16, directory + 36);
  original.write('.rsrc', table);
  original.writeUInt32LE(0x2000, table + 8);
  original.writeUInt32LE(0x1000, table + 12);
  original.writeUInt32LE(0x200, table + 16);
  original.writeUInt32LE(0x200, table + 20);
  // A resource directory stays on disk, but its synthetic payload is available
  // only in captured memory. No image/audio/game data is included.
  const tree = original.subarray(0x200);
  for (const [offset, id, target] of [
    [0, 10, 0x20],
    [0x20, 7, 0x40],
    [0x40, 1041, 0x60],
  ]) {
    tree.writeUInt16LE(1, offset + 14);
    tree.writeUInt32LE(id, offset + 16);
    tree.writeUInt32LE(offset === 0x40 ? target : (target | 0x80000000) >>> 0, offset + 20);
  }
  const payload = Buffer.from('synthetic restored metadata');
  tree.writeUInt32LE(0x2100, 0x60);
  tree.writeUInt32LE(payload.length, 0x64);
  original.copy(mapped, 0, 0, 0x200);
  tree.copy(mapped, 0x1000);
  payload.copy(mapped, 0x2100);
  mapped.writeUInt32LE(0, optional + 16);
  mapped.fill(0xda, table, table + 40);

  const metadata = Buffer.alloc(0x1000);
  metadata.write('MDMP');
  metadata.writeUInt32LE(0xa793, 4);
  metadata.writeUInt32LE(2, 8);
  metadata.writeUInt32LE(0x20, 12);
  metadata.writeUInt32LE(4, 0x20);
  metadata.writeUInt32LE(4 + 108 * 2, 0x24);
  metadata.writeUInt32LE(0x40, 0x28);
  metadata.writeUInt32LE(memory64 ? 9 : 5, 0x2c);
  const prefix = memory64 ? 16 : 4;
  metadata.writeUInt32LE(prefix + 4 * 16, 0x30);
  metadata.writeUInt32LE(0x200, 0x34);
  metadata.writeUInt32LE(2, 0x40);
  for (const at of [0x44, 0x44 + 108]) {
    metadata.writeBigUInt64LE(BigInt(base), at);
    metadata.writeUInt32LE(imageSize, at + 8);
    metadata.writeUInt32LE(0x12345678, at + 16);
    metadata.writeUInt32LE(0x300, at + 20);
  }
  const name = Buffer.from('C:\\Games\\game.exe', 'utf16le');
  metadata.writeUInt32LE(name.length, 0x300);
  name.copy(metadata, 0x304);
  // An unrelated 64 MiB memory region precedes the requested image. The sparse
  // ByteSource refuses reads from it, proving recovery is range-based.
  const unrelatedSize = 64 * 1024 * 1024,
    imageOffset = 0x1000 + unrelatedSize;
  const segments = [
    [0x2000, 0x2000],
    [0, 0x1000],
    [0x1000, 0x1000],
  ];
  const data = Buffer.concat(segments.map(([start, size]) => mapped.subarray(start, start + size)));
  if (memory64) {
    metadata.writeBigUInt64LE(4n, 0x200);
    metadata.writeBigUInt64LE(0x1000n, 0x208);
  } else metadata.writeUInt32LE(4, 0x200);
  let offset = 0x1000;
  for (const [i, [address, size]] of [
    [base + 0x10000000, unrelatedSize],
    ...segments.map(([start, size]) => [base + start, size]),
  ].entries()) {
    const at = 0x200 + prefix + i * 16;
    metadata.writeBigUInt64LE(BigInt(address), at);
    if (memory64) metadata.writeBigUInt64LE(BigInt(size), at + 8);
    else {
      metadata.writeUInt32LE(size, at + 8);
      metadata.writeUInt32LE(offset, at + 12);
    }
    offset += size;
  }
  const reads = [];
  const source = {
    size: imageOffset + data.length,
    async read(offset, length) {
      reads.push({offset, length});
      assert.ok(length <= 1024 * 1024);
      if (offset < metadata.length && offset + length <= metadata.length)
        return metadata.subarray(offset, offset + length);
      assert.ok(offset >= imageOffset, 'must not read unrelated memory');
      return data.subarray(offset - imageOffset, offset - imageOffset + length);
    },
  };
  return {
    source,
    original,
    mapped,
    metadata,
    data,
    reads,
    payload,
    table,
    directory,
    base,
    descriptor: 0x200 + prefix + 16,
  };
}

test('matching snapshot recovery restores PE metadata with bounded reads and rejects ambiguous or mismatched captures', async () => {
  for (const [memory64, plus] of [
    [true, false],
    [false, true],
  ]) {
    const fixture = snapshot(memory64, plus);
    const before = Buffer.from(fixture.original);
    assert.throws(() => parsePeResources(before), /Unmapped or ambiguous/);
    const image = await recoverMinidumpPeImage(fixture.source, fixture.original, 'GAME.EXE');
    assert.deepEqual(fixture.original, before);
    assert.equal(Buffer.from(image).readUInt32LE(0x98 + 16), 0x1234);
    assert.equal(Buffer.from(image).readUInt32LE(fixture.table + 20), 0x1000);
    assert.equal(Buffer.from(image).readUInt32LE(fixture.directory + 32), 0);
    assert.deepEqual(
      parsePeResources(image).map(({type, id, bytes}) => ({type, id, bytes: Buffer.from(bytes)})),
      [{type: 10, id: 7, bytes: fixture.payload}],
    );
    assert.ok(fixture.reads.reduce((sum, read) => sum + read.length, 0) < image.length + 4096);
    assert.equal(
      await recoverMinidumpPeImage(fixture.source, fixture.original, 'missing.exe'),
      null,
    );

    fixture.metadata.writeUInt32LE(0x87654321, 0x44 + 16);
    await assert.rejects(
      recoverMinidumpPeImage(fixture.source, fixture.original, 'game.exe'),
      /identity does not match/,
    );
    fixture.metadata.writeUInt32LE(0x12345678, 0x44 + 16);
    fixture.metadata.writeBigUInt64LE(BigInt(fixture.base + 0x1000), 0x44 + 108);
    await assert.rejects(
      recoverMinidumpPeImage(fixture.source, fixture.original, 'game.exe'),
      /identity does not match/,
    );
    fixture.metadata.writeBigUInt64LE(BigInt(fixture.base), 0x44 + 108);
    fixture.metadata.writeBigUInt64LE(BigInt(fixture.base + 0x2001), fixture.descriptor);
    await assert.rejects(
      recoverMinidumpPeImage(fixture.source, fixture.original, 'game.exe'),
      /Missing minidump module memory/,
    );
    fixture.metadata.writeBigUInt64LE(BigInt(fixture.base + 0x1fff), fixture.descriptor);
    await assert.rejects(
      recoverMinidumpPeImage(fixture.source, fixture.original, 'game.exe'),
      /overlapping minidump/,
    );
    fixture.metadata.writeBigUInt64LE(BigInt(fixture.base + 0x2000), fixture.descriptor);
    // The module list alone cannot establish architecture: check the captured
    // PE header before replacing any modified header bytes with the disk copy.
    fixture.data.writeUInt16LE(0, 0x2000 + 0x84);
    await assert.rejects(
      recoverMinidumpPeImage(fixture.source, fixture.original, 'game.exe'),
      /Captured PE identity/,
    );
  }
});
