import type {BurikoBpAbi} from '../bp/abi.js';
import {withBurikoBitmapText} from './bitmap-dom-text.js';
import {nativeMeshSineCosine} from '../bp/opcodes/native-math.js';
import {roundToInt32} from '../bp/opcodes/fixed.js';
import {bitmapStorage, type BurikoBitmap, type BurikoBitmapRectangle} from './bitmap.js';
import {bitmapRead32, bitmapWrite32} from './bitmap-scalar.js';
import type {BurikoBitmapCompositor} from './bitmap-compositor.js';
import {runBurikoBitmapMeshOperation} from './bitmap-operation-jobs.js';
import {burikoRosettaSseReciprocal} from './cpu-numerical-profile.js';

const f32 = Math.fround;
const meshEpsilon = 2 ** -14;
const rotationOrders = ['phb', 'pbh', 'hpb', 'hbp', 'bph', 'bhp'] as const;

export interface BurikoMeshVertex {
  readonly x: number;
  readonly y: number;
  readonly q: number;
  readonly uq: number;
  readonly vq: number;
}

export interface BurikoMeshGeometry {
  readonly destinationPivotX: number;
  readonly destinationPivotY: number;
  readonly source: BurikoBitmap;
  readonly sourcePivotX: number;
  readonly sourcePivotY: number;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly translationX: number;
  readonly translationY: number;
  readonly translationZ: number;
  readonly pitch: number;
  readonly heading: number;
  readonly bank: number;
  readonly rotationOrder: number;
  readonly perspective: number;
}

export interface BurikoMeshScanline {
  readonly left: number;
  readonly right: number;
  readonly q: number;
  readonly uq: number;
  readonly vq: number;
  readonly dq: number;
  readonly duq: number;
  readonly dvq: number;
}

export interface BurikoMeshScanlineResult {
  readonly records: readonly BurikoMeshScanline[];
  readonly firstRow: number;
  readonly bounds: BurikoBitmapRectangle;
}

interface MeshEdge {
  index: number;
  x: number;
  q: number;
  uq: number;
  vq: number;
  dx: number;
  dq: number;
  duq: number;
  dvq: number;
}

interface MeshEndpoint {
  x: number;
  q: number;
  uq: number;
  vq: number;
}

type MeshWords = [number, number, number, number];

function cvttInt32(value: number): number {
  if (!Number.isFinite(value) || value < -0x80000000 || value >= 0x80000000) return -0x80000000;
  return Math.trunc(value) | 0;
}

function snapFloatNearInteger(value: number): number {
  value = f32(value);
  const floor = f32(Math.floor(value)),
    fraction = f32(value - floor),
    upper = f32(1 - f32(meshEpsilon));
  if (fraction >= upper) return f32(Math.ceil(value));
  if (fraction <= f32(meshEpsilon)) return floor;
  return value;
}

function snapDoubleNearInteger(value: number): number {
  const floor = Math.floor(value),
    fraction = value - floor,
    upper = 1 - meshEpsilon;
  if (fraction >= upper) return Math.ceil(value);
  if (fraction <= meshEpsilon) return floor;
  return value;
}

function wrapMeshVertex(index: number): number {
  if (index < 0) return index + 4;
  if (index >= 4) return index - 4;
  return index;
}

function mutableEndpoint(edge: MeshEdge): MeshEndpoint {
  return {x: edge.x, q: edge.q, uq: edge.uq, vq: edge.vq};
}

function resetEdge(edge: MeshEdge, vertex: BurikoMeshVertex): void {
  edge.x = vertex.x;
  edge.q = vertex.q;
  edge.uq = vertex.uq;
  edge.vq = vertex.vq;
}

