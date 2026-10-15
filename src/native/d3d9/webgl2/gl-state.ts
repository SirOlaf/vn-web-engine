/**
 * Shadow of the WebGL2 state the device sets. Each setter issues the GL call only when its
 * arguments differ from the last call with the same key. `invalidate` forgets everything
 * (after a context restore, or when another user of the context changed its state).
 */
export class GlStateCache {
  private readonly values = new Map<string, readonly unknown[]>();

  /** Runs `apply` unless `key` was last set with the same `args` (compared with `===`). */
  set(key: string, args: readonly unknown[], apply: () => void): void {
    const previous = this.values.get(key);
    if (
      previous !== undefined &&
      previous.length === args.length &&
      previous.every((value, index) => value === args[index])
    )
      return;
    this.values.set(key, args);
    apply();
  }

  /** Forgets one key, so the next `set` for it always applies. */
  forget(key: string): void {
    this.values.delete(key);
  }

  invalidate(): void {
    this.values.clear();
  }
}
