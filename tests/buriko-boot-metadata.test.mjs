import test from 'node:test';
import assert from 'node:assert/strict';
import {inferBurikoBootProductIdentity} from '../dist/engines/buriko/native/boot-metadata.js';
import {BURIKO_BP_ABI_169, BURIKO_BP_ABI_172} from '../dist/engines/buriko/bp/abi.js';

function moduleWithComparison(identity) {
  const bytes = new Uint8Array(128),
    view = new DataView(bytes.buffer);
  view.setUint32(0, 16, true);
  view.setUint32(4, 112, true);
  bytes.set([0x04, 16, 0, 0x80, 0xe8, 0x04, 16, 0, 0x05, 56, 0, 0x69], 16);
  bytes.set(new TextEncoder().encode(identity), 16 + 64);
  return bytes;
}

test('optional IPL metadata proves a native identity comparison and rejects data/ambiguous operands', () => {
  for (const abi of [BURIKO_BP_ABI_169, BURIKO_BP_ABI_172]) {
    const program = moduleWithComparison('Synthetic_BGI_Product');
    assert.equal(
      new TextDecoder().decode(inferBurikoBootProductIdentity(program, abi)),
      'Synthetic_BGI_Product',
    );
    program[22] = 20; // The comparison reads another frame location.
    assert.equal(inferBurikoBootProductIdentity(program, abi), null);
    const decoy = moduleWithComparison('Unused_Data');
    decoy.copyWithin(32, 16, 28);
    decoy.set([0x80, 0x6a], 16); // Native exit; later bytes are not reachable instructions.
    assert.equal(inferBurikoBootProductIdentity(decoy, abi), null);
    assert.equal(inferBurikoBootProductIdentity(program.subarray(0, 40), abi), null);
  }
});