function advanceEdgeSegment(
  edge: MeshEdge,
  direction: -1 | 1,
  vertices: readonly BurikoMeshVertex[],
  row: number,
  top: number,
  bottom: number,
): void {
  const edgeY = vertices[edge.index]!.y,
    nextRow = (row + 1) | 0;
  if (!(nextRow > edgeY) || row >= bottom) return;
  if (row !== top) {
    const distance = edgeY - row;
    edge.x += distance * edge.dx;
    edge.q += distance * edge.dq;
    edge.uq += distance * edge.duq;
    edge.vq += distance * edge.dvq;
  }

  let priorIndex = edge.index,
    reset = false;
  for (;;) {
    if (reset) resetEdge(edge, vertices[edge.index]!);
    priorIndex = edge.index;
    edge.index = wrapMeshVertex(edge.index + direction);
    const selectedY = vertices[edge.index]!.y;
    if (!(selectedY >= edgeY && selectedY < nextRow)) break;
    reset = true;
  }

  const prior = vertices[priorIndex]!,
    selected = vertices[edge.index]!,
    dy = f32(selected.y - prior.y);
  edge.dx = f32(selected.x - prior.x) / dy;
  edge.dq = f32(selected.q - prior.q) / dy;
  edge.duq = f32(selected.uq - prior.uq) / dy;
  edge.dvq = f32(selected.vq - prior.vq) / dy;
  const distance = nextRow - prior.y - 1;
  edge.x += distance * edge.dx;
  edge.q += distance * edge.dq;
  edge.uq += distance * edge.duq;
  edge.vq += distance * edge.dvq;
}

function signedWord(value: number): number {
  return (value << 16) >> 16;
}

function packedSignedWord(value: number): number {
  value |= 0;
  return Math.max(-0x8000, Math.min(0x7fff, value));
}

function multiplyHighSignedWord(left: number, right: number): number {
  return (Math.imul(signedWord(left), signedWord(right)) >> 16) & 0xffff;
}

function interpolateMeshWord(left: number, right: number, fraction: number): number {
  const difference = (right - left) & 0xffff,
    doubled = (difference << 1) & 0xffff;
  return (left + multiplyHighSignedWord(doubled, fraction)) & 0xffff;
}

function unpackMeshPixel(pixel: number): MeshWords {
  return [pixel & 255, (pixel >>> 8) & 255, (pixel >>> 16) & 255, pixel >>> 24];
}

function packMeshPixel(words: MeshWords): number {
  let pixel = 0;
  for (let channel = 0; channel < 4; channel++)
    pixel |= Math.min(255, Math.max(0, signedWord(words[channel]!))) << (channel * 8);
  return pixel >>> 0;
}

function interpolateMeshWords(left: MeshWords, right: MeshWords, fraction: number): MeshWords {
  return left.map((value, channel) =>
    interpolateMeshWord(value, right[channel]!, fraction),
  ) as MeshWords;
}

function meshReciprocal(value: number): number {
  const seed = burikoRosettaSseReciprocal(value),
    square = f32(seed * seed),
    doubled = f32(seed + seed);
  return f32(doubled - f32(square * value));
}

function meshCoordinate(attribute: number, reciprocal: number): number {
  return roundToInt32(f32(f32(reciprocal * attribute) * 65536));
}

function sampleBurikoMesh(
  source: BurikoBitmap,
  q: number,
  uq: number,
  vq: number,
): {words: MeshWords; sampled: boolean; alphaPresent: boolean} {
  const reciprocal = meshReciprocal(q),
    x = meshCoordinate(uq, reciprocal),
    y = meshCoordinate(vq, reciprocal),
    xInteger = x >> 16,
    yInteger = y >> 16,
    xFraction = (x & 0xffff) >>> 1,
    yFraction = (y & 0xffff) >>> 1,
    packedX = packedSignedWord(xInteger),
    packedY = packedSignedWord(yInteger),
    base =
      source.offset + ((Math.imul(packedX, 4) + Math.imul(packedY, signedWord(source.stride))) | 0),
    width = source.width >>> 0,
    height = source.height >>> 0;
  let sampled = false;
  const read = (offset: number, sx: number, sy: number): MeshWords => {
    if (sx >>> 0 >= width || sy >>> 0 >= height) return [0, 0, 0, 0];
    sampled = true;
    return unpackMeshPixel(bitmapRead32(source, offset));
  };
  const top = interpolateMeshWords(
      read(base, xInteger, yInteger),
      read(base + 4, (xInteger + 1) | 0, yInteger),
      xFraction,
    ),
    bottom = interpolateMeshWords(
      read(base + source.stride, xInteger, (yInteger + 1) | 0),
      read(base + source.stride + 4, (xInteger + 1) | 0, (yInteger + 1) | 0),
      xFraction,
    );
  return {
    words: interpolateMeshWords(top, bottom, yFraction),
    sampled,
    alphaPresent: (top[3] | bottom[3]) !== 0,
  };
}

