// VC-1 decoder for progressive I and P pictures of Main profile (WMV3) and Advanced profile
// (WVC1) streams, following FFmpeg 7.1.1 libavcodec (vc1.c, vc1dec.c, vc1_block.c, vc1_pred.c,
// vc1_mc.c, vc1_loopfilter.c, mpegvideo_dec.c), LGPL 2.1 or later. Every path reproduces
// FFmpeg's integer arithmetic, buffer layout and error behaviour, so decoded pictures are
// bit-identical. Features outside this subset are refused when the stream announces them.
// Copyright notices and license: ./NOTICE and ./LICENSE.

import {BitReader, BITSTREAM_PADDING, buildVlc} from './bitstream.js';
import type {Vlc} from './bitstream.js';
import * as D from './dsp.js';
import * as T from './tables.js';
import {VC1_BLOCK_SCALARS, VC1_BLOCK_BUFFERS} from './block-state.js';

export const FOURCC_WMV3 = 0x33564d57;
export const FOURCC_WVC1 = 0x31435657;
export const PICTURE_I = 1;
export const PICTURE_P = 2;
const PICTURE_B = 3;
const PICTURE_BI = 4;
/** FFmpeg `AVERROR_INVALIDDATA`. */
export const INVALID_DATA = -1094995529;
/** Bound compressed packet storage independently of the dimensions announced in a header. */
export const VC1_PACKET_LIMIT = 16 * 1024 * 1024;

/** A decode error with FFmpeg's error code. */
export class Vc1Error extends Error {
  constructor(readonly code: number) {
    super(`VC-1 decode error ${code}`);
  }
}

/** A decoded picture. The planes belong to the decoder and are valid until the next call. */
export interface Vc1Picture {
  readonly y: Uint8Array;
  readonly cb: Uint8Array;
  readonly cr: Uint8Array;
  readonly stride: number;
  readonly chromaStride: number;
  /** `PICTURE_I` or `PICTURE_P`. */
  readonly type: number;
  /** Time of the packet whose decoding allocated the picture. */
  readonly time: number;
}

const unsupported = (feature: string): Error => new Error(`Unsupported VC-1 feature: ${feature}`);

// Start codes.
const CODE_ENDOFSEQ = 0x10a;
const CODE_SLICE = 0x10b;
const CODE_FIELD = 0x10c;
const CODE_FRAME = 0x10d;
const CODE_ENTRYPOINT = 0x10e;
const CODE_SEQHDR = 0x10f;

// Coding sets (CS_*).
const HIGH_MOT_INTRA = 0;
const HIGH_MOT_INTER = 1;
const LOW_MOT_INTRA = 2;
const LOW_MOT_INTER = 3;
const MID_RATE_INTRA = 4;
const MID_RATE_INTER = 5;
const HIGH_RATE_INTRA = 6;
const HIGH_RATE_INTER = 7;

// Motion vector modes (MV_PMODE_*).
const MV_1MV_HPEL_BILIN = 0;
const MV_1MV_HPEL = 2;
const MV_MIXED = 3;
const MV_IC = 4;
const MV_PMODE = [0, 1, 2, 4, 3, 1, 3, 2, 4, 0];
const MV_PMODE2 = [0, 1, 2, 3, 1, 3, 2, 0];

// Transform types (TT_*).
const TT_8X8 = 0;
const TT_8X4_BOTTOM = 1;
const TT_8X4_TOP = 2;
const TT_8X4 = 3;
const TT_4X8_RIGHT = 4;
const TT_4X8_LEFT = 5;
const TT_4X8 = 6;
const TT_4X4 = 7;
const TTFRM_TO_TT = [TT_8X8, TT_8X4, TT_4X8, TT_4X4];
const TTBLK_TO_TT = [3, 6, 0, 7, 2, 1, 4, 5, 0, 4, 5, 7, 3, 6, 1, 2, 0, 6, 7, 1, 4, 5, 3, 2];

// Loop filter edge flags.
const LEFT_EDGE = 1;
const RIGHT_EDGE = 2;
const TOP_EDGE = 4;
const BOTTOM_EDGE = 8;

const MV_OFFSET = [0, 1, 3, 7, 15, 31, 63, 127, 255];
const MV_SIZE = [0, 2, 3, 4, 5, 8];
/** `vc1_i_pred_dc` predictor for missing neighbours (uint16, so -1 is 65535). */
const DC_PRED = new Uint16Array([
  -1, 1024, 512, 341, 256, 205, 171, 146, 128, 114, 102, 93, 85, 79, 73, 68, 64, 60, 57, 54, 51, 49,
  47, 45, 43, 41, 39, 38, 37, 35, 34, 33,
]);
const POPCOUNT4 = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];
const CHROMA_INDEX2 = [0, 0, 0, 0x01, 0, 0x02, 0x12, 0, 0, 0x03, 0x13, 0, 0x23, 0, 0, 0];

interface Tables {
  imode: Vlc;
  norm2: Vlc;
  norm6: Vlc;
  ttmb: Vlc[];
  ttblk: Vlc[];
  subblkpat: Vlc[];
  cbpcy: Vlc[];
  mvDiff: Vlc[];
  ac: Vlc[];
  mbIntra: Vlc;
  /** Index `table * 2 + chroma`. */
  dc: Vlc[];
}

let tables: Tables | undefined;
function vlcTables(): Tables {
  if (tables) return tables;
  const range = (n: number, f: (i: number) => Vlc) => Array.from({length: n}, (_, i) => f(i));
  const acStart: number[] = [];
  for (let i = 0, s = 0; i < 8; s += T.AC_SIZES[i]!, i++) acStart.push(s);
  tables = {
    imode: buildVlc(4, T.IMODE, 0, 7),
    norm2: buildVlc(3, T.NORM2, 0, 4),
    norm6: buildVlc(9, T.NORM6, 0, 64),
    ttmb: range(3, (i) => buildVlc(9, T.TTMB, i * 16, 16)),
    ttblk: range(3, (i) => buildVlc(5, T.TTBLK, i * 8, 8)),
    subblkpat: range(3, (i) => buildVlc(6, T.SUBBLKPAT, i * 15, 15)),
    cbpcy: range(4, (i) => buildVlc(9, T.CBPCY_P, i * 64, 64)),
    mvDiff: range(4, (i) => buildVlc(9, T.MV_DIFF, i * 73, 73)),
    ac: range(8, (i) => buildVlc(9, T.AC_CODES, acStart[i]!, T.AC_SIZES[i]!)),
    mbIntra: buildVlc(9, T.MB_I, 0, 64),
    dc: range(4, (i) => buildVlc(9, T.DC_CODES, i * 120, 120)),
  };
  return tables;
}

const clip = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const clipUint8 = (a: number): number => (a & ~255 ? (~a >> 31) & 255 : a);

function midPred(a: number, b: number, c: number): number {
  if (a > b) {
    if (c > b) b = c > a ? a : c;
  } else if (b > c) b = c > a ? c : a;
  return b;
}

function median4(a: number, b: number, c: number, d: number): number {
  const half = (x: number) => (x / 2) | 0;
  if (a < b) {
    if (c < d) return half(Math.max(a, c) + Math.min(b, d));
    return half(Math.max(a, d) + Math.min(b, c));
  }
  if (c < d) return half(Math.max(b, c) + Math.min(a, d));
  return half(Math.max(b, d) + Math.min(a, c));
}

const readU32 = (b: Uint8Array, o: number): number =>
  ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
const isMarker = (x: number): boolean => x >>> 8 === 1;

/** `find_next_marker`: offset of the next start code in `[start, end)`, or `end`. */
function findNextMarker(b: Uint8Array, start: number, end: number): number {
  if (end - start < 4) return end;
  for (let i = start; i + 3 < end; i++)
    if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1) return i;
  return end;
}

/** `vc1_unescape_buffer`: removes emulation prevention bytes, returns the output size. */
function unescape(src: Uint8Array, s: number, size: number, dst: Uint8Array): number {
  if (size < 4) {
    dst.set(src.subarray(s, s + size));
    return size;
  }
  let n = 0;
  for (let i = 0; i < size; i++) {
    const v = src[s + i]!;
    if (
      v === 3 &&
      i >= 2 &&
      !src[s + i - 1] &&
      !src[s + i - 2] &&
      i < size - 1 &&
      src[s + i + 1]! < 4
    ) {
      dst[n++] = src[s + i + 1]!;
      i++;
    } else dst[n++] = v;
  }
  return n;
}

/** Storage and slice decoding supplied by the optional Rust backend. */
export interface Vc1WasmBackend {
  reset(bytes: number): void;
  u8(length: number): Uint8Array;
  i16(length: number): Int16Array;
  i8(length: number): Int8Array;
  i32(length: number): Int32Array;
  decodeBlocks(state: Int32Array, bits: BitReader, lutY: Uint8Array, lutUv: Uint8Array): void;
}

class Picture {
  readonly y: Uint8Array;
  readonly cb: Uint8Array;
  readonly cr: Uint8Array;
  type = 0;
  time = 0;
  constructor(
    lumaSize: number,
    chromaSize: number,
    slack: number,
    backend?: Vc1WasmBackend,
    repeated?: Picture,
  ) {
    this.y = repeated?.y ?? backend?.u8(lumaSize + slack) ?? new Uint8Array(lumaSize + slack);
    this.cb = repeated?.cb ?? backend?.u8(chromaSize + slack) ?? new Uint8Array(chromaSize + slack);
    this.cr = repeated?.cr ?? backend?.u8(chromaSize + slack) ?? new Uint8Array(chromaSize + slack);
  }
}

interface Slice {
  reader: BitReader;
  mbyStart: number;
}

export class Vc1Decoder {
  /** Output size. */
  width: number;
  height: number;
  private readonly advanced: boolean;

  // Sequence and entry point.
  private loopFilter = 0;
  private multires = 0;
  private resX8 = 0;
  private resFasttx = 0;
  private fastuvmc = 0;
  private extendedMv = 0;
  private dquant = 0;
  private vstransform = 0;
  private overlap = 0;
  private rangered = 0;
  private maxBFrames = 0;
  private quantizerMode = 0;
  private finterp = 0;
  private resRtm = 0;
  private postprocflag = 0;
  private broadcast = 0;
  private interlace = 0;
  private tfcntr = 0;
  private hrdBuckets = -1;
  private maxCodedWidth = 0;
  private maxCodedHeight = 0;
  private codedWidth = 0;
  private codedHeight = 0;
  private seqInitialized = false;
  private entryInitialized = false;

  // Scan tables.
  private readonly zz8x8: Uint8Array[] = [];
  private zz8x4: Uint8Array = T.WMV2_SCAN_A;
  private zz4x8: Uint8Array = T.WMV2_SCAN_B;
  private readonly leftSh = 0;
  private readonly topSh = 3;

  // Context, allocated for the coded size.
  private initialized = false;
  private lowDelay = 1;
  private allocWidth = -1;
  private allocHeight = -1;
  private mbw = 0;
  private mbh = 0;
  private mbs = 0;
  private b8 = 0;
  private ls = 0;
  private uvls = 0;
  private hEdge = 0;
  private vEdge = 0;
  /** Origin of the block-indexed arrays (`b8_stride + 1`). */
  private origin = 0;
  private dcVal: Int16Array = new Int16Array(0);
  private acVal: Int16Array = new Int16Array(0);
  private codedBlock: Uint8Array = new Uint8Array(0);
  private mbType: Uint8Array = new Uint8Array(0);
  private motion: Int16Array = new Int16Array(0);
  private qscale: Int8Array = new Int8Array(0);
  private cbpRow: Int32Array = new Int32Array(0);
  private ttblkRow: Int32Array = new Int32Array(0);
  private isIntraRow: Uint8Array = new Uint8Array(0);
  private lumaMv: Int16Array = new Int16Array(0);
  private mvTypePlane: Uint8Array = new Uint8Array(0);
  private skipPlane: Uint8Array = new Uint8Array(0);
  private acpredPlane: Uint8Array = new Uint8Array(0);
  private blocks: Int16Array = new Int16Array(0);
  private emu: Uint8Array = new Uint8Array(0);
  private readonly blockState = new Int32Array(
    VC1_BLOCK_SCALARS.length + VC1_BLOCK_BUFFERS.length + 8,
  );
  private pool: Picture[] = [];
  private cur: Picture | null = null;
  private last: Picture | null = null;
  private next: Picture | null = null;
  private buf2 = new Uint8Array(BITSTREAM_PADDING);
  private packet = new Uint8Array(BITSTREAM_PADDING);
  private gb = new BitReader();

  // Picture header.
  private pictType = 0;
  private skipped = 0;
  private rnd = 0;
  private pq = 0;
  private pqindex = 0;
  private halfpq = 0;
  private pquantizer = 0;
  private dquantfrm = 0;
  private mvrange = 0;
  private kX = 0;
  private kY = 0;
  private rangeX = 0;
  private rangeY = 0;
  private ttIndex = 0;
  private mvMode = 0;
  private quarterSample = 0;
  private mspel = 0;
  private mvTypeIsRaw = 0;
  private skipIsRaw = 0;
  private acpredIsRaw = 0;
  private mvTable = 0;
  private cbptab = 0;
  private ttmbf = 0;
  private ttfrm = 0;
  private cAc = 0;
  private yAc = 0;
  private dcTable = 0;
  private firstPicHeader = 0;
  private useIc = 0;
  private readonly lutY = new Uint8Array(256);
  private readonly lutUv = new Uint8Array(256);
  private rawFlag = 0;

