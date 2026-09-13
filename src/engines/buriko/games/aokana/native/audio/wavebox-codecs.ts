import {
  parseAokanaWaveBoxHeader,
  type AokanaWaveBoxHeader,
  type AokanaWaveBoxCheckpoint,
} from './wavebox-header.js';

export interface AokanaWaveBoxDecoder {
  readonly header: AokanaWaveBoxHeader;
  readonly sourceFrameCount: number;
  readonly sampleRate: number;
  readonly channels: number;
  readonly outputBits: 16;
  readonly loopEnabled: number;
  readonly loopStartFrame: number;
  /** Native +c8 counts lower-reader frames, separately from the outer stream's playback cursor. */
  readonly decodedFramePosition: number;
  readFrameBytes(count: number): Uint8Array;
  reset(): void;
  restartLoop(): void;
  /** Native 118af0 changes loop enabled/start fields without changing checkpoint words. */
  overrideLoop(enabled: number): void;
}

export interface AokanaWaveBoxDecoderOptions {
  /** Binary64 multiplier stored at native model +78 and applied before the output FIFO. */
  readonly gain: number;
}

export interface AokanaAdpcmState {
  predictor: number;
  step: number;
}

function clip16(value: number): number {
  return Math.max(-32768, Math.min(32767, value | 0));
}
function cvttInt32(value: number): number {
  const truncated = Math.trunc(value);
  return !Number.isFinite(truncated) || truncated < -2147483648 || truncated > 2147483647
    ? -2147483648
    : truncated;
}
const adpcm4Scale = [57, 57, 57, 57, 77, 102, 128, 153] as const;

/** 14011c660: predictor wraps independently of signed-16 output clipping. */
export function decodeAokanaAdpcm4Sample(code: number, state: AokanaAdpcmState): number {
  const magnitude = code & 7;
  const nextStep = Math.imul(adpcm4Scale[magnitude]!, state.step) >>> 6;
  const delta = Math.imul(magnitude * 2 + 1, state.step) >> 3;
  state.predictor = (state.predictor + Math.imul(1 - ((code >>> 2) & 2), delta)) >>> 0;
  state.step = Math.max(127, Math.min(24576, nextStep));
  return clip16(state.predictor);
}

/** 14011c580: unsigned DIV in reconstruction, signed truncating /64 in adaptation. */
export function decodeAokanaHfAdpcm8Sample(
  code: number,
  state: AokanaAdpcmState,
  shiftParameter: number,
): number {
  const threshold = 1 << ((((shiftParameter + 1) >>> 0) >>> 1) & 31);
  const divisor = (threshold * 2) >>> 0;
  if (divisor === 0) throw new RangeError('Aokana HFADPCM8 native integer division by zero');
  const magnitude = code & 127;
  const delta = Math.floor((Math.imul(magnitude * 2 + 1, state.step) >>> 0) / divisor);
  state.predictor = (state.predictor + Math.imul(code & 128 ? -1 : 1, delta)) >>> 0;
  const multiplier =
    magnitude < threshold ? 57 : (77 - cvttInt32(((magnitude - threshold) >>> 0) * -25.6)) | 0;
  state.step = Math.max(127, Math.min(24576, Math.trunc(Math.imul(multiplier, state.step) / 64)));
  return clip16(state.predictor);
}

/** Native allocations retain written bytes across short stream reads and resets. */
class NativeBuffer {
  readonly bytes: Uint8Array;
  readonly defined: Uint8Array;
  private readonly view: DataView;
  constructor(length: number) {
    this.bytes = new Uint8Array(length);
    this.defined = new Uint8Array(length);
    this.view = new DataView(this.bytes.buffer);
  }
  require(offset: number, length: number): void {
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      offset < 0 ||
      offset + length > this.bytes.length
    )
      throw new RangeError('Aokana WaveBox memory access exceeds native allocation');
    for (let index = offset; index < offset + length; index++)
      if (this.defined[index] === 0)
        throw new Error('Aokana WaveBox reads unwritten native allocation');
  }
  byte(offset: number): number {
    this.require(offset, 1);
    return this.bytes[offset]!;
  }
  word(offset: number): number {
    this.require(offset, 2);
    return this.view.getInt16(offset, true);
  }
  dword(offset: number): number {
    this.require(offset, 4);
    return this.view.getUint32(offset, true);
  }
  storeSample(offset: number, value: number): void {
    if (offset < 0 || offset + 2 > this.bytes.length)
      throw new RangeError('Aokana WaveBox sample write exceeds native allocation');
    this.view.setInt16(offset, value, true);
    this.defined.fill(1, offset, offset + 2);
  }
  slice(length: number): Uint8Array {
    this.require(0, length);
    return this.bytes.slice(0, length);
  }
  moveWithin(start: number, length: number): void {
    if (start < 0 || length < 0 || start + length > this.bytes.length)
      throw new RangeError('Aokana WaveBox refill exceeds native allocation');
    this.bytes.copyWithin(0, start, start + length);
    this.defined.copyWithin(0, start, start + length);
  }
}