function blendMeshRgb(source: MeshWords, destination: MeshWords, transparency: number): MeshWords {
  const coefficient = ((transparency & 0xffff) << 4) & 0xffff;
  return source.map((value, channel) => {
    const difference = (destination[channel]! - value) & 0xffff,
      shifted = (difference << 4) & 0xffff;
    return (value + multiplyHighSignedWord(shifted, coefficient)) & 0xffff;
  }) as MeshWords;
}

function blendMeshAlpha(
  source: MeshWords,
  destination: MeshWords,
  transparency: number,
): MeshWords {
  const factor = (0x100 - (transparency & 0xffff)) & 0xffff,
    coefficient = Math.imul(source[3], factor) & 0xffff;
  return source.map((value, channel) => {
    const difference = (value - destination[channel]!) & 0xffff,
      doubled = (difference << 1) & 0xffff;
    return (destination[channel]! + multiplyHighSignedWord(doubled, coefficient >>> 1)) & 0xffff;
  }) as MeshWords;
}

function clearMeshSpan(bitmap: BurikoBitmap, row: number, first: number, end: number): void {
  const count = end - first;
  if (count <= 0) return;
  const offset = bitmap.offset + row * bitmap.stride + first * 4,
    length = count * 4,
    storage = bitmapStorage(bitmap, offset, length, false);
  storage.bytes.fill(0, offset, offset + length);
  storage.written(offset, length);
}

type MeshPixelMode = 'copy' | 'rgb' | 'alpha';

function rasterizeBurikoMesh(
  destination: BurikoBitmap,
  source: BurikoBitmap,
  records: readonly BurikoMeshScanline[],
  firstRow: number,
  xOffset: number,
  transparency: number,
  pixelMode: MeshPixelMode,
): void {
  const count = records.length | 0;
  if (pixelMode !== 'copy' && count === 0) return;
  const width = destination.width | 0,
    height = destination.height | 0;
  firstRow |= 0;
  xOffset |= 0;
  if (pixelMode === 'copy' && firstRow > 0)
    for (let row = 0; row < Math.min(firstRow, height); row++)
      clearMeshSpan(destination, row, 0, width);

  const start = Math.max(firstRow, 0),
    end = count < 1 ? 0 : Math.min((firstRow + count) | 0, height);
  for (let row = start; row < end; row++) {
    const record = records[row - firstRow];
    if (record === undefined)
      throw new RangeError('Buriko mesh rasterizer is missing a native scanline record');
    const left = (record.left + xOffset) | 0,
      right = (record.right + xOffset) | 0;
    if (left > right || left >= width || right < 0) {
      if (pixelMode === 'copy') clearMeshSpan(destination, row, 0, width);
      continue;
    }

    let q = f32(record.q),
      uq = f32(record.uq),
      vq = f32(record.vq);
    const dq = f32(record.dq),
      duq = f32(record.duq),
      dvq = f32(record.dvq);
    let first = left;
    if (left < 1) {
      first = 0;
      const skipped = f32(left);
      q = f32(q - f32(skipped * dq));
      uq = f32(uq - f32(skipped * duq));
      vq = f32(vq - f32(skipped * dvq));
    } else if (pixelMode === 'copy') clearMeshSpan(destination, row, 0, left);
    const last = Math.min((right + 1) | 0, width);
    for (let column = first; column < last; column++) {
      const sample = sampleBurikoMesh(source, q, uq, vq),
        offset = destination.offset + row * destination.stride + column * 4;
      if (pixelMode === 'copy') bitmapWrite32(destination, offset, packMeshPixel(sample.words));
      else if (pixelMode === 'rgb') {
        if (sample.sampled)
          bitmapWrite32(
            destination,
            offset,
            packMeshPixel(
              blendMeshRgb(
                sample.words,
                unpackMeshPixel(bitmapRead32(destination, offset)),
                transparency,
              ),
            ),
          );
      } else if (sample.alphaPresent)
        bitmapWrite32(
          destination,
          offset,
          packMeshPixel(
            blendMeshAlpha(
              sample.words,
              unpackMeshPixel(bitmapRead32(destination, offset)),
              transparency,
            ),
          ),
        );
      q = f32(q + dq);
      uq = f32(uq + duq);
      vq = f32(vq + dvq);
    }
    if (pixelMode === 'copy' && last < width) clearMeshSpan(destination, row, last, width);
  }

  if (pixelMode === 'copy' && end < height && firstRow < height)
    for (let row = Math.max(end, 0); row < height; row++) clearMeshSpan(destination, row, 0, width);
}

