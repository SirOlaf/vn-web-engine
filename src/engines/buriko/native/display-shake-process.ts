import {BurikoDisplayControlProcess} from './display-control-process.js';

function divideUnsigned(numerator: number, denominator: number): number {
  denominator >>>= 0;
  if (denominator === 0) throw new Error('Buriko display shake native unsigned division fault');
  return Math.floor((numerator >>> 0) / denominator) >>> 0;
}

/** CProcShakeDspObj 07E410: concrete object motion over the shared control process. */
export class BurikoDisplayShakeProcess extends BurikoDisplayControlProcess {
  private mode = 0;
  private framesPerCycle = 0;
  private amplitudes: Uint32Array = new Uint32Array(0);
  private phases: Int32Array = new Int32Array(0);

  /** 07E120's two copied tables: signed64 decay and folded triangular phases. */
  initializeShake(
    mode: number,
    amplitude: number,
    frequency: number,
    cycles: number,
    decay: number,
    frameRate: number,
  ): number {
    mode >>>= 0;
    frequency >>>= 0;
    cycles >>>= 0;
    frameRate >>>= 0;
    if (mode > 5) return 0x80000001;
    if (frequency === 0) return 0x80000002;
    if (cycles === 0) return 0x80000003;
    if (frameRate === 0 || frameRate < frequency) return 0x80000004;
    this.mode = mode;
    this.tickMilliseconds = divideUnsigned(1000, frameRate);
    this.framesPerCycle = divideUnsigned(1000, Math.imul(this.tickMilliseconds, frequency));
    this.current = 0;
    this.total = Math.imul(this.framesPerCycle, cycles);
    this.frameLimit = 0;
    const position = this.object.position();
    this.startX = position.x;
    this.startY = position.y;
    this.lastX = this.lastY = -0x80000000;
    this.object.setActivation(1);
    this.object.invalidate();
    this.setDeadline(this.tickMilliseconds);

    this.amplitudes = new Uint32Array(cycles);
    let value = BigInt((amplitude << 16) >>> 0);
    const factor = BigInt((100 - decay) | 0);
    for (let index = 0; index < cycles; index++) {
      this.amplitudes[index] = Number(BigInt.asUintN(32, value >> 16n));
      value = BigInt.asIntN(64, factor * value) / 100n;
    }

    this.phases = new Int32Array(this.framesPerCycle);
    const origin = mode < 4 ? 0 : 0x8000;
    let phase = origin;
    let step = divideUnsigned(0x20000, this.framesPerCycle) | 0;
    for (let index = 0; index < this.framesPerCycle; index++) {
      const sum = (step + phase) | 0;
      let direction = sum < 0x10000 ? step : -step | 0;
      const folded = sum < 0x10000 ? sum : (0x20000 - sum) | 0;
      if (folded <= 0) direction = -direction | 0;
      step = direction;
      phase = Math.abs(folded) | 0;
      this.phases[index] = mode === 0 || mode === 2 ? origin - phase : phase - origin;
    }
    return 0;
  }

  /** 07E000 uses signed phase × zero-extended amplitude and restores XY at completion. */
  protected override update(forceFinish: boolean): boolean {
    const finished = forceFinish || this.advanceFrames();
    if (forceFinish) this.current = this.total;
    let x = this.startX,
      y = this.startY;
    if (!finished) {
      const current = this.current >>> 0,
        phase = this.phases[current % this.framesPerCycle],
        amplitude = this.amplitudes[Math.floor(current / this.framesPerCycle)];
      if (phase === undefined || amplitude === undefined)
        throw new RangeError('Buriko display shake reads beyond its native phase/amplitude tables');
      const product = BigInt.asIntN(64, BigInt(phase) * BigInt(amplitude));
      const offset = Number(BigInt.asIntN(32, product >> 16n));
      if (this.mode === 0 || this.mode === 1 || this.mode === 4) y = (y + offset) | 0;
      else x = (x + offset) | 0;
    }
    if (x !== this.lastX || y !== this.lastY) {
      this.lastX = x;
      this.lastY = y;
      this.object.invalidate();
      this.object.move(x, y);
      this.object.invalidate();
      this.dirty = true;
    }
    return finished;
  }

  override dispose(): void {
    this.amplitudes = new Uint32Array(0);
    this.phases = new Int32Array(0);
    super.dispose();
  }
}
