import {pointerView} from '../bp/memory.js';
import type {BurikoBpPointer} from '../bp/memory.js';
import {nativeVectorAngle} from '../bp/opcodes/native-math.js';
import {native1665VectorAngle} from '../bp/opcodes/legacy-1665.js';
import type {BurikoBpAbi} from '../bp/abi.js';
import {
  BurikoLogicalGridPath,
  gridAbsolute,
  gridAllocation,
  gridCopy,
  gridOutput,
  gridRead,
} from './logical-grid-path.js';

export type BurikoGridAbilityMap = {
  request: Uint8Array;
  ordinary: Uint8Array;
  extended: Uint8Array | null;
};

/** Native comparisons short-circuit after each QWORD and the final DWORD. */
export function sameGridAbilityRequest(
  request: BurikoBpPointer | null,
  bytes: Uint8Array,
): boolean {
  if (request === null) throw new Error('Buriko logical-grid null ability request');
  const stored = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (const offset of [0, 8]) {
    if (
      pointerView({bytes: request.bytes, offset: request.offset + offset}, 8).getBigUint64(
        0,
        true,
      ) !== stored.getBigUint64(offset, true)
    )
      return false;
  }
  return (
    pointerView({bytes: request.bytes, offset: request.offset + 16}, 4).getUint32(0, true) ===
    stored.getUint32(16, true)
  );
}

export class BurikoLogicalGridAgent {
  x = -1;
  y = -1;
  direction = 0;
  height = 3;
  width = 0x80;
  masks: [number, number] = [0, 0];
  costPlane = 0;
  occupancyHeight = 1;
  path: BurikoLogicalGridPath | null = null;
  readonly abilityMaps: BurikoGridAbilityMap[] = [];
  constructor(readonly id: number) {}
  dispose(): void {
    this.path?.dispose();
    this.path = null;
    this.abilityMaps.length = 0;
  }
}

/** DCTELgclGrdFldMngr (1400a1090), distinct from D040's floating-point space. */
export class BurikoLogicalGridManager {
  private disposed = false;
  width: number | undefined;
  height: number | undefined;
  cells: Uint8Array | null = null;
  corners: Uint8Array | null = null;
  readonly agents: BurikoLogicalGridAgent[] = [];
  private readonly costPlanes: {id: number; bytes: Uint8Array}[] = [];
  private nextPlane = 0x10000000;
  private nextAgent = 0x20000000;
  readonly centerDistances = new Int32Array(256);

