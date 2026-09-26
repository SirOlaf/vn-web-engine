import type {BurikoDistributedAllocator} from './distributed-processing.js';

/** 2776F8: short cooperative metadata scopes; never held across a native lower await. */
export class BurikoLoaderMetadata {
  private owner: object | null = null;
  private depth = 0;
  constructor(readonly allocator: BurikoDistributedAllocator) {}

  run<T>(
    actor: object,
    operation: () => T & (Extract<T, PromiseLike<unknown>> extends never ? unknown : never),
  ): T {
    if (this.owner !== null && this.owner !== actor)
      throw new Error('Buriko loader metadata has a different synchronous owner');
    this.owner = actor;
    this.depth++;
    try {
      return operation();
    } finally {
      if (--this.depth === 0) this.owner = null;
    }
  }
}
