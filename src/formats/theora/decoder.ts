import {TheoraBits, type TheoraInfo, type TheoraSetup} from './headers.js';

/** One decoded plane in Theora coordinates: row 0 is the bottom row of the frame. */
export interface TheoraPlane {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

type TheoraFrame = [TheoraPlane, TheoraPlane, TheoraPlane];

const enum Mode {
  InterNoMv = 0,
  Intra = 1,
  InterMv = 2,
  InterMvLast = 3,
  InterMvLast2 = 4,
  GoldenNoMv = 5,
  GoldenMv = 6,
  InterMvFour = 7,
}

/** Block (x, y) of each Hilbert curve position inside a 4x4-block superblock. */
const HILBERT = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
  [0, 2],
  [0, 3],
  [1, 3],
  [1, 2],
  [2, 2],
  [2, 3],
  [3, 3],
  [3, 2],
  [3, 1],
  [2, 1],
  [2, 0],
  [3, 0],
] as const;
/** Macroblock (x, y) of each quadrant of a luma superblock. */
const QUADRANTS = [
  [0, 0],
  [0, 1],
  [1, 1],
  [1, 0],
] as const;
/** Mode alphabets of schemes 1 to 6. */
const ALPHABETS = [
  [3, 4, 2, 0, 1, 5, 6, 7],
  [3, 4, 0, 2, 1, 5, 6, 7],
  [3, 2, 4, 0, 1, 5, 6, 7],
  [3, 2, 0, 4, 1, 5, 6, 7],
  [0, 3, 4, 2, 1, 5, 6, 7],
  [0, 5, 3, 4, 2, 1, 6, 7],
];
const ZIGZAG = Uint8Array.of(
  0,
  1,
  8,
  16,
  9,
  2,
  3,
  10,
  17,
  24,
  32,
  25,
  18,
  11,
  4,
  5,
  12,
  19,
  26,
  33,
  40,
  48,
  41,
  34,
  27,
  20,
  13,
  6,
  7,
  14,
  21,
  28,
  35,
  42,
  49,
  56,
  57,
  50,
  43,
  36,
  29,
  22,
  15,
  23,
  30,
  37,
  44,
  51,
  58,
  59,
  52,
  45,
  38,
  31,
  39,
  46,
  53,
  60,
  61,
  54,
  47,
  55,
  62,
  63,
);
/** DC predictor weights (left, down-left, down, down-right) and divisor per neighbour set. */
const PREDICTORS = [
  [0, 0, 0, 0, 1],
  [1, 0, 0, 0, 1],
  [0, 1, 0, 0, 1],
  [1, 0, 0, 0, 1],
  [0, 0, 1, 0, 1],
  [1, 0, 1, 0, 2],
  [0, 0, 1, 0, 1],
  [29, -26, 29, 0, 32],
  [0, 0, 0, 1, 1],
  [75, 0, 0, 53, 128],
  [0, 1, 0, 1, 2],
  [75, 0, 0, 53, 128],
  [0, 0, 1, 0, 1],
  [75, 0, 0, 53, 128],
  [0, 3, 10, 3, 16],
  [29, -26, 29, 0, 32],
];

const int16 = (value: number) => (value << 16) >> 16;
const clamp255 = (value: number) => (value < 0 ? 0 : value > 255 ? 255 : value);

/** Superblock run lengths (long runs) of the coded flags and block qi indices. */
function longRun(bits: TheoraBits): number {
  if (!bits.read1()) return 1;
  if (!bits.read1()) return 2 + bits.read1();
  if (!bits.read1()) return 4 + bits.read1();
  if (!bits.read1()) return 6 + bits.read(2);
  if (!bits.read1()) return 10 + bits.read(3);
  if (!bits.read1()) return 18 + bits.read(4);
  return 34 + bits.read(12);
}

/** Block run lengths (short runs) inside partially coded superblocks. */
function shortRun(bits: TheoraBits): number {
  if (!bits.read1()) return 1 + bits.read1();
  if (!bits.read1()) return 3 + bits.read1();
  if (!bits.read1()) return 5 + bits.read1();
  if (!bits.read1()) return 7 + bits.read(2);
  if (!bits.read1()) return 11 + bits.read(2);
  return 15 + bits.read(4);
}

/** Decodes flags over the selected items with long runs: a run of 4129 (the maximum) reads
 * a fresh flag, any other run toggles it. */
