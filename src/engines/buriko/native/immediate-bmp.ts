import {type BurikoBpPointer} from '../bp/memory.js';
import {importBurikoWindowsBitmap} from './bitmap-image.js';
import type {BurikoProgramResources} from './program-resources.js';
import type {BurikoSurfaces} from './surfaces.js';
import {textBytes} from './text.js';

/** 037170 passes a null ROOT to BDA60, independently of all configured resource roots. */
export async function loadBurikoImmediateBmp(
  surfaces: BurikoSurfaces,
  resources: BurikoProgramResources,
  surface: number,
  name: BurikoBpPointer | null,
): Promise<number> {
  const operationAllocator = surfaces.allocator,
    operationActor = operationAllocator.currentActor;
  const runAsActor = <T>(operation: () => T): T =>
    operationAllocator.withActor(operationActor, operation);

  if (name === null) throw new Error('Buriko immediate BMP load dereferences a null filename');
  const loaded = await runAsActor(() => resources.partialLoose(null, textBytes(name, true), 0, 0));
  if (loaded.result !== 0) return 0xffffffff;
  const bytes = loaded.bytes;
  if (bytes === null) throw new Error('Buriko successful BMP resource lacks its output bytes');
  if (bytes.length === 0) return 0xffffffff;
  return runAsActor(() => importBurikoWindowsBitmap(surfaces, surface, bytes));
}
