import type {AsbTag} from '../../formats/artemis/asb.js';
import type {WindowCaptionHost} from '../../platform/window-caption.js';

/** UTF-8 caption command (0x1400c9870): absent data clears the selected caption.
 * Native ignores SetWindowTextW's result; legacy ANSI conversion requires an owner.
 */
export class ArtemisCaption {
  constructor(private readonly window: WindowCaptionHost) {}
  dispatch(tag: AsbTag): boolean {
    if (tag.name !== 'caption') return false;
    this.window.setCaption((tag.args.get('data') ?? '').split('\0', 1)[0]!);
    return true;
  }
}