function longRunFlags(bits: TheoraBits, count: number, set: (index: number, flag: number) => void) {
  let flag = bits.read1(),
    index = 0;
  while (index < count) {
    let run = longRun(bits);
    const full = run >= 4129;
    for (; run > 0 && index < count; run--) set(index++, flag);
    flag = full && index < count ? bits.read1() : flag ^ 1;
  }
}

function motionComponent(bits: TheoraBits, fixed: boolean): number {
  if (fixed) {
    const value = bits.read(6);
    return value & 1 ? -(value >> 1) : value >> 1;
  }
  const code = bits.read(3);
  if (code === 0) return 0;
  if (code === 1) return 1;
  if (code === 2) return -1;
  let magnitude: number, sign: number;
  if (code < 5) {
    magnitude = code - 1;
    sign = bits.read1();
  } else {
    const extra = bits.read(code - 2);
    magnitude = (1 << (code - 3)) + (extra >> 1);
    sign = extra & 1;
  }
  return sign ? -magnitude : magnitude;
}

/** libtheora's 1-D iDCT of eight coefficients with stride `step`. */
function idct8(output: Int16Array, out: number, input: Int16Array, at: number, step: number) {
  const x0 = input[at]!,
    x1 = input[at + step]!,
    x2 = input[at + 2 * step]!,
    x3 = input[at + 3 * step]!,
    x4 = input[at + 4 * step]!,
    x5 = input[at + 5 * step]!,
    x6 = input[at + 6 * step]!,
    x7 = input[at + 7 * step]!;
  let t0 = (46341 * int16(x0 + x4)) >> 16,
    t1 = (46341 * int16(x0 - x4)) >> 16,
    t2 = ((25080 * x2) >> 16) - ((60547 * x6) >> 16),
    t3 = ((60547 * x2) >> 16) + ((25080 * x6) >> 16),
    t4 = ((12785 * x1) >> 16) - ((64277 * x7) >> 16),
    t5 = ((54491 * x5) >> 16) - ((36410 * x3) >> 16),
    t6 = ((36410 * x5) >> 16) + ((54491 * x3) >> 16),
    t7 = ((64277 * x1) >> 16) + ((12785 * x7) >> 16);
  let r = t4 + t5;
  t5 = (46341 * int16(t4 - t5)) >> 16;
  t4 = r;
  r = t7 + t6;
  t6 = (46341 * int16(t7 - t6)) >> 16;
  t7 = r;
  r = t0 + t3;
  t3 = t0 - t3;
  t0 = r;
  r = t1 + t2;
  t2 = t1 - t2;
  t1 = r;
  r = t6 + t5;
  t5 = t6 - t5;
  t6 = r;
  output[out] = t0 + t7;
  output[out + 8] = t1 + t6;
  output[out + 16] = t2 + t5;
  output[out + 24] = t3 + t4;
  output[out + 32] = t3 - t4;
  output[out + 40] = t2 - t5;
  output[out + 48] = t1 - t6;
  output[out + 56] = t0 - t7;
}

/** Loop filter response for the edge filter value `r` and limit `limit`. */
function loopFilterValue(r: number, limit: number): number {
  if (r <= -2 * limit || r >= 2 * limit) return 0;
  if (r <= -limit) return -r - 2 * limit;
  if (r < limit) return r;
  return 2 * limit - r;
}

/** Theora I frame decoder with libtheora's reconstruction arithmetic (iDCT, DC-only
 * shortcut, half-/quarter-pel prediction and the loop filter), so frames match libtheora
 * bit for bit. Post-processing is not applied, as libtheora's default level 0. */
export class TheoraDecoder {
  /** Fragment geometry per plane: blocks across/up and the first fragment index. */
  private readonly planes: {width: number; height: number; offset: number; count: number}[];
  private readonly fragments: number;
  /** Superblocks of all planes in coded order: 16 fragment indices each, -1 when outside. */
  private readonly superblocks: Int32Array;
  private readonly superblockPlaneEnd: number[];
  /** Macroblocks in coded order: four luma fragments (bottom-left, bottom-right, top-left,
   * top-right) and the chroma fragments of both chroma planes. */
  private readonly macroblockLuma: Int32Array;
  private readonly macroblockChroma: Int32Array;
  private readonly chromaPerMacroblock: number;
  private readonly macroblocks: number;
  private readonly coded: Uint8Array;
  private readonly mode: Uint8Array;
  private readonly motionX: Int8Array;
  private readonly motionY: Int8Array;
  private readonly qii: Uint8Array;
  private readonly coefficients: Int16Array;
  /** Next token index and coefficient count of each fragment. */
  private readonly tokenIndex: Uint8Array;
  private readonly coefficientCount: Uint8Array;
  private readonly dc: Int16Array;
  private readonly buffers: TheoraFrame[];
  private current = -1;
  private previous = -1;
  private golden = -1;
  private readonly residual = new Int16Array(64);
  private readonly work = new Int16Array(64);

