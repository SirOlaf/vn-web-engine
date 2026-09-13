import test from 'node:test';
import assert from 'node:assert/strict';
import {aokanaOggChecksum, parseAokanaOggVorbisLinks, decodeAokanaOggVorbis} from '../dist/engines/buriko/games/aokana/native/audio/ogg-vorbis.js';
import {quantizeAokanaVorbisSample, AokanaWaveBoxOggDecoder} from '../dist/engines/buriko/games/aokana/native/audio/wavebox-ogg.js';
import {parseAokanaWaveBoxHeader} from '../dist/engines/buriko/games/aokana/native/audio/wavebox-header.js';
function page(channels = 2, sampleRate = 44100, serial = 1) {
  const result = new Uint8Array(58), v = new DataView(result.buffer);
  result.set(new TextEncoder().encode('OggS')); result[5] = 6; result[26] = 1; result[27] = 30;
  v.setUint32(14, serial, true); v.setBigInt64(6, 4n, true);
  result.set([1, 118, 111, 114, 98, 105, 115], 28); result[39] = channels;
  v.setUint32(40, sampleRate, true); result[56] = 0x86; result[57] = 1;
  v.setUint32(22, aokanaOggChecksum(result), true); return result;
}
function header(channels = 1, sourceFrameCount = 4, loopStartFrame = 1) {
  const bytes = new Uint8Array(64), v = new DataView(bytes.buffer);
  for (const [offset, value] of [[4, 0x20207762], [12, sourceFrameCount], [16, 44100], [20, channels], [24, 1], [28, loopStartFrame], [48, 3]]) v.setUint32(offset, value, true);
  return parseAokanaWaveBoxHeader(bytes);
}
const pcm = (planes) => ({channels: planes.length, sampleRate: 44100, shortBlock: 64, longBlock: 256, frames: planes[0].length, planes: planes.map((plane) => Float32Array.from(plane))});
test('Ogg identification follows verified CRC pages and separate chained geometries', () => {
  const corrupt = page(); corrupt[57] = 0;
  const stream = Uint8Array.from([9, 8, ...corrupt, ...page(2), ...page(1, 22050, 2)]);
  const links = parseAokanaOggVorbisLinks(stream);
  assert.deepEqual(links.map((link) => [link.serial, link.channels, link.sampleRate, link.finalGranule]), [[1, 2, 44100, 4n], [2, 1, 22050, 4n]]);
  assert.throws(() => parseAokanaOggVorbisLinks(corrupt), (error) => error.nativeCode === 0x10000000);
});
test('browser Vorbis uses identification sample rates, recovers eight-channel order, and preserves discrete planes', async () => {
  const contexts = [];
  class OfflineContext {
    constructor(options) {this.options = options; contexts.push(options);}
    async decodeAudioData() {
      const {numberOfChannels, sampleRate} = this.options;
      return {numberOfChannels, sampleRate, length: 4, getChannelData(channel) {return new Float32Array(4).fill(channel);}};
    }
  }
  const links = await decodeAokanaOggVorbis(Uint8Array.from([...page(8, 32000), ...page(9, 48000, 2)]), OfflineContext);
  assert.deepEqual(contexts, [{numberOfChannels: 8, sampleRate: 32000, length: 1}, {numberOfChannels: 9, sampleRate: 48000, length: 1}]);
  assert.deepEqual(links[0].planes.map((plane) => plane[0]), [0, 2, 1, 6, 7, 4, 5, 3]);
  assert.deepEqual(links[1].planes.map((plane) => plane[0]), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
});
test('Vorbis quantization converts before clipping, including integer-indefinite values', () => {
  for (const bits of [16, 24]) {
    const scale = 2 ** (bits - 1);
    assert.equal(quantizeAokanaVorbisSample(1, 1, bits), scale - 1);
    assert.equal(quantizeAokanaVorbisSample(-1, 1, bits), -scale);
    assert.equal(quantizeAokanaVorbisSample(0.5, 0.5, bits), scale / 4);
    assert.equal(quantizeAokanaVorbisSample(NaN, 1, bits), -scale);
    assert.equal(quantizeAokanaVorbisSample(Infinity, 1, bits), -scale);
    assert.equal(quantizeAokanaVorbisSample(1, 2 ** 32, bits), -scale);
  }
});
test('native Vorbis output applies its own eight-channel permutation after the browser boundary', () => {
  const decoder = new AokanaWaveBoxOggDecoder(header(8, 1), [pcm(Array.from({length: 8}, (_, index) => [index / 16]))], 16, 1);
  const bytes = decoder.readFrameBytes(1), v = new DataView(bytes.buffer);
  assert.deepEqual(Array.from({length: 8}, (_, channel) => v.getInt16(channel * 2, true)), [0, 4096, 2048, 14336, 6144, 8192, 10240, 12288]);
});
test('Ogg producer traverses chained PCM and keeps failed-loop-seek position distinct from its native counter', () => {
  const decoder = new AokanaWaveBoxOggDecoder(header(1, 4, 1), [pcm([[0, 0.25]]), pcm([[0.5, 0.75]])], 24, 1);
  assert.equal(decoder.readFrameBytes(3).length, 9); assert.equal(decoder.decodedFramePosition, 3);
  decoder.restartLoop(); assert.equal(decoder.decodedFramePosition, 1);
  assert.deepEqual(Array.from(decoder.readFrameBytes(1)), [0, 0, 32]);
  decoder.overrideLoop(2); decoder.restartLoop(); assert.equal(decoder.loopStartFrame, 0); assert.equal(decoder.loopEnabled, 2);
  assert.deepEqual(Array.from(decoder.readFrameBytes(1)), [0, 0, 0]);
  const invalid = new AokanaWaveBoxOggDecoder(header(1, 4, 5), [pcm([[0.25, 0.5, 0.75, 1]])], 16, 1);
  invalid.readFrameBytes(1); invalid.restartLoop();
  assert.equal(invalid.decodedFramePosition, 5);
  assert.deepEqual(Array.from(invalid.readFrameBytes(1)), [0, 64]);
});
test('WaveBox channels remain authoritative and an absent Vorbis plane cannot become silent output', () => {
  const decoder = new AokanaWaveBoxOggDecoder(header(2), [pcm([[1, 1, 1, 1]])], 16, 1);
  assert.throws(() => decoder.readFrameBytes(1), /undefined Vorbis channel/);
});
