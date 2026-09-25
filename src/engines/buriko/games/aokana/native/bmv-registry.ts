import {pointerView, type AokanaBpPointer} from '../bp/memory.js';
import {AokanaDisplayCriticalSection} from './display-critical-section.js';
import type {AokanaDistributedAllocator} from './distributed-processing.js';
import {terminatedNativeBytes} from './program-files.js';

export interface AokanaBmvProvenance {
  readonly archive: Uint8Array | null;
  readonly name: Uint8Array;
  readonly length: number;
}

/** The shared +30/+38/+40 backing of one ordinary alias chain. */
export class AokanaBmvResource {
  private data: Uint8Array | null;
  private source: AokanaBmvProvenance | null;
  constructor(bytes: Uint8Array, provenance: AokanaBmvProvenance | null) {
    this.data = bytes;
    this.source = provenance;
  }
  get bytes(): Uint8Array {
    if (this.data === null) throw new Error('Aokana BMV resource backing was released');
    return this.data;
  }
  get provenance(): AokanaBmvProvenance | null {
    return this.source;
  }
  release(): void {
    this.data = null;
    this.source = null;
  }
}

export interface AokanaBmvEntry {
  readonly id: number;
  readonly lock: AokanaDisplayCriticalSection;
  readonly resource: AokanaBmvResource;
  previousAlias: number;
  nextAlias: number;
  next: AokanaBmvEntry | null;
}

/** 1D0410/1D0460 and 0385D0/0384B0/0380C0; separate from streaming movie playback. */
export class AokanaBmvRegistry {
  readonly lock: AokanaDisplayCriticalSection;
  private counter = 0;
  private first: AokanaBmvEntry | null = null;
  constructor(readonly allocator: AokanaDistributedAllocator) {
    this.lock = new AokanaDisplayCriticalSection(() => allocator.currentActor);
  }

  /** 038450 lookup; callers hold the registry/entry lock appropriate to their native chain. */
  find(id: number): AokanaBmvEntry | null {
    for (let entry = this.first; entry !== null; entry = entry.next)
      if (entry.id === id >>> 0) return entry;
    return null;
  }

  private create(resource: AokanaBmvResource, previousAlias: number): AokanaBmvEntry {
    this.counter = (this.counter + 1) >>> 0;
    return {
      id: this.counter,
      resource,
      previousAlias: previousAlias >>> 0,
      nextAlias: 0,
      lock: new AokanaDisplayCriticalSection(() => this.allocator.currentActor),
      next: this.first,
    };
  }

  /** 0385D0 accepts the signature only, retaining all codec versions for later dispatch. */
  register(
    output: AokanaBpPointer | null,
    metadata: AokanaBpPointer | null,
    source: Uint8Array,
    count: number,
    provenance: AokanaBmvProvenance | null = null,
  ): number {
    return this.lock.run(() => {
      const signature = pointerView({bytes: source, offset: 0}, 16);
      if (
        signature.getBigUint64(0, true) !== 0x6569766f4d5f4642n ||
        signature.getBigUint64(8, true) !== 0x005f5f5f5f5f5f5fn
      )
        return 0x80000002;
      count >>>= 0;
      pointerView({bytes: source, offset: 0}, count);
      const bytes = source.slice(0, count),
        copied =
          provenance === null
            ? null
            : {
                archive:
                  provenance.archive === null
                    ? null
                    : terminatedNativeBytes(provenance.archive).slice(),
                name: terminatedNativeBytes(provenance.name).slice(),
                length: provenance.length >>> 0,
              },
        entry = this.create(new AokanaBmvResource(bytes, copied), 0);
      this.first = entry;
      if (output === null)
        throw new Error('Aokana BMV registration dereferences null handle output');
      pointerView(output, 4).setUint32(0, entry.id, true);
      for (const [index, offset] of [0x14, 0x18, 0x20, 0x24, 0x28].entries()) {
        const value = pointerView({bytes, offset}, 4).getUint32(0, true);
        if (metadata === null)
          throw new Error('Aokana BMV registration dereferences null metadata output');
        pointerView({bytes: metadata.bytes, offset: metadata.offset + index * 4}, 4).setUint32(
          0,
          value,
          true,
        );
      }
      return 0;
    });
  }

  /** 0380C0 permits exactly one successor per entry, sharing encoded data and provenance. */
  alias(output: AokanaBpPointer | null, id: number): number {
    return this.lock.run(() => {
      const source = this.find(id);
      if (source === null) return 0x80000003;
      if (source.nextAlias !== 0) return 0x80000007;
      const entry = this.create(source.resource, source.id);
      source.nextAlias = entry.id;
      this.first = entry;
      if (output === null) throw new Error('Aokana BMV alias dereferences null handle output');
      pointerView(output, 4).setUint32(0, entry.id, true);
      return 0;
    });
  }

  /** 0384B0 removes one list entry; only the last remaining alias releases shared backing. */
  remove(id: number): number {
    return this.lock.run(() => {
      let previous: AokanaBmvEntry | null = null,
        entry = this.first;
      while (entry !== null && entry.id !== id >>> 0) {
        previous = entry;
        entry = entry.next;
      }
      if (entry === null) return 0x80000003;
      entry.lock.enter();
      entry.lock.leave();
      if (previous === null) this.first = entry.next;
      else previous.next = entry.next;
      if (entry.previousAlias !== 0) {
        const before = this.find(entry.previousAlias);
        if (before === null) throw new Error('Aokana BMV alias predecessor is absent');
        before.nextAlias = entry.nextAlias;
      }
      if (entry.nextAlias !== 0) {
        const after = this.find(entry.nextAlias);
        if (after === null) throw new Error('Aokana BMV alias successor is absent');
        after.previousAlias = entry.previousAlias;
      }
      if (entry.previousAlias === 0 && entry.nextAlias === 0) entry.resource.release();
      return 0;
    });
  }

  /** Final graph retirement after frame workers and native callbacks have joined. */
  clear(): void {
    this.lock.run(() => {
      const released = new Set<AokanaBmvResource>();
      for (let entry = this.first; entry !== null; entry = entry.next) {
        entry.lock.enter();
        entry.lock.leave();
        if (!released.has(entry.resource)) {
          entry.resource.release();
          released.add(entry.resource);
        }
      }
      this.first = null;
    });
  }
}
