import {pointerView, type BurikoBpPointer} from '../bp/memory.js';
import type {BurikoTextLayoutState} from './text-layout-state.js';

/**034c50: ADDSS then CVTTSS2SI32 for A/C, CVTTSS2SI64 (low DWORD) for B. */
function roundedMetric(value: number, wide: boolean): number {
  const rounded = Math.fround(Math.fround(value) + 0.5),
    integer = Math.trunc(rounded);
  if (wide) {
    if (!Number.isFinite(integer) || integer < -(2 ** 63) || integer >= 2 ** 63) return 0;
    return Number(BigInt.asUintN(32, BigInt(integer)));
  }
  return !Number.isFinite(integer) || integer < -2147483648 || integer > 2147483647
    ? -2147483648
    : integer;
}

/** Actual registered cached glyph metrics, with native nullable count/output behavior. */
export async function collectBurikoRegisteredTextAbc(
  state: BurikoTextLayoutState,
  output: BurikoBpPointer | null,
  count: BurikoBpPointer | null,
  source: BurikoBpPointer | null,
  registered: number,
  size: number,
  width: number,
  bold: number,
): Promise<number> {
  const fonts = state.surfaces.fonts,
    selected = await fonts.get(fonts.name(registered), size, width, bold);
  if (selected.result === 0x80000002) return 0x80000001;
  if (selected.result === 0x80000003) return 0x80000002;
  if (selected.result === 0x80000004) return 0x80000003;
  if (selected.result !== 0)
    throw new Error('Buriko registered ABC query returns an unwritten native font status');
  if (source === null) throw new Error('Buriko registered ABC query reads null text');
  const wide = state.text.decodeAuto(source),
    font = fonts.find(selected.id);
  if (font === null) throw new Error('Buriko registered ABC query has no published font');
  let written = 0;
  for (let index = 0; index < wide.length; index++) {
    const code = wide.charCodeAt(index);
    if (code === 0) break;
    if (output !== null) {
      if (font.raster === null)
        throw new Error('Buriko ABC query reads undefined native glyph cache');
      const abc = font.raster.glyph(code).abc;
      const address = {bytes: output.bytes, offset: output.offset + written * 12};
      // Native publishes A before B/C; preserve access/write ordering.
      pointerView(address, 4).setInt32(0, roundedMetric(abc[0], false), true);
      pointerView({bytes: output.bytes, offset: address.offset + 4}, 4).setUint32(
        0,
        roundedMetric(abc[1], true),
        true,
      );
      pointerView({bytes: output.bytes, offset: address.offset + 8}, 4).setInt32(
        0,
        roundedMetric(abc[2], false),
        true,
      );
      written = (written + 1) >>> 0;
    }
  }
  if (count !== null) pointerView(count, 4).setUint32(0, written, true);
  return 0;
}
