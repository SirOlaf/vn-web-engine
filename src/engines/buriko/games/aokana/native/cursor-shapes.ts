import {PeCursorReader} from '../../../../../formats/pe/cursor.js';
import type {AokanaNativeCursor} from './engine-dialogs.js';
import type {AokanaWindowMessages} from './window-messages.js';

/** C3C50 loads the executable's actual group106; absent LoadCursor remains null. */
export function readAokanaCursorResource(executable: Uint8Array): Uint8Array | null {
  const resource = new PeCursorReader(executable).read(106);
  if (resource === undefined) return null;
  if (resource.kind !== 'static')
    throw new Error('Aokana cursor resource106 requires a static browser CUR profile');
  return resource.bytes;
}

/** Five native handles share the same physical cursor used by modal/auto-hide owners. */
export class AokanaCursorShapes {
  private selected = 0;
  private readonly resourceUrl: string | null;
  private readonly pointer = () => {
    this.messages.send(this.messages.mainTarget(), 0x20, 0, 0x02000001);
  };
  constructor(
    readonly physical: AokanaNativeCursor,
    readonly messages: AokanaWindowMessages,
    resource: Uint8Array | null,
  ) {
    this.resourceUrl =
      resource === null
        ? null
        : URL.createObjectURL(new Blob([resource.slice().buffer], {type: 'image/x-icon'}));
    physical.surface.addEventListener('pointerenter', this.pointer);
    physical.surface.addEventListener('pointermove', this.pointer);
  }

  /** E8500 only stores the index. The next actual WM_SETCURSOR applies it. */
  select(index: number): void {
    if (index >>> 0 >= 5) throw new RangeError('Aokana cursor index exceeds five native handles');
    this.selected = index >>> 0;
  }

  /** FF770: null handle entries do not call SetCursor and do not imply hidden. */
  applySelected(): void {
    if (this.selected === 0) this.physical.setShape('default');
    else if (this.selected === 1 && this.resourceUrl !== null)
      this.physical.setShape(`url("${this.resourceUrl}"), default`);
  }

  /** C3CB0 registers IDC_ARROW. FF770 falls through to DefWindowProc even after
   * its explicit SetCursor, so the scoped client surface ends with the class arrow. */
  defaultClientCursor(hitTest: number): 1 {
    if (hitTest !== 1)
      throw new Error('Aokana browser cursor profile requires the scoped client area');
    this.physical.setShape('default');
    return 1;
  }

  dispose(): void {
    this.physical.surface.removeEventListener('pointerenter', this.pointer);
    this.physical.surface.removeEventListener('pointermove', this.pointer);
    this.physical.setShape('');
    if (this.resourceUrl !== null) URL.revokeObjectURL(this.resourceUrl);
  }
}
