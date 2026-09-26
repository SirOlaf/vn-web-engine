/**
 * A fixed x86 compatibility profile for browser implementations of Windows
 * programs that ask for CPUID and processor topology. These values describe
 * the emulated instruction contract, not the user's physical CPU. In
 * particular, a browser cannot expose genuine CPUID or thread affinity.
 */
export class BrowserX86CompatibilityCpuHost {
  static readonly logicalProcessors = 2;

  private readonly epochMilliseconds: number;
  private lastTimestamp = 0n;

  constructor(private readonly clock: Pick<Performance, 'now'> = globalThis.performance) {
    this.epochMilliseconds = clock.now();
  }

  /** EAX, EBX, ECX, EDX. Unknown leaves and subleaves have no advertised features. */
  cpuid(leaf: number, subleaf: number): readonly [number, number, number, number] {
    if (subleaf >>> 0 !== 0) return [0, 0, 0, 0];
    switch (leaf >>> 0) {
      case 0:
        // "WebEngineCPU" in the CPUID vendor register order EBX, EDX, ECX.
        return [1, 0x45626557, 0x55504365, 0x6e69676e];
      case 1:
        // Family 6, two logical processors, and an emulated SSE/SSE2 path.
        return [0x600, BrowserX86CompatibilityCpuHost.logicalProcessors << 16, 0, 0x06000000];
      case 0x80000000:
        return [0x80000006, 0, 0, 0];
      case 0x80000001:
        return [0, 0, 0, 0];
      case 0x80000005:
        // 64 KiB L1 data cache with a 64-byte line in the native record format.
        return [0, 0, 0x40080040, 0];
      case 0x80000006:
        // 512 KiB L2 cache with a 64-byte line in the native record format.
        return [0, 0, 0x02006040, 0];
      case 0x80000002:
      case 0x80000003:
      case 0x80000004:
        return brandRegisters((leaf >>> 0) - 0x80000002);
      default:
        return [0, 0, 0, 0];
    }
  }

  /** Approximate 2.4 GHz TSC from the browser's monotonic clock. */
  readTimestampCounter(): bigint {
    const elapsed = Math.max(0, this.clock.now() - this.epochMilliseconds);
    const approximation = BigInt(Math.floor(elapsed * 1000)) * 2400n;
    if (approximation > this.lastTimestamp) this.lastTimestamp = approximation;
    return this.lastTimestamp;
  }

  /** A browser cannot pin its JavaScript thread; expose one stable virtual mask. */
  setCurrentThreadAffinity(_mask: bigint): bigint {
    return 1n;
  }

  logicalProcessorCount(): number {
    return BrowserX86CompatibilityCpuHost.logicalProcessors;
  }

  logicalProcessorInformation(): Iterable<{relationship: number; processorMask: bigint}> {
    return [{relationship: 0, processorMask: 3n}];
  }
}

const brand = new Uint8Array(48);
brand.set(new TextEncoder().encode('Web Engine x86 compatibility CPU'));

function brandRegisters(index: number): readonly [number, number, number, number] {
  const view = new DataView(brand.buffer, brand.byteOffset + index * 16, 16);
  return [
    view.getUint32(0, true),
    view.getUint32(4, true),
    view.getUint32(8, true),
    view.getUint32(12, true),
  ];
}