/** 0436B0 builds and transforms four float vertices in the selected phb rotation order. */
export function buildBurikoMeshVertices(
  geometry: BurikoMeshGeometry,
  revision?: BurikoBpAbi['revision'],
): readonly BurikoMeshVertex[] {
  const scaleX = (geometry.scaleX >>> 0) * 2 ** -16,
    scaleY = (geometry.scaleY >>> 0) * 2 ** -16,
    pivotX = (geometry.sourcePivotX | 0) * 2 ** -16 * scaleX,
    pivotY = (geometry.sourcePivotY | 0) * 2 ** -16 * scaleY,
    sourceRight = (geometry.source.width - 1) >>> 0,
    sourceBottom = (geometry.source.height - 1) >>> 0,
    right = sourceRight * scaleX - pivotX,
    bottom = sourceBottom * scaleY - pivotY,
    u = f32(sourceRight),
    v = f32(sourceBottom);
  const initial: [number, number, number, number, number][] = [
    [f32(-pivotX), f32(-pivotY), 0, 0, 0],
    [f32(-pivotX), f32(bottom), 0, 0, v],
    [f32(right), f32(bottom), 0, u, v],
    [f32(right), f32(-pivotY), 0, u, 0],
  ];
  const angles = {
      p: nativeMeshSineCosine(geometry.pitch, true, revision),
      h: nativeMeshSineCosine(geometry.heading, false, revision),
      b: nativeMeshSineCosine(geometry.bank, true, revision),
    },
    order = rotationOrders[(geometry.rotationOrder >>> 0) % rotationOrders.length]!,
    translationX = (geometry.translationX | 0) * 2 ** -16,
    translationY = (geometry.translationY | 0) * 2 ** -16,
    translationZ = (geometry.translationZ | 0) * 2 ** -16,
    destinationPivotX = (geometry.destinationPivotX | 0) * 2 ** -16,
    destinationPivotY = (geometry.destinationPivotY | 0) * 2 ** -16,
    perspective = geometry.perspective | 0;

  return initial.map(([storedX, storedY, storedZ, storedU, storedV]) => {
    let x = storedX,
      y = storedY,
      z = storedZ;
    for (const value of order) {
      const rotation = value as keyof typeof angles;
      const {cosine, sine} = angles[rotation];
      if (rotation === 'p') {
        const oldY = y,
          oldZ = z;
        y = cosine * oldY - sine * oldZ;
        z = sine * oldY + cosine * oldZ;
      } else if (rotation === 'h') {
        const oldX = x,
          oldZ = z;
        x = sine * oldZ + cosine * oldX;
        z = cosine * oldZ - sine * oldX;
      } else {
        const oldX = x,
          oldY = y;
        x = cosine * oldX - sine * oldY;
        y = sine * oldX + cosine * oldY;
      }
    }
    x += translationX;
    y += translationY;
    z += translationZ;
    let q = 1;
    if (z !== 0 && perspective !== 0)
      q = z > 0 ? perspective / (perspective + z) : (perspective - z) / perspective;
    return {
      x: f32(q * x + destinationPivotX),
      y: f32(q * y + destinationPivotY),
      q: f32(q),
      uq: f32(storedU * q),
      vq: f32(storedV * q),
    };
  });
}

