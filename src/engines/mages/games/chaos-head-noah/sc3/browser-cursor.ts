import {PeCursorReader} from '../../../../../formats/pe/cursor.js';
import type {NoahCursor, NoahCursorImage} from './cursor.js';

export interface NoahCursorResources {
  normal: Uint8Array;
  active: Uint8Array;
}
/** SHA-256 of reconstructed CUR contents verified against 140060b40's loads.
 * Resource IDs 111/108 identify the reference build, not other PE layouts. */
export const NOAH_CURSOR_HASHES = {
  normal: '2ad978eec20a37b0a9a0c69933c1067e591c57ab3bc99c7cdaf57ad36dadcc3a',
  active: '34dcb98309affed05533a0e3c244bdf669e85bb513988e79bf7afc2dc71db5d5',
} as const;
export async function readNoahCursors(executable: Uint8Array): Promise<NoahCursorResources> {
  const reader = new PeCursorReader(executable);
  const read = async (role: keyof NoahCursorResources) => {
    const cursor = await reader.readByHash(NOAH_CURSOR_HASHES[role]);
    if (!cursor)
      throw new Error(
        `The game executable is missing the known ${role} cursor (${NOAH_CURSOR_HASHES[role]})`,
      );
    if (cursor.kind !== 'static') throw new Error(`Unexpected animated Noah ${role} cursor`);
    return cursor.bytes;
  };
  const [normal, active] = await Promise.all([read('normal'), read('active')]);
  return {normal, active};
}

/** Cursor images are optional presentation data, as for BGI: a missing executable or
 * unrecognised cursor resources are reported and the system cursor stands in. */
export async function readOptionalNoahCursors(
  executable: Promise<Uint8Array> | undefined,
): Promise<NoahCursorResources | null> {
  if (!executable) {
    console.info('CHAOS;HEAD NOAH: no game executable selected; using the system cursor.');
    return null;
  }
  try {
    return await readNoahCursors(await executable);
  } catch (error) {
    console.info('CHAOS;HEAD NOAH: game cursors unavailable; using the system cursor.', error);
    return null;
  }
}

/** Browser SetCursor boundary. CUR retains the executable's hotspot and mask;
 * its OS-sized image is independent of the framebuffer's CSS scaling.
 * Without resources every image presents as the system arrow. */
export class BrowserNoahCursor {
  private readonly urls: Record<'normal' | 'active', string> | null = null;
  private readonly original: string;
  private current: NoahCursor | undefined;
  private disposed = false;
  private readonly show = (image: NoahCursorImage) => {
    this.element.style.cursor =
      image === 'system' || !this.urls ? 'default' : `url("${this.urls[image]}"), default`;
  };
  constructor(
    readonly element: HTMLElement,
    resources: NoahCursorResources | null,
  ) {
    this.original = element.style.cursor;
    if (!resources) return;
    const normal = URL.createObjectURL(
      new Blob([resources.normal.slice().buffer], {type: 'image/x-icon'}),
    );
    try {
      this.urls = {
        normal,
        active: URL.createObjectURL(
          new Blob([resources.active.slice().buffer], {type: 'image/x-icon'}),
        ),
      };
    } catch (error) {
      URL.revokeObjectURL(normal);
      throw error;
    }
  }
  bind(cursor: NoahCursor): void {
    if (this.disposed) throw new Error('Cursor presenter is disposed');
    this.clear();
    this.current = cursor;
    cursor.onChange = this.show;
    this.show(cursor.current);
  }
  clear(): void {
    if (this.current?.onChange === this.show) this.current.onChange = undefined;
    this.current = undefined;
    this.element.style.cursor = this.original;
  }
  dispose(): void {
    if (this.disposed) return;
    this.clear();
    this.disposed = true;
    if (!this.urls) return;
    URL.revokeObjectURL(this.urls.normal);
    URL.revokeObjectURL(this.urls.active);
  }
}
