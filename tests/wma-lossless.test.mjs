import assert from 'node:assert/strict';
import test from 'node:test';
import {WmaLosslessDecoder} from '../dist/formats/wma/lossless.js';
import {createWmaLosslessDecoder} from '../dist/formats/wma/wasm-decoder.js';
import {compressedPacket} from './helpers/wma-lossless-packet.mjs';

function config(bits) {
  const extra = new Uint8Array(18),
    view = new DataView(extra.buffer);
  view.setUint16(0, bits, true);
  view.setUint32(2, 3, true);
  view.setUint16(14, 0x1a1, true);
  return {sampleRate: 48000, channels: 2, blockAlign: 16384, extra};
}

function writer() {
  const data = new Uint8Array(16384);
  let index = 0;
  return {
    data,
    put(n, value) {
      for (let i = n - 1; i >= 0; i--, index++)
        data[index >> 3] |= ((value >>> i) & 1) << (7 - (index & 7));
    },
  };
}

// One synthetic frame in the reservoir. The final trailer ends the frame;
// draining decodes it without requiring another codec packet.
function rawPacket(bits, padding = 0, trim = 0) {
  const w = writer(),
    width = bits - padding;
  w.put(4, 0);
  w.put(2, 0);
  w.put(18, 0); // Packet header, no previous-frame tail.
  w.put(1, 1);
  w.put(4, 15); // Both channels share one 2048-sample tile.
  w.put(8, 0); // DRC metadata.
  w.put(1, trim ? 1 : 0);
  if (trim) {
    w.put(1, 0);
    w.put(1, 1);
    w.put(12, trim);
  }
  w.put(1, 0);
  w.put(1, 1); // Non-seekable raw PCM tile.
  w.put(1, padding ? 1 : 0);
  if (padding) w.put(5, padding);
  const source = Array.from({length: 2}, (_, ch) =>
    Int32Array.from(
      {length: 2048},
      (_, i) => ((i * 7919 + ch * 997) % 2 ** width) - 2 ** (width - 1),
    ),
  );
  for (const c of source) for (const x of c) w.put(width, x);
  w.put(1, 0);
  return {data: w.data, source};
}

for (const wasm of [false, true])
  for (const bits of [16, 24])
    test(`WMA Lossless ${bits}-bit ${wasm ? 'Rust' : 'JS'} raw PCM, end trim and drain`, () => {
      const decoder = wasm
        ? createWmaLosslessDecoder(config(bits))
        : new WmaLosslessDecoder(config(bits));
      assert.ok(decoder);
      const {data, source} = rawPacket(bits, 3, 17);
      assert.deepEqual(decoder.decode(data, 321), []);
      const out = decoder.decode(null);
      assert.equal(out.length, 1);
      assert.equal(out[0].time, -1);
      for (let c = 0; c < 2; c++) {
        const expected = Float32Array.from(
          source[c].subarray(0, 2031),
          (x) => (x * 8) / 2 ** (bits - 1),
        );
        assert.deepEqual(out[0].channels[c], expected);
      }
      assert.deepEqual(decoder.decode(null), []);
      decoder.close();
      decoder.close();
      assert.throws(() => decoder.decode(data), /closed/);
    });

test('WMA Lossless instances isolate reservoirs and reject unsupported layouts', () => {
  const a = new WmaLosslessDecoder(config(16)),
    b = new WmaLosslessDecoder(config(24));
  const pa = rawPacket(16),
    pb = rawPacket(24);
  a.decode(pa.data);
  b.decode(pb.data);
  assert.equal(a.decode(null)[0].channels[0][0], -1);
  assert.equal(b.decode(null)[0].channels[1][0], Math.fround(pb.source[1][0] / 2 ** 23));
  assert.throws(() => new WmaLosslessDecoder({...config(16), channels: 6}), /configuration/);
  assert.throws(
    () => new WmaLosslessDecoder({...config(16), extra: new Uint8Array(2)}),
    /extradata/,
  );
  const truncated = new WmaLosslessDecoder(config(16));
  assert.throws(() => truncated.decode(new Uint8Array(1)), /Truncated|reservoir/);
});

for (const bits of [16, 24])
  test(`WMA Lossless ${bits}-bit cascaded, stereo and AC prediction`, () => {
    const js = new WmaLosslessDecoder(config(bits)),
      wasm = createWmaLosslessDecoder(config(bits));
    assert.ok(wasm);
    const data = compressedPacket(bits);
    assert.deepEqual(js.decode(data), []);
    assert.deepEqual(wasm.decode(data), []);
    const expected = js.decode(null),
      actual = wasm.decode(null);
    assert.deepEqual(actual, expected);
    assert.equal(actual.length, 1);
    // Independently checked against the original decoder using this synthetic packet.
    assert.deepEqual(
      actual[0].channels[0].subarray(0, 8),
      Float32Array.from([150, 57, 56, 30, 28, 15, 8, 12], (x) => x / 2 ** (bits - 1)),
    );
    js.close();
    wasm.close();
  });