/** 043D30 walks both quadrilateral edges and publishes exact 32-byte scanline semantics. */
export function buildBurikoMeshScanlines(
  vertices: readonly BurikoMeshVertex[],
  clippingHeight: number,
): BurikoMeshScanlineResult | null {
  if (vertices.length !== 4)
    throw new RangeError('Buriko mesh scanline construction requires exactly four vertices');
  const snapped = vertices.map((vertex) => ({
    x: snapFloatNearInteger(vertex.x),
    y: snapFloatNearInteger(vertex.y),
  }));
  let minimum = 0,
    minimumY = snapped[0]!.y,
    maximumY = minimumY,
    minimumX = snapped[0]!.x,
    maximumX = minimumX;
  for (let index = 1; index < 4; index++) {
    const point = snapped[index]!;
    if (point.y < minimumY) {
      minimumY = point.y;
      minimum = index;
    }
    maximumY = Math.max(maximumY, point.y);
    minimumX = Math.min(minimumX, point.x);
    maximumX = Math.max(maximumX, point.x);
  }
  if (minimumY === maximumY || minimumX === maximumX) return null;
  const top = cvttInt32(Math.floor(minimumY)),
    bottom = cvttInt32(Math.ceil(maximumY));
  if (bottom < 0) return null;
  const left = cvttInt32(Math.floor(minimumX)),
    right = cvttInt32(Math.ceil(maximumX)),
    firstRow = Math.max(top, 0),
    clippedBottom = Math.min(bottom, (clippingHeight - 1) | 0),
    count = (clippedBottom - firstRow + 1) | 0;
  if (count <= 0)
    throw new RangeError('Buriko mesh clipped count has no safe browser allocation profile');

  const start = vertices[minimum]!,
    forward: MeshEdge = {
      index: minimum,
      x: start.x,
      q: start.q,
      uq: start.uq,
      vq: start.vq,
      dx: 0,
      dq: 0,
      duq: 0,
      dvq: 0,
    },
    reverse: MeshEdge = {...forward};
  const records: BurikoMeshScanline[] = [];
  let previousLeft = 0x7fffffff,
    previousRight = -0x80000000,
    horizontalDq: number | undefined,
    horizontalDuq: number | undefined,
    horizontalDvq: number | undefined;

  for (let row = firstRow; row <= bottom && row < (clippingHeight | 0); row++) {
    advanceEdgeSegment(forward, 1, vertices, row, top, bottom);
    advanceEdgeSegment(reverse, -1, vertices, row, top, bottom);
    let first = mutableEndpoint(forward),
      second = mutableEndpoint(reverse);

    if (row === top && first.x === second.x) {
      const firstNextX = first.x + forward.dx,
        secondNextX = second.x + reverse.dx,
        nextWidth = secondNextX - firstNextX;
      if (nextWidth !== 0) {
        const dq = (second.q + reverse.dq - (first.q + forward.dq)) / nextWidth,
          duq = (second.uq + reverse.duq - (first.uq + forward.duq)) / nextWidth,
          dvq = (second.vq + reverse.dvq - (first.vq + forward.dvq)) / nextWidth;
        first = {
          x: firstNextX,
          q: first.q + dq * forward.dx,
          uq: first.uq + duq * forward.dx,
          vq: first.vq + dvq * forward.dx,
        };
        second = {
          x: secondNextX,
          q: second.q + dq * reverse.dx,
          uq: second.uq + duq * reverse.dx,
          vq: second.vq + dvq * reverse.dx,
        };
      }
    }
    if (first.x > second.x) [first, second] = [second, first];
    const width = second.x - first.x;
    if (width <= 0) {
      records.push({
        left: 0x7fffffff,
        right: -0x80000000,
        q: 0,
        uq: 0,
        vq: 0,
        dq: 0,
        duq: 0,
        dvq: 0,
      });
    } else {
      if (row === top || width >= 2) {
        horizontalDq = (second.q - first.q) / width;
        horizontalDuq = (second.uq - first.uq) / width;
        horizontalDvq = (second.vq - first.vq) / width;
      }
      if (horizontalDq === undefined || horizontalDuq === undefined || horizontalDvq === undefined)
        throw new Error('Buriko mesh reaches a narrow row before initializing native slopes');
      const snappedLeft = snapDoubleNearInteger(first.x),
        snappedRight = snapDoubleNearInteger(second.x),
        rawLeft = cvttInt32(Math.floor(snappedLeft)),
        rawRight = cvttInt32(Math.ceil(snappedRight));
      let nextLeft = rawLeft,
        nextRight = rawRight;
      if (row < bottom) {
        let firstNextX = forward.x + forward.dx,
          secondNextX = reverse.x + reverse.dx;
        if (firstNextX > secondNextX) [firstNextX, secondNextX] = [secondNextX, firstNextX];
        if (secondNextX - firstNextX > 0) {
          nextLeft = cvttInt32(Math.floor(snapDoubleNearInteger(firstNextX)));
          nextRight = cvttInt32(Math.ceil(snapDoubleNearInteger(secondNextX)));
        }
      }
      const storedLeft = Math.max(left, Math.min(previousLeft, rawLeft, nextLeft)),
        storedRight = Math.min(right, Math.max(previousRight, rawRight, nextRight)),
        distance = snappedLeft - storedLeft;
      records.push({
        left: storedLeft,
        right: storedRight,
        q: f32(first.q - distance * horizontalDq),
        uq: f32(first.uq - distance * horizontalDuq),
        vq: f32(first.vq - distance * horizontalDvq),
        dq: f32(horizontalDq),
        duq: f32(horizontalDuq),
        dvq: f32(horizontalDvq),
      });
      previousLeft = rawLeft;
      previousRight = rawRight;
    }

    forward.x += forward.dx;
    forward.q += forward.dq;
    forward.uq += forward.duq;
    forward.vq += forward.dvq;
    reverse.x += reverse.dx;
    reverse.q += reverse.dq;
    reverse.uq += reverse.duq;
    reverse.vq += reverse.dvq;
  }
  if (records.length !== count)
    throw new Error('Buriko mesh scanline count diverges from its native clipped allocation');
  return {records, firstRow, bounds: {left, top, right, bottom}};
}

