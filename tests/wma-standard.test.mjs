import assert from 'node:assert/strict';
import test from 'node:test';
import {InverseMdct, wmaSineWindow} from '../dist/formats/wma/imdct.js';
import {WmaStandardDecoder} from '../dist/formats/wma/standard.js';
import {createWmaStandardDecoder} from '../dist/formats/wma/wasm-decoder.js';
import {standardConfig, standardPacket} from './helpers/wma-standard-packet.mjs';
import {mdctKernel} from './helpers/wma-mdct-kernel.mjs';

test('WMA IMDCT basis vectors agree with the direct cosine definition', () => {
  for (const n of [128, 256, 512, 1024, 2048]) {
    const transform = new InverseMdct(n, 1 / 32768),
      input = new Float32Array(n),
      out = new Float32Array(n * 2);
    for (const k of [0, 1, 7]) {
      input.fill(0);
      input[k] = 1;
      out.fill(NaN);
      transform.full(input, out);
      for (let i = 0; i < out.length; i++) {
        const expected = -Math.cos((Math.PI / n) * (i + 0.5 + n / 2) * (k + 0.5)) / 32768;
        assert.ok(Math.abs(out[i] - expected) < 2e-11, `${n}/${k}/${i}`);
      }
    }
    const window = wmaSineWindow(n);
    assert.equal(wmaSineWindow(n), window);
    for (let i = 0; i < n; i++)
      assert.ok(Math.abs(window[i] ** 2 + window[n - 1 - i] ** 2 - 1) < 2e-7);
  }
  assert.throws(() => new InverseMdct(100, 1), /Unsupported/);
  assert.throws(() => wmaSineWindow(NaN), /Unsupported/);
  assert.throws(
    () => new InverseMdct(128, 1).full(new Float32Array(1), new Float32Array(256)),
    /Short/,
  );
});

test('WMA Standard packet delay, sample trimming, timestamp and drain', () => {
  const decoder = new WmaStandardDecoder(standardConfig());
  const out = decoder.decode(standardPacket(), 100);
  assert.equal(out.length, 1);
  assert.equal(out[0].time, 185);
  for (const c of out[0].channels) assert.deepEqual(c, new Float32Array(2048));
  const tail = decoder.decode(null);
  assert.equal(tail.length, 1);
  assert.equal(tail[0].time, -1);
  assert.equal(tail[0].channels[0].length, 2048);
  assert.deepEqual(decoder.decode(null), []);
  decoder.close();
  decoder.close();
  assert.throws(() => decoder.decode(null), /closed/);
});

test('WMA Standard validates supported configurations and packet bounds', () => {
  const config = standardConfig();
  assert.throws(() => new WmaStandardDecoder({...config, channels: 1}), /Unsupported/);
  assert.throws(() => new WmaStandardDecoder({...config, extra: new Uint8Array(6)}), /Unsupported/);
  assert.throws(() => new WmaStandardDecoder(config).decode(new Uint8Array(10)), /Truncated/);
  assert.throws(() => new WmaStandardDecoder(config).decode(new Uint8Array(2731)), /superframe/);
});

test('WMA Standard synthetic VLC exponents and DC spectrum preserve float samples', () => {
  const decoder = new WmaStandardDecoder(standardConfig());
  const out = decoder.decode(standardPacket(true), 100);
  assert.equal(out.length, 1);
  assert.equal(out[0].time, 185);
  // Independently checked using the original decoder on the generated packet.
  assert.deepEqual(
    out[0].channels[0].subarray(0, 8),
    new Float32Array([
      2.3644770408282056e-7, 2.3644771829367528e-7, 2.3644770408282056e-7, 2.3644773250453e-7,
      2.3644770408282056e-7, 2.3644773250453e-7, 2.3644773250453e-7, 2.3644771829367528e-7,
    ]),
  );
  for (let i = 0; i < 2048; i++) assert.equal(out[0].channels[1][i], -out[0].channels[0][i]);
  decoder.close();
});

test('WMA Rust Standard frame loop preserves packet output and instance isolation', () => {
  const plain = createWmaStandardDecoder(standardConfig());
  const coded = createWmaStandardDecoder(standardConfig());
  assert.ok(plain);
  assert.ok(coded);
  for (const [decoder, value] of [
    [plain, false],
    [coded, true],
  ]) {
    const reference = new WmaStandardDecoder(standardConfig()),
      packet = standardPacket(value);
    assert.deepEqual(decoder.decode(packet, 500), reference.decode(packet, 500));
    assert.deepEqual(decoder.decode(null), reference.decode(null));
    assert.deepEqual(decoder.decode(null), []);
    decoder.close();
    reference.close();
    assert.throws(() => decoder.decode(packet), /closed/);
  }
});

test('WMA Rust full/half IMDCT matches float bits, including signed zeros', () => {
  const kernel = mdctKernel();
  let seed = 0x159bca1;
  const random = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed >>> 0;
  };
  for (const n of [128, 256, 512, 1024, 2048])
    for (const scale of [1 / 32768, 2 / (n * 2 ** 23)]) {
      const transform = new InverseMdct(n, scale),
        plan = kernel.createPlan(transform);
      const input = new Float32Array(n),
        expected = new Float32Array(n * 2);
      for (let vector = 0; vector < 30; vector++) {
        if (vector < 2) input.fill(vector ? -0 : 0);
        else
          for (let i = 0; i < n; i++)
            input[i] = Math.fround(((random() % 65536) - 32768) / 2 ** (random() % 24));
        transform.full(input, expected);
        assert.deepEqual(plan.decode(input), expected);
        assert.deepEqual(plan.decode(input, false), expected.subarray(n / 2, (n * 3) / 2));
      }
    }
});

test('WMA Standard fixed blocks omit reservoir and block-length headers', () => {
  const config = standardConfig();
  config.extra[4] = 1;
  for (const decoder of [new WmaStandardDecoder(config), createWmaStandardDecoder(config)]) {
    assert.ok(decoder);
    const packet = new Uint8Array(config.blockAlign);
    // Every packet contains one silent 2048-sample frame, starting with three
    // zero channel/stereo bits. The initial two frames are decoder delay.
    assert.deepEqual(decoder.decode(packet, 0), []);
    assert.deepEqual(decoder.decode(packet, 43), []);
    const out = decoder.decode(packet, 85);
    assert.equal(out.length, 1);
    assert.equal(out[0].time, 85);
    for (const channel of out[0].channels) assert.deepEqual(channel, new Float32Array(2048));
    assert.equal(decoder.decode(null)[0].channels[0].length, 2048);
    decoder.close();
  }
});
