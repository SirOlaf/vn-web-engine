import type {BurikoBpPointer} from '../bp/memory.js';
import type {BurikoBpThread} from '../bp/state.js';
import {listThreadModules} from '../bp/modules.js';
import {pointerBytes} from '../bp/opcodes/operands.js';

export interface BurikoDiagnosticCounterBank {
  readonly bank: number;
  readonly count: number;
  readonly counts: BurikoBpPointer;
  readonly flags: BurikoBpPointer | null;
}
function word(pointer: BurikoBpPointer | null, offset: number): DataView {
  if (pointer === null)
    throw new Error('Buriko diagnostic counter dereferences a null flags array');
  const bytes = pointerBytes(pointer, 4, offset);
  return new DataView(bytes.buffer, bytes.byteOffset, 4);
}
function zero(pointer: BurikoBpPointer, length: number): void {
  for (let offset = 0; offset < length; offset++) {
    const at = pointer.offset + offset;
    if (at < 0 || at >= pointer.bytes.length)
      throw new Error('Buriko diagnostic clear writes beyond native counter storage');
    pointer.bytes[at] = 0;
  }
}

/** 1400aa8d0 initializes these arrays; this shipping executable has no incrementing writer. */
export class BurikoDiagnosticCounts {
  readonly banks: BurikoDiagnosticCounterBank[] = [];
  constructor() {
    for (const bank of [0x7f, 0x80, 0x81, 0x90, 0x91, 0x92, 0xa0, 0xb0, 0xc0, 0xd0])
      this.register(
        bank,
        256,
        {bytes: new Uint8Array(1024), offset: 0},
        {bytes: new Uint8Array(1024), offset: 0},
      );
  }

  /** 1400ab1e0: removal precedes pointer validation; appending links before clearing storage. */
  register(
    bank: number,
    count: number,
    counts: BurikoBpPointer | null,
    flags: BurikoBpPointer | null,
  ): 0 | 1 {
    bank |= 0;
    count >>>= 0;
    const found = this.banks.findIndex((entry) => entry.bank === bank);
    if (found >= 0) {
      if (count !== 0) return 0;
      this.banks.splice(found, 1);
      return 1;
    }
    if (count === 0 || counts === null) return 0;
    this.banks.push({bank, count, counts, flags});
    zero(counts, count * 4);
    return 1;
  }

  clear(): void {
    for (const entry of this.banks) zero(entry.counts, entry.count * 4);
  }

  setFlags(bank: number, secondary: number, flags: number): 0 | 3 | 4 {
    const entry = this.banks.find((entry) => entry.bank === (bank | 0));
    if (!entry) return 3;
    secondary >>>= 0;
    if (secondary >= entry.count) return 4;
    word(entry.flags, secondary * 4).setUint32(0, flags, true);
    return 0;
  }

  /** 1400ab0d0 rereads the count AFTER storing the output opcode; aliases are observable. */
  enumerate(output: BurikoBpPointer | null): number {
    let total = 0;
    for (const entry of this.banks) {
      for (let index = 0; index < entry.count; index++) {
        if (word(entry.counts, index * 4).getUint32(0, true) === 0) continue;
        if ((word(entry.flags, index * 4).getUint32(0, true) & 1) !== 0) continue;
        if (output !== null) {
          word(output, total * 8).setUint32(0, ((entry.bank & 255) << 8) | (index & 255), true);
          const count = word(entry.counts, index * 4).getUint32(0, true);
          word(output, total * 8 + 4).setUint32(0, count, true);
        }
        total = (total + 1) >>> 0;
      }
    }
    return total;
  }

  dispose(): void {
    this.banks.length = 0;
  }
}

export interface BurikoPooledAllocationRecord {
  readonly address: number;
  readonly text: Uint8Array;
}
/** 1400aac60/1400aabf0: retained native byte strings, newest first, independent logging flag. */
export class BurikoPooledAllocationDiagnostics {
  enabled = 0;
  readonly records: BurikoPooledAllocationRecord[] = [];

  record(address: number, size: number, thread: BurikoBpThread): 0 | 1 {
    if (this.enabled === 0) return 0;
    const modules = listThreadModules(thread, true);
    if (modules.length === 0) return 0;
    const site = thread.instructionStart >>> 0;
    const module = modules.find((entry) => site >= entry.base);
    if (!module)
      throw new Error('Buriko pooled-allocation diagnostic reads beyond its module list');
    const hex = (value: number): string =>
      (value >>> 0).toString(16).toUpperCase().padStart(8, '0');
    const prefix = new TextEncoder().encode(
      `Address [ $${hex(address)} ] : Size [ ${size | 0} ] : Thread [ ${thread.id | 0} ] , Program [ `,
    );
    const suffix = new TextEncoder().encode(` ] , IP [ $${hex(site - module.base)} ]\n`);
    const text = new Uint8Array(prefix.length + module.name.length + suffix.length);
    if (text.length >= 256)
      throw new Error(
        'Buriko pooled-allocation diagnostic overwrites its native sprintf stack buffer',
      );
    text.set(prefix);
    text.set(module.name, prefix.length);
    text.set(suffix, prefix.length + module.name.length);
    this.records.unshift({address: address >>> 0, text});
    return 1;
  }

  remove(address: number): 0 | 1 {
    const index = this.records.findIndex((record) => record.address === address >>> 0);
    if (index < 0) return 0;
    this.records.splice(index, 1);
    return 1;
  }

  dispose(): void {
    this.records.length = 0;
  }
}
