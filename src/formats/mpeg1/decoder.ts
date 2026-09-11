import {BitReader} from '../../core/bits.js';
import {Vlc} from '../../core/vlc.js';
import {allocateFrame} from '../../video/frame.js';
import type {YuvFrame} from '../../video/frame.js';
import * as T from './tables.js';
import {MpegIdct} from './idct.js';
const AC = new Vlc(T.AC),
  ADDRESS = new Vlc(T.ADDRESS),
  CBP = new Vlc(T.CBP),
  MOTION = new Vlc(T.MOTION),
  DC = [new Vlc(T.DC_Y), new Vlc(T.DC_C)];
const TYPE = [new Vlc(T.I_TYPE), new Vlc(T.P_TYPE), new Vlc(T.B_TYPE)];
export const ZIGZAG = new Uint8Array([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20,
  13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52,
  45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
]);
const INTRA = new Uint8Array([
  8, 16, 19, 22, 26, 27, 29, 34, 16, 16, 22, 24, 27, 29, 34, 37, 19, 22, 26, 27, 29, 34, 34, 38, 22,
  22, 26, 27, 29, 34, 37, 40, 22, 26, 27, 29, 32, 35, 40, 48, 26, 27, 29, 32, 35, 40, 48, 58, 26,
  27, 29, 34, 38, 46, 56, 69, 27, 29, 35, 38, 46, 56, 69, 83,
]);
const RATES = [0, 24000 / 1001, 24, 25, 30000 / 1001, 30, 50, 60000 / 1001, 60];
export interface MpegSequence {
  width: number;
  height: number;
  frameRate: number;
  aspectCode: number;
}
/** MPEG-1 video elementary stream; incrementally accepts arbitrary byte boundaries. */
export class Mpeg1Decoder {
  sequence?: MpegSequence;
  private pending = new Uint8Array();
  private current?: YuvFrame;
  private past?: YuvFrame;
  private future?: YuvFrame;
  private outputIndex = 0;
  private failed = false;
  private ended = false;
  private intraMatrix = INTRA.slice();
  private interMatrix = new Uint8Array(64).fill(16);
  private readonly coeff = new Int32Array(64);
  private readonly idct = new MpegIdct();
  private readonly dc = [128, 128, 128];
  private readonly motion = [0, 0, 0, 0];
  private readonly fcode = [0, 0];
  private readonly fullpel = [0, 0];
  private dcPrecision = 0;
  private quant = 0;
  private address = -1;
  private lastType = 0;
  private decodedBlocks = 0;
  private covered = new Uint8Array();
  push(bytes: Uint8Array): YuvFrame[] {
    if (this.failed || this.ended) throw new Error('MPEG decoder cannot accept more data');
    if (this.pending.length + bytes.length > 16 * 1024 * 1024)
      throw new Error('MPEG section exceeds memory limit');
    const combined = new Uint8Array(this.pending.length + bytes.length);
    combined.set(this.pending);
    combined.set(bytes, this.pending.length);
    const out: YuvFrame[] = [];
    let start = -1;
    try {
      for (let i = 0; i + 3 < combined.length; i++)
        if (combined[i] === 0 && combined[i + 1] === 0 && combined[i + 2] === 1) {
          if (start >= 0) this.section(combined[start + 3]!, combined.subarray(start + 4, i), out);
          else if (i !== 0 && combined.subarray(0, i).some((x) => x !== 0))
            throw new Error('Missing MPEG start code');
          start = i;
          i += 2;
        }
      this.pending = combined.slice(start < 0 ? 0 : start);
    } catch (error) {
      this.failed = true;
      throw error;
    }
    return out;
  }
  flush(): YuvFrame[] {
    if (this.failed || this.ended) throw new Error('MPEG decoder already closed');
    const out: YuvFrame[] = [];
    try {
      if (
        this.pending.length >= 4 &&
        this.pending[0] === 0 &&
        this.pending[1] === 0 &&
        this.pending[2] === 1
      )
        this.section(this.pending[3]!, this.pending.subarray(4), out);
      else if (this.pending.length) throw new Error('Truncated MPEG start code');
      this.finishPicture(out);
      if (this.future) {
        this.emit(this.future, out);
        this.future = undefined;
      }
      this.pending = new Uint8Array();
      this.ended = true;
    } catch (error) {
      this.failed = true;
      throw error;
    }
    return out;
  }
  private emit(frame: YuvFrame, out: YuvFrame[]): void {
    if (out.length >= 32)
      throw new Error('Too many pictures in one MPEG input chunk; feed smaller chunks');
    frame.index = this.outputIndex++;
    out.push(frame);
  }
  private finishPicture(out: YuvFrame[]): void {
    const frame = this.current;
    if (!frame) return;
    if (this.decodedBlocks !== (frame.stride * frame.paddedHeight) / 256)
      throw new Error('Incomplete MPEG picture');
    if (frame.pictureType === 3) this.emit(frame, out);
    else {
      if (this.future) this.emit(this.future, out);
      this.past = this.future;
      this.future = frame;
    }
    this.current = undefined;
  }
  private section(code: number, bytes: Uint8Array, out: YuvFrame[]): void {
    const bits = new BitReader(bytes);
    if (code === 0xb3) {
      this.finishPicture(out);
      const width = bits.read(12),
        height = bits.read(12),
        aspectCode = bits.read(4),
        frameRate = RATES[bits.read(4)];
      if (
        !width ||
        !height ||
        width > 4096 ||
        height > 2160 ||
        !frameRate ||
        !aspectCode ||
        aspectCode === 15
      )
        throw new Error('Unsupported MPEG sequence dimensions/rate');
      if (this.sequence && (width !== this.sequence.width || height !== this.sequence.height))
        throw new Error('MPEG resolution changes are unsupported');
      this.sequence = {width, height, aspectCode, frameRate};
      bits.skip(18);
      if (bits.read(1) !== 1) throw new Error('Invalid MPEG sequence marker');
      bits.skip(11);
      this.intraMatrix = INTRA.slice();
      this.interMatrix.fill(16);
      for (const matrix of [this.intraMatrix, this.interMatrix])
        if (bits.read(1))
          for (let i = 0; i < 64; i++) {
            const value = bits.read(8);
            if (!value) throw new Error('Zero MPEG quantization matrix entry');
            matrix[ZIGZAG[i]!] = value;
          }
    } else if (code === 0) {
      this.finishPicture(out);
      const s = this.sequence;
      if (!s) throw new Error('Picture precedes MPEG sequence');
      const temporalReference = bits.read(10),
        type = bits.read(3);
      bits.skip(16);
      if (type < 1 || type > 3) throw new Error(`Unsupported MPEG picture type ${type}`);
      for (let d = 0; d < 2; d++)
        if (type >= d + 2) {
          this.fullpel[d] = bits.read(1);
          this.fcode[d] = bits.read(3);
          if (!this.fcode[d]) throw new Error('Zero MPEG motion f_code');
        }
      while (bits.read(1)) bits.skip(8);
      this.current = allocateFrame(s.width, s.height);
      this.current.pictureType = type;
      this.current.temporalReference = temporalReference;
      this.decodedBlocks = 0;
      this.covered = new Uint8Array((this.current.stride * this.current.paddedHeight) / 256);
    } else if (code >= 1 && code <= 0xaf) {
      if (!this.current) throw new Error('Slice precedes MPEG picture');
      try {
        this.slice(code, bits);
      } catch (error) {
        throw new Error(
          `MPEG picture ${this.current.temporalReference} type ${this.current.pictureType}, slice ${code}, MB ${this.address}, bit ${bits.position}: ${error instanceof Error ? error.message : error}`,
          {cause: error},
        );
      }
    } else if (code === 0xb8) {
      this.finishPicture(out);
      bits.skip(27);
    } else if (code === 0xb7) {
      this.finishPicture(out);
      if (this.future) {
        this.emit(this.future, out);
        this.future = undefined;
      }
      this.past = undefined;
    } else if (code === 0xb2) {
      // Native 1401830b0: IDCPREC zero selects 8 bits; nonzero selects 11 bits.
      const text = new TextDecoder('ascii').decode(bytes),
        marker = text.indexOf('IDCPREC\0');
      if (marker >= 0) {
        const length = text.slice(marker + 8, marker + 16),
          value = text.slice(marker + 16, marker + 24);
        if (length !== '00000008' || !/^0000000[0-3]$/.test(value))
          throw new Error('Unsupported IDCPREC extension');
        this.dcPrecision = Number(value) ? 3 : 0;
      }
    } else
      throw new Error(
        `Unsupported MPEG start code 0x${code.toString(16)} (MPEG-2 extensions are not MPEG-1)`,
      );
  }
  private slice(code: number, bits: BitReader): void {
    const frame = this.current!,
      mbWidth = frame.stride / 16,
      maxAddress = (mbWidth * frame.paddedHeight) / 16;
    this.quant = bits.read(5);
    if (!this.quant) throw new Error('Zero slice quantizer');
    while (bits.read(1)) bits.skip(8);
    this.dc.fill(128 << this.dcPrecision);
    this.motion.fill(0);
    this.address = (code - 1) * mbWidth - 1;
    this.lastType = 0;
    let first = true;
    while (bits.bitLength - bits.position >= 1) {
      // A slice may end with byte-alignment zero bits only.
      const left = bits.bitLength - bits.position;
      if (left <= 7 && bits.peek(left) === 0) {
        bits.skip(left);
        break;
      }
      let increment = 0,
        value: number;
      do {
        value = ADDRESS.read(bits);
        if (value === 34) increment += 33;
      } while (value >= 34);
      increment += value;
      if (this.address + increment >= maxAddress)
        throw new Error('Macroblock address exceeds picture');
      if (!first && increment > 1) {
        this.dc.fill(128 << this.dcPrecision);
        for (let skip = 1; skip < increment; skip++) {
          this.address++;
          if (frame.pictureType === 1) throw new Error('Skipped intra macroblock');
          if (frame.pictureType === 2) {
            this.motion.fill(0);
            this.predict(8);
          } else {
            if (!(this.lastType & 12) || this.lastType & 1)
              throw new Error('Invalid skipped B macroblock');
            this.predict(this.lastType);
          }
          this.markMacroblock();
        }
        this.address++;
      } else this.address += increment;
      first = false;
      const type = TYPE[frame.pictureType - 1]!.read(bits);
      this.lastType = type;
      if (type & 16) {
        this.quant = bits.read(5);
        if (!this.quant) throw new Error('Zero macroblock quantizer');
      }
      const intra = !!(type & 1);
      if (intra) this.motion.fill(0);
      else {
        this.dc.fill(128 << this.dcPrecision);
        for (let d = 0; d < 2; d++) {
          if (type & (8 >> d))
            for (let axis = 0; axis < 2; axis++) this.decodeMotion(bits, d, axis);
          else if (frame.pictureType === 2 && d === 0) {
            this.motion[0] = 0;
            this.motion[1] = 0;
          }
        }
        this.predict(frame.pictureType === 2 ? type | 8 : type);
      }
      const pattern = type & 2 ? CBP.read(bits) : intra ? 63 : 0;
      for (let b = 0; b < 6; b++) if (pattern & (32 >> b)) this.block(bits, b, intra);
      this.markMacroblock();
    }
  }
  private markMacroblock(): void {
    if (this.address < 0 || this.address >= this.covered.length || this.covered[this.address])
      throw new Error('Overlapping/out-of-range MPEG macroblock');
    this.covered[this.address] = 1;
    this.decodedBlocks++;
  }
  private decodeMotion(bits: BitReader, direction: number, axis: number): void {
    const code = MOTION.read(bits),
      r = this.fcode[direction]! - 1,
      scale = 1 << r,
      i = direction * 2 + axis;
    let delta = 0;
    if (code) {
      delta = (Math.abs(code) - 1) * scale + (r ? bits.read(r) : 0) + 1;
      if (code < 0) delta = -delta;
    }
    let value = this.motion[i]! + delta;
    const limit = 16 * scale;
    if (value < -limit) value += 2 * limit;
    else if (value >= limit) value -= 2 * limit;
    this.motion[i] = value;
  }
  private predict(type: number): void {
    const frame = this.current!;
    let average = false;
    for (let d = 0; d < 2; d++)
      if (type & (8 >> d)) {
        const ref = d === 1 || frame.pictureType === 2 ? this.future : this.past;
        if (!ref) throw new Error('Missing MPEG reference picture');
        let mx = this.motion[d * 2]! * (1 << this.fullpel[d]!),
          my = this.motion[d * 2 + 1]! * (1 << this.fullpel[d]!);
        for (let p = 0; p < 3; p++) {
          const stride = p ? frame.stride / 2 : frame.stride,
            height = p ? frame.paddedHeight / 2 : frame.paddedHeight,
            size = p ? 8 : 16;
          const dx = p ? Math.trunc(mx / 2) : mx,
            dy = p ? Math.trunc(my / 2) : my,
            ix = Math.floor(dx / 2),
            iy = Math.floor(dy / 2),
            hx = dx & 1,
            hy = dy & 1;
          const x0 = (this.address % (frame.stride / 16)) * size,
            y0 = Math.floor(this.address / (frame.stride / 16)) * size;
          const src = p === 0 ? ref.y : p === 1 ? ref.cb : ref.cr,
            dst = p === 0 ? frame.y : p === 1 ? frame.cb : frame.cr;
          for (let y = 0; y < size; y++) {
            const sy = Math.max(0, Math.min(height - 1, y0 + y + iy)),
              sy1 = Math.max(0, Math.min(height - 1, y0 + y + iy + 1)),
              row = sy * stride,
              row1 = sy1 * stride,
              target = (y0 + y) * stride + x0;
            for (let x = 0; x < size; x++) {
              const sx = Math.max(0, Math.min(stride - 1, x0 + x + ix)),
                sx1 = Math.max(0, Math.min(stride - 1, x0 + x + ix + 1));
              let v = src[row + sx]!;
              if (hx && hy) v = (v + src[row + sx1]! + src[row1 + sx]! + src[row1 + sx1]! + 2) >> 2;
              else if (hx) v = (v + src[row + sx1]! + 1) >> 1;
              else if (hy) v = (v + src[row1 + sx]! + 1) >> 1;
              dst[target + x] = average ? (dst[target + x]! + v + 1) >> 1 : v;
            }
          }
        }
        average = true;
      }
    if (!average) throw new Error('Inter macroblock has no prediction');
  }
  private block(bits: BitReader, block: number, intra: boolean): void {
    const coeff = this.coeff;
    coeff.fill(0);
    let n = 0;
    if (intra) {
      const component = block < 4 ? 0 : block - 3,
        size = DC[component ? 1 : 0]!.read(bits),
        raw = bits.read(size);
      const delta = size && raw < 1 << (size - 1) ? raw - ((1 << size) - 1) : raw;
      this.dc[component] = this.dc[component]! + delta;
      coeff[0] = this.dc[component]! * (1 << (3 - this.dcPrecision));
      n = 1;
    }
    for (;;) {
      let code: number;
      if (!intra && n === 0 && bits.peek(1)) {
        bits.skip(1);
        code = 1;
      } else code = AC.read(bits);
      if (code === -1) {
        if (!n) throw new Error('Empty coded block');
        break;
      }
      let run: number, level: number;
      if (code === -2) {
        run = bits.read(6);
        level = bits.read(8);
        if (level === 0) level = bits.read(8);
        else if (level === 128) level = bits.read(8) - 256;
        else if (level > 128) level -= 256;
        if (!level) throw new Error('Zero escaped DCT level');
      } else {
        run = code >> 8;
        level = code & 255;
        if (bits.read(1)) level = -level;
      }
      n += run;
      if (n >= 64) throw new Error('DCT run exceeds block');
      const index = ZIGZAG[n++]!,
        sign = level < 0 ? -1 : 1;
      let value = Math.floor(
        intra
          ? (Math.abs(level) * this.intraMatrix[index]! * this.quant) / 8
          : ((2 * Math.abs(level) + 1) * this.interMatrix[index]! * this.quant) / 16,
      );
      if (value && !(value & 1)) value--;
      coeff[index] = Math.max(-2048, Math.min(2047, value * sign));
    }
    const frame = this.current!,
      mbWidth = frame.stride / 16,
      x = this.address % mbWidth,
      y = Math.floor(this.address / mbWidth);
    const stride = block < 4 ? frame.stride : frame.stride / 2;
    const offset =
      block < 4
        ? (y * 16 + (block >> 1) * 8) * stride + x * 16 + (block & 1) * 8
        : y * 8 * stride + x * 8;
    this.idct.add(
      coeff,
      block < 4 ? frame.y : block === 4 ? frame.cb : frame.cr,
      offset,
      stride,
      intra,
    );
  }
}
