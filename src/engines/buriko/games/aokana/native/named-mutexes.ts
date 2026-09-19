import type {AokanaBpPointer} from '../bp/memory.js';
import {textBytes} from './text.js';

export interface AokanaNamedMutexCreateResult {
  /** Opaque nonnull handle returned by the selected synchronous host primitive. */
  readonly handle: unknown;
  /** GetLastError sampled immediately after successful create-owned. */
  readonly lastError: number;
}

/**
 * Explicit CreateMutexA/ReleaseMutex/CloseHandle boundary. The host synchronously
 * consumes the ANSI pointer during createOwned; browser labels are not mutex identity.
 */
export interface AokanaNamedMutexHost {
  createOwned(name: AokanaBpPointer | null): AokanaNamedMutexCreateResult | null;
  release(handle: unknown): void;
  close(handle: unknown): void;
}

interface NamedMutexNode {
  readonly id: number;
  readonly name: Uint8Array;
  readonly handle: unknown;
}

/** F0CF0..F0E63: title-local newest-first mutex nodes and persistent DWORD ID counter. */
export class AokanaNamedMutexes {
  private counter = 0;
  private readonly nodes: NamedMutexNode[] = [];

  constructor(readonly host: AokanaNamedMutexHost) {}

  get nextIdSource(): number {
    return this.counter;
  }

  get ids(): readonly number[] {
    return this.nodes.map((node) => node.id);
  }

  name(id: number): Uint8Array | null {
    const node = this.nodes.find((candidate) => candidate.id === id >>> 0);
    return node === undefined ? null : node.name.slice();
  }

  /** F0D20 samples last-error before allocation and rejects every nonzero value. */
  create(name: AokanaBpPointer | null): number {
    const result = this.host.createOwned(name);
    if (result === null) return 0;
    if (result.lastError >>> 0 !== 0) {
      this.host.close(result.handle);
      return 0;
    }
    this.counter = (this.counter + 1) >>> 0;
    const copy = textBytes(name!, true).slice();
    this.nodes.unshift({id: this.counter, name: copy, handle: result.handle});
    return this.counter;
  }

  /** F0DF0 unlinks first, then releases ownership and closes the host handle. */
  release(id: number): number {
    const index = this.nodes.findIndex((node) => node.id === id >>> 0);
    if (index < 0) return 0;
    const [node] = this.nodes.splice(index, 1);
    this.host.release(node!.handle);
    this.host.close(node!.handle);
    return 1;
  }

  /** F0CF0 repeatedly removes the current head and preserves the ID counter. */
  clear(): void {
    while (this.nodes.length !== 0) this.release(this.nodes[0]!.id);
  }
}
