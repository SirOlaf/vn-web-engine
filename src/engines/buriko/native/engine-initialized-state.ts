/** The distinct 1E8B78 engine lifecycle bit read by the main-window procedure.
 * The complete C3900 owner calls completeStartup only after its ordered initializer legs;
 * a constructed window, display device, or resource worker does not publish this bit. */
export class BurikoEngineInitializedState {
  private value = false;

  get initialized(): boolean {
    return this.value;
  }

  /** C3900 returns its grouped initializer result, while the published bit additionally
   * depends on B8190. Native calls B8190 only when that grouped result is nonzero. */
  completeStartup(groupedResult: 0 | 1, finalCondition: () => number): 0 | 1 {
    this.value = false;
    if (groupedResult !== 0) this.value = finalCondition() !== 0;
    return groupedResult;
  }

  /** F41A0 clears 1E8B78 before MF close, worker shutdown, or any awaited teardown. */
  clearAtTeardownIngress(): void {
    this.value = false;
  }
}
