import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, webcrypto} from 'node:crypto';
import {sha256, sha256Fallback} from '../dist/core/sha256.js';
const hex = (bytes) => Buffer.from(bytes).toString('hex');
test('portable SHA-256 matches published known answers', () => {
  for (const [text, expected] of [
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    [
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    ],
    ['a'.repeat(1000000), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0'],
  ])
    assert.equal(hex(sha256Fallback(new TextEncoder().encode(text))), expected);
});
test('portable digest matches independent Node SHA-256 across padding and view boundaries', () => {
  for (const length of [...Array.from({length: 260}, (_, i) => i), 1024, 4095, 4096, 65537]) {
    const backing = Uint8Array.from(
        {length: length + 19},
        (_, i) => (Math.imul(i, 73) ^ (i >>> 3)) & 255,
      ),
      bytes = backing.subarray(7, 7 + length),
      before = backing.slice();
    assert.equal(
      hex(sha256Fallback(bytes)),
      createHash('sha256').update(bytes).digest('hex'),
      `length ${length}`,
    );
    assert.deepEqual(backing, before);
  }
});
test('digest uses Web Crypto when available and falls back when crypto or subtle is absent', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto'),
    bytes = new Uint8Array([1, 2, 3]),
    expected = createHash('sha256').update(bytes).digest('hex');
  let calls = 0;
  try {
    for (const crypto of [
      undefined,
      {},
      {
        subtle: {
          digest(...args) {
            calls++;
            return webcrypto.subtle.digest(...args);
          },
        },
      },
    ]) {
      Object.defineProperty(globalThis, 'crypto', {configurable: true, value: crypto});
      assert.equal(hex(await sha256(bytes)), expected);
    }
    assert.equal(calls, 1);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
    else delete globalThis.crypto;
  }
});
