import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Mpeg1Decoder} from '../dist/formats/mpeg1/decoder.js';
import {MpegPsReader} from '../dist/formats/mpeg-ps/demux.js';

const directory = new URL('./fixtures/mpeg-ps/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', directory), 'utf8'));

function xorshift(seed) {
  let state = seed >>> 0 || 1;
  return (limit) => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % limit;
  };
}

/** The video elementary stream of a synthetic FFmpeg program stream. */
async function elementaryVideo(name) {
  const bytes = readFileSync(new URL(name + '.mpg', directory)),
    reader = new MpegPsReader({
      size: bytes.length,
      read: async (offset, length) => bytes.subarray(offset, offset + length),
    }),
    parts = [];
  for (let packet; (packet = await reader.next());)
    if (packet.streamId === 0xe0) parts.push(packet.payload);
  return Buffer.concat(parts);
}

/** Everything a caller observes: pictures per call, the sequence, and any error with its cause. */
function run(wasm, data, chunks) {
  const decoder = new Mpeg1Decoder({wasm});
  assert.equal(decoder.accelerated, wasm);
  const calls = [];
  const record = (call) => {
    try {
      const frames = call().map((f) => ({...f, y: [...f.y], cb: [...f.cb], cr: [...f.cr]}));
      calls.push({frames, sequence: decoder.sequence && {...decoder.sequence}});
      return true;
    } catch (error) {
      calls.push({error: error.message, cause: error.cause?.message});
      return false;
    }
  };
  let offset = 0;
  for (const size of chunks) {
    if (!record(() => decoder.push(data.subarray(offset, offset + size)))) return calls;
    offset += size;
  }
  record(() => decoder.flush());
  return calls;
}

function chunking(random, length) {
  const sizes = [];
  for (let left = length; left > 0;) {
    const size = Math.min(left, 1 + random(random(2) ? 64 : 4096));
    sizes.push(size);
    left -= size;
  }
  return sizes;
}

test('WebAssembly MPEG-1 decoding matches the reference on I/P/B streams at any chunking', async () => {
  const random = xorshift(0x6d706731);
  for (const {name, frameCount} of manifest.fixtures) {
    const data = await elementaryVideo(name);
    for (const chunks of [
      [data.length],
      chunking(random, data.length),
      Array(data.length).fill(1),
    ]) {
      const reference = run(false, data, chunks);
      assert.equal(
        reference.flatMap((call) => call.frames ?? []).length,
        frameCount,
        `${name} decodes`,
      );
      assert.deepEqual(run(true, data, chunks), reference, name);
    }
  }
});

test('WebAssembly MPEG-1 decoding reports the reference output and errors for corrupted input', async () => {
  const random = xorshift(0x46555a5a),
    streams = await Promise.all(manifest.fixtures.map(({name}) => elementaryVideo(name)));
  for (let iteration = 0; iteration < 400; iteration++) {
    const data = Buffer.from(streams[random(streams.length)]);
    const edits = 1 + random(4);
    for (let edit = 0; edit < edits; edit++) {
      const at = random(data.length);
      switch (random(4)) {
        case 0:
          data[at] ^= 1 << random(8);
          break;
        case 1:
          data[at] = random(256);
          break;
        case 2:
          // A start code inside picture data splits a section.
          data.set([0, 0, 1, [0, 1, 0xb2, 0xb3, 0xb5, 0xb7, 0xb8][random(7)]], Math.max(0, at - 4));
          break;
        default:
          data.fill(0, at, Math.min(data.length, at + random(64)));
      }
    }
    const end = random(4) ? data.length : random(data.length + 1),
      input = data.subarray(0, end),
      chunks = chunking(random, input.length);
    assert.deepEqual(run(true, input, chunks), run(false, input, chunks), `iteration ${iteration}`);
  }
});

test('MPEG-1 output pictures belong to the caller', async () => {
  const data = await elementaryVideo(manifest.fixtures[0].name);
  for (const wasm of [false, true]) {
    const decoder = new Mpeg1Decoder({wasm}),
      seen = [],
      buffers = new Set();
    const accept = (frames) => {
      for (const frame of frames) {
        seen.push({...frame, y: [...frame.y], cb: [...frame.cb], cr: [...frame.cr]});
        for (const plane of [frame.y, frame.cb, frame.cr]) {
          buffers.add(plane.buffer);
          // Overwriting a returned reference picture must not change later predictions.
          plane.fill(0);
        }
      }
    };
    for (let offset = 0; offset < data.length; offset += 512)
      accept(decoder.push(data.subarray(offset, offset + 512)));
    accept(decoder.flush());
    assert.equal(buffers.size, seen.length * 3, 'every plane has its own transferable buffer');
    assert.deepEqual(
      seen,
      run(wasm, data, [data.length]).flatMap((call) => call.frames),
    );
  }
});
