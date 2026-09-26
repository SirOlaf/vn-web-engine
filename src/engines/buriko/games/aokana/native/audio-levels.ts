/** CVTTSD2SI's indefinite result, including values outside the signed 32-bit range. */
function truncateSigned32(value: number): number {
  const integer = Math.trunc(value);
  return Number.isFinite(integer) && integer >= -0x80000000 && integer <= 0x7fffffff
    ? integer | 0
    : -0x80000000;
}

/** The six consecutive words consumed by 0x1401122a0. */
export class AokanaAudioFade {
  active = false;
  start = 0;
  end = 0;
  from = 0;
  to = 0;
  current = 0;

  begin(rawTick: number, duration: number, target: number): void {
    this.start = rawTick | 0;
    this.end = (rawTick + duration) | 0;
    this.from = this.current;
    this.to = target | 0;
    this.active = true;
  }

  /** Signed wrapped tick subtraction and double interpolation, with no lower clamp. */
  update(rawTick: number): void {
    const duration = (this.end - this.start) | 0;
    let fraction = ((rawTick - this.start) | 0) / duration;
    if (duration <= 0 || fraction >= 1) {
      fraction = 1;
      this.active = false;
    }
    this.current = truncateSigned32(((this.to - this.from) | 0) * fraction + this.from);
  }
}

/** The four native level factors of each 0x50-byte music or static-sound record. */
export class AokanaAudioLevels {
  master = 0;
  additional = 0;
  readonly volume = new AokanaAudioFade();
  readonly envelope = new AokanaAudioFade();

  /** 0x140112310: the divisor is the binary64 constant 2.66666666, not 8/3. */
  attenuation(): number {
    const divisor = 2.66666666;
    const factors = [this.master, this.additional, this.volume.current, this.envelope.current];
    let sum = 0x200;
    for (const factor of factors) sum = (sum - factor) | 0;
    const attenuation = truncateSigned32(sum / divisor);
    for (const factor of factors) {
      if (((0x80 - factor) | 0) / divisor >= 48) return 0x80;
    }
    return attenuation;
  }

  /** 0x140112170 updates the output even when this tick finishes the last fade. */
  update(rawTick: number): boolean {
    const volumeActive = this.volume.active;
    const envelopeActive = this.envelope.active;
    if (volumeActive) this.volume.update(rawTick);
    if (envelopeActive) this.envelope.update(rawTick);
    return volumeActive || envelopeActive;
  }
}

/** 0x140113200 / 0x1401147d0: title pan 0..128 becomes backend pan -128..128. */
export function aokanaAudioPan(value: number): number {
  return (Math.max(0, Math.min(128, value | 0)) - 64) * 2;
}

/** 0x1401186e0: signed cubic pan expressed in DirectSound hundredths of a decibel. */
export function aokanaAudioPanDecibels(backendPan: number): number {
  const pan = Math.max(-128, Math.min(128, backendPan | 0));
  return truncateSigned32(-((Math.pow(pan, 3) / Math.pow(128, 3)) * -10000));
}

/** 0x1401187d0 stores this value even if DirectSound rejects a positive result. */
export function aokanaAudioVolumeDecibels(attenuation: number): number {
  return Math.max(-10000, Math.imul(attenuation, -100));
}
