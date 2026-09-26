import type {AokanaBitmap} from './bitmap.js';
import type {AokanaBitmapCompositor} from './bitmap-compositor.js';
import {clearAokanaBitmap} from './bitmap-copy.js';
import {
  buildAokanaMeshVertices,
  buildAokanaMeshScanlines,
  drawAokanaBitmapMesh,
  type AokanaMeshGeometry,
} from './bitmap-mesh.js';

/** 0449C0 owns the geometry/scanline lifetime and mode-zero empty-mesh clear. */
export function drawAokanaTransformedMesh(
  compositor: AokanaBitmapCompositor,
  destination: AokanaBitmap,
  geometry: AokanaMeshGeometry,
  mode: number,
  transparency: number,
): void {
  const mesh = buildAokanaMeshScanlines(buildAokanaMeshVertices(geometry), destination.height);
  if (mesh !== null) {
    drawAokanaBitmapMesh(
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
  } else if ((mode | 0) === 0) clearAokanaBitmap(destination);
}
