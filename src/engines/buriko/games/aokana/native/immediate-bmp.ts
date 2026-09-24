import {type AokanaBpPointer} from '../bp/memory.js';
import {importAokanaWindowsBitmap} from './bitmap-image.js';
import type {AokanaProgramResources} from './program-resources.js';
import type {AokanaSurfaces} from './surfaces.js';
import {textBytes} from './text.js';

/** 037170 passes a null ROOT to BDA60, independently of all configured resource roots. */
export async function loadAokanaImmediateBmp(
  surfaces: AokanaSurfaces,
  resources: AokanaProgramResources,
  surface: number,
  name: AokanaBpPointer | null,
): Promise<number> {
  const operationAllocator = surfaces.allocator,
    operationActor = operationAllocator.currentActor;
  const runAsActor = <T>(operation: () => T): T =>
    operationAllocator.withActor(operationActor, operation);

  if (name === null) throw new Error('Aokana immediate BMP load dereferences a null filename');
  const loaded = await runAsActor(() => resources.partialLoose(null, textBytes(name, true), 0, 0));
  if (loaded.result !== 0) return 0xffffffff;
  if (loaded.bytes === null)
    throw new Error('Aokana successful BMP resource lacks its output bytes');
  if (loaded.bytes.length === 0) return 0xffffffff;
  return runAsActor(() => importAokanaWindowsBitmap(surfaces, surface, loaded.bytes));
}