  constructor(
    readonly verticalDivisor: number,
    readonly revision: BurikoBpAbi['revision'] = '1.685.3',
  ) {
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        const dx = x < 8 ? 8 - x : x - 7,
          dy = y < 8 ? 8 - y : y - 7;
        this.centerDistances[y * 16 + x] = Math.trunc(Math.sqrt(dx * dx + dy * dy)) << 5;
      }
  }

  dispose(): void {
    this.corners = null;
    this.clearCells();
    this.disposed = true;
  }

  private clearCells(): void {
    for (const agent of this.agents) agent.dispose();
    this.agents.length = this.costPlanes.length = 0;
    this.cells = null;
  }

  dimensions(): {width: number; height: number} {
    if (this.width === undefined || this.height === undefined)
      throw new Error('Buriko logical-grid uninitialized dimensions');
    return {width: this.width, height: this.height};
  }

  inside(x: number, y: number): boolean {
    const {width, height} = this.dimensions();
    return x >= 0 && x < width && y >= 0 && y < height;
  }

  index(x: number, y: number): number {
    return (Math.imul(this.dimensions().width, y) + x) | 0;
  }

  cell(x: number, y: number, cells = this.cells): DataView {
    if (cells === null) throw new Error('Buriko logical-grid null cells');
    return pointerView({bytes: cells, offset: this.index(x, y) * 16}, 16);
  }

  agent(id: number): BurikoLogicalGridAgent | undefined {
    return this.agents.find((agent) => agent.id === id >>> 0);
  }
  agentAt(x: number, y: number): BurikoLogicalGridAgent | undefined {
    return this.agents.find((agent) => agent.x === x && agent.y === y);
  }

  /** 14009f950/14009f6f0 duplicate cells and derived maps, but discard every search path. */
  clone(): BurikoLogicalGridManager | null {
    if (this.disposed)
      throw new Error('Buriko logical-grid clone dereferences a destroyed manager');
    if (this.cells === null) return null;
    const result = new BurikoLogicalGridManager(this.verticalDivisor, this.revision);
    const {width, height} = this.dimensions();
    result.setCells(width, height, {bytes: this.cells, offset: 0});
    let maximumPlane = 0;
    for (const plane of this.costPlanes) {
      const bytes = gridAllocation(width, height, 4, true);
      bytes.set(plane.bytes);
      result.costPlanes.push({id: plane.id, bytes});
      maximumPlane = Math.max(maximumPlane, plane.id >>> 0);
    }
    result.nextPlane = (maximumPlane + 1) >>> 0;
    for (const agent of this.agents) {
      const copy = new BurikoLogicalGridAgent(agent.id);
      copy.x = agent.x;
      copy.y = agent.y;
      copy.direction = agent.direction;
      copy.height = agent.height;
      copy.width = agent.width;
      copy.masks = [...agent.masks];
      copy.costPlane = agent.costPlane;
      copy.occupancyHeight = agent.occupancyHeight;
      for (const map of agent.abilityMaps) {
        const ordinary = gridAllocation(width, height, 28, true);
        ordinary.set(map.ordinary);
        const extended = map.extended === null ? null : gridAllocation(width, height, 28, true);
        if (extended !== null) extended.set(map.extended!);
        copy.abilityMaps.push({request: map.request.slice(), ordinary, extended});
      }
      result.agents.push(copy);
    }
    return result;
  }

  copyPosition(output: BurikoBpPointer | null, id: number): number {
    const agent = this.agent(id);
    if (agent === undefined) return 0x80000003;
    gridOutput(output, agent.x);
    gridOutput(output, agent.y, 4);
    return 0;
  }

  copyDirection(output: BurikoBpPointer | null, id: number): number {
    const agent = this.agent(id);
    if (agent === undefined) return 0x80000003;
    gridOutput(output, agent.direction);
    return 0;
  }

  clearAbilityMaps(id: number): number {
    const agent = this.agent(id);
    if (agent === undefined) return 0x80000003;
    agent.abilityMaps.length = 0;
    return 0;
  }

  /** 14009e550 searches all five DWORDs before choosing either copied map. */
  copyAbilityMap(
    output: BurikoBpPointer | null,
    id: number,
    request: BurikoBpPointer | null,
    variant: number,
  ): number {
    const agent = this.agent(id);
    if (agent === undefined) return 0x80000003;
    const map = agent.abilityMaps.find((entry) => sameGridAbilityRequest(request, entry.request));
    if (map === undefined) return 0x8000000d;
    const bytes = (variant | 0) === 0 ? map.ordinary : map.extended;
    if (bytes === null) return 0x8000000e;
    gridCopy(output, bytes);
    return 0;
  }

  setCells(width: number, height: number, input: BurikoBpPointer | null): number {
    width |= 0;
    height |= 0;
    if (width === 0 || height === 0) return 0x80000001;
    this.clearCells();
    this.corners = null;
    this.width = width;
    this.height = height;
    this.cells = gridAllocation(width, height, 16, true);
    this.cells.set(gridRead(input, this.cells.length));
    this.prepareCorners();
    return 0;
  }

  /** 1400a0570: all four cells surrounding each lower-left concavity receive a height. */
  private prepareCorners(): void {
    const {width, height} = this.dimensions();
    const corners = gridAllocation(width, height, 16);
    for (let y = 1; y < height; y++)
      for (let x = 0; x < width - 1; x++) {
        const top = this.cell(x, y - 1),
          right = this.cell(x + 1, y),
          bottom = this.cell(x, y),
          topHeight = (top.getInt32(0, true) + (top.getUint32(12, true) >>> 28)) | 0,
          rightHeight = (right.getInt32(0, true) + (right.getUint32(12, true) >>> 28)) | 0,
          bottomHeight = bottom.getInt32(0, true);
        if (bottomHeight < topHeight && bottomHeight < rightHeight) {
          const value = Math.min(topHeight, rightHeight);
          this.cell(x, y - 1, corners).setInt32(12, value, true);
          this.cell(x + 1, y - 1, corners).setInt32(8, value, true);
          this.cell(x, y, corners).setInt32(4, value, true);
          this.cell(x + 1, y, corners).setInt32(0, value, true);
        }
      }
    this.corners = corners;
  }

  addCostPlane(output: BurikoBpPointer | null, input: BurikoBpPointer | null): number {
    if (this.cells === null) return 0x80000002;
    const {width, height} = this.dimensions(),
      bytes = gridAllocation(width, height, 4),
      id = this.nextPlane;
    bytes.set(gridRead(input, bytes.length));
    this.nextPlane = (this.nextPlane + 1) >>> 0;
    this.costPlanes.unshift({id, bytes});
    gridOutput(output, id);
    return 0;
  }

  createAgent(output: BurikoBpPointer | null): number {
    if (this.cells === null) return 0x80000002;
    const agent = new BurikoLogicalGridAgent(this.nextAgent);
    this.nextAgent = (this.nextAgent + 1) >>> 0;
    this.agents.unshift(agent);
    gridOutput(output, agent.id);
    return 0;
  }

  removeAgent(id: number): number {
    const index = this.agents.findIndex((agent) => agent.id === id >>> 0);
    if (index < 0) return 0x80000003;
    const agent = this.agents[index]!;
    this.agents.splice(index, 1);
    agent.dispose();
    return 0;
  }

  clearPath(id: number): number {
    const agent = this.agent(id);
    if (agent === undefined) return 0x80000003;
    agent.path?.dispose();
    agent.path = null;
    return 0;
  }

  setPosition(id: number, x: number, y: number): number {
    const agent = this.agent(id);
    if (agent === undefined) return 0x80000003;
    x |= 0;
    y |= 0;
    if (!this.inside(x, y)) return 0x80000004;
    agent.x = x;
    agent.y = y;
    return 0;
  }

  setSize(id: number, height: number, width: number): number {
    const agent = this.agent(id);
    if (agent === undefined) return 0x80000003;
    if ((height | 0) < 0) return 0x80000009;
    if ((width | 0) < 0) return 0x8000000a;
    agent.height = height | 0;
    agent.width = width | 0;
    return 0;
  }

  setMasks(id: number, input: BurikoBpPointer | null): number {
    const agent = this.agent(id);
    if (agent === undefined) return 0x80000003;
    if (input === null) throw new Error('Buriko logical-grid null agent mask input');
    const view = pointerView(input, 8);
    agent.masks = [view.getUint32(0, true), view.getUint32(4, true)];
    return 0;
  }

  selectCostPlane(id: number, plane: number): number {
    const agent = this.agent(id);
    if (agent === undefined) return 0x80000003;
    if (!this.costPlanes.some((entry) => entry.id === plane >>> 0)) return 0x80000005;
    agent.costPlane = plane >>> 0;
    return 0;
  }

  setDirection(id: number, direction: number): number {
    const agent = this.agent(id);
    if (agent === undefined) return 0x80000003;
    direction |= 0;
    if (direction !== 0 && (direction - 2) >>> 0 > 3) return 0x8000000b;
    agent.direction = direction;
    return 0;
  }

  /** 14009e220 copies terrain, adds the selected plane, then stamps every agent newest first. */
  initializePath(path: BurikoLogicalGridPath, planeId: number, stampAgents: boolean): number {
    if (this.cells === null) return 0x80000002;
    const {width, height} = this.dimensions(),
      cells = gridAllocation(width, height, 16);
    cells.set(this.cells);
    const plane = this.costPlanes.find((entry) => entry.id === planeId >>> 0);
    if (plane !== undefined) {
      const costs = new DataView(
        plane.bytes.buffer,
        plane.bytes.byteOffset,
        plane.bytes.byteLength,
      );
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const cell = this.cell(x, y, cells);
          cell.setInt32(
            4,
            (cell.getInt32(4, true) + costs.getInt32(this.index(x, y) * 4, true)) | 0,
            true,
          );
        }
    }
    if (stampAgents)
      for (const agent of this.agents) {
        // The native code dereferences the agent position before checking its bounds.
        const own = this.cell(agent.x, agent.y, cells);
        own.setUint32(8, own.getUint32(8, true) | 1, true);
        this.stampOccupancy(cells, agent);
      }
    path.setCells(width, height, cells);
    return 0;
  }

  private stampOccupancy(cells: Uint8Array, agent: BurikoLogicalGridAgent): void {
    const ownHeight = this.cell(agent.x, agent.y, cells).getInt32(0, true),
      mask = agent.masks[1] & 255;
    if (this.inside(agent.x, agent.y) && agent.occupancyHeight >= 0) {
      const own = this.cell(agent.x, agent.y, cells);
      own.setUint32(12, own.getUint32(12, true) | mask, true);
    }
    for (const [dx, dy] of [
      [0, -1],
      [0, 1],
      [-1, 0],
      [1, 0],
    ]) {
      const x = (agent.x + dx!) | 0,
        y = (agent.y + dy!) | 0;
      if (!this.inside(x, y)) continue;
      const cell = this.cell(x, y, cells);
      if (gridAbsolute((cell.getInt32(0, true) - ownHeight) | 0) <= agent.occupancyHeight) {
        cell.setUint32(12, cell.getUint32(12, true) | mask, true);
      }
    }
  }

  search(
    id: number,
    maximumClimb: number,
    budget: number,
    targetX: number,
    targetY: number,
    stampAgents = true,
  ): number {
    const agent = this.agent(id);
    if (agent === undefined) return 0x80000003;
    agent.path?.dispose();
    agent.path = new BurikoLogicalGridPath(this.verticalDivisor);
    this.initializePath(agent.path, agent.costPlane, stampAgents);
    return agent.path.search(
      agent.x,
      agent.y,
      agent.masks,
      maximumClimb,
      budget,
      targetX,
      targetY,
    ) === 0
      ? 0
      : 0xffffffff;
  }

  copyRoute(
    output: BurikoBpPointer | null,
    count: BurikoBpPointer | null,
    id: number,
    x: number,
    y: number,
  ): number {
    const agent = this.agent(id);
    if (agent === undefined) return 0x80000003;
    if (agent.path === null) return 0x80000006;
    const status = agent.path.copyRoute(output, count, x, y);
    return status === 0
      ? 0
      : status === 0x80000003
        ? 0x80000006
        : status === 0x80000004 || status === 0x80000005
          ? 0x80000007
          : status === 0xfffffffe
            ? status
            : 0xffffffff;
  }

  copyResults(output: BurikoBpPointer | null, id: number): number {
    const agent = this.agent(id);
    if (agent === undefined) return 0x80000003;
    if (agent.path === null) return 0x80000006;
    const status = agent.path.copyResults(output);
    return status === 0 ? 0 : status === 0x80000003 ? 0x80000006 : 0xffffffff;
  }

  copyReachable(
    output: BurikoBpPointer | null,
    count: BurikoBpPointer | null,
    id: number,
    sort = false,
  ): number {
    const agent = this.agent(id);
    if (agent === undefined) return 0x80000003;
    if (agent.path === null) return 0x80000006;
    const status = agent.path.copyReachable(output, count, sort);
    return status === 0 ? 0 : status === 0x80000003 ? 0x80000006 : 0xffffffff;
  }

  copyMetric(
    output: BurikoBpPointer | null,
    id: number,
    x: number,
    y: number,
    direction = false,
  ): number {
    const agent = this.agent(id);
    if (agent === undefined) return 0x80000003;
    if (agent.path === null) return 0x80000006;
    const status = agent.path.copyMetric(output, x, y, direction);
    return status === 0
      ? 0
      : status === 0x80000003
        ? 0x80000006
        : status === 0x80000004 || status === 0x80000005
          ? 0x80000007
          : 0xffffffff;
  }

  copyNeighborPaths(
    steps: BurikoBpPointer | null,
    coordinates: BurikoBpPointer | null,
    id: number,
    x: number,
    y: number,
  ): number {
    const agent = this.agent(id);
    if (agent === undefined) return 0x80000003;
    if (agent.path === null) return 0x80000006;
    const status = agent.path.copyNeighbors(steps, coordinates, x, y, 1);
    return status === 0
      ? 0
      : status === 0x80000003
        ? 0x80000006
        : status === 0xfffffffe
          ? status
          : 0xffffffff;
  }

  copyRouteCoordinates(
    output: BurikoBpPointer | null,
    count: BurikoBpPointer | null,
    id: number,
    x: number,
    y: number,
  ): number {
    const status = this.copyRoute(null, count, id, x, y);
    if (status !== 0 || output === null) return status;
    if (count === null) throw new Error('Buriko logical-grid null route count');
    const length = pointerView(count, 4).getInt32(0, true);
    if (length > 0) {
      const agent = this.agent(id)!;
      const bytes = gridAllocation(length, 1, 4),
        directions = {bytes, offset: 0};
      agent.path!.copyRoute(directions, count, x, y);
      agent.path!.directionsToCoordinates(output, directions, length, agent.x, agent.y);
    }
    return status;
  }

  /** 1400a0a20's relative direction order, used by evaluator facing selection. */
  directionOrder(output: BurikoBpPointer | null, direction: number, zeroBased: boolean): number {
    direction = ((direction | 0) + (zeroBased ? 2 : 0)) | 0;
    const order =
      direction === 2
        ? [3, 4, 5, 2]
        : direction === 3
          ? [2, 5, 4, 3]
          : direction === 4
            ? [5, 3, 2, 4]
            : direction === 5
              ? [4, 2, 3, 5]
              : undefined;
    if (order === undefined) return 0x80000008;
    for (let i = 0; i < 4; i++) gridOutput(output, order[i]!, i * 4);
    if (zeroBased) for (let i = 0; i < 4; i++) gridOutput(output, order[i]! - 2, i * 4);
    return 0;
  }

  facingAngle(output: BurikoBpPointer | null, x: number, y: number, id: number): number {
    const agent = this.agent(id);
    if (agent === undefined) return 0x80000003;
    let angle = 0,
      status = 0;
    if (agent.direction !== 0) {
      let base = 0;
      if (agent.direction === 2) base = 90 * 65536;
      else if (agent.direction === 3) base = 270 * 65536;
      else if (agent.direction === 4) base = 180 * 65536;
      else if (agent.direction !== 5) status = 0x8000000b;
      const directionAngle = (
        this.revision === '1.665' ? native1665VectorAngle : nativeVectorAngle
      )((x - agent.x) | 0, (agent.y - y) | 0);
      angle = gridAbsolute((directionAngle - base) | 0);
      if (angle > 180 * 65536) angle = (360 * 65536 - angle) | 0;
      if (status !== 0) return status;
    }
    gridOutput(output, angle);
    return 0;
  }

  /** 1400a09d0/14009ff20 compute an adjacent point without checking grid bounds. */
  copyAdjacentPosition(
    output: BurikoBpPointer | null,
    id: number,
    direction: number,
    zeroBased: boolean,
  ): number {
    const agent = this.agent(id);
    if (agent === undefined) return 0x80000003;
    direction = ((direction | 0) + (zeroBased ? 2 : 0)) | 0;
    let x = agent.x,
      y = agent.y;
    if (direction === 2) y = (y - 1) | 0;
    else if (direction === 3) y = (y + 1) | 0;
    else if (direction === 4) x = (x - 1) | 0;
    else if (direction === 5) x = (x + 1) | 0;
    else return 0x8000000b;
    gridOutput(output, x);
    gridOutput(output, y, 4);
    return 0;
  }

  directionBetween(x: number, y: number, targetX: number, targetY: number): number {
    const angle =
      (this.revision === '1.665' ? native1665VectorAngle : nativeVectorAngle)(
        (x - targetX) | 0,
        (targetY - y) | 0,
      ) >> 16;
    if ((angle - 45) >>> 0 < 90) return 2;
    if ((angle - 225) >>> 0 < 90) return 3;
    return Number((angle - 135) >>> 0 > 89) + 4;
  }
}