  constructor(
    readonly info: TheoraInfo,
    private readonly setup: TheoraSetup,
  ) {
    const lumaWidth = info.macroblockWidth * 2,
      lumaHeight = info.macroblockHeight * 2;
    const chromaWidth = info.pixelFormat & 1 ? lumaWidth : info.macroblockWidth,
      chromaHeight = info.pixelFormat & 2 ? lumaHeight : info.macroblockHeight;
    this.planes = [];
    let offset = 0;
    for (const [width, height] of [
      [lumaWidth, lumaHeight],
      [chromaWidth, chromaHeight],
      [chromaWidth, chromaHeight],
    ] as const) {
      this.planes.push({width, height, offset, count: width * height});
      offset += width * height;
    }
    this.fragments = offset;
    const superblocks: number[] = [];
    this.superblockPlaneEnd = [];
    for (const plane of this.planes) {
      for (let sy = 0; sy < Math.ceil(plane.height / 4); sy++)
        for (let sx = 0; sx < Math.ceil(plane.width / 4); sx++)
          for (const [bx, by] of HILBERT) {
            const x = sx * 4 + bx,
              y = sy * 4 + by;
            superblocks.push(
              x < plane.width && y < plane.height ? plane.offset + y * plane.width + x : -1,
            );
          }
      this.superblockPlaneEnd.push(superblocks.length / 16);
    }
    this.superblocks = Int32Array.from(superblocks);
    const chroma = this.planes[1]!;
    this.chromaPerMacroblock =
      (chroma.width / info.macroblockWidth) * (chroma.height / info.macroblockHeight);
    const luma: number[] = [],
      chromaFragments: number[] = [];
    for (let sy = 0; sy < Math.ceil(info.macroblockHeight / 2); sy++)
      for (let sx = 0; sx < Math.ceil(info.macroblockWidth / 2); sx++)
        for (const [qx, qy] of QUADRANTS) {
          const mx = sx * 2 + qx,
            my = sy * 2 + qy;
          if (mx >= info.macroblockWidth || my >= info.macroblockHeight) continue;
          for (const [bx, by] of [
            [0, 0],
            [1, 0],
            [0, 1],
            [1, 1],
          ] as const)
            luma.push((my * 2 + by) * lumaWidth + mx * 2 + bx);
          for (const plane of [this.planes[1]!, this.planes[2]!]) {
            const cw = plane.width / info.macroblockWidth,
              ch = plane.height / info.macroblockHeight;
            for (let by = 0; by < ch; by++)
              for (let bx = 0; bx < cw; bx++)
                chromaFragments.push(plane.offset + (my * ch + by) * plane.width + mx * cw + bx);
          }
        }
    this.macroblockLuma = Int32Array.from(luma);
    this.macroblockChroma = Int32Array.from(chromaFragments);
    this.macroblocks = luma.length / 4;
    const count = this.fragments;
    this.coded = new Uint8Array(count);
    this.mode = new Uint8Array(count);
    this.motionX = new Int8Array(count);
    this.motionY = new Int8Array(count);
    this.qii = new Uint8Array(count);
    this.coefficients = new Int16Array(count * 64);
    this.tokenIndex = new Uint8Array(count);
    this.coefficientCount = new Uint8Array(count);
    this.dc = new Int16Array(count);
    this.buffers = [0, 1, 2].map(
      () =>
        this.planes.map((plane) => ({
          width: plane.width * 8,
          height: plane.height * 8,
          data: new Uint8Array(plane.width * plane.height * 64),
        })) as TheoraFrame,
    );
  }

  /** The last decoded frame, or null before the first one. */
  get frame(): readonly TheoraPlane[] | null {
    return this.current < 0 ? null : this.buffers[this.current]!;
  }

  /** Writes plane `index` of the last frame top-down (the order of th_decode_ycbcr_out). */
  copyPlane(index: number, target: Uint8Array, stride?: number): void {
    const plane = this.frame?.[index];
    if (!plane) throw Error('No decoded Theora frame');
    const width = plane.width,
      rowStride = stride ?? width;
    for (let row = 0; row < plane.height; row++) {
      const source = (plane.height - 1 - row) * width;
      target.set(plane.data.subarray(source, source + width), row * rowStride);
    }
  }

