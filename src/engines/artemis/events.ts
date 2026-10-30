export const ARTEMIS_EVENTS = [
  'onEnterFrame',
  'onClickWaitIn',
  'onClickWaitOut',
  'onSave',
  'onLoad',
  'onInputEvent',
  'onDebugSkipOut',
] as const;
export type ArtemisEvent = (typeof ARTEMIS_EVENTS)[number];

/** Native 0x140133730 copies recognized callback names; registrations are patches. */
export class ArtemisEvents {
  private readonly handlers = new Map<ArtemisEvent, string>();
  constructor(private readonly invoke: (name: string, args: ReadonlyMap<string, string>) => void) {}
  register(entries: Iterable<readonly [string, string]>): void {
    for (const [name, callback] of entries) {
      const event = name === 'onClickWait' ? 'onClickWaitIn' : name;
      if ((ARTEMIS_EVENTS as readonly string[]).includes(event))
        this.handlers.set(event as ArtemisEvent, callback);
    }
  }
  /** bf210 empties every callback name (3d98..3e58). */
  clear(): void {
    this.handlers.clear();
  }
  /** Scenario archive sections 0x22, 0x26, 0x32, 0x45, 0x46, 0x54, 0x50: the callback
   * names at +0x3d98..+0x3e58, which follow `ARTEMIS_EVENTS` order. */
  saveFields(): string[] {
    return ARTEMIS_EVENTS.map((event) => this.handler(event));
  }
  /** Loader reads assign the present names. */
  loadFields(names: readonly (string | undefined)[]): void {
    names.forEach((name, index) => {
      if (name === undefined) return;
      const event = ARTEMIS_EVENTS[index];
      if (!event) throw Error('Unsupported Artemis saved event name');
      this.handlers.set(event, name);
    });
  }
  handler(event: ArtemisEvent): string {
    return this.handlers.get(event) ?? '';
  }
  /** Frame/input/save owners decide when to emit; this object does not create a scheduler. */
  emit(event: ArtemisEvent, args: ReadonlyMap<string, string> = new Map()): boolean {
    const callback = this.handler(event);
    if (!callback) return false;
    try {
      this.invoke(callback, args);
    } catch (error) {
      this.fail(event);
      throw error;
    }
    return true;
  }
  /** `emit` through an owner-supplied invoker that can wait for resource work a callback
   * starts (native loads it synchronously inside the call). */
  async emitAsync(
    event: ArtemisEvent,
    args: ReadonlyMap<string, string>,
    invoke: (name: string, args: ReadonlyMap<string, string>) => Promise<void>,
  ): Promise<boolean> {
    const callback = this.handler(event);
    if (!callback) return false;
    try {
      await invoke(callback, args);
    } catch (error) {
      this.fail(event);
      throw error;
    }
    return true;
  }
  /** Native frame/wait, save and load owners disable their failed callback. An owner that
   * resumes a callback after resource work reports its failure here. */
  fail(event: ArtemisEvent): void {
    if (
      event === 'onEnterFrame' ||
      event === 'onClickWaitIn' ||
      event === 'onClickWaitOut' ||
      event === 'onSave' ||
      event === 'onLoad'
    )
      this.handlers.set(event, '');
  }
}