  // Slice and macroblock state.
  private codingset = 0;
  private codingset2 = 0;
  private startMbY = 0;
  private endMbY = 0;
  private mbX = 0;
  private mbY = 0;
  private firstSliceLine = 0;
  private readonly bi = new Int32Array(6);
  private readonly wrap = new Int32Array(6);
  private dest0 = 0;
  private dest1 = 0;
  private curBlk = 0;
  private leftBlk = 0;
  private topleftBlk = 0;
  private topBlk = 0;
  private acPred = 0;
  private mbIntra = 0;
  private aAvail = 0;
  private cAvail = 0;
  private yDcScale = 0;
  private cDcScale = 0;
  private esc3Level = 0;
  private esc3Run = 0;
  private readonly mv = new Int32Array(8);
  private dmvX = 0;
  private dmvY = 0;
  private mbHasCoeffs = 0;
  private acLast = 0;
  private acRun = 0;
  private acValue = 0;
  private ttOut = 0;

  constructor(
    fourcc: number,
    width: number,
    height: number,
    extra: Uint8Array,
    private readonly backend?: Vc1WasmBackend,
  ) {
    this.checkDimensions(width, height);
    vlcTables();
    for (let k = 0; k < 4; k++) {
      const zz = new Uint8Array(64);
      for (let i = 0; i < 64; i++) {
        const x = T.WMV1_SCAN[k * 64 + i]!;
        zz[i] = (x >> 3) | ((x & 7) << 3);
      }
      this.zz8x8.push(zz);
    }
    this.width = width;
    this.height = height;
    if (!extra.length) throw new Vc1Error(INVALID_DATA);
    if (fourcc === FOURCC_WMV3) {
      this.advanced = false;
      if (extra.length < 4) throw new Vc1Error(INVALID_DATA);
      const gb = new BitReader(padded(extra), extra.length);
      this.sequenceHeader(gb);
      if (this.advanced) throw unsupported('Advanced profile in WMV3');
      this.codedWidth = width;
      this.codedHeight = height;
    } else if (fourcc === FOURCC_WVC1) {
      this.advanced = true;
      if (extra.length < 16) throw new Vc1Error(INVALID_DATA);
      const end = extra.length,
        buf = new Uint8Array(end + BITSTREAM_PADDING);
      let start = findNextMarker(extra, 0, end),
        next = start;
      for (; next < end; start = next) {
        next = findNextMarker(extra, start + 4, end);
        const size = next - start - 4;
        if (size <= 0) continue;
        buf.fill(0);
        const gb = new BitReader(buf, unescape(extra, start + 4, size, buf));
        const code = readU32(extra, start);
        if (code === CODE_SEQHDR) this.sequenceHeader(gb);
        else if (code === CODE_ENTRYPOINT) this.entryPoint(gb);
      }
      if (!this.seqInitialized || !this.entryInitialized) throw new Vc1Error(INVALID_DATA);
      this.zz8x4 = T.ZZ_8X4_ADV;
      this.zz4x8 = T.ZZ_4X8_ADV;
    } else throw unsupported(`codec 0x${fourcc.toString(16)}`);
    if (!this.advanced && !this.resFasttx) throw unsupported('simple IDCT (res_fasttx = 0)');
    this.allocate();
  }

  // ---------------------------------------------------------------------------------------
  // Headers

  private sequenceHeader(gb: BitReader): void {
    const profile = gb.bits(2);
    if (profile === 3) {
      if (!this.advanced) throw unsupported('Advanced profile in WMV3');
      this.resRtm = 1;
      gb.bits(3); // level
      if (gb.bits(2) !== 1) throw new Vc1Error(-1); // chroma format
      gb.bits(3);
      gb.bits(5);
      this.postprocflag = gb.bit();
      this.maxCodedWidth = (gb.bits(12) + 1) << 1;
      this.maxCodedHeight = (gb.bits(12) + 1) << 1;
      this.broadcast = gb.bit();
      this.interlace = gb.bit();
      this.tfcntr = gb.bit();
      this.finterp = gb.bit();
      gb.skip(1);
      if (gb.bit()) throw new Vc1Error(-1); // psf
      this.maxBFrames = 7;
      if (gb.bit()) {
        gb.bits(14);
        gb.bits(14);
        let ar = 0;
        if (gb.bit()) ar = gb.bits(4);
        if (ar === 15) {
          gb.bits(8);
          gb.bits(8);
        }
        if (gb.bit()) {
          if (gb.bit()) gb.bits(16);
          else {
            gb.bits(8);
            gb.bits(4);
          }
        }
        if (gb.bit()) {
          gb.bits(8);
          gb.bits(8);
          gb.bits(8);
        }
      }
      this.hrdBuckets = -1;
      if (gb.bit()) {
        this.hrdBuckets = gb.bits(5);
        gb.skip(4);
        gb.skip(4);
        for (let i = 0; i < this.hrdBuckets; i++) {
          gb.skip(16);
          gb.skip(16);
        }
      }
      if (this.interlace) throw unsupported('interlaced coding');
      this.seqInitialized = true;
      return;
    }
    if (this.advanced) throw unsupported(`profile ${profile} in WVC1`);
    if (profile !== 1) throw unsupported(`WMV3 profile ${profile}`);
    if (gb.bit()) throw new Vc1Error(-1); // res_y411
    if (gb.bit()) throw unsupported('sprites');
    gb.bits(3);
    gb.bits(5);
    this.loopFilter = gb.bit();
    this.resX8 = gb.bit();
    this.multires = gb.bit();
    this.resFasttx = gb.bit();
    this.fastuvmc = gb.bit();
    if (!profile && !this.fastuvmc) throw new Vc1Error(-1);
    this.extendedMv = gb.bit();
    if (!profile && this.extendedMv) throw new Vc1Error(-1);
    this.dquant = gb.bits(2);
    this.vstransform = gb.bit();
    if (gb.bit()) throw new Vc1Error(-1); // res_transtab
    this.overlap = gb.bit();
    gb.bit(); // resync marker
    this.rangered = gb.bit();
    this.maxBFrames = gb.bits(3);
    this.quantizerMode = gb.bits(2);
    this.finterp = gb.bit();
    this.resRtm = gb.bit();
    if (this.resX8) throw unsupported('X8 intra pictures');
    if (this.multires) throw unsupported('multiresolution');
    if (this.rangered) throw unsupported('range reduction');
    if (this.dquant) throw unsupported('macroblock quantizer');
    if (this.overlap) throw unsupported('overlap transform');
    if (this.maxBFrames) throw unsupported('B pictures');
    this.seqInitialized = true;
  }

  private entryPoint(gb: BitReader): void {
    gb.bit(); // broken link
    gb.bit(); // closed entry
    gb.bit(); // pan-scan
    gb.bit(); // refdist
    this.loopFilter = gb.bit();
    this.fastuvmc = gb.bit();
    this.extendedMv = gb.bit();
    this.dquant = gb.bits(2);
    this.vstransform = gb.bit();
    this.overlap = gb.bit();
    this.quantizerMode = gb.bits(2);
    for (let i = 0; i < this.hrdBuckets; i++) gb.skip(8);
    let w = this.maxCodedWidth,
      h = this.maxCodedHeight;
    if (gb.bit()) {
      w = (gb.bits(12) + 1) << 1;
      h = (gb.bits(12) + 1) << 1;
    }
    this.codedWidth = this.width = w;
    this.codedHeight = this.height = h;
    if (this.extendedMv) gb.bit(); // extended dmv
    if (gb.bit()) throw unsupported('luma range mapping');
    if (gb.bit()) throw unsupported('chroma range mapping');
    if (this.dquant) throw unsupported('macroblock quantizer');
    if (this.overlap) throw unsupported('overlap transform');
    this.entryInitialized = true;
  }

  private quantizer(gb: BitReader): number {
    const pqindex = gb.bits(5);
    if (!pqindex) return -1;
    this.pq = T.PQUANT[(this.quantizerMode === 0 ? 0 : 32) + pqindex]!;
    this.pqindex = pqindex;
    this.halfpq = pqindex < 9 ? gb.bit() : 0;
    switch (this.quantizerMode) {
      case 0:
        this.pquantizer = pqindex < 9 ? 1 : 0;
        break;
      case 2:
        this.pquantizer = 0;
        break;
      case 1:
        this.pquantizer = gb.bit();
        break;
      default:
        this.pquantizer = 1;
    }
    this.dquantfrm = 0;
    return 0;
  }

  private setMvRange(): void {
    this.kX = this.mvrange + 9 + (this.mvrange >> 1);
    this.kY = this.mvrange + 8;
    this.rangeX = 1 << (this.kX - 1);
    this.rangeY = 1 << (this.kY - 1);
  }

  /** `rotate_luts` for I and P pictures: the last LUT becomes the identity. */
  private rotateLuts(): void {
    for (let i = 0; i < 256; i++) this.lutY[i] = this.lutUv[i] = i;
    this.useIc = 0;
  }

  /** `INIT_LUT` chained onto the last LUT (both field LUTs are equal in progressive streams). */
  private initLut(lumscale: number, lumshift: number): void {
    let scale: number, shift: number;
    if (!lumscale) {
      scale = -64;
      shift = (255 - lumshift * 2) * 64;
      if (lumshift > 31) shift += 128 << 6;
    } else {
      scale = lumscale + 32;
      shift = lumshift > 31 ? (lumshift - 64) * 64 : lumshift << 6;
    }
    for (let i = 0; i < 256; i++) {
      this.lutY[i] = clipUint8((scale * this.lutY[i]! + shift + 32) >> 6);
      this.lutUv[i] = clipUint8((scale * (this.lutUv[i]! - 128) + 128 * 64 + 32) >> 6);
    }
  }

  /** The P picture motion mode, bit planes and transform syntax shared by both profiles. */
  private pHeader(gb: BitReader, advanced: boolean): number {
    this.ttIndex = (this.pq > 4 ? 1 : 0) + (this.pq > 12 ? 1 : 0);
    const lowquant = this.pq > 12 ? 0 : 1;
    this.mvMode = MV_PMODE[lowquant * 5 + gb.unary(1, 4)]!;
    let mode = this.mvMode;
    if (mode === MV_IC) {
      mode = MV_PMODE2[lowquant * 4 + gb.unary(1, 3)]!;
      const lumscale = gb.bits(6),
        lumshift = gb.bits(6);
      this.useIc = 1;
      this.initLut(lumscale, lumshift);
    }
    this.quarterSample = mode !== MV_1MV_HPEL && mode !== MV_1MV_HPEL_BILIN ? 1 : 0;
    this.mspel = mode !== MV_1MV_HPEL_BILIN ? 1 : 0;
    if (mode === MV_MIXED) {
      if (this.bitplane(this.mvTypePlane) < 0) return -1;
      this.mvTypeIsRaw = this.rawFlag;
    } else {
      this.mvTypeIsRaw = 0;
      this.mvTypePlane.fill(0, 0, this.mbs * this.mbh);
    }
    if (this.bitplane(this.skipPlane) < 0) return -1;
    this.skipIsRaw = this.rawFlag;
    if (!advanced && gb.left() < 4) return INVALID_DATA;
    this.mvTable = gb.bits(2);
    this.cbptab = gb.bits(2);
    if (this.vstransform) {
      this.ttmbf = gb.bit();
      this.ttfrm = this.ttmbf ? TTFRM_TO_TT[gb.bits(2)]! : 0;
    } else {
      this.ttmbf = 1;
      this.ttfrm = TT_8X8;
    }
    return 0;
  }

  /** `ff_vc1_parse_frame_header` (Main profile). */
  private frameHeaderMain(): number {
    const gb = this.gb;
    if (this.finterp) gb.bit();
    gb.skip(2);
    let type: number;
    if (gb.bit()) type = PICTURE_P;
    else type = this.maxBFrames && !gb.bit() ? PICTURE_B : PICTURE_I;
    this.pictType = type;
    this.skipped = 0;
    if (type === PICTURE_I) gb.skip(7);
    if (type === PICTURE_I) this.rnd = 1;
    if (type === PICTURE_P) this.rnd ^= 1;
    if (gb.left() < 5) return INVALID_DATA;
    if (this.quantizer(gb) < 0) return -1;
    if (this.extendedMv) this.mvrange = gb.unary(0, 3);
    this.setMvRange();
    if (this.firstPicHeader) this.rotateLuts();
    if (type === PICTURE_P) {
      const ret = this.pHeader(gb, false);
      if (ret < 0) return ret;
    }
    this.cAc = gb.decode012();
    if (type === PICTURE_I) this.yAc = gb.decode012();
    this.dcTable = gb.bit();
    return 0;
  }

  /** `ff_vc1_parse_frame_header_adv` for progressive pictures. */
  private frameHeaderAdv(): number {
    const gb = this.gb;
    this.skipped = 0;
    switch (gb.unary(0, 4)) {
      case 0:
        this.pictType = PICTURE_P;
        break;
      case 1:
        this.pictType = PICTURE_B;
        break;
      case 2:
        this.pictType = PICTURE_I;
        break;
      case 3:
        this.pictType = PICTURE_BI;
        break;
      default:
        this.pictType = PICTURE_P;
        this.skipped = 1;
    }
    if (this.tfcntr) gb.skip(8);
    if (this.broadcast) gb.bits(2);
    if (this.skipped) return 0;
    this.rnd = gb.bit();
    if (this.finterp) gb.bit();
    if (this.pictType === PICTURE_B) {
      let index = gb.bits(3);
      if (index === 7) index = 7 + gb.bits(4);
      if (index === 21) return INVALID_DATA;
      if (T.BFRACTION[index] === 0) this.pictType = PICTURE_BI;
    }
    if (this.quantizer(gb) < 0) return -1;
    if (this.postprocflag) gb.bits(2);
    const type = this.pictType;
    // B pictures are refused before their remaining syntax matters.
    if (type === PICTURE_B || type === PICTURE_BI) return 0;
    if (this.firstPicHeader) this.rotateLuts();
    if (type === PICTURE_I) {
      if (this.bitplane(this.acpredPlane) < 0) return -1;
      this.acpredIsRaw = this.rawFlag;
    } else {
      this.mvrange = this.extendedMv ? gb.unary(0, 3) : 0;
      this.setMvRange();
      const ret = this.pHeader(gb, true);
      if (ret < 0) return ret;
    }
    this.cAc = gb.decode012();
    if (type === PICTURE_I) this.yAc = gb.decode012();
    this.dcTable = gb.bit();
    return 0;
  }

