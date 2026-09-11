import {checkRange} from '../../../../../core/binary.js';
import * as defaults from './noah-reset-data.js';

/** Audited native layout, kept in bounded regions so overlapping fields remain overlapping.
 * These are engine data, never executable memory or host addresses. RVAs identify fields
 * whose purpose is still being named during reverse engineering. */
export class NoahState {
  readonly regions = [
    // Native zero-filled history snapshot array; no producer found in this build.
    {address: 0x1023b60, bytes: new Uint8Array(400 * 0x4a2c)},
    {address: 0x1d8be20, bytes: new Uint8Array(4 * 0x1258)},
    {address: 0x1d90900, bytes: new Uint8Array(10 * 0x5218)},
    {address: 0x200000, bytes: new Uint8Array(0x10000)},
    {address: 0x531000, bytes: new Uint8Array(0x344000)},
    {address: 0x179c000, bytes: new Uint8Array(0x14000)},
    {address: 0x176e528, bytes: new Uint8Array(8)},
    {address: 0x1d1b200, bytes: new Uint8Array(512 * 0x1b0)},
    {address: 0x1d51200, bytes: new Uint8Array(8 * 0xe0)},
    {address: 0x1d7d190, bytes: new Uint8Array(0xc0)},
    {address: 0x1dd97e9, bytes: new Uint8Array(1)},
    {address: 0x875000, bytes: new Uint8Array(0x1023a50 - 0x875000)},
    {address: 0x1762020, bytes: new Uint8Array(0xc508)},
    {address: 0x1de15a0, bytes: new Uint8Array(0x170)},
    {address: 0x1bb0379, bytes: new Uint8Array(15)},
    {address: 0x1de8bb4, bytes: new Uint8Array(4)},
    {address: 0x1de9cc8, bytes: new Uint8Array(12)},
    {address: 0x1bae4e0, bytes: new Uint8Array(0xc04)},
    {address: 0x1badfbc, bytes: new Uint8Array(4)},
    {address: 0x1badf64, bytes: new Uint8Array(4)},
    {address: 0x1dd9c90, bytes: new Uint8Array(0x374)},
    {address: 0x1023a50, bytes: new Uint8Array(0x110)},
  ];
  readonly variableBytes = new Uint8Array(32000);
  readonly variables = new DataView(this.variableBytes.buffer);
  readonly flags = new Uint8Array(1000);
  readonly galleryUnlocks = new Uint8Array(1200);
  readonly readFlags = new Uint8Array(0xb400);
  readonly auxiliary = new Uint8Array(0x400);
  /** Native heap allocation behind 140578b70, 64*36*2 fracture records. */
  readonly backgroundFragments = new Uint8Array(4608 * 0x68);
  /** Shared mutable CPU vertex allocation at 14056cdb0. Submission transforms it in place. */
  readonly triangleVertices = new Float32Array(0x360000 / 4);
  private readonly scalarViews = new WeakMap<Uint8Array, DataView>();
  constructor(readonly random15: () => number) {
    // Mutable PE .data defaults, verified against the pinned image. These run
    // once per process state; VM allocation/reset must not replay them.
    this.put(0x20a690, 0x10000);
    for (const a of [0x20a694, 0x20b5d8, 0x20bbec, 0x20d394, 0x20d3cc]) this.put(a, 65535);
    for (const a of [0x20b5dc, 0x20bb90]) this.put(a, 255);
    for (const a of [0x20bb94, 0x20bbb4]) this.put(a, 99999);
    for (let i = 0; i < 3; i++) this.put(0x20bba8 + i * 4, 19);
    for (let i = 0; i < 10; i++) this.put(0x20ddc0 + i * 4, 65535);
    for (let i = 0; i < 16; i++) this.put(0x20ddf0 + i * 4, 65535);
    // Executable data initializer: navigation hints start in keyboard mode.
    this.put(0x20d22c, 1);
    // BrowserInput supplies coordinates in the native 1920x1080 client space.
    this.view(0x1badf64, 4).setFloat32(0, 1, true);
    this.view(0x17adf9c, 4).setFloat32(0, 1, true);
    [5, 3, 6, 11, 10].forEach((count, i) => this.put(0x20d218 + i * 4, count));
    this.put(0x20dde8, 7);
    this.put(0x20ddec, 8);
    // 140010ee0 initializes the mutable character compositor indirection.
    for (let i = 0; i < 8; i++) this.put(0x57aad0 + i * 4, i);
    // Executable data initializer: title submenu row counts, 14020d380.
    [0, 0, 2, 0, 3].forEach((count, i) => this.put(0x20d380 + i * 4, count));
  }
  bytes(address: number, size: number): Uint8Array {
    const r = this.regions.find(
      (r) => address >= r.address && address + size <= r.address + r.bytes.length,
    );
    if (!r) throw new Error(`Unmapped Noah state RVA 0x${address.toString(16)} + ${size}`);
    checkRange(r.bytes.length, address - r.address, size);
    return r.bytes.subarray(address - r.address, address - r.address + size);
  }
  view(address: number, size: number): DataView {
    const b = this.bytes(address, size);
    return new DataView(b.buffer, b.byteOffset, b.length);
  }
  private spans(address: number, size: number): Uint8Array[] {
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid state span');
    const result: Uint8Array[] = [];
    while (size) {
      const r = this.regions.find(
        (r) => address >= r.address && address < r.address + r.bytes.length,
      );
      if (!r) throw new Error(`Unmapped state span ${address.toString(16)}`);
      const n = Math.min(size, r.address + r.bytes.length - address);
      result.push(this.bytes(address, n));
      address += n;
      size -= n;
    }
    return result;
  }
  readSpan(address: number, size: number): Uint8Array {
    const out = new Uint8Array(size);
    let offset = 0;
    for (const span of this.spans(address, size)) {
      out.set(span, offset);
      offset += span.length;
    }
    return out;
  }
  writeSpan(address: number, bytes: Uint8Array): void {
    const spans = this.spans(address, bytes.length),
      input = bytes.slice();
    let offset = 0;
    for (const span of spans) {
      span.set(input.subarray(offset, offset + span.length));
      offset += span.length;
    }
  }
  /** Keep scalar access allocation-free after the first access to a region.
   * Resolve in original order on every access: regions and their byte arrays are
   * publicly exposed, and overlapping/replaced entries retain first-match semantics. */
  private scalarRegion(address: number, size: number) {
    for (let i = 0, length = this.regions.length; i < length; i++) {
      const r = this.regions[i]!;
      if (address >= r.address && address + size <= r.address + r.bytes.length) {
        checkRange(r.bytes.length, address - r.address, size);
        return r;
      }
    }
    throw new Error(`Unmapped Noah state RVA 0x${address.toString(16)} + ${size}`);
  }
  private scalarView(bytes: Uint8Array): DataView {
    let view = this.scalarViews.get(bytes);
    if (!view) {
      view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      this.scalarViews.set(bytes, view);
    }
    return view;
  }
  get(address: number): number {
    const r = this.scalarRegion(address, 4);
    return this.scalarView(r.bytes).getInt32(address - r.address, true);
  }
  put(address: number, value: number, width = 4): void {
    const r = this.scalarRegion(address, width),
      v = this.scalarView(r.bytes),
      offset = address - r.address;
    if (width === 1) v.setUint8(offset, value);
    else if (width === 2) v.setUint16(offset, value, true);
    else if (width === 4) v.setUint32(offset, value, true);
    else if (width === 8) v.setBigUint64(offset, BigInt(value), true);
    else throw new Error(`Invalid state write width ${width}`);
  }
  zero(address: number, size: number): void {
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid state clear length');
    const spans: Uint8Array[] = [];
    while (size) {
      const region = this.regions.find(
        (r) => address >= r.address && address < r.address + r.bytes.length,
      );
      if (!region) throw new Error(`Unmapped state clear RVA 0x${address.toString(16)}`);
      const length = Math.min(size, region.address + region.bytes.length - address);
      spans.push(this.bytes(address, length));
      address += length;
      size -= length;
    }
    for (const bytes of spans) bytes.fill(0);
  }
  variable(index: number): number {
    checkRange(32000, index * 4, 4);
    return this.variables.getInt32(index * 4, true);
  }
  setVariable(index: number, value: number): void {
    checkRange(32000, index * 4, 4);
    this.variables.setInt32(index * 4, value, true);
  }
  flag(index: number): number {
    checkRange(8000, index, 1);
    return (this.flags[index >>> 3]! >>> (index & 7)) & 1;
  }
  setFlag(index: number, value: number): void {
    checkRange(8000, index, 1);
    const byte = index >>> 3,
      mask = 1 << (index & 7);
    this.flags[byte] = value ? this.flags[byte]! | mask : this.flags[byte]! & ~mask;
  }
  private clearFlagMasks(pairs: readonly (readonly [number, number])[]): void {
    for (const [offset, mask] of pairs) this.flags[offset] = this.flags[offset]! & ~mask;
  }
  private apply(writes: readonly defaults.StateWrite[]): void {
    for (const [address, width, value] of writes) {
      if (address >= 32000) this.put(address, value, width);
      else if (width === 8) this.variables.setBigUint64(address, BigInt(value), true);
      else if (width === 4) this.variables.setUint32(address, value, true);
      else if (width === 2) this.variables.setUint16(address, value, true);
      else this.variables.setUint8(address, value);
    }
  }
  settingsDefaults(): void {
    this.apply(defaults.SETTINGS_DEFAULTS);
  }
  /** Pure VM allocation state from 14005f920. Archive/graphics host startup is separate. */
  initialize(): void {
    this.flags.fill(0);
    this.variableBytes.fill(0);
    this.galleryUnlocks.fill(0);
    this.readFlags.fill(0);
    this.auxiliary.fill(0);
    this.apply(defaults.ALLOCATE_DEFAULTS);
    this.settingsDefaults();
    this.zero(0x17acbd0, 200);
    this.zero(0x17abe90, 800);
    this.zero(0x872140, 0xc80);
    this.apply(defaults.KEY_MASKS);
    this.apply(defaults.KEY_BINDINGS);
  }
  /** 14003ea10: deliberately preserves fields outside the native reset's writes. */
  resetText(index: number): void {
    const stride = index * 0x11984;
    for (const base of [0x5b8164, 0x5b8ac4, 0x5b10e4]) this.zero(base + stride, 0x960);
    this.bytes(0x5bf1e4 + stride, 0x960).fill(255);
    for (const base of [0x5b10a0, 0x5b10ac, 0x5b10b8, 0x5b10c0]) this.zero(base + stride, 8);
    this.put(0x5b10b4 + stride, 0, 1);
    this.put(0x5b10d8 + stride, 0);
    this.put(0x5b10e0 + stride, 0);
    this.put(0x80c4d0 + index * 4, 0);
    this.put(0x80cff0 + index * 4, 0);
  }
  /** 14000c830, also called directly when opening the CG gallery. */
  galleryProgress(): void {
    let total = 0,
      unlocked = 0;
    this.put(0x5451c4, 0);
    this.put(0x543564, 0);
    for (let i = 0; i < defaults.GALLERY.length; i++) {
      let yes = 0,
        no = 0;
      const group = defaults.GALLERY[i]!;
      this.put(0x543570 + i * 4, 0);
      this.put(0x5432e0 + i * 4, 0);
      this.put(0x543050 + i * 4, 0);
      for (const [index, displayId] of group) {
        total++;
        if (this.galleryUnlocks[index]) {
          this.put(0x5438a0 + (i * 10 + yes++) * 4, displayId);
          unlocked++;
        } else no++;
      }
      this.put(0x543570 + i * 4, yes);
      this.put(0x5432e0 + i * 4, no);
      if (group.length) {
        this.put(0x543050 + i * 4, group.length);
        this.put(0x543564, unlocked);
        this.put(0x5451c4, total);
      }
    }
    for (let category = 0; category < 8; category++) {
      let count = 0;
      while (count < 20 && this.get(0x543050 + (category * 20 + count) * 4)) count++;
      this.put(0x542d80 + category * 4, count);
    }
  }
  /** 14000b960: refresh the two aggregate ending flags. */
  refreshEndingFlags(): void {
    this.flags[0xf1] = this.flags[0xf1]! & ~12;
    if ((this.flags[0x6d]! & 0xfc) === 0xfc && (this.flags[0x6e]! & 3) === 3) {
      this.flags[0xf1] |= 4;
      if (this.flags[0x6e]! & 4) this.flags[0xf1] |= 8;
    }
  }
  /** 14002eba0: title-menu initialization, also called by persistent resets. */
  initializeTitle(): void {
    this.refreshEndingFlags();
    for (const a of [
      0x5af948, 0x5afa8c, 0x5b0994, 0x5af94c, 0x5b0a40, 0x5b0a50, 0x5a7108, 0x5af920,
    ])
      this.put(a, 0);
    this.zero(0x5af910, 16);
    this.put(0x5b0990, this.flags[0x65]! & 4 ? 0 : 3);
    this.put(0x20d388, this.flags[0x6f]! & 0x20 ? 3 : 2);
    this.put(0x5afa9c, !(this.flags[0xf1]! & 4) || this.flags[0xf1]! & 8 ? 1 : 0);
    this.setVariable(0x210c / 4, 0);
    this.setVariable(0x211c / 4, 0);
    this.setVariable(0x36cc / 4, 255);
    this.galleryProgress();
    const total = this.get(0x5451c4) >>> 0,
      unlocked = this.get(0x543564) >>> 0;
    let percentage = total ? Math.trunc(((Math.imul(unlocked, 100) + 50) >>> 0) / total) : 0;
    if (percentage === 100 && unlocked !== total) percentage = 99;
    this.put(0x5afac4, percentage);
    let bits = 0;
    for (let i = 0; i < 18; i++) bits += (this.variable(0x1f64 / 4) >>> i) & 1;
    this.put(0x5a9ac8, Math.trunc((bits * 100) / 18));
    const a = this.flags[0x6d]!,
      b = this.flags[0x6e]!;
    const endings = [
      (a >>> 4) & 1,
      (a >>> 6) & 1,
      b & 1,
      (b >>> 1) & 1,
      a >>> 7,
      (a >>> 5) & 1,
      (a >>> 2) & 1,
      (a >>> 3) & 1,
      (b >>> 2) & 1,
    ];
    endings.forEach((value, i) => this.put(0x5b0448 + i * 4, value));
    this.put(
      0x5b09e4,
      endings.reduce((a, b) => a + b, 0),
    );
  }
  private particles(): void {
    const rand = () => this.random15() & 0x7fff;
    const scaled = (range: number) => (rand() * range) >>> 15;
    const float = (a: number, v: number) => this.view(a, 4).setFloat32(0, v, true);
    this.zero(0x56cdb8, 8);
    for (let i = 0; i < 4000; i++) {
      const x = scaled(4000) - 2000,
        y = scaled(2000) - 1000;
      this.put(0x54d400 + i * 8, x);
      this.put(0x54d404 + i * 8, y);
      float(0x57ae30 + i * 12, x);
      float(0x57ae34 + i * 12, y);
      float(0x57ae38 + i * 12, scaled(2000) - 1000);
      this.put(0x570e60 + i * 4, 256);
    }
    this.zero(0x555108, 8);
    for (let i = 0; i < 4000; i++) {
      float(0x559200 + i * 20, scaled(4000) - 2000);
      float(0x559204 + i * 20, scaled(2000) - 1000);
      float(0x559208 + i * 20, scaled(3000) - 1500);
      float(0x55920c + i * 20, ((rand() >>> 2) - 4096) / 65536);
      float(0x559210 + i * 20, ((rand() >>> 2) - 4096) / 65536);
      const rotation = scaled(24);
      this.put(0x555110 + i * 4, 512);
      this.put(0x574cf0 + i * 4, 256);
      this.put(0x56cfe0 + i * 4, 0);
      this.put(0x545660 + i * 4, rotation);
      this.put(0x578b90 + i * 2, (rand() >>> 2) << 3, 2);
    }
    this.put(0x5378e0, scaled(1920));
    this.put(0x5425a0, scaled(1920));
  }
  /** Complete 10/00 selector switch, including native fallthrough and preserved state. */
  reset(selector: number, configEnabled: boolean): void {
    switch (selector | 0) {
      case 0:
        this.flags.fill(0);
        this.variableBytes.fill(0);
        this.settingsDefaults();
        this.readFlags.fill(0);
        this.zero(0x17acbd0, 200);
        this.galleryUnlocks.fill(0);
        this.auxiliary.fill(0);
        this.particles();
        this.apply(defaults.RESET_0);
        for (let i = 0; i < 32; i++) this.setVariable(0x2050 / 4 + i, i);
        this.setVariable(0x34b8 / 4, this.get(0x17ac318));
        this.setFlag(0xe4 * 8 + 5, +configEnabled);
        this.setVariable(0x241c / 4, this.get(0x17add50));
      // Native falls through to selector 1.
      case 1:
        this.apply(defaults.RESET_1_BEFORE_PROGRESS);
        for (let i = 0; i < 8; i++) {
          this.setFlag(0x960 + i, 0);
          const start = 0x1194 + i * 40;
          for (let j = 0; j < 20; j++) this.setVariable(start + j, 0);
          for (const [j, v] of [
            [7, 65535],
            [13, 256],
            [16, 1280],
            [17, 720],
            [18, 65535],
            [19, 0xffffff],
          ])
            this.setVariable(start + j!, v!);
          this.setVariable(0xd48 + i, i);
        }
        for (let i = 0; i < 16; i++) {
          this.setVariable(0x166c + i, 65535);
          this.setFlag(0x96a + i, 0);
          const start = 0x13ec + i * 40;
          for (let j = 0; j <= 10; j++) this.setVariable(start + j, 0);
          for (let j = 14; j <= 17; j++) this.setVariable(start + j, 0);
          for (const [j, v] of [
            [0, 640],
            [1, 360],
            [7, 256],
            [8, 0xffffff],
            [9, 65535],
            [18, 255],
            [19, 255],
            [20, 65535],
          ])
            this.setVariable(start + j!, v!);
          this.setVariable(0xd7a + i, i + 8);
        }
        this.clearFlagMasks([[0x130, 0x18]]);
        for (let i = 0; i < 2; i++) {
          this.setFlag(0x97f + i, 0);
          for (let j = 0; j < 13; j++) this.setVariable(5000 + i * 20 + j, 0);
          [256, 0, 0, 65535, 0xffffff].forEach((v, j) => this.setVariable(0x1395 + i * 20 + j, v));
        }
        this.clearFlagMasks([
          [0xa0, 0xa0],
          [0x98, 0xa0],
          [0x97, 0xe0],
          [0x96, 2],
          [0x9c, 0x38],
          [0x138, 0xc0],
          [0x139, 1],
          [0x9b, 0x1c],
          [0xeb, 0x40],
          [0xa1, 7],
        ]);
        for (let i = 0; i < 5; i++) this.resetText(i);
        // These arrays are reset across all 20 slots after the five text resets.
        this.zero(0x80c4d0, 80);
        this.zero(0x80cff0, 80);
        this.flags[0xee] = this.flags[0xee]! | 2;
        this.initializeTitle();
        this.apply(defaults.RESET_1_AFTER_PROGRESS);
        this.clearFlagMasks([
          [0x161, 0x80],
          [0x162, 3],
        ]);
        this.zero(0x558fe0, 480);
        for (let i = 0; i < 16; i++) this.put(0x56cd70 + i * 4, 255);
        return;
      case 2:
        for (const [a, n] of [
          [0, 100],
          [150, 75],
          [300, 100],
          [500, 125],
        ])
          this.flags.fill(0, a!, a! + n!);
        this.variableBytes.fill(0, 0, 0x1900);
        this.variableBytes.fill(0, 0x20d0, 0x3390);
        for (let i = 0x10cc; i < 8000; i++) if (i < 0x10f4 || i >= 0x10fc) this.setVariable(i, 0);
        this.apply(defaults.RESET_2);
        this.clearFlagMasks([
          [0x161, 128],
          [0x162, 3],
        ]);
      case 5:
        this.apply(defaults.RESET_5);
        return;
      case 9:
        this.settingsDefaults();
        return;
      case 10:
        this.settingsDefaults();
        this.flags.fill(0, 100, 150);
        this.flags.fill(0, 460, 500);
        this.variableBytes.fill(0, 0x960, 0xfa0);
        this.variableBytes.fill(0, 8000, 8400);
        this.apply(defaults.RESET_10_BEFORE_PROGRESS);
        this.initializeTitle();
        this.put(0x543038, 1);
        this.put(0x543890, 0);
        this.galleryProgress();
        this.apply(defaults.RESET_10_AFTER_PROGRESS);
        this.zero(0x17acbd0, 100);
        this.readFlags.fill(0);
        this.galleryUnlocks.fill(0);
        this.auxiliary.fill(0);
        return;
      case 0xf9:
        this.bytes(0x17acbd0, 100).fill(1);
        return;
      default:
        return; // Verified native switch default; selector expression is still evaluated.
    }
  }
}