  /** Decodes one data packet. Returns false for an empty packet, which repeats the
   * previous frame. */
  decode(packet: Uint8Array): boolean {
    if (!packet.length) {
      if (this.current < 0) throw Error('Theora duplicate frame without a decoded frame');
      return false;
    }
    const bits = new TheoraBits(packet);
    if (bits.read1()) throw Error('Theora header packet in the frame data');
    const intra = bits.read1() === 0;
    const qis = [bits.read(6)];
    if (bits.read1()) {
      qis.push(bits.read(6));
      if (bits.read1()) qis.push(bits.read(6));
    }
    if (intra && bits.read(3)) throw Error('Unsupported Theora frame header');
    if (!intra && (this.previous < 0 || this.golden < 0)) this.initializeReferences();
    this.current = [0, 1, 2].find((index) => index !== this.previous && index !== this.golden)!;
    const codedList = intra ? this.allCoded() : this.codedFlags(bits);
    if (intra) this.mode.fill(Mode.Intra);
    else {
      this.macroblockModes(bits);
      this.motionVectors(bits);
    }
    this.blockQis(bits, codedList, qis.length);
    this.tokens(bits, codedList);
    this.predictDc();
    this.reconstruct(qis);
    this.loopFilter(this.setup.loopFilterLimits[qis[0]!]!);
    this.previous = this.current;
    if (intra) this.golden = this.current;
    return true;
  }

  /** libtheora fills missing references with mid-grey before decoding an inter frame. */
  private initializeReferences(): void {
    for (const plane of this.buffers[0]!) plane.data.fill(128);
    this.previous = this.golden = 0;
  }

  /** Coded fragments of all planes in coded order. */
  private allCoded(): Int32Array[] {
    this.coded.fill(1);
    const lists: Int32Array[] = [];
    let begin = 0;
    for (const end of this.superblockPlaneEnd) {
      const list: number[] = [];
      for (let index = begin * 16; index < end * 16; index++) {
        const fragment = this.superblocks[index]!;
        if (fragment >= 0) list.push(fragment);
      }
      lists.push(Int32Array.from(list));
      begin = end;
    }
    return lists;
  }

  private codedFlags(bits: TheoraBits): Int32Array[] {
    const count = this.superblocks.length / 16;
    const partial = new Uint8Array(count),
      full = new Uint8Array(count);
    let partials = 0;
    longRunFlags(bits, count, (index, flag) => {
      partial[index] = flag;
      partials += flag;
    });
    if (partials < count) {
      const others: number[] = [];
      for (let index = 0; index < count; index++) if (!partial[index]) others.push(index);
      longRunFlags(bits, others.length, (index, flag) => (full[others[index]!] = flag));
    }
    let flag = partials ? bits.read1() ^ 1 : 0,
      run = 0;
    const lists: Int32Array[] = [];
    let begin = 0;
    for (const end of this.superblockPlaneEnd) {
      const list: number[] = [];
      for (let superblock = begin; superblock < end; superblock++)
        for (let index = superblock * 16; index < superblock * 16 + 16; index++) {
          const fragment = this.superblocks[index]!;
          if (fragment < 0) continue;
          let coded: number;
          if (full[superblock]) coded = 1;
          else if (!partial[superblock]) coded = 0;
          else {
            if (run <= 0) {
              run = shortRun(bits);
              flag ^= 1;
            }
            run--;
            coded = flag;
          }
          this.coded[fragment] = coded;
          if (coded) list.push(fragment);
        }
      lists.push(Int32Array.from(list));
      begin = end;
    }
    return lists;
  }

  private macroblockModes(bits: TheoraBits): void {
    const scheme = bits.read(3);
    let alphabet: readonly number[];
    if (scheme === 0) {
      const custom = new Array<number>(8).fill(Mode.InterNoMv);
      for (let mode = 0; mode < 8; mode++) custom[bits.read(3)] = mode;
      alphabet = custom;
    } else alphabet = scheme === 7 ? [0, 1, 2, 3, 4, 5, 6, 7] : ALPHABETS[scheme - 1]!;
    for (let macroblock = 0; macroblock < this.macroblocks; macroblock++) {
      let mode = Mode.InterNoMv;
      if (this.macroblockCoded(macroblock)) {
        if (scheme === 7) mode = alphabet[bits.read(3)]!;
        else {
          let index = 0;
          while (index < 7 && bits.read1()) index++;
          mode = alphabet[index]!;
        }
      }
      this.setMacroblock(macroblock, (fragment) => (this.mode[fragment] = mode));
    }
  }

