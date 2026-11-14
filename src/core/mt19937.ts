/** 32-bit Mersenne Twister (MT19937) with the reference `init_genrand` seeding, as used
 * by std::mt19937 and boost::random::mt19937. Outputs are uint32. */
export class Mt19937 {
  private readonly state = new Uint32Array(624);
  private index = 624;
  constructor(seed: number) {
    const state = this.state;
    state[0] = seed >>> 0;
    for (let i = 1; i < 624; i++) {
      const previous = state[i - 1]! ^ (state[i - 1]! >>> 30);
      state[i] = (Math.imul(previous, 0x6c078965) + i) >>> 0;
    }
  }
  private twist(): void {
    const state = this.state;
    for (let i = 0; i < 624; i++) {
      const y = (state[i]! & 0x80000000) | (state[(i + 1) % 624]! & 0x7fffffff);
      state[i] = state[(i + 397) % 624]! ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
    }
    this.index = 0;
  }
  next(): number {
    if (this.index >= 624) this.twist();
    let y = this.state[this.index++]!;
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }
}