/** 042FF0 perspective-samples matching RGB/RGBA formats and clears uncovered output. */
function copyBurikoBitmapMesh32Pixels(
  destination: BurikoBitmap,
  source: BurikoBitmap,
  records: readonly BurikoMeshScanline[],
  firstRow: number,
  xOffset = 0,
): void {
  rasterizeBurikoMesh(destination, source, records, firstRow, xOffset, 0, 'copy');
}

/** 042BA0 perspective-samples RGB and applies the native signed-WORD blend coefficient. */
function blendBurikoBitmapMeshRgb32Pixels(
  destination: BurikoBitmap,
  source: BurikoBitmap,
  records: readonly BurikoMeshScanline[],
  firstRow: number,
  xOffset: number,
  transparency: number,
): void {
  rasterizeBurikoMesh(destination, source, records, firstRow, xOffset, transparency, 'rgb');
}

/** 042750 perspective-samples RGBA and combines sample alpha with inverse transparency. */
function blendBurikoBitmapMeshAlphaIntoRgb32Pixels(
  destination: BurikoBitmap,
  source: BurikoBitmap,
  records: readonly BurikoMeshScanline[],
  firstRow: number,
  xOffset: number,
  transparency: number,
): void {
  rasterizeBurikoMesh(destination, source, records, firstRow, xOffset, transparency, 'alpha');
}