  private macroblockCoded(macroblock: number): boolean {
    for (let index = macroblock * 4; index < macroblock * 4 + 4; index++)
      if (this.coded[this.macroblockLuma[index]!]) return true;
    return false;
  }

  private setMacroblock(macroblock: number, set: (fragment: number) => void): void {
    for (let index = macroblock * 4; index < macroblock * 4 + 4; index++)
      set(this.macroblockLuma[index]!);
    const chroma = this.chromaPerMacroblock * 2;
    for (let index = macroblock * chroma; index < (macroblock + 1) * chroma; index++)
      set(this.macroblockChroma[index]!);
  }

  private motionVectors(bits: TheoraBits): void {
    this.motionX.fill(0);
    this.motionY.fill(0);
    const fixed = bits.read1() === 1;
    let lastX = 0,
      lastY = 0,
      last2X = 0,
      last2Y = 0;
    for (let macroblock = 0; macroblock < this.macroblocks; macroblock++) {
      const mode = this.mode[this.macroblockLuma[macroblock * 4]!]!;
      let x = 0,
        y = 0;
      switch (mode) {
        case Mode.InterMvFour: {
          // Uncoded luma blocks keep a zero vector; the last coded block's vector becomes
          // the last vector once for the whole macroblock.
          const lumaX = [0, 0, 0, 0],
            lumaY = [0, 0, 0, 0];
          let lastBlock = -1;
          for (let block = 0; block < 4; block++) {
            const fragment = this.macroblockLuma[macroblock * 4 + block]!;
            if (!this.coded[fragment]) continue;
            lumaX[block] = motionComponent(bits, fixed);
            lumaY[block] = motionComponent(bits, fixed);
            this.motionX[fragment] = lumaX[block]!;
            this.motionY[fragment] = lumaY[block]!;
            lastBlock = block;
          }
          if (lastBlock >= 0) {
            last2X = lastX;
            last2Y = lastY;
            lastX = lumaX[lastBlock]!;
            lastY = lumaY[lastBlock]!;
          }
          this.chromaMotion(macroblock, lumaX, lumaY);
          continue;
        }
        case Mode.InterMv:
          last2X = lastX;
          last2Y = lastY;
          x = lastX = motionComponent(bits, fixed);
          y = lastY = motionComponent(bits, fixed);
          break;
        case Mode.InterMvLast:
          x = lastX;
          y = lastY;
          break;
        case Mode.InterMvLast2:
          x = last2X;
          y = last2Y;
          last2X = lastX;
          last2Y = lastY;
          lastX = x;
          lastY = y;
          break;
        case Mode.GoldenMv:
          x = motionComponent(bits, fixed);
          y = motionComponent(bits, fixed);
          break;
        default:
          continue;
      }
      this.setMacroblock(macroblock, (fragment) => {
        this.motionX[fragment] = x;
        this.motionY[fragment] = y;
      });
    }
  }

  /** Chroma vectors of a four-vector macroblock: the rounded mean of the luma vectors
   * covering each chroma block. */
  private chromaMotion(macroblock: number, x: number[], y: number[]): void {
    const per = this.chromaPerMacroblock;
    const vectors: [number, number][] = [];
    const mean = (values: number[], indices: number[]) => {
      const sum = indices.reduce((total, index) => total + values[index]!, 0);
      const shift = indices.length === 4 ? 2 : 1;
      return (sum + (sum < 0 ? -1 : 0) + (1 << (shift - 1))) >> shift;
    };
    if (per === 1) vectors.push([mean(x, [0, 1, 2, 3]), mean(y, [0, 1, 2, 3])]);
    else if (per === 2)
      vectors.push([mean(x, [0, 1]), mean(y, [0, 1])], [mean(x, [2, 3]), mean(y, [2, 3])]);
    else for (let block = 0; block < 4; block++) vectors.push([x[block]!, y[block]!]);
    for (let plane = 0; plane < 2; plane++)
      for (let block = 0; block < per; block++) {
        const fragment = this.macroblockChroma[(macroblock * 2 + plane) * per + block]!;
        this.motionX[fragment] = vectors[block]![0];
        this.motionY[fragment] = vectors[block]![1];
      }
  }

