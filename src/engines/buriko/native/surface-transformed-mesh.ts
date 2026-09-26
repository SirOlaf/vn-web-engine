import {drawBurikoTransformedMesh} from './bitmap-transformed-mesh.js';
import type {BurikoMeshGeometry} from './bitmap-mesh.js';
import type {BurikoSurfaces} from './surfaces.js';

export interface BurikoSurfaceMeshParameters extends Omit<BurikoMeshGeometry, 'source'> {
  readonly destination: number;
  readonly source: number;
  readonly mode: number;
  readonly transparency: number;
}
/** 032CE0 snapshots the destination before the source, then ignores draw status. */
export function drawBurikoSurfaceTransformedMesh(
  surfaces: BurikoSurfaces,
  parameters: BurikoSurfaceMeshParameters,
): 0 | 0x80000009 | 0x8000000a {
  const destination = surfaces.snapshot(parameters.destination);
  if (destination === null) return 0x80000009;
  const source = surfaces.snapshot(parameters.source);
  if (source === null) return 0x8000000a;
  drawBurikoTransformedMesh(
    surfaces.compositor,
    destination,
    {...parameters, source},
    parameters.mode,
    parameters.transparency,
  );
  return 0;
}