/** Grid handles have no logical-space reference counter, and begin at zero. */
export class BurikoLogicalGridManagers {
  private nextId = 0;
  private readonly entries: {id: number; manager: BurikoLogicalGridManager}[] = [];
  constructor(readonly revision: BurikoBpAbi['revision'] = '1.685.3') {}
  get(id: number): BurikoLogicalGridManager | undefined {
    return this.entries.find((entry) => entry.id === id >>> 0)?.manager;
  }
  create(output: BurikoBpPointer | null, kind: number, divisor: number): number {
    if ((kind | 0) !== 0) return 0;
    const id = this.nextId,
      manager = new BurikoLogicalGridManager(divisor | 0, this.revision);
    this.nextId = (id + 1) >>> 0;
    this.entries.unshift({id, manager});
    gridOutput(output, id);
    return 1;
  }
  destroy(id: number): number {
    const index = this.entries.findIndex((entry) => entry.id === id >>> 0);
    if (index < 0) return 0;
    const entry = this.entries[index]!;
    this.entries.splice(index, 1);
    entry.manager.dispose();
    return 1;
  }

  /** Final registry cleanup through the same manager destructor as D0:01. */
  disposeAll(): void {
    let firstError: unknown;
    let failed = false;
    while (this.entries.length !== 0) {
      try {
        this.destroy(this.entries[0]!.id);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
      }
    }
    if (failed) throw firstError;
  }
}