  private blockQis(bits: TheoraBits, lists: Int32Array[], count: number): void {
    this.qii.fill(0);
    if (count === 1) return;
    const coded = lists.flatMap((list) => [...list]);
    let nonzero = 0;
    longRunFlags(bits, coded.length, (index, flag) => {
      this.qii[coded[index]!] = flag;
      nonzero += flag;
    });
    if (count === 3 && nonzero) {
      const raised = coded.filter((fragment) => this.qii[fragment]);
      longRunFlags(bits, raised.length, (index, flag) => (this.qii[raised[index]!]! += flag));
    }
  }

  /** DCT tokens: for each token index, every coded luma fragment and then every coded
   * chroma fragment still expecting a token at that index, in coded order. End-of-block
   * runs continue across fragments, planes and token indices. */
  private tokens(bits: TheoraBits, lists: Int32Array[]): void {
    const huffman = this.setup.huffman;
    for (const list of lists)
      for (const fragment of list) {
        this.coefficients.fill(0, fragment * 64, fragment * 64 + 64);
        this.tokenIndex[fragment] = 0;
        this.coefficientCount[fragment] = 0;
      }
    let pending = lists.map((list) => list.slice());
    let endRun = 0,
      lumaTable = 0,
      chromaTable = 0;
    for (let ti = 0; ti < 64; ti++) {
      if (ti === 0 || ti === 1) {
        lumaTable = bits.read(4);
        chromaTable = bits.read(4);
      }
      const group = ti === 0 ? 0 : ti < 6 ? 1 : ti < 15 ? 2 : ti < 28 ? 3 : 4;
      pending = pending.map((list, plane) => {
        const tree = huffman[group * 16 + (plane ? chromaTable : lumaTable)]!;
        const next: number[] = [];
        for (const fragment of list) {
          if (this.tokenIndex[fragment] !== ti) {
            if (this.tokenIndex[fragment]! < 64) next.push(fragment);
            continue;
          }
          if (endRun > 0) {
            endRun--;
            this.endBlock(fragment);
            continue;
          }
          const token = huffmanToken(bits, tree);
          if (token < 7) {
            endRun = endOfBlockRun(bits, token) - 1;
            this.endBlock(fragment);
            continue;
          }
          const base = fragment * 64;
          let index = ti;
          if (token < 9) index += token === 7 ? bits.read(3) + 1 : bits.read(6) + 1;
          else {
            const [run, value] = coefficientToken(bits, token);
            index += run;
            if (index < 64) this.coefficients[base + index] = value;
            index++;
          }
          if (index > 64) throw Error('Invalid Theora DCT token run');
          this.tokenIndex[fragment] = index;
          this.coefficientCount[fragment] = index;
          if (index < 64) next.push(fragment);
        }
        return Int32Array.from(next);
      });
    }
  }

  private endBlock(fragment: number): void {
    this.coefficientCount[fragment] = this.tokenIndex[fragment]!;
    this.tokenIndex[fragment] = 64;
  }

  /** DC prediction per plane in raster order from the coded neighbours that use the same
   * reference frame. */
  private predictDc(): void {
    const reference = (fragment: number) => {
      const mode = this.mode[fragment]!;
      return mode === Mode.Intra ? 0 : mode === Mode.GoldenNoMv || mode === Mode.GoldenMv ? 2 : 1;
    };
    for (const plane of this.planes) {
      const last = [0, 0, 0];
      for (let y = 0; y < plane.height; y++)
        for (let x = 0; x < plane.width; x++) {
          const fragment = plane.offset + y * plane.width + x;
          if (!this.coded[fragment]) continue;
          const frame = reference(fragment);
          const neighbour = (dx: number, dy: number) => {
            const nx = x + dx,
              ny = y + dy;
            if (nx < 0 || nx >= plane.width || ny < 0) return -1;
            const other = plane.offset + ny * plane.width + nx;
            return this.coded[other] && reference(other) === frame ? other : -1;
          };
          const left = neighbour(-1, 0),
            downLeft = neighbour(-1, -1),
            down = neighbour(0, -1),
            downRight = neighbour(1, -1);
          const flags =
            (left >= 0 ? 1 : 0) |
            (downLeft >= 0 ? 2 : 0) |
            (down >= 0 ? 4 : 0) |
            (downRight >= 0 ? 8 : 0);
          let prediction: number;
          if (!flags) prediction = last[frame]!;
          else {
            const [wl, wdl, wd, wdr, divisor] = PREDICTORS[flags]!;
            const value = (fragment: number) => (fragment >= 0 ? this.dc[fragment]! : 0);
            const l = value(left),
              dl = value(downLeft),
              d = value(down),
              dr = value(downRight);
            prediction = Math.trunc((wl! * l + wdl! * dl + wd! * d + wdr! * dr) / divisor!);
            if ((flags & 7) === 7) {
              if (Math.abs(prediction - d) > 128) prediction = d;
              else if (Math.abs(prediction - l) > 128) prediction = l;
              else if (Math.abs(prediction - dl) > 128) prediction = dl;
            }
          }
          const dc = int16(this.coefficients[fragment * 64]! + prediction);
          this.dc[fragment] = dc;
          last[frame] = dc;
        }
    }
  }

