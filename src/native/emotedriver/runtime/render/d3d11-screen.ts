const f = Math.fround;

/**
 * Native screen projection state (+0x14c..+0x184), exact x64 DLL 80d28bd0…1e051.
 * SetScreenRect stores five int32 arguments; frame preparation resolves them
 * against the external target. This state does not set a D3D11 context viewport.
 */
export class EmoteD3d11Screen {
  private readonly requested = new Int32Array([0, 0, 0, 0, -1]);
  private readonly words = new Uint32Array(15);
  private readonly floats = new Float32Array(this.words.buffer);

  constructor() {
    // 0x18005f0e0 initializes the projection rectangle to zero and its mode to -1.
    this.words[14] = 0xffffffff;
  }

  /** Slot14, 0x180001ae0: defer conversion until the next frame preparation. */
  setScreenRect(x: number, y: number, width: number, height: number, mode: number): void {
    this.requested[0] = x;
    this.requested[1] = y;
    this.requested[2] = width;
    this.requested[3] = height;
    this.requested[4] = mode;
  }

  /** Resolved mode used by the automatic camera, not the pending setter value. */
  get mode(): number {
    return this.words[14]! | 0;
  }

  /**
   * 0x180061450 / 0x18005e8d0. Borrowed fifteen native words, valid until the
   * next preparation. Words0..3 are uint32 x/y/width/height,4..13 are float32
   * projection/depth fields and14 is the int32 mode. Do not mutate them.
   * Mode-1 leaves the last mapping intact when automatic matrices are disabled.
   */
  prepare(targetWidth: number, targetHeight: number, automatic: boolean): Uint32Array {
    let x: number, y: number, width: number, height: number, mode: number;
    if (this.requested[4] === -1) {
      if (!automatic) return this.words;
      x = y = 0;
      width = targetWidth >>> 0;
      height = targetHeight >>> 0;
      mode = 1;
    } else {
      x = this.requested[0]! >>> 0;
      y = this.requested[1]! >>> 0;
      width = this.requested[2]! >>> 0;
      height = this.requested[3]! >>> 0;
      mode = this.requested[4]!;
      if (mode === 0) y = (targetHeight - y - height) >>> 0;
    }
    const halfWidth = f(f(width) * 0.5),
      halfHeight = f(f(height) * 0.5);
    this.words[0] = x;
    this.words[1] = y;
    this.words[2] = width;
    this.words[3] = height;
    this.floats[4] = halfWidth;
    this.floats[5] = f(f(height) * (mode === 0 ? -0.5 : 0.5));
    this.floats[6] = this.floats[10] = 0.5;
    this.floats[7] = this.floats[11] = this.floats[12] = 0;
    this.floats[8] = f(f(x) + halfWidth);
    this.floats[9] = f(halfHeight + f(y));
    this.floats[13] = 1;
    this.words[14] = mode;
    return this.words;
  }
}
