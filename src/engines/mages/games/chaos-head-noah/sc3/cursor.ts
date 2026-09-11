import type {NoahState} from './noah-state.js';

export type NoahCursorImage = 'normal' | 'active' | 'system';
/** Noah's two SetCursor callbacks (140061f30/40), not a generic hover policy. */
export class NoahCursor {
  private image: NoahCursorImage = 'normal';
  onChange: ((image: NoahCursorImage) => void) | undefined;
  constructor(readonly state: NoahState) {}
  get current(): NoahCursorImage {
    return this.image;
  }
  private select(image: NoahCursorImage): void {
    this.image = image;
    this.onChange?.(image);
  }
  activate(): void {
    this.select('active');
  }
  useSystem(): void {
    this.select('system');
  }
  /** 140062ee0 runs before 14001e090 publishes this tick's pointer availability.
   * An inactive grid preserves the hover latch; a previous hit suppresses the
   * normal callback for one pass, while the drag byte forces the active one. */
  prepare(): void {
    const s = this.state;
    if (!s.bytes(0x17add76, 1)[0]) return;
    if (s.bytes(0x17add73, 1)[0]) this.activate();
    else if (!s.bytes(0x17add72, 1)[0]) this.select('normal');
    s.put(0x17add72, 0, 1);
  }
}