  /** `bitplane_decoding`; sets `rawFlag`, returns a negative value on error. */
  private bitplane(data: Uint8Array): number {
    const gb = this.gb,
      t = vlcTables(),
      width = this.mbw,
      height = this.mbh,
      stride = this.mbs;
    const invert = gb.bit();
    const imode = gb.vlc(t.imode, 4, 1);
    this.rawFlag = 0;
    let p = 0;
    switch (imode) {
      case 0:
        this.rawFlag = 1;
        return invert;
      case 1:
      case 2: {
        let y = 0,
          offset = 0;
        if ((height * width) & 1) {
          data[p++] = gb.bit();
          y = offset = 1;
          if (offset === width) {
            offset = 0;
            p += stride - width;
          }
        }
        for (; y < height * width; y += 2) {
          const code = gb.vlc(t.norm2, 3, 1);
          data[p++] = code & 1;
          if (++offset === width) {
            offset = 0;
            p += stride - width;
          }
          data[p++] = code >> 1;
          if (++offset === width) {
            offset = 0;
            p += stride - width;
          }
        }
        break;
      }
      case 3:
      case 4:
        if (!(height % 3) && width % 3) {
          for (let y = 0; y < height; y += 3) {
            for (let x = width & 1; x < width; x += 2) {
              const code = gb.vlc(t.norm6, 9, 2);
              if (code < 0) return -1;
              data[p + x] = code & 1;
              data[p + x + 1] = (code >> 1) & 1;
              data[p + x + stride] = (code >> 2) & 1;
              data[p + x + 1 + stride] = (code >> 3) & 1;
              data[p + x + stride * 2] = (code >> 4) & 1;
              data[p + x + 1 + stride * 2] = (code >> 5) & 1;
            }
            p += stride * 3;
          }
          if (width & 1) this.colskip(data, 0, 1, height);
        } else {
          p += (height & 1) * stride;
          for (let y = height & 1; y < height; y += 2) {
            for (let x = width % 3; x < width; x += 3) {
              const code = gb.vlc(t.norm6, 9, 2);
              if (code < 0) return -1;
              data[p + x] = code & 1;
              data[p + x + 1] = (code >> 1) & 1;
              data[p + x + 2] = (code >> 2) & 1;
              data[p + x + stride] = (code >> 3) & 1;
              data[p + x + 1 + stride] = (code >> 4) & 1;
              data[p + x + 2 + stride] = (code >> 5) & 1;
            }
            p += stride * 2;
          }
          const x = width % 3;
          if (x) this.colskip(data, 0, x, height);
          if (height & 1) this.rowskip(data, x, width - x, 1);
        }
        break;
      case 5:
        this.rowskip(data, 0, width, height);
        break;
      case 6:
        this.colskip(data, 0, width, height);
        break;
    }
    if (imode === 2 || imode === 4) {
      data[0]! ^= invert;
      for (let x = 1; x < width; x++) data[x]! ^= data[x - 1]!;
      for (let y = 1, r = stride; y < height; y++, r += stride) {
        data[r]! ^= data[r - stride]!;
        for (let x = 1; x < width; x++)
          if (data[r + x - 1] !== data[r + x - stride]) data[r + x]! ^= invert;
          else data[r + x]! ^= data[r + x - 1]!;
      }
    } else if (invert) {
      for (let x = 0; x < stride * height; x++) data[x] = data[x] ? 0 : 1;
    }
    return (imode << 1) + invert;
  }

  private rowskip(data: Uint8Array, p: number, width: number, height: number): void {
    const gb = this.gb;
    for (let y = 0; y < height; y++, p += this.mbs) {
      if (!gb.bit()) data.fill(0, p, p + width);
      else for (let x = 0; x < width; x++) data[p + x] = gb.bit();
    }
  }

  private colskip(data: Uint8Array, p: number, width: number, height: number): void {
    const gb = this.gb,
      stride = this.mbs;
    for (let x = 0; x < width; x++, p++) {
      if (!gb.bit()) for (let y = 0; y < height; y++) data[p + y * stride] = 0;
      else for (let y = 0; y < height; y++) data[p + y * stride] = gb.bit();
    }
  }

  // ---------------------------------------------------------------------------------------
  // Allocation and picture management

  private allocate(): void {
    const w = this.codedWidth,
      h = this.codedHeight;
    this.checkDimensions(w, h);
    this.allocWidth = w;
    this.allocHeight = h;
    const mbw = (w + 15) >> 4,
      mbh = (h + 15) >> 4;
    const mbhA = (mbh + 1) & ~1,
      mbs = mbw + 1,
      b8 = 2 * mbw + 1;
    this.mbw = mbw;
    this.mbh = mbh;
    this.mbs = mbs;
    this.b8 = b8;
    this.ls = mbw * 16;
    this.uvls = mbw * 8;
    this.origin = b8 + 1;
    const ySize = b8 * (2 * mbhA + 1),
      cSize = mbs * (mbhA + 1),
      yc = ySize + 2 * cSize;
    const blockLength = (mbw + 2) * 6 * 64;
    const emuLength = this.ls * 19 + this.uvls * 18 + 64;
    const lumaSize = this.ls * mbh * 16,
      chromaSize = this.uvls * mbh * 8;
    const slack = this.ls * 2 + 64;
    const contextBytes =
      yc * 35 + ySize + (b8 * 2 * mbhA + 8) * 4 + mbs * (mbh + 2) + mbs * 39 + mbs * (mbh + 1) * 3;
    // Reserve every context and picture buffer before creating views. Later memory growth
    // must never detach arrays that the JS header parser and Rust block loop share.
    this.backend?.reset(
      contextBytes +
        4 * (lumaSize + 2 * chromaSize + 3 * slack) +
        blockLength * 2 +
        emuLength +
        512,
    );
    this.dcVal = (this.backend?.i16(yc) ?? new Int16Array(yc)).fill(1024);
    this.acVal = this.backend?.i16(yc * 16) ?? new Int16Array(yc * 16);
    this.codedBlock = this.backend?.u8(ySize) ?? new Uint8Array(ySize);
    this.mbType =
      this.backend?.u8(b8 * (mbhA * 2 + 1) + mbs * (mbhA + 1) * 2) ??
      new Uint8Array(b8 * (mbhA * 2 + 1) + mbs * (mbhA + 1) * 2);
    this.motion =
      this.backend?.i16((b8 * 2 * mbhA + 8) * 2) ?? new Int16Array((b8 * 2 * mbhA + 8) * 2);
    this.qscale = this.backend?.i8(mbs * (mbh + 1) + mbs) ?? new Int8Array(mbs * (mbh + 1) + mbs);
    this.cbpRow = this.backend?.i32(3 * mbs) ?? new Int32Array(3 * mbs);
    this.ttblkRow = this.backend?.i32(3 * mbs) ?? new Int32Array(3 * mbs);
    this.isIntraRow = this.backend?.u8(3 * mbs) ?? new Uint8Array(3 * mbs);
    this.lumaMv = this.backend?.i16(3 * mbs * 2) ?? new Int16Array(3 * mbs * 2);
    this.mvTypePlane = this.backend?.u8(mbs * (mbh + 1)) ?? new Uint8Array(mbs * (mbh + 1));
    this.skipPlane = this.backend?.u8(mbs * (mbh + 1)) ?? new Uint8Array(mbs * (mbh + 1));
    this.acpredPlane = this.backend?.u8(mbs * (mbh + 1)) ?? new Uint8Array(mbs * (mbh + 1));
    this.blocks = this.backend?.i16(blockLength) ?? new Int16Array(blockLength);
    this.emu = this.backend?.u8(emuLength) ?? new Uint8Array(emuLength);
    this.pool = [];
    this.cur = this.last = this.next = null;
    this.initialized = false;
  }

