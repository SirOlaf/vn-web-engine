import type {BurikoBpPointer} from '../bp/memory.js';
import {textBytes} from './text.js';

export interface BurikoNamedMutexCreateResult {
  /** Opaque nonnull handle returned by the selected synchronous host primitive. */
  readonly handle: unknown;
  /** GetLastError sampled immediately after successful create-owned. */
  readonly lastError: number;
}

/**
 * Explicit CreateMutexA/ReleaseMutex/CloseHandle boundary. The host synchronously
 * consumes the ANSI pointer during createOwned; browser labels are not mutex identity.
 */
export interface BurikoNamedMutexHost {
  createOwned(name: BurikoBpPointer | null): BurikoNamedMutexCreateResult | null;
  release(handle: unknown): void;
  close(handle: unknown): void;
}

interface NamedMutexNode {
  readonly id: number;
  readonly name: Uint8Array;
  readonly handle: unknown;
}

/** F0CF0..F0E63: title-local newest-first mutex nodes and persistent DWORD ID counter. */
export class BurikoNamedMutexes {
  private counter = 0;
  private readonly nodes: NamedMutexNode[] = [];
  private readonly pendingCloses: unknown[] = [];

  constructor(readonly host: BurikoNamedMutexHost) {}

  get nextIdSource(): number {
    return this.counter;
  }

  get ids(): readonly number[] {
    return this.nodes.map((node) => node.id);
  }

  get pendingCloseCount(): number {
    return this.pendingCloses.length;
  }

  private closeHandle(handle: unknown): void {
    try {
      this.host.close(handle);
    } catch (error) {
      this.pendingCloses.push(handle);
      throw error;
    }
  }

  name(id: number): Uint8Array | null {
    const node = this.nodes.find((candidate) => candidate.id === id >>> 0);
    return node === undefined ? null : node.name.slice();
  }

  /** F0D20 samples last-error before allocation and rejects every nonzero value. */
  create(name: BurikoBpPointer | null): number {
    const result = this.host.createOwned(name);
    if (result === null) return 0;
    if (result.lastError >>> 0 !== 0) {
      this.closeHandle(result.handle);
      return 0;
    }
    this.counter = (this.counter + 1) >>> 0;
    try {
      const copy = textBytes(name!, true).slice();
      this.nodes.unshift({id: this.counter, name: copy, handle: result.handle});
    } catch (error) {
      try {
        this.closeHandle(result.handle);
      } catch {
        // Preserve the name-copy failure; the handle remains available for clear().
      }
      throw error;
    }
    return this.counter;
  }

  /** F0DF0 unlinks first, then releases ownership and closes the host handle. */
  release(id: number): number {
    const index = this.nodes.findIndex((node) => node.id === id >>> 0);
    if (index < 0) return 0;
    const [node] = this.nodes.splice(index, 1);
    let firstError: unknown;
    let failed = false;
    try {
      this.host.release(node!.handle);
    } catch (error) {
      failed = true;
      firstError = error;
    }
    try {
      this.closeHandle(node!.handle);
    } catch (error) {
      if (!failed) {
        failed = true;
        firstError = error;
      }
    }
    if (failed) throw firstError;
    return 1;
  }

  /** F0CF0 repeatedly removes the current head and preserves the ID counter. */
  clear(): void {
    let firstError: unknown;
    let failed = false;
    while (this.nodes.length !== 0) {
      try {
        this.release(this.nodes[0]!.id);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
      }
    }
    const pending = this.pendingCloses.splice(0);
    for (const handle of pending) {
      try {
        this.closeHandle(handle);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
      }
    }
    if (failed) throw firstError;
  }
}