  private reconstruct(qis: number[]): void {
    const target = this.buffers[this.current]!,
      previous = this.previous >= 0 ? this.buffers[this.previous]! : null,
      golden = this.golden >= 0 ? this.buffers[this.golden]! : null;
    const residual = this.residual;
    for (let pli = 0; pli < 3; pli++) {
      const plane = this.planes[pli]!,
        output = target[pli]!,
        stride = output.width;
      const quarterX = pli > 0 && !(this.info.pixelFormat & 1),
        quarterY = pli > 0 && !(this.info.pixelFormat & 2);
      for (let by = 0; by < plane.height; by++)
        for (let bx = 0; bx < plane.width; bx++) {
          const fragment = plane.offset + by * plane.width + bx,
            px = bx * 8,
            py = by * 8;
          if (!this.coded[fragment]) {
            const source = previous![pli]!.data;
            for (let row = 0; row < 8; row++) {
              const at = (py + row) * stride + px;
              output.data.set(source.subarray(at, at + 8), at);
            }
            continue;
          }
          const mode = this.mode[fragment]!;
          this.residualBlock(fragment, pli, mode === Mode.Intra ? 0 : 1, qis);
          if (mode === Mode.Intra) {
            for (let row = 0; row < 8; row++)
              for (let col = 0; col < 8; col++)
                output.data[(py + row) * stride + px + col] = clamp255(
                  residual[row * 8 + col]! + 128,
                );
            continue;
          }
          const reference = (
            mode === Mode.GoldenNoMv || mode === Mode.GoldenMv ? golden : previous
          )![pli]!;
          const [x0, x1] = motionOffsets(this.motionX[fragment]!, quarterX),
            [y0, y1] = motionOffsets(this.motionY[fragment]!, quarterY);
          const width = reference.width,
            height = reference.height,
            source = reference.data;
          const two = x1 !== x0 || y1 !== y0;
          for (let row = 0; row < 8; row++) {
            const ya = clampIndex(py + row + y0, height) * width,
              yb = clampIndex(py + row + y1, height) * width;
            for (let col = 0; col < 8; col++) {
              let predicted = source[ya + clampIndex(px + col + x0, width)]!;
              if (two)
                predicted = (predicted + source[yb + clampIndex(px + col + x1, width)]!) >> 1;
              output.data[(py + row) * stride + px + col] = clamp255(
                predicted + residual[row * 8 + col]!,
              );
            }
          }
        }
    }
  }

  /** Dequantized coefficients through libtheora's iDCT (or its DC-only shortcut) into
   * `residual`, rows from the bottom of the block. */
  private residualBlock(fragment: number, pli: number, qti: number, qis: number[]): void {
    const tables = this.setup.quantizers[qti]![pli]!;
    const residual = this.residual;
    const dcQuant = tables[qis[0]!]![0]!;
    if (this.coefficientCount[fragment]! < 2) {
      residual.fill(int16((this.dc[fragment]! * dcQuant + 15) >> 5));
      return;
    }
    const acQuant = tables[qis[this.qii[fragment]!]!]!;
    const input = this.work;
    input.fill(0);
    input[0] = int16(this.dc[fragment]! * dcQuant);
    const base = fragment * 64;
    for (let index = 1; index < 64; index++) {
      const value = this.coefficients[base + index]!;
      if (value) input[ZIGZAG[index]!] = int16(value * acQuant[ZIGZAG[index]!]!);
    }
    const columns = new Int16Array(64);
    for (let row = 0; row < 8; row++) idct8(columns, row, input, row * 8, 1);
    for (let row = 0; row < 8; row++) idct8(residual, row, columns, row * 8, 1);
    for (let index = 0; index < 64; index++) residual[index] = (residual[index]! + 8) >> 4;
  }

