import type {AokanaBpPointer} from '../bp/memory.js';
import type {AokanaLogicalGridManager} from './logical-grid.js';
import {gridOutput} from './logical-grid-path.js';
import {AokanaNativeSpline, truncateSplineInteger} from './spline.js';

const cornerBounds = [
  [0, 0, 8192, 8192],
  [57344, 0, 65536, 8192],
  [0, 57344, 8192, 65536],
  [57344, 57344, 65536, 65536],
] as const;

/** 14009ff80 performs the horizontal squares in signed DWORD arithmetic. */
function gridDistance(
  manager: AokanaLogicalGridManager,
  x: number,
  y: number,
  z: number,
  targetX: number,
  targetY: number,
  targetZ: number,
): number {
  const dx = (x - targetX) | 0,
    dy = (y - targetY) | 0,
    dz = ((z - targetZ) | 0) / (manager.verticalDivisor | 0);
  return Math.sqrt(((Math.imul(dy, dy) + Math.imul(dx, dx)) | 0) + dz * dz);
}

function lowTruncatedInt64(value: number): number {
  if (!Number.isFinite(value) || value < -(2 ** 63) || value >= 2 ** 63) return 0;
  return Number(BigInt.asUintN(32, BigInt(Math.trunc(value))));
}

/** The manager's spline-based visibility path, 1400a00e0 / 1400a0b50. */
export class AokanaLogicalGridVisibility {
  constructor(private readonly manager: AokanaLogicalGridManager) {}

  lineOfSight(
    output: AokanaBpPointer | null,
    x: number,
    y: number,
    targetX: number,
    targetY: number,
    curvature: number,
    ignoreAgents: number,
  ): number {
    const result = this.trace(x, y, targetX, targetY, curvature, ignoreAgents);
    if (result.status === 0) gridOutput(output, result.visible!);
    return result.status;
  }

  private trace(
    x: number,
    y: number,
    targetX: number,
    targetY: number,
    curvature: number,
    ignoreAgents: number,
  ): {status: number; visible?: number} {
    const manager = this.manager;
    x |= 0;
    y |= 0;
    targetX |= 0;
    targetY |= 0;
    curvature |= 0;
    if (manager.cells === null) return {status: 0x80000002};
    if (!manager.inside(x, y) || (x === targetX && y === targetY)) return {status: 0x80000004};
    if (!manager.inside(targetX, targetY)) return {status: 0x80000008};
    const sourceHeight = manager.cell(x, y).getInt32(0, true),
      targetHeight = manager.cell(targetX, targetY).getInt32(0, true),
      distance = gridDistance(manager, x, y, sourceHeight, targetX, targetY, targetHeight),
      duration = lowTruncatedInt64(distance * 8),
      targetAgentHeight = (manager.agentAt(targetX, targetY)?.height ?? 3) << 15,
      sourceAgentHeight = (manager.agentAt(x, y)?.height ?? 3) << 15,
      spline = new AokanaNativeSpline();
    spline.append(
      ((targetX << 16) + 0x8000) | 0,
      ((targetY << 16) + 0x8000) | 0,
      ((targetHeight << 16) + targetAgentHeight) | 0,
    );
    if (curvature > 0) {
      const vertical = truncateSplineInteger(curvature * distance * -0.00390625 * 65536);
      spline.append(
        (x + 1 + targetX) << 15,
        (y + 1 + targetY) << 15,
        (((targetHeight + sourceHeight) << 15) -
          vertical +
          (((sourceAgentHeight + targetAgentHeight) | 0) >> 1)) |
          0,
      );
    }
    spline.append(
      ((x << 16) + 0x8000) | 0,
      ((y << 16) + 0x8000) | 0,
      ((sourceHeight << 16) + sourceAgentHeight) | 0,
    );
    spline.setDuration(duration);
    let visible = 1,
      intercepted = false;
    const position = new Int32Array(3);
    for (let tick = 0; tick <= duration; tick = (tick + 1) >>> 0) {
      if (!spline.sample(tick, position)) continue;
      const cellX = position[0]! >> 16,
        cellY = position[1]! >> 16,
        z = position[2]! >> 16,
        cell = manager.cell(cellX, cellY),
        baseHeight = cell.getInt32(0, true);
      if (
        (cell.getUint32(8, true) & 2) !== 0 ||
        z < ((baseHeight + (cell.getUint32(12, true) >>> 28)) | 0)
      ) {
        visible = 0;
        break;
      }
      const corners = manager.cell(cellX, cellY, manager.corners),
        fractionX = position[0]! & 65535,
        fractionY = position[1]! & 65535;
      for (let corner = 0; corner < 4; corner++) {
        const bounds = cornerBounds[corner]!;
        if (
          z < corners.getInt32(corner * 4, true) &&
          fractionX >= bounds[0] &&
          fractionX < bounds[2] &&
          fractionY >= bounds[1] &&
          fractionY < bounds[3]
        ) {
          visible = 0;
          break;
        }
      }
      if (visible === 0) break;
      if ((ignoreAgents | 0) === 0 && (cellX !== targetX || cellY !== targetY)) {
        const agent = manager.agentAt(cellX, cellY);
        if (
          agent !== undefined &&
          z < ((agent.height + baseHeight) | 0) &&
          manager.centerDistances[(fractionY >>> 12) * 16 + (fractionX >>> 12)]! <= agent.width
        ) {
          visible = Number(cellX === x && cellY === y);
          intercepted = true;
          break;
        }
      }
    }
    if (visible !== 0 && !intercepted) visible = ~(manager.cell(x, y).getUint32(8, true) >>> 2) & 1;
    return {status: 0, visible};
  }