/** 043530 offers the real shared mode-four worker before selecting its three pixel kernels. */
function drawBurikoBitmapMeshPixels(
  compositor: BurikoBitmapCompositor,
  destination: BurikoBitmap,
  source: BurikoBitmap,
  records: readonly BurikoMeshScanline[],
  firstRow: number,
  xOffset: number,
  mode: number,
  transparency: number,
  parallel = true,
): void {
  if (
    parallel &&
    runBurikoBitmapMeshOperation(
      compositor.processing,
      destination,
      records,
      firstRow,
      (output, strip) =>
        drawBurikoBitmapMesh(
          compositor,
          output,
          source,
          strip.records,
          strip.firstRow,
          xOffset,
          mode,
          transparency,
          false,
        ),
    )
  )
    return;
  mode |= 0;
  if (
    mode === 0 &&
    destination.format === source.format &&
    (source.format === 1 || source.format === 2)
  )
    copyBurikoBitmapMesh32(destination, source, records, firstRow, xOffset);
  else if (mode === 1 && destination.format === 1) {
    if (source.format === 1)
      blendBurikoBitmapMeshRgb32(destination, source, records, firstRow, xOffset, transparency);
    else if (source.format === 2)
      blendBurikoBitmapMeshAlphaIntoRgb32(
        destination,
        source,
        records,
        firstRow,
        xOffset,
        transparency,
      );
  }
}

export const copyBurikoBitmapMesh32 = withBurikoBitmapText(copyBurikoBitmapMesh32Pixels, {
  replace: true,
  map: (x, y, args) => meshTextPoint(x, y, args[2], args[3], args[4] ?? 0),
});

export const blendBurikoBitmapMeshRgb32 = withBurikoBitmapText(blendBurikoBitmapMeshRgb32Pixels, {
  opacity: (args) => (256 - args[5]) / 256,
  map: (x, y, args) => meshTextPoint(x, y, args[2], args[3], args[4]),
});

export const blendBurikoBitmapMeshAlphaIntoRgb32 = withBurikoBitmapText(
  blendBurikoBitmapMeshAlphaIntoRgb32Pixels,
  {
    opacity: (args) => (256 - args[5]) / 256,
    map: (x, y, args) => meshTextPoint(x, y, args[2], args[3], args[4]),
  },
);

export const drawBurikoBitmapMesh = withBurikoBitmapText(drawBurikoBitmapMeshPixels, {
  alternateArgs: (args) => {
    const alternate = [...args] as Parameters<typeof drawBurikoBitmapMeshPixels>;
    alternate[8] = false;
    return alternate;
  },
  destination: 1,
  source: 2,
  replace: (args) => args[6] === 0,
  applied: (_, args) =>
    ((args[6] === 0 && args[1].format === args[2].format) ||
      (args[6] === 1 && args[1].format === 1)) &&
    (args[2].format === 1 || args[2].format === 2),
  opacity: (args) => (args[6] === 0 ? 1 : (256 - args[7]) / 256),
  map: (x, y, args) => meshTextPoint(x, y, args[3], args[4], args[5]),
});

/** DOM glyph boxes follow the nearest projected scanline; perspective glyph distortion stays approximate. */
function meshTextPoint(
  x: number,
  y: number,
  records: readonly BurikoMeshScanline[],
  firstRow: number,
  xOffset: number,
): [number, number] {
  let best = Infinity,
    output: [number, number] = [NaN, NaN];
  for (let row = 0; row < records.length; row++) {
    const record = records[row]!;
    if (record.right < record.left) continue;
    const a = record.uq - x * record.q,
      b = record.vq - y * record.q,
      da = record.duq - x * record.dq,
      db = record.dvq - y * record.dq,
      denominator = da * da + db * db;
    const step = denominator
        ? Math.max(0, Math.min(record.right - record.left + 1, -(a * da + b * db) / denominator))
        : 0,
      q = record.q + step * record.dq,
      u = (record.uq + step * record.duq) / q,
      v = (record.vq + step * record.dvq) / q,
      distance = (u - x) ** 2 + (v - y) ** 2;
    if (distance < best) {
      best = distance;
      output = [record.left + xOffset + step, firstRow + row];
    }
  }
  return output;
}
