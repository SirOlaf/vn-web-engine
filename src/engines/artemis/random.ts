import {Mt19937} from '../../core/mt19937.js';
import {artemisRevision} from './revision.js';

/** Script random source for Lua `random` (0x14012eb30): boost::mt19937 at script +0x110,
 * seeded in the script constructor with `(int)_time64(NULL)`, behind a uniform_int
 * distribution over [0, 0xffff] (+0xad8/+0xadc, sampled by 0x1400ebd90 as `u % 0x10000`).
 * The boost seed normalization of state[0] (0x1400f1a10) keeps only its high bit, which
 * is all the twist reads, so outputs equal the reference generator. */
export class ArtemisRandom {
  private readonly generator: Mt19937;
  /** `seconds` is the Unix time the native constructor reads. */
  constructor(executableSha256: string, seconds: number) {
    artemisRevision(executableSha256);
    if (!Number.isFinite(seconds)) throw Error('Invalid Artemis random seed time');
    this.generator = new Mt19937(Math.trunc(seconds) | 0);
  }
  next(): number {
    return this.generator.next() % 0x10000;
  }
}
