/** CObjectManager +B8, entered by 06e440 and left by 06e420. */
export class BurikoDisplayCriticalSection {
  private ownerValue: object | null = null;
  private depthValue = 0;

  constructor(private readonly currentActor: () => object) {}

  get owner(): object | null {
    return this.ownerValue;
  }
  get depth(): number {
    return this.depthValue;
  }
  enter(): void {
    const actor = this.currentActor();
    if (this.ownerValue !== null && this.ownerValue !== actor)
      throw new Error('Buriko object-manager lock requires its owning actor to resume');
    this.ownerValue = actor;
    this.depthValue++;
  }
  leave(): void {
    if (this.depthValue === 0 || this.ownerValue !== this.currentActor())
      throw new Error('Buriko object-manager lock is not owned by its current actor');
    if (--this.depthValue === 0) this.ownerValue = null;
  }
  /** Synchronous cooperative slices retain native recursive ownership across callbacks. */
  run<T>(body: () => T): T {
    this.enter();
    try {
      return body();
    } finally {
      this.leave();
    }
  }
}
