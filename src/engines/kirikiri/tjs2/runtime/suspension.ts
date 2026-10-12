/**
 * Suspension of synchronous native calls. Natively, storage reads, message boxes and modal
 * windows block the calling script while the core keeps running. In the browser such work is
 * asynchronous, so a call that has to wait returns `TJS_E_SUSPENDED` instead of a result:
 *
 * 1. The native that starts asynchronous work calls `suspend(promise, then)` and returns its
 *    result: `TJS_E_SUSPENDED`. `then` finishes the call once the promise settles.
 * 2. Every caller that sees `TJS_E_SUSPENDED` and has work left after the call registers that
 *    work with `defer(resume)` and returns `TJS_E_SUSPENDED` too. A caller with nothing left
 *    (the call was its last action, writing into the caller's result slot) just returns the
 *    code. Callers that cannot continue later run their callees inside `nonSuspending`.
 * 3. The driver (`run`) awaits the promise, then resumes the continuations innermost first,
 *    passing each one the outcome of the one inside it. A continuation can suspend again; its
 *    new continuations then run before the outer ones that are still waiting.
 *
 * Results travel through the slots the callers handed down, which the continuations still hold.
 * The VM uses the same protocol for its explicit frames. While a chain is suspended no other
 * script runs: natively the whole core waited inside the blocking call.
 */
import {TJS_E_SUSPENDED} from './interface.js';
import {TjsSuspensionError} from './errors.js';

/** How the call inside a continuation ended: a result code, or a thrown value. */
export type Outcome = {readonly code: number} | {readonly error: unknown};

/** Finishes one caller's work after its callee completed. Returns a code or throws. */
export type Continuation = (inner: Outcome) => number;

/** The suspender driving the top-level call in progress. */
let running: Suspender | null = null;

/**
 * For runtime code that has no engine at hand (the default member handlers, `CustomObject`):
 * registers `resume` behind a callee that returned `TJS_E_SUSPENDED`.
 */
export function deferSuspended(resume: Continuation): number {
  if (!running) throw new TjsSuspensionError('TJS_E_SUSPENDED outside a top-level call');
  return running.defer(resume);
}

/** Runs `fn` where nothing may suspend, when a top-level call is in progress. */
export function withoutSuspension<T>(fn: () => T): T {
  return running ? running.nonSuspending(fn) : fn();
}

export class Suspender {
  /** Continuations of the current chain, innermost first. */
  #chain: Continuation[] = [];
  #pending: Promise<unknown> | null = null;
  #nonSuspending = 0;
  #running = false;

  /** True while a chain waits for asynchronous work. */
  get suspended(): boolean {
    return this.#pending !== null;
  }

  /** True when a call made now may suspend. */
  canSuspend(): boolean {
    return this.#running && this.#nonSuspending === 0 && this.#pending === null;
  }

  /**
   * Starts waiting for `promise`. `then` receives its value and returns the call's final code
   * (or throws); a rejection is thrown into the chain. Returns `TJS_E_SUSPENDED`.
   */
  suspend<T>(promise: Promise<T>, then: (value: T) => number): number {
    if (!this.canSuspend())
      throw new TjsSuspensionError('Cannot wait for asynchronous work in this context');
    let settled: {value: T} | {error: unknown} | null = null;
    this.#pending = promise.then(
      (value) => {
        settled = {value};
      },
      (error: unknown) => {
        settled = {error};
      },
    );
    this.#chain.push(() => {
      const s = settled!;
      if ('error' in s) throw s.error;
      return then(s.value);
    });
    return TJS_E_SUSPENDED;
  }

  /** Registers the rest of a caller's work behind a suspended callee. Returns `TJS_E_SUSPENDED`. */
  defer(resume: Continuation): number {
    if (this.#pending === null) throw new TjsSuspensionError('defer() without a suspended callee');
    this.#chain.push(resume);
    return TJS_E_SUSPENDED;
  }

  /** Runs `fn` where nothing may suspend (natives that call script and cannot resume). */
  nonSuspending<T>(fn: () => T): T {
    this.#nonSuspending++;
    try {
      return fn();
    } finally {
      this.#nonSuspending--;
    }
  }

  /**
   * Runs a top-level call (an event handler, the startup script) to completion, awaiting
   * every suspension in it. Resolves to the final code; rejects with what the chain threw.
   */
  async run(start: () => number): Promise<number> {
    if (this.#running) throw new TjsSuspensionError('Re-entrant top-level run');
    this.#running = true;
    const outer = running;
    running = this;
    try {
      let outcome = this.#call(start);
      while ('code' in outcome && outcome.code === TJS_E_SUSPENDED) {
        if (this.#pending === null) throw new TjsSuspensionError('Suspended without pending work');
        await this.#pending;
        this.#pending = null;
        const chain = this.#chain;
        this.#chain = [];
        // The leaf continuation runs first, without an inner outcome.
        let inner: Outcome = {code: 0};
        let i = 0;
        for (; i < chain.length; i++) {
          inner = this.#call(() => chain[i]!(inner));
          if ('code' in inner && inner.code === TJS_E_SUSPENDED) break;
        }
        if (i < chain.length) {
          // Suspended again: the outer continuations wait behind the new inner ones.
          this.#chain.push(...chain.slice(i + 1));
        }
        outcome = inner;
      }
      if (this.#chain.length || this.#pending) {
        throw new TjsSuspensionError('A suspended call was not propagated to the top level');
      }
      if ('error' in outcome) throw outcome.error;
      return outcome.code;
    } finally {
      this.#chain = [];
      this.#pending = null;
      this.#running = false;
      running = outer;
    }
  }

  #call(fn: () => number): Outcome {
    try {
      const code = fn();
      if (code === TJS_E_SUSPENDED && this.#pending === null)
        throw new TjsSuspensionError('TJS_E_SUSPENDED without pending work');
      return {code};
    } catch (error) {
      return {error};
    }
  }
}