  private loopFilter(limit: number): void {
    if (!limit) return;
    const frame = this.buffers[this.current]!;
    for (let pli = 0; pli < 3; pli++) {
      const plane = this.planes[pli]!,
        data = frame[pli]!.data,
        stride = frame[pli]!.width;
      const horizontal = (x: number, y: number) => {
        for (let row = 0; row < 8; row++) {
          const at = (y + row) * stride + x - 2;
          const f = loopFilterValue(
            (data[at]! - data[at + 3]! + 3 * (data[at + 2]! - data[at + 1]!) + 4) >> 3,
            limit,
          );
          data[at + 1] = clamp255(data[at + 1]! + f);
          data[at + 2] = clamp255(data[at + 2]! - f);
        }
      };
      const vertical = (x: number, y: number) => {
        for (let col = 0; col < 8; col++) {
          const at = (y - 2) * stride + x + col;
          const f = loopFilterValue(
            (data[at]! -
              data[at + 3 * stride]! +
              3 * (data[at + 2 * stride]! - data[at + stride]!) +
              4) >>
              3,
            limit,
          );
          data[at + stride] = clamp255(data[at + stride]! + f);
          data[at + 2 * stride] = clamp255(data[at + 2 * stride]! - f);
        }
      };
      for (let by = 0; by < plane.height; by++)
        for (let bx = 0; bx < plane.width; bx++) {
          const fragment = plane.offset + by * plane.width + bx;
          if (!this.coded[fragment]) continue;
          if (bx > 0) horizontal(bx * 8, by * 8);
          if (by > 0) vertical(bx * 8, by * 8);
          if (bx + 1 < plane.width && !this.coded[fragment + 1]) horizontal(bx * 8 + 8, by * 8);
          if (by + 1 < plane.height && !this.coded[fragment + plane.width])
            vertical(bx * 8, by * 8 + 8);
        }
    }
  }
}

function clampIndex(value: number, size: number): number {
  return value < 0 ? 0 : value >= size ? size - 1 : value;
}

/** Integer offsets of one vector component: truncation toward zero, and away from zero
 * as the second offset when the component has a fractional part. */
function motionOffsets(value: number, quarter: boolean): [number, number] {
  const divisor = quarter ? 4 : 2;
  const whole = Math.trunc(value / divisor);
  return [whole, value % divisor ? whole + Math.sign(value) : whole];
}

function huffmanToken(bits: TheoraBits, tree: Int16Array): number {
  let node = 0;
  if (tree.length === 1) return -1 - tree[0]!;
  for (;;) {
    node = tree[node + bits.read1()]!;
    if (node < 0) return -1 - node;
  }
}

function endOfBlockRun(bits: TheoraBits, token: number): number {
  switch (token) {
    case 0:
    case 1:
    case 2:
      return token + 1;
    case 3:
      return 4 + bits.read(2);
    case 4:
      return 8 + bits.read(3);
    case 5:
      return 16 + bits.read(4);
    default:
      // A zero-length run ends every remaining block of the frame.
      return bits.read(12) || Infinity;
  }
}

/** Zero run and coefficient value of tokens 9 to 31. Sign bits precede magnitude and run
 * bits. */
function coefficientToken(bits: TheoraBits, token: number): [number, number] {
  const signed = (value: number) => (bits.read1() ? -value : value);
  switch (token) {
    case 9:
      return [0, 1];
    case 10:
      return [0, -1];
    case 11:
      return [0, 2];
    case 12:
      return [0, -2];
    case 13:
    case 14:
    case 15:
    case 16:
      return [0, signed(token - 10)];
    case 17:
    case 18:
    case 19:
    case 20:
    case 21:
    case 22: {
      const size = [1, 2, 3, 4, 5, 9][token - 17]!,
        base = [7, 9, 13, 21, 37, 69][token - 17]!;
      const negative = bits.read1();
      const value = base + bits.read(size);
      return [0, negative ? -value : value];
    }
    case 23:
    case 24:
    case 25:
    case 26:
    case 27:
      return [token - 22, signed(1)];
    case 28:
    case 29: {
      const negative = bits.read1();
      const run = token === 28 ? 6 + bits.read(2) : 10 + bits.read(3);
      return [run, negative ? -1 : 1];
    }
    case 30: {
      const negative = bits.read1();
      const value = 2 + bits.read1();
      return [1, negative ? -value : value];
    }
    default: {
      const negative = bits.read1();
      const value = 2 + bits.read1();
      const run = 2 + bits.read1();
      return [run, negative ? -value : value];
    }
  }
}
