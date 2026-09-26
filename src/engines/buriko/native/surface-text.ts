import type {BurikoBpPointer} from '../bp/memory.js';
import {BurikoBitmapText} from './font-bitmap.js';
import type {BurikoSurfaces} from './surfaces.js';

export interface BurikoSurfaceTextArguments {
  surface: number;
  x: number;
  y: number;
  source: BurikoBpPointer | null;
  registeredFont: number;
  size: number;
  width: number;
  bold: number;
  proportional: number;
  color: number;
  wrap: number;
  linePercent: number;
}

/** 035750/035650 retain the surface snapshot before the actual registered font lookup. */
export async function drawBurikoSurfaceText(
  surfaces: BurikoSurfaces,
  arguments_: BurikoSurfaceTextArguments,
): Promise<{status: number; metric?: number}> {
  const operationAllocator = surfaces.allocator,
    operationActor = operationAllocator.currentActor;
  const runAsActor = <T>(operation: () => T): T =>
    operationAllocator.withActor(operationActor, operation);

  const bitmap = surfaces.snapshot(arguments_.surface);
  if (bitmap === null) return {status: 0x80000004};
  const font = await surfaces.fonts.get(
    surfaces.fonts.name(arguments_.registeredFont),
    arguments_.size,
    arguments_.width,
    arguments_.bold,
  );
  if (font.result === 0x80000002) return {status: 0x80000001};
  if (font.result === 0x80000003) return {status: 0x80000002};
  if (font.result === 0x80000004) return {status: 0x80000003};
  if (font.result !== 0)
    throw new Error('Buriko surface text returns an unwritten native font status');
  let metric: number | undefined;
  const output = {
    get value(): number {
      if (metric === undefined) throw new Error('Buriko surface text reads an unwritten metric');
      return metric;
    },
    set value(value: number) {
      metric = value;
    },
  };
  runAsActor(() =>
    new BurikoBitmapText(surfaces.fonts, surfaces.compositor).draw(
      bitmap,
      output,
      arguments_.x,
      arguments_.y,
      arguments_.source,
      font.id,
      arguments_.color,
      0,
      arguments_.proportional,
      arguments_.wrap,
      arguments_.linePercent,
    ),
  );
  if (metric === undefined)
    throw new Error('Buriko surface text consumes an unpublished native metric');
  return {status: 0, metric};
}
