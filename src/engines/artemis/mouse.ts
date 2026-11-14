import type {CursorHost} from '../../input/cursor-host.js';
import type {AsbTag} from '../../formats/artemis/asb.js';

function atoi(value: string): number {
  const token = /^[\t\n\v\f\r ]*([+-]?\d+)/.exec(value);
  const number = token ? Number(token[1]) : 0;
  if (!Number.isSafeInteger(number) || number < -0x80000000 || number > 0x7fffffff)
    throw new Error('Unsupported Artemis mouse integer');
  return number;
}

/** 0x1400c9dc0 mouse command and 0x1400c0560 auto-hide deadline.
 * Pointer activity/reset must be supplied by the native window/input owner.
 */
export class ArtemisMouse {
  explicitHidden = false;
  autoHideMilliseconds = 0;
  private activityTick = 0;
  constructor(
    private readonly cursor: CursorHost,
    private readonly now: () => number,
  ) {}
  dispatch(tag: AsbTag): boolean {
    if (tag.name !== 'mouse') return false;
    const p = tag.args;
    if (p.has('left') && p.has('top'))
      this.cursor.setPosition(atoi(p.get('left')!), atoi(p.get('top')!));
    if (p.has('hide')) {
      this.explicitHidden = p.get('hide') !== '0';
      this.cursor.setVisible(!this.explicitHidden);
    }
    if (p.has('autohide')) {
      this.autoHideMilliseconds = atoi(p.get('autohide')!);
      if (!this.autoHideMilliseconds) this.cursor.setVisible(true);
      else this.activityTick = this.now() >>> 0;
    }
    return true;
  }
  tick(now: number): void {
    if (
      this.autoHideMilliseconds &&
      this.activityTick &&
      this.autoHideMilliseconds >>> 0 <= ((now >>> 0) - this.activityTick) >>> 0
    ) {
      this.cursor.setVisible(false);
      this.activityTick = 0;
    }
  }
}
