import type {BurikoBitmap} from './bitmap.js';
import type {BurikoBitmapCompositor} from './bitmap-compositor.js';
import {clearBurikoBitmap} from './bitmap-copy.js';
import {
  buildBurikoMeshVertices,
  buildBurikoMeshScanlines,
  drawBurikoBitmapMesh,
  type BurikoMeshGeometry,
} from './bitmap-mesh.js';

/** 0449C0 owns the geometry/scanline lifetime and mode-zero empty-mesh clear. */
export function drawBurikoTransformedMesh(
  compositor: BurikoBitmapCompositor,
  destination: BurikoBitmap,
  geometry: BurikoMeshGeometry,
  mode: number,
  transparency: number,
): void {
  const mesh = buildBurikoMeshScanlines(buildBurikoMeshVertices(geometry), destination.height);
  if (mesh !== null) {
    drawBurikoBitmapMesh(
      compositor,
      destination,
      geometry.source,
      mesh.records,
      mesh.firstRow,
      0,
      mode,
      transparency,
      true,
    );
  } else if ((mode | 0) === 0) clearBurikoBitmap(destination);
}