class NativeSource {
  position = 64;
  constructor(readonly bytes: Uint8Array) {}
  seek(offset: number): void {
    this.position = offset >>> 0;
  }
  read(buffer: NativeBuffer, offset: number, count: number): number {
    count >>>= 0;
    if (offset < 0 || offset + count > buffer.bytes.length)
      throw new RangeError('Aokana WaveBox stream read exceeds native allocation');
    const length = Math.min(count, Math.max(0, this.bytes.length - this.position));
    buffer.bytes.set(this.bytes.subarray(this.position, this.position + length), offset);
    buffer.defined.fill(1, offset, offset + length);
    this.position += length;
    return length;
  }
}

function join(chunks: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

abstract class CustomDecoder implements AokanaWaveBoxDecoder {
  readonly outputBits = 16 as const;
  readonly source: NativeSource;
  readonly scratch = new NativeBuffer(0x100000);
  protected framePosition = 0;
  private selectedLoopEnabled: number;
  private selectedLoopStartFrame: number;
  get loopEnabled(): number {
    return this.selectedLoopEnabled;
  }
  get loopStartFrame(): number {
    return this.selectedLoopStartFrame;
  }
  overrideLoop(enabled: number): void {
    this.selectedLoopEnabled = enabled >>> 0;
    this.selectedLoopStartFrame = 0;
  }
  get decodedFramePosition(): number {
    return this.framePosition;
  }
  get sourceFrameCount(): number {
    return this.header.sourceFrameCount;
  }
  get sampleRate(): number {
    return this.header.sampleRate;
  }
  get channels(): number {
    return this.header.channels;
  }
  get frameBytes(): number {
    return Math.imul(this.channels, 2) >>> 0;
  }
  constructor(
    readonly header: AokanaWaveBoxHeader,
    bytes: Uint8Array,
    readonly gain: number,
  ) {
    this.source = new NativeSource(bytes);
    this.selectedLoopEnabled = header.loopEnabled;
    this.selectedLoopStartFrame = header.loopStartFrame;
  }
  protected divide(numerator: number, denominator: number): number {
    if (denominator === 0) throw new RangeError('Aokana WaveBox native integer division by zero');
    return Math.floor((numerator >>> 0) / (denominator >>> 0));
  }
  protected scale(sampleCount: number): void {
    for (let index = 0; index < sampleCount; index++)
      this.scratch.storeSample(
        index * 2,
        clip16(cvttInt32(this.scratch.word(index * 2) * this.gain)),
      );
  }
  abstract readFrameBytes(count: number): Uint8Array;
  abstract reset(): void;
  abstract restartLoop(): void;
}

class Pcm16Decoder extends CustomDecoder {
  readFrameBytes(count: number): Uint8Array {
    const frames = Math.min(count >>> 0, (this.sourceFrameCount - this.framePosition) >>> 0);
    let remaining = Math.imul(frames, this.frameBytes) >>> 0;
    const blockSize = this.divide(0x100000, this.frameBytes) * this.frameBytes;
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (remaining !== 0) {
      if (blockSize === 0) throw new Error('Aokana PCM16 native frame reader cannot make progress');
      const requested = Math.min(blockSize, remaining),
        read = this.source.read(this.scratch, 0, requested);
      this.scale(read >>> 1);
      chunks.push(this.scratch.slice(read));
      totalBytes = (totalBytes + read) >>> 0;
      remaining = (remaining - read) >>> 0;
      if (read !== requested) break;
    }
    this.framePosition = (this.framePosition + this.divide(totalBytes, this.frameBytes)) >>> 0;
    return join(chunks);
  }
  reset(): void {
    this.framePosition = 0;
    this.source.seek(this.header.resetDataOffset);
  }
  restartLoop(): void {
    this.source.seek(
      (Math.imul(this.frameBytes, this.loopStartFrame) + this.header.resetDataOffset) >>> 0,
    );
    this.framePosition = this.loopStartFrame;
  }
}

abstract class AdpcmDecoder extends CustomDecoder {
  readonly left: AokanaAdpcmState = {predictor: 0, step: 127};
  readonly right: AokanaAdpcmState = {predictor: 0, step: 127};
  protected restore(left: AokanaWaveBoxCheckpoint, right: AokanaWaveBoxCheckpoint): void {
    Object.assign(this.left, left);
    Object.assign(this.right, right);
  }
  protected resetPredictors(): void {
    this.restore({predictor: 0, step: 127}, {predictor: 0, step: 127});
  }
  protected loopPredictors(): void {
    this.restore(this.header.loopLeft, this.header.loopRight);
    this.framePosition = this.loopStartFrame;
  }
}

class Adpcm4Decoder extends AdpcmDecoder {
  readonly encoded = new NativeBuffer(0x40000);
  private hasPending = false;
  private pending = 0;
  readFrameBytes(count: number): Uint8Array {
    count >>>= 0;
    const chunks: Uint8Array[] = [];
    if (this.hasPending) {
      chunks.push(Uint8Array.of(this.pending & 255, (this.pending >>> 8) & 255));
      count = (count - 1) >>> 0;
    }
    const frames = Math.min(count, (this.sourceFrameCount - this.framePosition) >>> 0);
    const blockFrames = this.divide(0x100000, this.frameBytes);
    this.hasPending = this.channels === 1 && (count & 1) !== 0;
    let completed = 0;
    while (completed < frames) {
      if (blockFrames === 0)
        throw new Error('Aokana ADPCM4 native frame reader cannot make progress');
      const available = frames - completed,
        writtenFrames = Math.min(available, blockFrames);
      const decodedFrames =
        available < blockFrames ? available + (available & this.channels & 1) : blockFrames;
      this.source.read(this.encoded, 0, Math.imul(this.frameBytes, decodedFrames) >>> 2);
      const samples = Math.imul(decodedFrames, this.channels) >>> 0;
      for (let index = 0; index < samples; index++) {
        const byte = this.encoded.byte(index >>> 1),
          code = index & 1 ? byte >>> 4 : byte & 15;
        this.scratch.storeSample(
          index * 2,
          decodeAokanaAdpcm4Sample(
            code,
            this.channels === 2 && (index & 1) !== 0 ? this.right : this.left,
          ),
        );
      }
      this.scale(samples);
      chunks.push(this.scratch.slice(Math.imul(this.frameBytes, writtenFrames) >>> 0));
      completed += writtenFrames;
      if (this.hasPending && writtenFrames !== decodedFrames)
        this.pending = this.scratch.word(writtenFrames * 2);
    }
    this.framePosition = (this.framePosition + completed) >>> 0;
    if (this.framePosition === this.sourceFrameCount) this.hasPending = false;
    return join(chunks);
  }
  reset(): void {
    this.framePosition = 0;
    this.resetPredictors();
    this.hasPending = false;
    this.pending = 0;
    this.source.seek(this.header.resetDataOffset);
  }
  restartLoop(): void {
    this.loopPredictors();
    this.source.seek(((Math.imul(this.frameBytes, this.loopStartFrame) >>> 2) + 64) >>> 0);
    if (this.channels === 1 && (this.framePosition & 1) !== 0) {
      const byte = new NativeBuffer(1);
      this.source.read(byte, 0, 1);
      this.pending = decodeAokanaAdpcm4Sample(byte.byte(0) >>> 4, this.left);
      this.hasPending = true;
    }
  }
}

class HfAdpcm8Decoder extends AdpcmDecoder {
  readonly prefix = new NativeBuffer(0x408);
  readonly tree = new NativeBuffer(0x400);
  readonly encoded = new NativeBuffer(0x400);
  readonly symbols = new NativeBuffer(0x80000);
  private encodedBytes = 0;
  private bitPosition = 0;
  constructor(header: AokanaWaveBoxHeader, bytes: Uint8Array, gain: number) {
    super(header, bytes, gain);
    this.readPrefix();
    this.tree.bytes.set(this.prefix.bytes.subarray(8));
    this.tree.defined.set(this.prefix.defined.subarray(8));
  }
  private readPrefix(): void {
    this.source.read(this.prefix, 0, 0x408);
    this.encodedBytes = this.source.read(this.encoded, 0, 0x400);
    this.bitPosition = 0;
  }
  private readSymbol(): number {
    let node = this.tree.dword(0),
      position = this.bitPosition;
    while ((node | 0) > 255) {
      const bit = this.encoded.byte(position >>> 3) & (0x80 >>> (position & 7));
      node = this.tree.word((node | 0) * 4 + (bit === 0 ? 4 : 6) - 0x400) >>> 0;
      position = (position + 1) >>> 0;
    }
    this.bitPosition = position;
    return node & 255;
  }
  private decodeBlock(sampleCount: number): void {
    let shortRead = false;
    for (let index = 0; index < sampleCount; index++) {
      if ((this.encodedBytes * 8 - this.bitPosition) >>> 0 < 0x100 && !shortRead) {
        const wholeBytes = this.bitPosition >>> 3;
        this.encodedBytes = (this.encodedBytes - wholeBytes) >>> 0;
        this.encoded.moveWithin(wholeBytes, this.encodedBytes);
        const wanted = 0x400 - this.encodedBytes;
        const read = this.source.read(this.encoded, this.encodedBytes, wanted);
        if (read < wanted) shortRead = true;
        this.encodedBytes += read;
        this.bitPosition &= 7;
      }
      this.symbols.bytes[index] = this.readSymbol();
      this.symbols.defined[index] = 1;
    }
    // Native 11ac50 produces the entire symbol block before 11a7b0 mutates predictors.
    for (let index = 0; index < sampleCount; index++)
      this.scratch.storeSample(
        index * 2,
        decodeAokanaHfAdpcm8Sample(
          this.symbols.byte(index),
          this.channels === 2 && (index & 1) !== 0 ? this.right : this.left,
          this.header.hfAdpcmShiftParameter,
        ),
      );
  }
  readFrameBytes(count: number): Uint8Array {
    const frames = Math.min(count >>> 0, (this.sourceFrameCount - this.framePosition) >>> 0);
    const blockFrames = this.divide(0x80000, this.channels);
    const chunks: Uint8Array[] = [];
    let completed = 0;
    while (completed < frames) {
      if (blockFrames === 0)
        throw new Error('Aokana HFADPCM8 native frame reader cannot make progress');
      const length = Math.min(frames - completed, blockFrames),
        samples = Math.imul(length, this.channels) >>> 0;
      this.decodeBlock(samples);
      this.scale(samples);
      chunks.push(this.scratch.slice(Math.imul(length, this.frameBytes) >>> 0));
      completed += length;
    }
    this.framePosition = (this.framePosition + completed) >>> 0;
    return join(chunks);
  }
  reset(): void {
    this.framePosition = 0;
    this.resetPredictors();
    this.source.seek(this.header.resetDataOffset);
    this.readPrefix();
  }
  restartLoop(): void {
    this.loopPredictors();
    this.source.seek(((this.header.huffmanLoopBitOffset >>> 3) + 0x448) >>> 0);
    this.encodedBytes = this.source.read(this.encoded, 0, 0x400);
    this.bitPosition = this.header.huffmanLoopBitOffset & 7;
  }
}

/** The three proprietary/PCM codecs selected by native values 0, 1, and 2. OGG has its own decoder. */
export function createAokanaCustomWaveBoxDecoder(
  bytes: Uint8Array,
  options: AokanaWaveBoxDecoderOptions,
): AokanaWaveBoxDecoder {
  const header = parseAokanaWaveBoxHeader(bytes);
  if (header.codec === 0) return new Adpcm4Decoder(header, bytes, options.gain);
  if (header.codec === 1) return new Pcm16Decoder(header, bytes, options.gain);
  if (header.codec === 2) return new HfAdpcm8Decoder(header, bytes, options.gain);
  throw new TypeError('OGG WaveBox resources require the Aokana OGG decoder');
}