  private checkDimensions(width: number, height: number): void {
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > 4096 ||
      height > 2160
    )
      throw unsupported('picture dimensions');
  }

  private newPicture(): Picture {
    const free = this.pool.find((p) => p.y !== this.last?.y && p.y !== this.next?.y);
    if (free) return free;
    const pic = new Picture(
      this.ls * this.mbh * 16,
      this.uvls * this.mbh * 8,
      this.ls * 2 + 64,
      this.backend,
    );
    this.pool.push(pic);
    return pic;
  }

  /** `ff_mpv_frame_start`, including the gray dummy reference for a P picture without one. */
  private frameStart(time: number): void {
    // A whole skipped picture keeps the reference storage and gets independent metadata.
    // Pool selection compares plane identities so a later frame cannot overwrite an alias.
    const cur =
      this.skipped && this.next ? new Picture(0, 0, 0, undefined, this.next) : this.newPicture();
    cur.type = this.pictType;
    cur.time = time;
    this.cur = cur;
    this.last = this.next;
    this.next = cur;
    if (!this.last && this.pictType !== PICTURE_I) {
      const dummy = new Picture(
        this.ls * this.mbh * 16,
        this.uvls * this.mbh * 8,
        this.ls * 2 + 64,
        this.backend,
      );
      dummy.y.fill(0x80);
      dummy.cb.fill(0x80);
      dummy.cr.fill(0x80);
      this.last = dummy;
    }
  }

  private output(pic: Picture): Vc1Picture {
    return {
      y: pic.y,
      cb: pic.cb,
      cr: pic.cr,
      stride: this.ls,
      chromaStride: this.uvls,
      type: pic.type,
      time: pic.time,
    };
  }

  // ---------------------------------------------------------------------------------------
  // Packets

  /** Decodes one packet; `null` drains the delayed picture of Advanced profile streams. */
  decode(data: Uint8Array | null, time: number): Vc1Picture | null {
    const size = data ? data.length : 0;
    if (size > VC1_PACKET_LIMIT) throw unsupported('packet size');
    if (!data || size === 0 || (size === 4 && readU32(data, 0) === CODE_ENDOFSEQ)) {
      if (this.initialized && !this.lowDelay && this.next) {
        const pic = this.next;
        this.next = null;
        return this.output(pic);
      }
      return null;
    }
    const slices: Slice[] = [];
    if (this.advanced) {
      if (this.buf2.length < size + BITSTREAM_PADDING)
        this.buf2 = new Uint8Array(size + BITSTREAM_PADDING);
      const buf2 = this.buf2;
      let size2 = 0;
      if (isMarker(readU32(data, 0))) {
        for (let start = 0, next = 0; next < size; start = next) {
          next = findNextMarker(data, start + 4, size);
          const n = next - start - 4;
          if (n <= 0) continue;
          switch (readU32(data, start)) {
            case CODE_FRAME:
              size2 = unescape(data, start + 4, n, buf2);
              break;
            case CODE_FIELD:
              throw unsupported('field pictures');
            case CODE_ENTRYPOINT: {
              size2 = unescape(data, start + 4, n, buf2);
              buf2.fill(0, size2, size2 + BITSTREAM_PADDING);
              this.entryPoint(new BitReader(buf2, size2));
              break;
            }
            case CODE_SLICE: {
              const buf = new Uint8Array(n + BITSTREAM_PADDING);
              const reader = new BitReader(buf, unescape(data, start + 4, n, buf));
              slices.push({reader, mbyStart: reader.bits(9)});
              break;
            }
          }
        }
      } else size2 = unescape(data, 0, size, buf2);
      buf2.fill(0, size2, size2 + BITSTREAM_PADDING);
      this.gb.reset(buf2, size2 * 8);
    } else {
      if (this.packet.length < size + BITSTREAM_PADDING)
        this.packet = new Uint8Array(size + BITSTREAM_PADDING);
      this.packet.set(data);
      this.packet.fill(0, size, size + BITSTREAM_PADDING);
      this.gb.reset(this.packet, size * 8);
    }

    if (this.allocWidth !== this.codedWidth || this.allocHeight !== this.codedHeight)
      this.allocate();
    if (!this.initialized) {
      this.lowDelay = this.maxBFrames ? 0 : 1;
      if (this.advanced) {
        if (this.codedWidth <= 1 || this.codedHeight <= 1) throw new Vc1Error(INVALID_DATA);
        this.hEdge = this.codedWidth;
        this.vEdge = this.codedHeight;
      } else {
        this.hEdge = this.mbw * 16;
        this.vEdge = this.mbh * 16;
      }
      this.initialized = true;
    }

    this.firstPicHeader = 1;
    const ret = this.advanced ? this.frameHeaderAdv() : this.frameHeaderMain();
    this.firstPicHeader = 0;
    if (ret < 0) throw new Vc1Error(ret);
    if (this.pictType === PICTURE_B || this.pictType === PICTURE_BI) {
      if (!this.last && this.pictType === PICTURE_B) return null;
      throw unsupported('B pictures');
    }

    this.frameStart(time);
    const mbh = this.mbh;
    let headerRet = 0;
    for (let i = 0; i <= slices.length; i++) {
      if (i > 0 && slices[i - 1]!.mbyStart >= mbh) continue;
      if (i && this.gb.bit()) {
        headerRet = this.frameHeaderAdv();
        if (headerRet < 0) continue;
        if (this.pictType !== PICTURE_I && this.pictType !== PICTURE_P)
          throw unsupported('B slices');
      }
      if (headerRet < 0) continue;
      this.startMbY = i === 0 ? 0 : Math.max(0, slices[i - 1]!.mbyStart % mbh);
      this.endMbY = i === slices.length ? mbh : Math.min(mbh, slices[i]!.mbyStart % mbh);
      if (this.endMbY <= this.startMbY) continue;
      this.decodeBlocks();
      if (i !== slices.length) this.gb = slices[i]!.reader;
    }
    this.gb = new BitReader();
    if (this.lowDelay) return this.output(this.cur!);
    return this.last ? this.output(this.last) : null;
  }

  // ---------------------------------------------------------------------------------------
  // Macroblock layer

  private decodeBlocks(): void {
    if (this.skipped && this.cur?.y === this.last?.y) return;
    if (this.backend) {
      const state = this.blockState;
      let at = 0;
      for (const name of VC1_BLOCK_SCALARS) state[at++] = Number(this[name]);
      for (const name of VC1_BLOCK_BUFFERS) state[at++] = this[name].byteOffset;
      const current = this.cur!,
        last = this.last;
      state[at++] = current.y.byteOffset;
      state[at++] = current.cb.byteOffset;
      state[at++] = current.cr.byteOffset;
      state[at++] = last?.y.byteOffset ?? 0;
      state[at++] = last?.cb.byteOffset ?? 0;
      state[at++] = last?.cr.byteOffset ?? 0;
      this.backend.decodeBlocks(state, this.gb, this.lutY, this.lutUv);
      return;
    }
    this.esc3Level = 0;
    this.curBlk = 0;
    this.leftBlk = -1;
    this.topleftBlk = 1;
    this.topBlk = 2;
    if (this.pictType === PICTURE_I) {
      if (this.advanced) this.iBlocksAdv();
      else this.iBlocks();
    } else if (this.skipped) this.skipBlocks();
    else this.pBlocks();
  }

  private incBlocks(): void {
    const n = this.mbw + 2;
    if (++this.topleftBlk >= n) this.topleftBlk = 0;
    if (++this.topBlk >= n) this.topBlk = 0;
    if (++this.leftBlk >= n) this.leftBlk = 0;
    if (++this.curBlk >= n) this.curBlk = 0;
  }

  private updateBlockIndex(): void {
    const x = this.mbX,
      y = this.mbY,
      b8 = this.b8,
      mbs = this.mbs,
      bi = this.bi,
      base = b8 * this.mbh * 2;
    bi[0] = b8 * 2 * y + 2 * x;
    bi[1] = bi[0] + 1;
    bi[2] = bi[0] + b8;
    bi[3] = bi[2] + 1;
    bi[4] = mbs * (y + 1) + base + x;
    bi[5] = mbs * (y + this.mbh + 2) + base + x;
    const w = this.wrap;
    w[0] = w[1] = w[2] = w[3] = b8;
    w[4] = w[5] = mbs;
    this.dest0 = 16 * x + 16 * y * this.ls;
    this.dest1 = 8 * x + 8 * y * this.uvls;
  }

  private blk(ring: number, n: number): number {
    return (ring * 6 + n) * 64;
  }

  private plane(pic: Picture, n: number): Uint8Array {
    return n < 4 ? pic.y : n === 4 ? pic.cb : pic.cr;
  }

  private setIntraCodingSets(): void {
    switch (this.yAc) {
      case 0:
        this.codingset = this.pqindex <= 8 ? HIGH_RATE_INTRA : LOW_MOT_INTRA;
        break;
      case 1:
        this.codingset = HIGH_MOT_INTRA;
        break;
      case 2:
        this.codingset = MID_RATE_INTRA;
        break;
    }
    this.setInterCodingSet();
  }

  private setInterCodingSet(): void {
    switch (this.cAc) {
      case 0:
        this.codingset2 = this.pqindex <= 8 ? HIGH_RATE_INTER : LOW_MOT_INTER;
        break;
      case 1:
        this.codingset2 = HIGH_MOT_INTER;
        break;
      case 2:
        this.codingset2 = MID_RATE_INTER;
        break;
    }
  }

  /** `vc1_coded_block_pred`. */
  private codedBlockPred(n: number): number {
    const xy = this.origin + this.bi[n]!,
      wrap = this.b8,
      cb = this.codedBlock;
    const a = cb[xy - 1]!,
      b = cb[xy - 1 - wrap]!,
      c = cb[xy - wrap]!;
    return b === c ? a : c;
  }

  /** `vc1_decode_i_blocks` (Main profile). */
  private iBlocks(): void {
    const gb = this.gb,
      t = vlcTables(),
      blocks = this.blocks;
    this.setIntraCodingSets();
    this.yDcScale = this.cDcScale = T.DC_SCALE[this.pq]!;
    this.mbIntra = 1;
    this.firstSliceLine = 1;
    for (this.mbY = this.startMbY; this.mbY < this.endMbY; this.mbY++) {
      for (this.mbX = 0; this.mbX < this.mbw; this.mbX++) {
        this.updateBlockIndex();
        const base = this.blk(this.curBlk, 0);
        blocks.fill(0, base, base + 384);
        let cbp = gb.vlc(t.mbIntra, 9, 2);
        this.acPred = gb.bit();
        for (let k = 0; k < 6; k++) {
          this.mbType[this.origin + this.bi[k]!] = 1;
          let val = (cbp >> (5 - k)) & 1;
          if (k < 4) {
            val ^= this.codedBlockPred(k);
            this.codedBlock[this.origin + this.bi[k]!] = val;
          }
          cbp |= val << (5 - k);
          this.iBlock(base + k * 64, k, val, k < 4 ? this.codingset : this.codingset2);
          D.invTrans8x8(blocks, base + k * 64);
        }
        this.putBlocks(false);
        if (this.loopFilter) this.iLoopFilter();
        if (gb.left() < 0) return;
        this.incBlocks();
      }
      this.firstSliceLine = 0;
    }
  }

  /** `vc1_decode_i_blocks_adv`. */
  private iBlocksAdv(): void {
    const gb = this.gb,
      t = vlcTables(),
      blocks = this.blocks;
    if (gb.left() <= 1) return;
    this.setIntraCodingSets();
    this.mbIntra = 1;
    this.firstSliceLine = 1;
    this.mbX = 0;
    this.mbY = this.startMbY;
    if (this.startMbY) {
      const o = this.origin + (2 * this.mbY - 1) * this.b8 - 2;
      this.codedBlock.fill(0, o, o + 1 + this.b8);
    }
    for (; this.mbY < this.endMbY; this.mbY++) {
      for (this.mbX = 0; this.mbX < this.mbw; this.mbX++) {
        const mquant = this.pq;
        this.updateBlockIndex();
        const base = this.blk(this.curBlk, 0);
        blocks.fill(0, base, base + 384);
        const mbPos = this.mbX + this.mbY * this.mbs;
        if (gb.left() <= 1) return;
        let cbp = gb.vlc(t.mbIntra, 9, 2);
        this.acPred = this.acpredIsRaw ? gb.bit() : this.acpredPlane[mbPos]!;
        this.qscale[this.mbs + mbPos] = mquant;
        this.yDcScale = this.cDcScale = T.DC_SCALE[Math.abs(mquant)]!;
        for (let k = 0; k < 6; k++) {
          this.mbType[this.origin + this.bi[k]!] = 1;
          let val = (cbp >> (5 - k)) & 1;
          if (k < 4) {
            val ^= this.codedBlockPred(k);
            this.codedBlock[this.origin + this.bi[k]!] = val;
          }
          cbp |= val << (5 - k);
          this.aAvail = !this.firstSliceLine || k === 2 || k === 3 ? 1 : 0;
          this.cAvail = this.mbX || k === 1 || k === 3 ? 1 : 0;
          this.iBlockAdv(base + k * 64, k, val, k < 4 ? this.codingset : this.codingset2, mquant);
          D.invTrans8x8(blocks, base + k * 64);
        }
        this.putBlocks(true);
        if (this.loopFilter) this.iLoopFilter();
        if (gb.left() < 0) return;
        this.incBlocks();
      }
      this.firstSliceLine = 0;
    }
  }

  /** `vc1_decode_p_blocks`. */
  private pBlocks(): void {
    const gb = this.gb,
      mbs = this.mbs;
    switch (this.cAc) {
      case 0:
        this.codingset = this.pqindex <= 8 ? HIGH_RATE_INTRA : LOW_MOT_INTRA;
        break;
      case 1:
        this.codingset = HIGH_MOT_INTRA;
        break;
      case 2:
        this.codingset = MID_RATE_INTRA;
        break;
    }
    this.setInterCodingSet();
    this.firstSliceLine = 1;
    this.cbpRow.fill(0);
    for (this.mbY = this.startMbY; this.mbY < this.endMbY; this.mbY++) {
      for (this.mbX = 0; this.mbX < this.mbw; this.mbX++) {
        this.updateBlockIndex();
        if ((this.mvTypeIsRaw || this.skipIsRaw) && gb.left() <= 1) return;
        const ret = this.pMb();
        if (this.loopFilter) this.pLoopFilter();
        if (ret < 0 || gb.left() < 0) return;
        this.incBlocks();
      }
      this.cbpRow.copyWithin(0, mbs, 3 * mbs);
      this.ttblkRow.copyWithin(0, mbs, 3 * mbs);
      this.isIntraRow.copyWithin(0, mbs, 3 * mbs);
      this.lumaMv.copyWithin(0, 2 * mbs, 6 * mbs);
      this.firstSliceLine = 0;
    }
  }

  /** `vc1_decode_skip_blocks`: a skipped P picture repeats the reference. */
  private skipBlocks(): void {
    const last = this.last,
      cur = this.cur!;
    if (!last) return;
    for (let y = this.startMbY; y < this.endMbY; y++) {
      const o = y * 16 * this.ls,
        c = y * 8 * this.uvls;
      cur.y.set(last.y.subarray(o, o + this.ls * 16), o);
      cur.cb.set(last.cb.subarray(c, c + this.uvls * 8), c);
      cur.cr.set(last.cr.subarray(c, c + this.uvls * 8), c);
    }
  }

  /** `vc1_decode_p_mb` (progressive). */
  private pMb(): number {
    const gb = this.gb,
      t = vlcTables(),
      blocks = this.blocks,
      cur = this.cur!,
      o = this.origin,
      bi = this.bi;
    const mbPos = this.mbX + this.mbY * this.mbs;
    let mquant = this.pq,
      ttmb = this.ttfrm,
      firstBlock = 1,
      blockCbp = 0,
      blockIntra = 0;
    this.ttOut = 0;
    this.mbHasCoeffs = 1;
    const fourmv = this.mvTypeIsRaw ? gb.bit() : this.mvTypePlane[mbPos]!;
    const skipped = this.skipIsRaw ? gb.bit() : this.skipPlane[mbPos]!;
    const base = this.blk(this.curBlk, 0);
    end: {
      if (!fourmv) {
        if (!skipped) {
          this.getMvData();
          this.predMv(0, this.dmvX, this.dmvY, true);
          let cbp: number;
          if (this.mbIntra && !this.mbHasCoeffs) {
            this.acPred = gb.bit();
            cbp = 0;
          } else if (this.mbHasCoeffs) {
            if (this.mbIntra) this.acPred = gb.bit();
            cbp = gb.vlc(t.cbpcy[this.cbptab]!, 9, 2);
          } else {
            mquant = this.pq;
            cbp = 0;
          }
          this.qscale[this.mbs + mbPos] = mquant;
          if (!this.ttmbf && !this.mbIntra && this.mbHasCoeffs)
            ttmb = gb.vlc(t.ttmb[this.ttIndex]!, 9, 2);
          if (!this.mbIntra) this.mc1mv();
          for (let i = 0; i < 6; i++) {
            this.dcVal[o + bi[i]!] = 0;
            const val = (cbp >> (5 - i)) & 1;
            const off = i & 4 ? 0 : (i & 1) * 8 + (i & 2) * 4 * this.ls;
            this.mbType[o + bi[i]!] = this.mbIntra;
            if (this.mbIntra) {
              this.setIntraAvail(i);
              const ret = this.intraBlock(
                base + i * 64,
                i,
                val,
                mquant,
                i & 4 ? this.codingset2 : this.codingset,
              );
              if (ret < 0) return ret;
              D.invTrans8x8(blocks, base + i * 64);
              blockCbp |= 0xf << (i << 2);
              blockIntra |= 1 << i;
            } else if (val) {
              const pat = this.pBlock(
                base + i * 64,
                i,
                mquant,
                ttmb,
                firstBlock,
                this.plane(cur, i),
                (i & 4 ? this.dest1 : this.dest0) + off,
                i & 4 ? this.uvls : this.ls,
              );
              if (pat < 0) return pat;
              blockCbp |= pat << (i << 2);
              if (!this.ttmbf && ttmb < 8) ttmb = -1;
              firstBlock = 0;
            }
          }
        } else {
          this.mbIntra = 0;
          for (let i = 0; i < 6; i++) {
            this.mbType[o + bi[i]!] = 0;
            this.dcVal[o + bi[i]!] = 0;
          }
          this.qscale[this.mbs + mbPos] = 0;
          this.predMv(0, 0, 0, true);
          this.mc1mv();
        }
      } else if (!skipped) {
        let intraCount = 0,
          codedInter = 0;
        const isIntra = [0, 0, 0, 0, 0, 0],
          isCoded = [0, 0, 0, 0, 0, 0];
        const cbp = gb.vlc(t.cbpcy[this.cbptab]!, 9, 2);
        for (let i = 0; i < 6; i++) {
          const val = (cbp >> (5 - i)) & 1;
          this.dcVal[o + bi[i]!] = 0;
          this.mbIntra = 0;
          if (i < 4) {
            this.dmvX = this.dmvY = 0;
            this.mbIntra = 0;
            this.mbHasCoeffs = 0;
            if (val) this.getMvData();
            this.predMv(i, this.dmvX, this.dmvY, false);
            if (!this.mbIntra) this.mc4mvLuma(i);
            intraCount += this.mbIntra;
            isIntra[i] = this.mbIntra;
            isCoded[i] = this.mbHasCoeffs;
          }
          if (i & 4) {
            isIntra[i] = intraCount >= 3 ? 1 : 0;
            isCoded[i] = val;
          }
          if (i === 4) this.mc4mvChroma();
          this.mbType[o + bi[i]!] = isIntra[i]!;
          if (!codedInter) codedInter = !isIntra[i] && isCoded[i] ? 1 : 0;
        }
        if (!intraCount && !codedInter) break end;
        this.qscale[this.mbs + mbPos] = mquant;
        let intrapred = 0;
        for (let i = 0; i < 6; i++)
          if (isIntra[i]) {
            const w = this.wrap[i]!;
            if (
              ((!this.firstSliceLine || i === 2 || i === 3) && this.mbType[o + bi[i]! - w]) ||
              ((this.mbX || i === 1 || i === 3) && this.mbType[o + bi[i]! - 1])
            ) {
              intrapred = 1;
              break;
            }
          }
        this.acPred = intrapred ? gb.bit() : 0;
        if (!this.ttmbf && codedInter) ttmb = gb.vlc(t.ttmb[this.ttIndex]!, 9, 2);
        for (let i = 0; i < 6; i++) {
          const off = i & 4 ? 0 : (i & 1) * 8 + (i & 2) * 4 * this.ls;
          this.mbIntra = isIntra[i]!;
          if (isIntra[i]) {
            this.setIntraAvail(i);
            const ret = this.intraBlock(
              base + i * 64,
              i,
              isCoded[i]!,
              mquant,
              i & 4 ? this.codingset2 : this.codingset,
            );
            if (ret < 0) return ret;
            D.invTrans8x8(blocks, base + i * 64);
            blockCbp |= 0xf << (i << 2);
            blockIntra |= 1 << i;
          } else if (isCoded[i]) {
            const pat = this.pBlock(
              base + i * 64,
              i,
              mquant,
              ttmb,
              firstBlock,
              this.plane(cur, i),
              (i & 4 ? this.dest1 : this.dest0) + off,
              i & 4 ? this.uvls : this.ls,
            );
            if (pat < 0) return pat;
            blockCbp |= pat << (i << 2);
            if (!this.ttmbf && ttmb < 8) ttmb = -1;
            firstBlock = 0;
          }
        }
      } else {
        this.mbIntra = 0;
        this.qscale[this.mbs + mbPos] = 0;
        for (let i = 0; i < 6; i++) {
          this.mbType[o + bi[i]!] = 0;
          this.dcVal[o + bi[i]!] = 0;
        }
        for (let i = 0; i < 4; i++) {
          this.predMv(i, 0, 0, false);
          this.mc4mvLuma(i);
        }
        this.mc4mvChroma();
      }
    }
    this.putBlocks(true);
    const m = 2 * this.mbs + this.mbX;
    this.cbpRow[m] = blockCbp;
    this.ttblkRow[m] = this.ttOut;
    this.isIntraRow[m] = blockIntra;
    return 0;
  }

  private setIntraAvail(i: number): void {
    const o = this.origin + this.bi[i]!;
    this.aAvail = this.cAvail = 0;
    if (i === 2 || i === 3 || !this.firstSliceLine) this.aAvail = this.mbType[o - this.wrap[i]!]!;
    if (i === 1 || i === 3 || this.mbX) this.cAvail = this.mbType[o - 1]!;
  }

  /** `GET_MVDATA`. */
  private getMvData(): void {
    const gb = this.gb,
      qs = this.quarterSample;
    let index = 1 + gb.vlc(vlcTables().mvDiff[this.mvTable]!, 9, 2);
    if (index > 36) {
      this.mbHasCoeffs = 1;
      index -= 37;
    } else this.mbHasCoeffs = 0;
    this.mbIntra = 0;
    if (!index) this.dmvX = this.dmvY = 0;
    else if (index === 35) {
      this.dmvX = gb.bits(this.kX - 1 + qs);
      this.dmvY = gb.bits(this.kY - 1 + qs);
    } else if (index === 36) {
      this.dmvX = this.dmvY = 0;
      this.mbIntra = 1;
    } else {
      const component = (i: number): number => {
        let v = MV_OFFSET[i]!;
        let n = MV_SIZE[i]! - (!qs && i === 5 ? 1 : 0);
        if (n > 0) {
          n = gb.bits(n);
          const sign = -(n & 1);
          v = (sign ^ ((n >> 1) + v)) - sign;
        }
        return v;
      };
      this.dmvX = component(index % 6);
      this.dmvY = component((index / 6) | 0);
    }
  }

  // ---------------------------------------------------------------------------------------
  // Block layer

  /** `vc1_decode_ac_coeff`; sets `acLast`, `acRun` and `acValue`. */
  private acCoeff(cs: number): number {
    const gb = this.gb,
      vlc = vlcTables().ac[cs]!,
      size = T.AC_SIZES[cs]!;
    let index = gb.vlc(vlc, 9, 3);
    if (index < 0) return index;
    let run: number, level: number, lst: number, sign: number;
    if (index !== size - 1) {
      run = T.INDEX_DECODE[(cs * 185 + index) * 2]!;
      level = T.INDEX_DECODE[(cs * 185 + index) * 2 + 1]!;
      lst = index >= T.LAST_DECODE[cs]! || gb.left() < 0 ? 1 : 0;
      sign = gb.bit();
    } else {
      const escape = gb.decode210();
      if (escape !== 2) {
        index = gb.vlc(vlc, 9, 3);
        if (index >>> 0 >= size - 1) return INVALID_DATA;
        run = T.INDEX_DECODE[(cs * 185 + index) * 2]!;
        level = T.INDEX_DECODE[(cs * 185 + index) * 2 + 1]!;
        lst = index >= T.LAST_DECODE[cs]! ? 1 : 0;
        if (escape === 0)
          level += lst ? T.LAST_DELTA_LEVEL[cs * 44 + run]! : T.DELTA_LEVEL[cs * 31 + run]!;
        else run += (lst ? T.LAST_DELTA_RUN[cs * 10 + level]! : T.DELTA_RUN[cs * 57 + level]!) + 1;
        sign = gb.bit();
      } else {
        lst = gb.bit();
        if (this.esc3Level === 0) {
          if (this.pq < 8 || this.dquantfrm) {
            this.esc3Level = gb.bits(3);
            if (!this.esc3Level) this.esc3Level = gb.bits(2) + 8;
          } else this.esc3Level = gb.unary(1, 6) + 2;
          this.esc3Run = 3 + gb.bits(2);
        }
        run = gb.bits(this.esc3Run);
        sign = gb.bit();
        level = gb.bits(this.esc3Level);
      }
    }
    this.acLast = lst;
    this.acRun = run;
    this.acValue = (level ^ -sign) + sign;
    return 0;
  }

  /** DC differential of an intra block. */
  private dcDiff(n: number, quant: number): number {
    const gb = this.gb;
    let dcdiff = gb.vlc(vlcTables().dc[this.dcTable * 2 + (n >= 4 ? 1 : 0)]!, 9, 3);
    if (dcdiff) {
      const m = quant === 1 || quant === 2 ? 3 - quant : 0;
      if (dcdiff === 119) dcdiff = gb.bits(8 + m);
      else if (m) dcdiff = (dcdiff << m) + gb.bits(m) - ((1 << m) - 1);
      if (gb.bit()) dcdiff = -dcdiff;
    }
    return dcdiff;
  }

  private dcDir = 0;

  /** `ff_vc1_pred_dc`; sets `dcDir`. */
  private predDc(n: number, aAvail: number, cAvail: number): number {
    const mbs = this.mbs,
      q = this.qscale,
      mbPos = mbs + this.mbX + this.mbY * mbs;
    const q1 = Math.abs(q[mbPos]!);
    const dqi = T.DC_SCALE[q1]! - 1;
    if (dqi < 0) return 0;
    const dq = T.DQSCALE[dqi]!;
    const scaled = (v: number, q2: number) =>
      ((Math.imul(Math.imul(v, T.DC_SCALE[q2]!), dq) + 0x20000) | 0) >> 18;
    const wrap = this.wrap[n]!,
      xy = this.origin + this.bi[n]!,
      dc = this.dcVal;
    let c = dc[xy - 1]!,
      b = dc[xy - 1 - wrap]!,
      a = dc[xy - wrap]!;
    if (cAvail && n !== 1 && n !== 3) {
      const q2 = Math.abs(q[mbPos - 1]!);
      if (q2 && q2 !== q1) c = scaled(c, q2);
    }
    if (aAvail && n !== 2 && n !== 3) {
      const q2 = Math.abs(q[mbPos - mbs]!);
      if (q2 && q2 !== q1) a = scaled(a, q2);
    }
    if (aAvail && cAvail && n !== 3) {
      let off = mbPos;
      if (n !== 1) off--;
      if (n !== 2) off -= mbs;
      const q2 = Math.abs(q[off]!);
      if (q2 && q2 !== q1) b = scaled(b, q2);
    }
    if (cAvail && (!aAvail || Math.abs(a - b) <= Math.abs(b - c))) {
      this.dcDir = 1;
      return c;
    }
    if (aAvail) {
      this.dcDir = 0;
      return a;
    }
    this.dcDir = 1;
    return 0;
  }

  /** `vc1_decode_i_block` (Main profile I pictures). */
  private iBlock(b: number, n: number, coded: number, codingset: number): number {
    const block = this.blocks,
      pq = this.pq;
    let dcdiff = this.dcDiff(n, pq);
    const scale = n < 4 ? this.yDcScale : this.cDcScale;
    const wrap = this.wrap[n]!,
      xy = this.origin + this.bi[n]!,
      dc = this.dcVal;
    let c = dc[xy - 1]!,
      bb = dc[xy - 1 - wrap]!,
      a = dc[xy - wrap]!;
    if (this.firstSliceLine && n !== 2 && n !== 3) bb = a = DC_PRED[scale]!;
    if (this.mbX === 0 && n !== 1 && n !== 3) bb = c = DC_PRED[scale]!;
    let dir: number;
    if (Math.abs(a - bb) <= Math.abs(bb - c)) {
      dcdiff += c;
      dir = 1;
    } else {
      dcdiff += a;
      dir = 0;
    }
    dc[xy] = dcdiff;
    block[b] = dcdiff * scale;

    const ac = this.acVal;
    const ac2 = xy * 16;
    let acv = dir ? ac2 - 16 : ac2 - 16 * wrap;
    const qscale = pq * 2 + this.halfpq;
    const leftSh = this.leftSh,
      topSh = this.topSh;
    if (coded) {
      const zz = this.acPred ? (dir ? this.zz8x8[3]! : this.zz8x8[2]!) : this.zz8x8[1]!;
      let i = 1,
        last = 0;
      while (!last) {
        const ret = this.acCoeff(codingset);
        if (ret < 0) return ret;
        last = this.acLast;
        i += this.acRun;
        if (i > 63) break;
        block[b + zz[i++]!] = this.acValue;
      }
      if (this.acPred) {
        let sh: number;
        if (dir) sh = leftSh;
        else {
          sh = topSh;
          acv += 8;
        }
        for (let k = 1; k < 8; k++) block[b + (k << sh)]! += ac[acv + k]!;
      }
      for (let k = 1; k < 8; k++) {
        ac[ac2 + k] = block[b + (k << leftSh)]!;
        ac[ac2 + k + 8] = block[b + (k << topSh)]!;
      }
      for (let k = 1; k < 64; k++)
        if (block[b + k]) {
          block[b + k]! *= qscale;
          if (!this.pquantizer) block[b + k]! += block[b + k]! < 0 ? -pq : pq;
        }
    } else {
      ac.fill(0, ac2, ac2 + 16);
      if (this.acPred) {
        let sh: number,
          dst = ac2;
        if (dir) sh = leftSh;
        else {
          sh = topSh;
          acv += 8;
          dst += 8;
        }
        ac.copyWithin(dst, acv, acv + 8);
        for (let k = 1; k < 8; k++) {
          const p = b + (k << sh);
          block[p] = ac[acv + k]! * qscale;
          if (!this.pquantizer && block[p]) block[p]! += block[p]! < 0 ? -pq : pq;
        }
      }
    }
    return 0;
  }

  /** `vc1_decode_i_block_adv`. */
  private iBlockAdv(
    b: number,
    n: number,
    coded: number,
    codingset: number,
    mquant: number,
  ): number {
    const block = this.blocks,
      aAvail = this.aAvail,
      cAvail = this.cAvail,
      quant = Math.abs(mquant),
      mbs = this.mbs,
      rawPos = this.mbX + this.mbY * mbs,
      mbPos = mbs + rawPos;
    let usePred = this.acPred;
    let dcdiff = this.dcDiff(n, quant);
    dcdiff += this.predDc(n, aAvail, cAvail);
    const dir = this.dcDir;
    const xy = this.origin + this.bi[n]!;
    this.dcVal[xy] = dcdiff;
    block[b] = dcdiff * (n < 4 ? this.yDcScale : this.cDcScale);
    if (!aAvail && !cAvail) usePred = 0;
    const scale = quant * 2 + (mquant < 0 ? 0 : this.halfpq);
    const ac = this.acVal,
      ac2 = xy * 16;
    let acv = dir ? ac2 - 16 : ac2 - 16 * this.wrap[n]!;
    let q1 = this.qscale[mbPos]!,
      q2 = 0;
    if (n === 3) q2 = q1;
    else if (dir) {
      if (n === 1) q2 = q1;
      else if (cAvail && rawPos) q2 = this.qscale[mbPos - 1]!;
    } else if (n === 2) q2 = q1;
    else if (aAvail && rawPos >= mbs) q2 = this.qscale[mbPos - mbs]!;
    const leftSh = this.leftSh,
      topSh = this.topSh,
      halfpq = this.halfpq;
    const dq = (x: number) => Math.abs(x) * 2 + (x < 0 ? 0 : halfpq) - 1;
    if (coded) {
      const zz = this.acPred ? (dir ? this.zz8x8[3]! : this.zz8x8[2]!) : this.zz8x8[1]!;
      let i = 1,
        last = 0;
      while (!last) {
        const ret = this.acCoeff(codingset);
        if (ret < 0) return ret;
        last = this.acLast;
        i += this.acRun;
        if (i > 63) break;
        block[b + zz[i++]!] = this.acValue;
      }
      if (usePred) {
        let sh: number;
        if (dir) sh = leftSh;
        else {
          sh = topSh;
          acv += 8;
        }
        q1 = dq(q1);
        if (q1 < 1) return INVALID_DATA;
        if (q2) q2 = dq(q2);
        if (q2 && q1 !== q2) {
          const s = T.DQSCALE[q1 - 1]!;
          for (let k = 1; k < 8; k++)
            block[b + (k << sh)]! +=
              ((Math.imul(Math.imul(ac[acv + k]!, q2), s) + 0x20000) | 0) >> 18;
        } else for (let k = 1; k < 8; k++) block[b + (k << sh)]! += ac[acv + k]!;
      }
      for (let k = 1; k < 8; k++) {
        ac[ac2 + k] = block[b + (k << leftSh)]!;
        ac[ac2 + k + 8] = block[b + (k << topSh)]!;
      }
      for (let k = 1; k < 64; k++)
        if (block[b + k]) {
          block[b + k]! *= scale;
          if (!this.pquantizer) block[b + k]! += block[b + k]! < 0 ? -quant : quant;
        }
    } else {
      ac.fill(0, ac2, ac2 + 16);
      if (usePred) {
        let sh: number,
          dst = ac2;
        if (dir) sh = leftSh;
        else {
          sh = topSh;
          acv += 8;
          dst += 8;
        }
        ac.copyWithin(dst, acv, acv + 8);
        q1 = dq(q1);
        if (q1 < 1) return INVALID_DATA;
        if (q2) q2 = dq(q2);
        if (q2 && q1 !== q2) {
          const s = T.DQSCALE[q1 - 1]!;
          for (let k = 1; k < 8; k++)
            ac[dst + k] = ((Math.imul(Math.imul(ac[dst + k]!, q2), s) + 0x20000) | 0) >> 18;
        }
        for (let k = 1; k < 8; k++) {
          const p = b + (k << sh);
          block[p] = ac[dst + k]! * scale;
          if (!this.pquantizer && block[p]) block[p]! += block[p]! < 0 ? -quant : quant;
        }
      }
    }
    return 0;
  }

  /** `vc1_decode_intra_block` (intra blocks of P pictures). */
  private intraBlock(
    b: number,
    n: number,
    coded: number,
    mquant: number,
    codingset: number,
  ): number {
    const block = this.blocks,
      aAvail = this.aAvail,
      cAvail = this.cAvail,
      mbs = this.mbs,
      rawPos = this.mbX + this.mbY * mbs,
      mbPos = mbs + rawPos;
    let usePred = this.acPred;
    block.fill(0, b, b + 64);
    let quant = Math.abs(mquant);
    quant = quant > 31 ? 31 : quant;
    this.yDcScale = this.cDcScale = T.DC_SCALE[quant]!;
    let dcdiff = this.dcDiff(n, quant);
    dcdiff += this.predDc(n, aAvail, cAvail);
    let dir = this.dcDir;
    const xy = this.origin + this.bi[n]!;
    this.dcVal[xy] = dcdiff;
    block[b] = dcdiff * (n < 4 ? this.yDcScale : this.cDcScale);
    if (!aAvail) dir = 1;
    if (!cAvail) dir = 0;
    if (!aAvail && !cAvail) usePred = 0;
    const ac = this.acVal,
      ac2 = xy * 16;
    const scale = quant * 2 + (mquant < 0 ? 0 : this.halfpq);
    const acv = dir ? ac2 - 16 : ac2 - 16 * this.wrap[n]!;
    let q1 = this.qscale[mbPos]!,
      q2 = 0;
    if (dir && cAvail && rawPos) q2 = this.qscale[mbPos - 1]!;
    if (!dir && aAvail && rawPos >= mbs) q2 = this.qscale[mbPos - mbs]!;
    if (dir && n === 1) q2 = q1;
    if (!dir && n === 2) q2 = q1;
    if (n === 3) q2 = q1;
    const leftSh = this.leftSh,
      topSh = this.topSh,
      halfpq = this.halfpq;
    const dq = (x: number) => Math.abs(x) * 2 + (x < 0 ? 0 : halfpq) - 1;
    const scaled = (v: number) =>
      ((Math.imul(Math.imul(v, q2), T.DQSCALE[q1 - 1]!) + 0x20000) | 0) >> 18;
    if (coded) {
      const zz = this.zz8x8[0]!;
      let i = 1,
        last = 0;
      while (!last) {
        const ret = this.acCoeff(codingset);
        if (ret < 0) return ret;
        last = this.acLast;
        i += this.acRun;
        if (i > 63) break;
        block[b + zz[i++]!] = this.acValue;
      }
      if (usePred) {
        q1 = dq(q1);
        if (q1 < 1) return INVALID_DATA;
        if (q2) q2 = dq(q2);
        if (q2 && q1 !== q2) {
          if (dir) for (let k = 1; k < 8; k++) block[b + (k << leftSh)]! += scaled(ac[acv + k]!);
          else for (let k = 1; k < 8; k++) block[b + (k << topSh)]! += scaled(ac[acv + k + 8]!);
        } else if (dir) for (let k = 1; k < 8; k++) block[b + (k << leftSh)]! += ac[acv + k]!;
        else for (let k = 1; k < 8; k++) block[b + (k << topSh)]! += ac[acv + k + 8]!;
      }
      for (let k = 1; k < 8; k++) {
        ac[ac2 + k] = block[b + (k << leftSh)]!;
        ac[ac2 + k + 8] = block[b + (k << topSh)]!;
      }
      for (let k = 1; k < 64; k++)
        if (block[b + k]) {
          block[b + k]! *= scale;
          if (!this.pquantizer) block[b + k]! += block[b + k]! < 0 ? -quant : quant;
        }
    } else {
      ac.fill(0, ac2, ac2 + 16);
      if (usePred) {
        const h = dir ? 0 : 8;
        ac.copyWithin(ac2 + h, acv + h, acv + h + 8);
        q1 = dq(q1);
        if (q1 < 1) return INVALID_DATA;
        if (q2) q2 = dq(q2);
        if (q2 && q1 !== q2) for (let k = 1; k < 8; k++) ac[ac2 + h + k] = scaled(ac[ac2 + h + k]!);
        const sh = dir ? leftSh : topSh;
        for (let k = 1; k < 8; k++) {
          const p = b + (k << sh);
          block[p] = ac[ac2 + h + k]! * scale;
          if (!this.pquantizer && block[p]) block[p]! += block[p]! < 0 ? -quant : quant;
        }
      }
    }
    return 0;
  }

  /** `vc1_decode_p_block`: decodes and adds an inter block, returns its coded subblock
   * pattern and ORs the transform type into `ttOut`. */
  private pBlock(
    b: number,
    n: number,
    mquant: number,
    ttmb: number,
    firstBlock: number,
    dst: Uint8Array,
    d: number,
    ls: number,
  ): number {
    const gb = this.gb,
      t = vlcTables(),
      block = this.blocks,
      quant = Math.abs(mquant),
      cs = this.codingset2;
    block.fill(0, b, b + 64);
    let ttblk = ttmb & 7,
      subblkpat = 0,
      pat = 0;
    if (ttmb === -1) ttblk = TTBLK_TO_TT[this.ttIndex * 8 + gb.vlc(t.ttblk[this.ttIndex]!, 5, 1)]!;
    if (ttblk === TT_4X4) subblkpat = ~(gb.vlc(t.subblkpat[this.ttIndex]!, 6, 1) + 1);
    if (
      ttblk !== TT_8X8 &&
      ttblk !== TT_4X4 &&
      (this.ttmbf || (ttmb !== -1 && ttmb & 8 && !firstBlock) || (!this.resRtm && !firstBlock))
    ) {
      subblkpat = gb.decode012();
      if (subblkpat) subblkpat ^= 3;
      if (ttblk === TT_8X4_TOP || ttblk === TT_8X4_BOTTOM) ttblk = TT_8X4;
      if (ttblk === TT_4X8_RIGHT || ttblk === TT_4X8_LEFT) ttblk = TT_4X8;
    }
    const scale = quant * 2 + (mquant < 0 ? 0 : this.halfpq);
    if (ttblk === TT_8X4_TOP || ttblk === TT_8X4_BOTTOM) {
      subblkpat = 2 - (ttblk === TT_8X4_TOP ? 1 : 0);
      ttblk = TT_8X4;
    }
    if (ttblk === TT_4X8_RIGHT || ttblk === TT_4X8_LEFT) {
      subblkpat = 2 - (ttblk === TT_4X8_LEFT ? 1 : 0);
      ttblk = TT_4X8;
    }
    const pquantizer = this.pquantizer;
    // Decodes coefficients of one (sub)block with `scan` until the last one or `limit`.
    const coefficients = (scan: Uint8Array, off: number, limit: number, last: number): number => {
      let i = 0;
      while (!last) {
        const ret = this.acCoeff(cs);
        if (ret < 0) return ret;
        last = this.acLast;
        i += this.acRun;
        if (i > limit) break;
        const idx = b + scan[i++]! + off;
        block[idx] = this.acValue * scale;
        if (!pquantizer) block[idx]! += block[idx]! < 0 ? -quant : quant;
      }
      return i;
    };
    switch (ttblk) {
      case TT_8X8: {
        pat = 0xf;
        const i = coefficients(this.zz8x8[0]!, 0, 63, 0);
        if (i < 0) return i;
        if (i === 1) D.invTrans8x8Dc(dst, d, ls, block[b]!);
        else {
          D.invTrans8x8(block, b);
          D.addPixelsClamped(block, b, dst, d, ls);
        }
        break;
      }
      case TT_4X4:
        pat = ~subblkpat & 0xf;
        for (let j = 0; j < 4; j++) {
          const off = (j & 1) * 4 + (j & 2) * 16;
          const i = coefficients(T.ZZ_4X4, off, 15, subblkpat & (1 << (3 - j)));
          if (i < 0) return i;
          if (!(subblkpat & (1 << (3 - j)))) {
            const o = d + (j & 1) * 4 + (j & 2) * 2 * ls;
            if (i === 1) D.invTrans4x4Dc(dst, o, ls, block[b + off]!);
            else D.invTrans4x4(dst, o, ls, block, b + off);
          }
        }
        break;
      case TT_8X4:
        pat = ~((subblkpat & 2) * 6 + (subblkpat & 1) * 3) & 0xf;
        for (let j = 0; j < 2; j++) {
          const off = j * 32;
          const i = coefficients(this.zz8x4, off, 31, subblkpat & (1 << (1 - j)));
          if (i < 0) return i;
          if (!(subblkpat & (1 << (1 - j)))) {
            const o = d + j * 4 * ls;
            if (i === 1) D.invTrans8x4Dc(dst, o, ls, block[b + off]!);
            else D.invTrans8x4(dst, o, ls, block, b + off);
          }
        }
        break;
      case TT_4X8:
        pat = ~(subblkpat * 5) & 0xf;
        for (let j = 0; j < 2; j++) {
          const off = j * 4;
          const i = coefficients(this.zz4x8, off, 31, subblkpat & (1 << (1 - j)));
          if (i < 0) return i;
          if (!(subblkpat & (1 << (1 - j)))) {
            const o = d + j * 4;
            if (i === 1) D.invTrans4x8Dc(dst, o, ls, block[b + off]!);
            else D.invTrans4x8(dst, o, ls, block, b + off);
          }
        }
        break;
    }
    this.ttOut |= ttblk << (n * 4);
    return pat;
  }

  /** `vc1_put_blocks_clamped`: writes intra blocks one row and one column behind decoding. */
  private putBlocks(signed: boolean): void {
    const put = signed ? D.putSignedPixelsClamped : D.putPixelsClamped;
    const cur = this.cur!,
      bi = this.bi,
      o = this.origin,
      mt = this.mbType,
      ls = this.ls,
      uvls = this.uvls,
      b8 = this.b8,
      mbs = this.mbs,
      blocks = this.blocks;
    const lastCol = this.mbX === this.mbw - 1;
    if (!this.firstSliceLine) {
      if (this.mbX)
        for (let i = 0; i < 6; i++)
          if (mt[o + (i > 3 ? bi[i]! - mbs - 1 : bi[i]! - 2 * b8 - 2)])
            put(
              blocks,
              this.blk(this.topleftBlk, i),
              this.plane(cur, i),
              i > 3
                ? this.dest1 - 8 * uvls - 8
                : this.dest0 + ((i & 2) - 4) * 4 * ls + ((i & 1) - 2) * 8,
              i > 3 ? uvls : ls,
            );
      if (lastCol)
        for (let i = 0; i < 6; i++)
          if (mt[o + (i > 3 ? bi[i]! - mbs : bi[i]! - 2 * b8)])
            put(
              blocks,
              this.blk(this.topBlk, i),
              this.plane(cur, i),
              i > 3 ? this.dest1 - 8 * uvls : this.dest0 + ((i & 2) - 4) * 4 * ls + (i & 1) * 8,
              i > 3 ? uvls : ls,
            );
    }
    if (this.mbY === this.endMbY - 1) {
      if (this.mbX)
        for (let i = 0; i < 6; i++)
          if (mt[o + (i > 3 ? bi[i]! - 1 : bi[i]! - 2)])
            put(
              blocks,
              this.blk(this.leftBlk, i),
              this.plane(cur, i),
              i > 3 ? this.dest1 - 8 : this.dest0 + (i & 2) * 4 * ls + ((i & 1) - 2) * 8,
              i > 3 ? uvls : ls,
            );
      if (lastCol)
        for (let i = 0; i < 6; i++)
          if (mt[o + bi[i]!])
            put(
              blocks,
              this.blk(this.curBlk, i),
              this.plane(cur, i),
              i > 3 ? this.dest1 : this.dest0 + (i & 2) * 4 * ls + (i & 1) * 8,
              i > 3 ? uvls : ls,
            );
    }
  }

  // ---------------------------------------------------------------------------------------
  // Motion vectors and compensation

  /** `ff_vc1_pred_mv` for progressive P pictures. */
  private predMv(n: number, dmvX: number, dmvY: number, mv1: boolean): void {
    const motion = this.motion,
      wrap = this.b8,
      xy = 4 + this.bi[n]!,
      mt = this.origin + this.bi[n]!;
    if (!this.quarterSample) {
      dmvX *= 2;
      dmvY *= 2;
    }
    if (this.mbIntra) {
      this.mv[n * 2] = this.mv[n * 2 + 1] = 0;
      motion[xy * 2] = motion[xy * 2 + 1] = 0;
      if (mv1) {
        motion.fill(0, (xy + 1) * 2, (xy + 2) * 2);
        motion.fill(0, (xy + wrap) * 2, (xy + wrap + 2) * 2);
        const m = (2 * this.mbs + this.mbX) * 2;
        this.lumaMv[m] = this.lumaMv[m + 1] = 0;
      }
      return;
    }
    const aValid = !this.firstSliceLine || n === 2 || n === 3;
    let bValid = aValid;
    const cValid = this.mbX !== 0 || n === 1 || n === 3;
    const mbw = this.mbw;
    let off: number;
    if (mv1) {
      off = this.mbX === mbw - 1 ? -1 : 2;
      bValid = bValid && mbw > 1;
    } else
      switch (n) {
        case 0:
          off = this.resRtm ? (this.mbX ? -1 : 1) : this.mbX ? -1 : 2 * mbw - wrap - 1;
          break;
        case 1:
          off = this.mbX === mbw - 1 ? -1 : 1;
          break;
        case 2:
          off = 1;
          break;
        default:
          off = -1;
      }
    let ax = 0,
      ay = 0,
      bx = 0,
      by = 0,
      cx = 0,
      cy = 0,
      count = 0;
    if (aValid) {
      ax = motion[(xy - wrap) * 2]!;
      ay = motion[(xy - wrap) * 2 + 1]!;
      count++;
    }
    if (bValid) {
      bx = motion[(xy - wrap + off) * 2]!;
      by = motion[(xy - wrap + off) * 2 + 1]!;
      count++;
    }
    if (cValid) {
      cx = motion[(xy - 1) * 2]!;
      cy = motion[(xy - 1) * 2 + 1]!;
      count++;
    }
    let px: number, py: number;
    if (aValid) {
      px = ax;
      py = ay;
    } else if (cValid) {
      px = cx;
      py = cy;
    } else if (bValid) {
      px = bx;
      py = by;
    } else px = py = 0;
    if (count > 1) {
      px = midPred(ax, bx, cx);
      py = midPred(ay, by, cy);
    }
    const lim = mv1 ? -60 : -28;
    const qx = (this.mbX << 6) + (n === 1 || n === 3 ? 32 : 0);
    const qy = (this.mbY << 6) + (n === 2 || n === 3 ? 32 : 0);
    const X = (mbw << 6) - 4,
      Y = (this.mbh << 6) - 4;
    if (qx + px < lim) px = lim - qx;
    if (qy + py < lim) py = lim - qy;
    if (qx + px > X) px = X - qx;
    if (qy + py > Y) py = Y - qy;
    if (aValid && cValid) {
      const gb = this.gb,
        isIntra = this.mbType;
      let sum = isIntra[mt - wrap]
        ? Math.abs(px) + Math.abs(py)
        : Math.abs(px - ax) + Math.abs(py - ay);
      if (sum > 32) {
        if (gb.bit()) {
          px = ax;
          py = ay;
        } else {
          px = cx;
          py = cy;
        }
      } else {
        sum = isIntra[mt - 1] ? Math.abs(px) + Math.abs(py) : Math.abs(px - cx) + Math.abs(py - cy);
        if (sum > 32) {
          if (gb.bit()) {
            px = ax;
            py = ay;
          } else {
            px = cx;
            py = cy;
          }
        }
      }
    }
    const rx = this.rangeX,
      ry = this.rangeY;
    const mx = ((px + dmvX + rx) & ((rx << 1) - 1)) - rx;
    const my = ((py + dmvY + ry) & ((ry << 1) - 1)) - ry;
    this.mv[n * 2] = mx;
    this.mv[n * 2 + 1] = my;
    motion[xy * 2] = mx;
    motion[xy * 2 + 1] = my;
    if (mv1) {
      for (const k of [xy + 1, xy + wrap, xy + wrap + 1]) {
        motion[k * 2] = mx;
        motion[k * 2 + 1] = my;
      }
    }
  }

  /** `ff_emulated_edge_mc`: a block from `src` with coordinates clamped to `w`x`h`. */
  private emulatedEdge(
    dst: Uint8Array,
    d: number,
    src: Uint8Array,
    stride: number,
    bw: number,
    bh: number,
    x0: number,
    y0: number,
    w: number,
    h: number,
  ): void {
    for (let j = 0; j < bh; j++, d += stride) {
      const sy = clip(y0 + j, 0, h - 1) * stride;
      for (let i = 0; i < bw; i++) dst[d + i] = src[sy + clip(x0 + i, 0, w - 1)]!;
    }
  }

  private applyLut(buf: Uint8Array, o: number, stride: number, k: number, lut: Uint8Array): void {
    for (let j = 0; j < k; j++, o += stride)
      for (let i = 0; i < k; i++) buf[o + i] = lut[buf[o + i]!]!;
  }

  private chromaRound(uv: number): number {
    return this.fastuvmc ? uv + (uv < 0 ? uv & 1 : -(uv & 1)) : uv;
  }

  /** `ff_vc1_mc_1mv` for P pictures. */
  private mc1mv(): void {
    const last = this.last;
    if (!last) return;
    const cur = this.cur!,
      ls = this.ls,
      uvls = this.uvls,
      ms = this.mspel,
      hEdge = this.hEdge,
      vEdge = this.vEdge;
    const mx = this.mv[0]!,
      my = this.mv[1]!;
    let uvmx = (mx + ((mx & 3) === 3 ? 1 : 0)) >> 1,
      uvmy = (my + ((my & 3) === 3 ? 1 : 0)) >> 1;
    const m = (2 * this.mbs + this.mbX) * 2;
    this.lumaMv[m] = uvmx;
    this.lumaMv[m + 1] = uvmy;
    uvmx = this.chromaRound(uvmx);
    uvmy = this.chromaRound(uvmy);
    let srcX = this.mbX * 16 + (mx >> 2),
      srcY = this.mbY * 16 + (my >> 2),
      uvX = this.mbX * 8 + (uvmx >> 2),
      uvY = this.mbY * 8 + (uvmy >> 2);
    if (!this.advanced) {
      srcX = clip(srcX, -16, this.mbw * 16);
      srcY = clip(srcY, -16, this.mbh * 16);
      uvX = clip(uvX, -8, this.mbw * 8);
      uvY = clip(uvY, -8, this.mbh * 8);
    } else {
      srcX = clip(srcX, -17, this.codedWidth);
      uvX = clip(uvX, -8, this.codedWidth >> 1);
      srcY = clip(srcY, -18, this.codedHeight + 1);
      uvY = clip(uvY, -8, this.codedHeight >> 1);
    }
    let ySrc = last.y,
      ys = srcY * ls + srcX,
      uSrc = last.cb,
      vSrc = last.cr,
      us = uvY * uvls + uvX,
      vs = us;
    if (
      this.useIc ||
      hEdge < 22 ||
      vEdge < 22 ||
      (srcX - ms) >>> 0 > (hEdge - (mx & 3) - 16 - ms * 3) >>> 0 ||
      (srcY - 1) >>> 0 > (vEdge - (my & 3) - 16 - 3) >>> 0
    ) {
      const emu = this.emu,
        ubuf = 19 * ls,
        vbuf = ubuf + 9 * uvls,
        k = 17 + ms * 2;
      this.emulatedEdge(emu, 0, last.y, ls, k, k, srcX - ms, srcY - ms, hEdge, vEdge);
      this.emulatedEdge(emu, ubuf, last.cb, uvls, 9, 9, uvX, uvY, hEdge >> 1, vEdge >> 1);
      this.emulatedEdge(emu, vbuf, last.cr, uvls, 9, 9, uvX, uvY, hEdge >> 1, vEdge >> 1);
      if (this.useIc) {
        this.applyLut(emu, 0, ls, k, this.lutY);
        this.applyLut(emu, ubuf, uvls, 9, this.lutUv);
        this.applyLut(emu, vbuf, uvls, 9, this.lutUv);
      }
      ySrc = uSrc = vSrc = emu;
      ys = ms * (1 + ls);
      us = ubuf;
      vs = vbuf;
    }
    const noRnd = this.rnd !== 0;
    if (ms) D.mspelMc(cur.y, this.dest0, ySrc, ys, ls, 16, mx & 3, my & 3, this.rnd, false);
    else D.hpelMc(cur.y, this.dest0, ySrc, ys, ls, 16, (my & 2) | ((mx & 2) >> 1), noRnd, false);
    uvmx = (uvmx & 3) << 1;
    uvmy = (uvmy & 3) << 1;
    D.chromaMc(cur.cb, this.dest1, uSrc, us, uvls, 8, 8, uvmx, uvmy, noRnd, false);
    D.chromaMc(cur.cr, this.dest1, vSrc, vs, uvls, 8, 8, uvmx, uvmy, noRnd, false);
  }

  /** `ff_vc1_mc_4mv_luma` for P pictures. */
  private mc4mvLuma(n: number): void {
    const last = this.last;
    if (!last) return;
    const ls = this.ls,
      ms = this.mspel,
      hEdge = this.hEdge,
      vEdge = this.vEdge;
    const mx = this.mv[n * 2]!,
      my = this.mv[n * 2 + 1]!;
    const off = ls * 4 * (n & 2) + (n & 1) * 8;
    let srcX = this.mbX * 16 + (n & 1) * 8 + (mx >> 2),
      srcY = this.mbY * 16 + (n & 2) * 4 + (my >> 2);
    if (!this.advanced) {
      srcX = clip(srcX, -16, this.mbw * 16);
      srcY = clip(srcY, -16, this.mbh * 16);
    } else {
      srcX = clip(srcX, -17, this.codedWidth);
      srcY = clip(srcY, -18, this.codedHeight + 1);
    }
    let src = last.y,
      s = srcY * ls + srcX;
    if (
      this.useIc ||
      hEdge < 13 ||
      vEdge < 23 ||
      (srcX - ms) >>> 0 > (hEdge - (mx & 3) - 8 - ms * 2) >>> 0 ||
      (srcY - ms) >>> 0 > (vEdge - (my & 3) - (8 + ms * 2)) >>> 0
    ) {
      const k = 9 + ms * 2,
        emu = this.emu;
      this.emulatedEdge(emu, 0, last.y, ls, k, k, srcX - ms, srcY - ms, hEdge, vEdge);
      if (this.useIc) this.applyLut(emu, 0, ls, k, this.lutY);
      src = emu;
      s = ms * (1 + ls);
    }
    const cur = this.cur!;
    if (ms) D.mspelMc(cur.y, this.dest0 + off, src, s, ls, 8, mx & 3, my & 3, this.rnd, false);
    else
      D.hpelMc(
        cur.y,
        this.dest0 + off,
        src,
        s,
        ls,
        8,
        (my & 2) | ((mx & 2) >> 1),
        this.rnd !== 0,
        false,
      );
  }

  /** `ff_vc1_mc_4mv_chroma` for P pictures. */
  private mc4mvChroma(): void {
    const last = this.last;
    if (!last) return;
    const mt = this.mbType,
      o = this.origin,
      bi = this.bi,
      mv = this.mv;
    const idx =
      (mt[o + bi[0]!] ? 0 : 1) |
      (mt[o + bi[1]!] ? 0 : 2) |
      (mt[o + bi[2]!] ? 0 : 4) |
      (mt[o + bi[3]!] ? 0 : 8);
    let tx: number, ty: number;
    switch (POPCOUNT4[idx]) {
      case 4:
        tx = median4(mv[0]!, mv[2]!, mv[4]!, mv[6]!);
        ty = median4(mv[1]!, mv[3]!, mv[5]!, mv[7]!);
        break;
      case 3: {
        const i0 = idx > 0xd ? 1 : 0,
          i1 = 1 + (idx > 0xb ? 1 : 0),
          i2 = 2 + (idx > 0x7 ? 1 : 0);
        tx = midPred(mv[i0 * 2]!, mv[i1 * 2]!, mv[i2 * 2]!);
        ty = midPred(mv[i0 * 2 + 1]!, mv[i1 * 2 + 1]!, mv[i2 * 2 + 1]!);
        break;
      }
      case 2: {
        const a = CHROMA_INDEX2[idx]! >> 4,
          b = CHROMA_INDEX2[idx]! & 0xf;
        tx = ((mv[a * 2]! + mv[b * 2]!) / 2) | 0;
        ty = ((mv[a * 2 + 1]! + mv[b * 2 + 1]!) / 2) | 0;
        break;
      }
      default: {
        const m = (2 * this.mbs + this.mbX) * 2;
        this.lumaMv[m] = this.lumaMv[m + 1] = 0;
        return;
      }
    }
    // int16 like FFmpeg's tx/ty.
    tx = (tx << 16) >> 16;
    ty = (ty << 16) >> 16;
    let uvmx = (tx + ((tx & 3) === 3 ? 1 : 0)) >> 1,
      uvmy = (ty + ((ty & 3) === 3 ? 1 : 0)) >> 1;
    const m = (2 * this.mbs + this.mbX) * 2;
    this.lumaMv[m] = uvmx;
    this.lumaMv[m + 1] = uvmy;
    uvmx = this.chromaRound(uvmx);
    uvmy = this.chromaRound(uvmy);
    let uvX = this.mbX * 8 + (uvmx >> 2),
      uvY = this.mbY * 8 + (uvmy >> 2);
    if (!this.advanced) {
      uvX = clip(uvX, -8, this.mbw * 8);
      uvY = clip(uvY, -8, this.mbh * 8);
    } else {
      uvX = clip(uvX, -8, this.codedWidth >> 1);
      uvY = clip(uvY, -8, this.codedHeight >> 1);
    }
    const uvls = this.uvls,
      hEdge = this.hEdge,
      vEdge = this.vEdge;
    let uSrc = last.cb,
      vSrc = last.cr,
      us = uvY * uvls + uvX,
      vs = us;
    if (
      this.useIc ||
      hEdge < 18 ||
      vEdge < 18 ||
      uvX >>> 0 > ((hEdge >> 1) - 9) >>> 0 ||
      uvY >>> 0 > ((vEdge >> 1) - 9) >>> 0
    ) {
      const emu = this.emu;
      this.emulatedEdge(emu, 0, last.cb, uvls, 9, 9, uvX, uvY, hEdge >> 1, vEdge >> 1);
      this.emulatedEdge(emu, 16, last.cr, uvls, 9, 9, uvX, uvY, hEdge >> 1, vEdge >> 1);
      if (this.useIc) {
        this.applyLut(emu, 0, uvls, 9, this.lutUv);
        this.applyLut(emu, 16, uvls, 9, this.lutUv);
      }
      uSrc = vSrc = emu;
      us = 0;
      vs = 16;
    }
    const cur = this.cur!,
      noRnd = this.rnd !== 0;
    uvmx = (uvmx & 3) << 1;
    uvmy = (uvmy & 3) << 1;
    D.chromaMc(cur.cb, this.dest1, uSrc, us, uvls, 8, 8, uvmx, uvmy, noRnd, false);
    D.chromaMc(cur.cr, this.dest1, vSrc, vs, uvls, 8, 8, uvmx, uvmy, noRnd, false);
  }

  // ---------------------------------------------------------------------------------------
  // In-loop filters

  /** `ff_vc1_i_loop_filter`: runs one row and one column behind decoding. */
  private iLoopFilter(): void {
    const ls = this.ls,
      uvls = this.uvls,
      d0 = this.dest0,
      d1 = this.dest1,
      x = this.mbX,
      y = this.mbY;
    const lastCol = x === this.mbw - 1;
    const v = (dl: number, dc: number, flags: number) => {
      for (let i = 0; i < 6; i++) this.iV(i > 3 ? dc : dl, flags, i);
    };
    const h = (dl: number, dc: number, flags: number) => {
      for (let i = 0; i < 6; i++) this.iH(i > 3 ? dc : dl, flags, i);
    };
    if (!this.firstSliceLine) {
      const flags = y === this.startMbY + 1 ? TOP_EDGE : 0;
      if (x) v(d0 - 16 * ls - 16, d1 - 8 * uvls - 8, flags);
      if (lastCol) v(d0 - 16 * ls, d1 - 8 * uvls, flags);
    }
    if (y === this.endMbY - 1) {
      const flags = this.firstSliceLine ? TOP_EDGE | BOTTOM_EDGE : BOTTOM_EDGE;
      if (x) v(d0 - 16, d1 - 8, flags);
      if (lastCol) v(d0, d1, flags);
    }
    const rightFlags = x === 0 ? LEFT_EDGE | RIGHT_EDGE : RIGHT_EDGE;
    if (y >= this.startMbY + 2) {
      if (x) h(d0 - 32 * ls - 16, d1 - 16 * uvls - 8, x === 1 ? LEFT_EDGE : 0);
      if (lastCol) h(d0 - 32 * ls, d1 - 16 * uvls, rightFlags);
    }
    if (y === this.endMbY - 1) {
      if (y >= this.startMbY + 1) {
        if (x) h(d0 - 16 * ls - 16, d1 - 8 * uvls - 8, x === 1 ? LEFT_EDGE : 0);
        if (lastCol) h(d0 - 16 * ls, d1 - 8 * uvls, rightFlags);
      }
      if (x) h(d0 - 16, d1 - 8, x === 1 ? LEFT_EDGE : 0);
      if (lastCol) h(d0, d1, rightFlags);
    }
  }

  private iH(dest: number, flags: number, n: number): void {
    if (n & 2) return;
    if (!(flags & LEFT_EDGE) || (n & 5) === 1) {
      const cur = this.cur!;
      if (n > 3) D.hLoopFilter(this.plane(cur, n), dest, this.uvls, 8, this.pq);
      else D.hLoopFilter(cur.y, dest + (n & 2) * 4 * this.ls + (n & 1) * 8, this.ls, 16, this.pq);
    }
  }

  private iV(dest: number, flags: number, n: number): void {
    if ((n & 5) === 1) return;
    if (!(flags & TOP_EDGE) || n & 2) {
      const cur = this.cur!;
      if (n > 3) D.vLoopFilter(this.plane(cur, n), dest, this.uvls, 8, this.pq);
      else D.vLoopFilter(cur.y, dest + (n & 2) * 4 * this.ls + (n & 1) * 8, this.ls, 16, this.pq);
    }
  }

  /** `ff_vc1_p_loop_filter`: runs two rows and two columns behind decoding. */
  private pLoopFilter(): void {
    const x = this.mbX,
      y = this.mbY,
      s = this.startMbY,
      lastCol = x === this.mbw - 1,
      lastRow = y === this.endMbY - 1;
    if (y >= s + 2) {
      if (x) this.pV(2, 1, y === s + 2 ? TOP_EDGE : 0);
      if (lastCol) this.pV(2, 0, y === s + 2 ? TOP_EDGE : 0);
    }
    if (lastRow) {
      const bottom = y === s ? TOP_EDGE | BOTTOM_EDGE : BOTTOM_EDGE;
      if (x) {
        if (y >= s + 1) this.pV(1, 1, y === s + 1 ? TOP_EDGE : 0);
        this.pV(0, 1, bottom);
      }
      if (lastCol) {
        if (y >= s + 1) this.pV(1, 0, y === s + 1 ? TOP_EDGE : 0);
        this.pV(0, 0, bottom);
      }
    }
    const rightFlags = x ? RIGHT_EDGE : LEFT_EDGE | RIGHT_EDGE;
    for (let r = 2; r >= 0; r--) {
      if (r === 2 ? y < s + 2 : !lastRow || (r === 1 && y < s + 1)) continue;
      if (x >= 2) this.pH(r, 2, x === 2 ? LEFT_EDGE : 0);
      if (lastCol) {
        if (x >= 1) this.pH(r, 1, x === 1 ? LEFT_EDGE : 0);
        this.pH(r, 0, rightFlags);
      }
    }
  }

  /** `vc1_p_v_loop_filter` for the macroblock `r` rows up and `c` columns left. */
  private pV(r: number, c: number, flags: number): void {
    const cur = this.cur!,
      ls = this.ls,
      uvls = this.uvls,
      mbs = this.mbs,
      b8 = this.b8,
      pq = this.pq,
      m = 2 * mbs + this.mbX - r * mbs - c,
      cbp = this.cbpRow,
      isIntra = this.isIntraRow,
      motion = this.motion,
      lumaMv = this.lumaMv;
    const dl = this.dest0 - 16 * r * ls - 16 * c,
      dc = this.dest1 - 8 * r * uvls - 8 * c;
    for (let n = 0; n < 6; n++) {
      const chroma = n > 3,
        lsz = chroma ? uvls : ls,
        p = this.plane(cur, n),
        topCbp = cbp[m]! >>> (n * 4);
      const dst = chroma ? dc : dl + (n & 2) * 4 * ls + (n & 1) * 8;
      if (!(flags & BOTTOM_EDGE) || n < 2) {
        const topIntra = isIntra[m]! & (1 << n);
        let bottomIntra: number, bottomCbp: number;
        if (chroma) {
          bottomIntra = isIntra[m + mbs]! & (1 << n);
          bottomCbp = cbp[m + mbs]! >>> (n * 4);
        } else if (n < 2) {
          bottomIntra = isIntra[m]! & (1 << (n + 2));
          bottomCbp = cbp[m]! >>> ((n + 2) * 4);
        } else {
          bottomIntra = isIntra[m + mbs]! & (1 << (n - 2));
          bottomCbp = cbp[m + mbs]! >>> ((n - 2) * 4);
        }
        let differ: boolean;
        if (chroma)
          differ =
            lumaMv[m * 2] !== lumaMv[(m + mbs) * 2] ||
            lumaMv[m * 2 + 1] !== lumaMv[(m + mbs) * 2 + 1];
        else {
          const k = 4 + this.bi[n]! - 2 * r * b8 - 2 * c;
          differ =
            motion[k * 2] !== motion[(k + b8) * 2] ||
            motion[k * 2 + 1] !== motion[(k + b8) * 2 + 1];
        }
        if (topIntra || bottomIntra || differ) D.vLoopFilter(p, dst + 8 * lsz, lsz, 8, pq);
        else {
          const idx = (topCbp | (bottomCbp >>> 2)) & 3;
          if (idx & 1) D.vLoopFilter(p, dst + 8 * lsz + 4, lsz, 4, pq);
          if (idx & 2) D.vLoopFilter(p, dst + 8 * lsz, lsz, 4, pq);
        }
      }
      const tt = (this.ttblkRow[m]! >> (n * 4)) & 0xf;
      if (tt === TT_4X4 || tt === TT_8X4) {
        if (topCbp & 5) D.vLoopFilter(p, dst + 4 * lsz + 4, lsz, 4, pq);
        if (topCbp & 10) D.vLoopFilter(p, dst + 4 * lsz, lsz, 4, pq);
      }
    }
  }

  /** `vc1_p_h_loop_filter` for the macroblock `r` rows up and `c` columns left. */
  private pH(r: number, c: number, flags: number): void {
    const cur = this.cur!,
      ls = this.ls,
      uvls = this.uvls,
      mbs = this.mbs,
      b8 = this.b8,
      pq = this.pq,
      m = 2 * mbs + this.mbX - r * mbs - c,
      cbp = this.cbpRow,
      isIntra = this.isIntraRow,
      motion = this.motion,
      lumaMv = this.lumaMv;
    const dl = this.dest0 - 16 * r * ls - 16 * c,
      dc = this.dest1 - 8 * r * uvls - 8 * c;
    for (let n = 0; n < 6; n++) {
      const chroma = n > 3,
        lsz = chroma ? uvls : ls,
        p = this.plane(cur, n),
        leftCbp = cbp[m]! >>> (n * 4);
      const dst = chroma ? dc : dl + (n & 2) * 4 * ls + (n & 1) * 8;
      if (!(flags & RIGHT_EDGE) || !(n & 5)) {
        const leftIntra = isIntra[m]! & (1 << n);
        let rightIntra: number, rightCbp: number;
        if (chroma) {
          rightIntra = isIntra[m + 1]! & (1 << n);
          rightCbp = cbp[m + 1]! >>> (n * 4);
        } else if (n & 1) {
          rightIntra = isIntra[m + 1]! & (1 << (n - 1));
          rightCbp = cbp[m + 1]! >>> ((n - 1) * 4);
        } else {
          rightIntra = isIntra[m]! & (1 << (n + 1));
          rightCbp = cbp[m]! >>> ((n + 1) * 4);
        }
        let differ: boolean;
        if (chroma)
          differ =
            lumaMv[m * 2] !== lumaMv[(m + 1) * 2] || lumaMv[m * 2 + 1] !== lumaMv[(m + 1) * 2 + 1];
        else {
          const k = 4 + this.bi[n]! - 2 * r * b8 - 2 * c;
          differ =
            motion[k * 2] !== motion[(k + 1) * 2] || motion[k * 2 + 1] !== motion[(k + 1) * 2 + 1];
        }
        if (leftIntra || rightIntra || differ) D.hLoopFilter(p, dst + 8, lsz, 8, pq);
        else {
          const idx = (leftCbp | (rightCbp >>> 1)) & 5;
          if (idx & 1) D.hLoopFilter(p, dst + 4 * lsz + 8, lsz, 4, pq);
          if (idx & 4) D.hLoopFilter(p, dst + 8, lsz, 4, pq);
        }
      }
      const tt = (this.ttblkRow[m]! >> (n * 4)) & 0xf;
      if (tt === TT_4X4 || tt === TT_4X8) {
        if (leftCbp & 3) D.hLoopFilter(p, dst + 4 * lsz + 4, lsz, 4, pq);
        if (leftCbp & 12) D.hLoopFilter(p, dst + 4, lsz, 4, pq);
      }
    }
  }
}

function padded(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length + BITSTREAM_PADDING);
  out.set(bytes);
  return out;
}
