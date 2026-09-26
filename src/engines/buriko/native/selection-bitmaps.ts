import {pointerView, type BurikoBpPointer} from '../bp/memory.js';
import type {BurikoWindowDisplayObject} from './display-window.js';

/** 07BE30: live 16-byte records, with the initial text inset retained across draws. */
export function drawBurikoSelectionBitmaps(
  window: BurikoWindowDisplayObject,
  count: number,
  records: BurikoBpPointer | null,
): void {
  window.clearText();
  const inset = window.getTextRectangle(),
    scratch = {...inset},
    manager = window.windowState.manager;
  for (let index = 0; index < count; index++) {
    if (records === null) throw new Error('Buriko bitmap selection reads null records');
    const record = {bytes: records.bytes, offset: records.offset + index * 16},
      source = manager.surfaces.snapshot(pointerView(record, 12).getInt32(8, true));
    if (source === null) continue;
    const y = pointerView(record, 8).getInt32(4, true),
      x = pointerView(record, 4).getInt32(0, true);
    window.drawTextBitmap(scratch, (x + inset.left) | 0, (y + inset.top) | 0, source, 0, 0);
  }
  const rectangle = window.textBitmapRectangle();
  window.environment.damage.record(window.sortKey(), rectangle);
}
