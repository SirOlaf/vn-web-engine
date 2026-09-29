import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeCompressedBgV1, packedImage} from '../dist/formats/buriko/compressed-bg.js';
import {decodeBurikoResource} from '../dist/engines/buriko/native/resource-decode.js';
import {
  BurikoDistributedAllocator,
  BurikoDistributedProcessing,
} from '../dist/engines/buriko/native/distributed-processing.js';
import {BurikoBitmapPreloadCache} from '../dist/engines/buriko/native/bitmap-preload-cache.js';
import {codecPrivatePointer} from '../dist/engines/buriko/native/codec-storage.js';
import {hostPointer} from '../dist/engines/buriko/bp/memory.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';
import {BlobSource, SliceSource, readsFreshBytes} from '../dist/core/source.js';
import {BufferedSource} from '../dist/core/buffered-source.js';
import {legacyCbg} from './aokana-resource-direct-fixtures.mjs';

const processing = () => new BurikoDistributedProcessing(new BurikoDistributedAllocator(1), 1);
const name = (value) => new TextEncoder().encode(value + '\0');

test('private legacy CompressedBG output carries no validity mask', async () => {
  const legacy = legacyCbg(),
    result = await decodeBurikoResource(legacy, processing(), 0, 0, null);
  assert.equal(result.status, 0);
  assert.equal(result.initialized, undefined);
  assert.deepEqual(result.bytes, packedImage(decodeCompressedBgV1(legacy)));
});

test('raw output returns an owned input uncopied and copies a borrowed one', async () => {
  const input = Uint8Array.from({length: 64}, (_, index) => index + 1);
  const borrowed = await decodeBurikoResource(input, processing());
  assert.notEqual(borrowed.bytes.buffer, input.buffer);
  assert.deepEqual(borrowed.bytes, input);
  const owned = await decodeBurikoResource(
    input,
    processing(),
    0,
    0,
    undefined,
    undefined,
    undefined,
    undefined,
    true,
  );
  assert.equal(owned.bytes, input);
  // A partial range is still a copy of only that range.
  const sliced = await decodeBurikoResource(
    input,
    processing(),
    8,
    4,
    undefined,
    undefined,
    undefined,
    undefined,
    true,
  );
  assert.notEqual(sliced.bytes.buffer, input.buffer);
  assert.deepEqual(Array.from(sliced.bytes), [9, 10, 11, 12]);
});

test('only blob-backed sources promise fresh reads', () => {
  const blob = new BlobSource(new Blob([new Uint8Array(8)]));
  assert.equal(readsFreshBytes(blob), true);
  assert.equal(readsFreshBytes(new SliceSource(blob, 2, 4)), true);
  assert.equal(readsFreshBytes(new BufferedSource(blob)), false);
});

test('an owned preload adopts private bytes; an ordinary one copies them', () => {
  const cache = new BurikoBitmapPreloadCache(new BurikoNativeText());
  const copiedSource = Uint8Array.from({length: 32}, (_, index) => index);
  assert.equal(cache.insertPointer(null, name('copied'), hostPointer(copiedSource), 32), 1);
  const ownedSource = Uint8Array.from({length: 32}, (_, index) => 100 + index);
  assert.equal(cache.insertPointer(null, name('owned'), hostPointer(ownedSource), 32, true), 1);
  const copied = cache.take(null, name('copied')),
    owned = cache.take(null, name('owned'));
  assert.notEqual(copied.buffer, copiedSource.buffer);
  assert.deepEqual(copied, copiedSource);
  assert.equal(owned.buffer, ownedSource.buffer);
  assert.deepEqual(owned, ownedSource);
  // Validity is still enforced for a masked private source before adoption.
  const masked = codecPrivatePointer(new Uint8Array(32), new Uint8Array(32));
  assert.throws(
    () => cache.insertPointer(null, name('masked'), masked, 32, true),
    /unwritten private storage/,
  );
});