  collect(
    output: AokanaBpPointer | null,
    distances: AokanaBpPointer | null,
    count: AokanaBpPointer | null,
    x: number,
    y: number,
    range: number,
    heightFactor: number,
    curvature: number,
    onlyAgents: number,
    ignoreAgents: number,
    excludeOrigin = true,
  ): number {
    const manager = this.manager;
    if (manager.cells === null) return 0x80000002;
    x |= 0;
    y |= 0;
    range |= 0;
    heightFactor |= 0;
    const {width, height} = manager.dimensions(),
      originHeight = manager.cell(x, y).getInt32(0, true),
      product = Math.imul(range, heightFactor),
      decrement = Math.imul(product, -256),
      thresholds = new Int32Array(32);
    let value = (Math.imul(Math.imul(product, 256), originHeight) + (range << 16)) | 0;
    for (let i = 0; i < 32; i++) {
      thresholds[i] = value < 0 ? 0 : (value + 0x4000) | 0;
      value = (value + decrement) | 0;
    }
    let length = 0;
    for (let row = 0; row < height; row++)
      for (let column = 0; column < width; column++) {
        const elevation = manager.cell(column, row).getInt32(0, true),
          distance = truncateSplineInteger(
            gridDistance(manager, column, row, elevation, x, y, originHeight) * 65536,
          );
        if (elevation < 0 || elevation >= 32)
          throw new Error('Aokana grid visibility reads outside native height-threshold stack');
        if (
          distance >= thresholds[elevation]! ||
          ((onlyAgents | 0) !== 0 && manager.agentAt(column, row) === undefined)
        )
          continue;
        const result = this.trace(column, row, x, y, curvature, ignoreAgents);
        if ((result.visible ?? 0) !== 0 || (!excludeOrigin && column === x && row === y)) {
          gridOutput(output, column, length * 8);
          gridOutput(output, row, length * 8 + 4);
          if (distances !== null) gridOutput(distances, distance, length * 4);
          length = (length + 1) | 0;
        }
      }
    gridOutput(count, length);
    return 0;
  }
}
