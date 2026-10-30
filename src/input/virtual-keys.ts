/** Windows virtual-key state sampled once per engine frame, as GetAsyncKeyState polling
 * sees it. A key pressed and released between two samples is reported held by the next
 * sample, so a short press is never lost. */
export class VirtualKeyState {
  private readonly held = new Set<number>();
  private readonly latched = new Set<number>();

  press(key: number): void {
    this.held.add(key);
    this.latched.add(key);
  }
  release(key: number): void {
    this.held.delete(key);
  }
  /** Focus loss: no key stays held. */
  releaseAll(): void {
    this.held.clear();
  }
  /** Keys held now or pressed since the previous sample. */
  sample(): Set<number> {
    const down = new Set([...this.held, ...this.latched]);
    this.latched.clear();
    return down;
  }
}
