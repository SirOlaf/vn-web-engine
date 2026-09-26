import {pointerView, type BurikoBpPointer} from '../bp/memory.js';
import {measureBurikoHorizontalWideText} from './text-layout-horizontal.js';
import type {BurikoTextLayoutState} from './text-layout-state.js';

/** 034DB0/035840: registered font lookup precedes conversion, measurement and output publication. */
export async function measureBurikoRegisteredText(
  state: BurikoTextLayoutState,
  output: BurikoBpPointer | null,
  source: BurikoBpPointer | null,
  registeredFont: number,
  size: number,
  width: number,
  bold: number,
  proportional: number,
): Promise<number> {
  const operationAllocator = state.surfaces.allocator,
    operationActor = operationAllocator.currentActor;
  const runAsActor = <T>(operation: () => T): T =>
    operationAllocator.withActor(operationActor, operation);

  const fonts = state.surfaces.fonts;
  const selected = await fonts.get(fonts.name(registeredFont), size, width, bold);
  if (selected.result === 0x80000002) return 0x80000001;
  if (selected.result === 0x80000003) return 0x80000002;
  if (selected.result === 0x80000004) return 0x80000003;
  if (selected.result !== 0)
    throw new Error('Buriko registered text measurement returns an unwritten native font status');
  if (source === null) throw new Error('Buriko registered text measurement reads null text');
  const wide = state.text.decodeAuto(source),
    font = fonts.find(selected.id);
  if (font === null) throw new Error('Buriko registered text measurement has no published font');
  const measured = runAsActor(() =>
    measureBurikoHorizontalWideText(state, wide, font, proportional),
  );
  if (output === null) throw new Error('Buriko registered text measurement writes through null');
  pointerView(output, 4).setInt32(0, measured.withoutLastBearing, true);
  return 0;
}
