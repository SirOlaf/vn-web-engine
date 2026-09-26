import {pointerView} from '../bp/memory.js';
import type {BurikoBpPointer} from '../bp/memory.js';

interface WorldMapEdge {
  weight: number;
  overrides: Map<number, number>;
}
interface WorldMapNode {
  position: Float32Array;
  edges: Map<number, WorldMapEdge>;
}
interface WorldMap {
  // The native constructor leaves these two DWORDs uninitialized until aa6a0 succeeds.
  nodeCount?: number;
  typeCount?: number;
  nodes: (WorldMapNode | undefined)[];
}
interface SearchEntry {
  node: number;
  cost: number;
  next: SearchEntry | null;
}
const f32 = Math.fround;

/** CVTDQ2PS followed by MULPS with 2^-16, as used by D0C4. */
export function worldMapPosition(source: BurikoBpPointer | null): Float32Array {
  if (source === null) throw new Error('Buriko world-map null position input');
  const view = pointerView(source, 16),
    position = new Float32Array(4);
  for (let i = 0; i < 4; i++) position[i] = f32(f32(view.getInt32(i * 4, true)) / 65536);
  return position;
}

/** Native SUBPS/MULPS, two HADDPS instructions, then SQRTSS. */
function distance(a: Float32Array, b: Float32Array): number {
  const square = (i: number): number => {
    const difference = f32(b[i]! - a[i]!);
    return f32(difference * difference);
  };
  return f32(Math.sqrt(f32(f32(square(0) + square(1)) + f32(square(2) + square(3)))));
}

function outputWord(pointer: BurikoBpPointer | null, value: number): void {
  if (pointer === null) throw new Error('Buriko world-map null DWORD output');
  pointerView(pointer, 4).setUint32(0, value, true);
}

/** DCWorldMapMngr (1400a9e20–1400aa850), owned independently of the logical-grid managers. */
export class BurikoNativeWorldMaps {
  private nextId = 0;
  private readonly maps = new Map<number, WorldMap>();

  private dimensions(map: WorldMap): readonly [number, number] {
    if (map.nodeCount === undefined || map.typeCount === undefined)
      throw new Error('Buriko world-map reads uninitialized dimensions after failed creation');
    return [map.nodeCount, map.typeCount];
  }

  private initialize(map: WorldMap, nodeCount: number, typeCount: number): number {
    nodeCount >>>= 0;
    typeCount >>>= 0;
    if ((nodeCount - 1) >>> 0 > 0x3ff) return 0x8000000a;
    if (typeCount === 1 || typeCount > 32) return 0x80000008;
    map.nodes = new Array<WorldMapNode | undefined>(nodeCount);
    map.nodeCount = nodeCount;
    map.typeCount = typeCount;
    return 0;
  }

  create(output: BurikoBpPointer | null, nodeCount: number, typeCount: number): number {
    this.nextId = (this.nextId + 1) >>> 0;
    // std::map insertion retains the previous object on a wrapped-key collision.
    if (!this.maps.has(this.nextId)) this.maps.set(this.nextId, {nodes: []});
    outputWord(output, this.nextId);
    return this.initialize(this.maps.get(this.nextId)!, nodeCount, typeCount);
  }

  destroy(id: number): number {
    return this.maps.delete(id >>> 0) ? 0 : 0x80000007;
  }

  /** Final owner disposal. Keep nextId monotonic across the owner's lifetime. */
  disposeAll(): void {
    this.maps.clear();
  }

  clear(id: number): number {
    const map = this.maps.get(id >>> 0);
    if (map === undefined) return 0x80000007;
    const [nodeCount, typeCount] = this.dimensions(map);
    return this.initialize(map, nodeCount, typeCount);
  }

  setNode(id: number, index: number, position: Float32Array): number {
    const map = this.maps.get(id >>> 0);
    if (map === undefined) return 0x80000007;
    const [nodeCount] = this.dimensions(map);
    if ((index | 0) < 0 || index >>> 0 >= nodeCount) return 0x8000000a;
    // Replacement destroys the old outgoing edge map; incoming links remain.
    map.nodes[index >>> 0] = {position: position.slice(), edges: new Map()};
    return 0;
  }

  removeNode(id: number, index: number): number {
    const map = this.maps.get(id >>> 0);
    if (map === undefined) return 0x80000007;
    const [nodeCount] = this.dimensions(map);
    if ((index | 0) < 0 || index >>> 0 >= nodeCount || map.nodes[index >>> 0] === undefined)
      return 0x8000000a;
    map.nodes[index >>> 0] = undefined;
    return 0;
  }

  setEdge(
    id: number,
    source: number,
    destination: number,
    fixedWeight: number,
    overrideCount: number,
    packedOverrides: BurikoBpPointer | null,
  ): number {
    const map = this.maps.get(id >>> 0);
    if (map === undefined) return 0x80000007;
    const overrides = new Map<number, number>();
    // fb480 constructs and fills the temporary map before any node/weight validation.
    for (let i = 0; i < (overrideCount | 0); i++) {
      if (packedOverrides === null) throw new Error('Buriko world-map null edge overrides');
      const packed = pointerView(
        {bytes: packedOverrides.bytes, offset: packedOverrides.offset + i * 4},
        4,
      ).getUint32(0, true);
      overrides.set(packed & 255, f32(f32(packed >>> 8) / 65536));
    }
    const weight = f32(f32(fixedWeight | 0) / 65536);
    const [nodeCount, typeCount] = this.dimensions(map);
    if ((source | 0) < 0 || source >>> 0 >= nodeCount || map.nodes[source >>> 0] === undefined)
      return 0x8000000a;
    if ((destination | 0) < 0 || destination >>> 0 >= nodeCount) return 0x8000000c;
    if (weight <= 0) return 0x80000008;
    for (const key of [...overrides.keys()].sort((a, b) => a - b)) {
      if (key >= typeCount) return 0x8000000b;
      if (overrides.get(key)! <= 0) return 0x80000008;
    }
    map.nodes[source >>> 0]!.edges.set(destination >>> 0, {weight, overrides});
    return 0;
  }

  removeEdge(id: number, source: number, destination: number): number {
    const map = this.maps.get(id >>> 0);
    if (map === undefined) return 0x80000007;
    const [nodeCount] = this.dimensions(map);
    if ((source | 0) < 0 || source >>> 0 >= nodeCount || map.nodes[source >>> 0] === undefined)
      return 0x8000000a;
    return map.nodes[source >>> 0]!.edges.delete(destination >>> 0) ? 0 : 0x8000000c;
  }

  findPath(
    countOutput: BurikoBpPointer | null,
    pathOutput: BurikoBpPointer | null,
    id: number,
    source: number,
    destination: number,
    type: number,
  ): number {
    const map = this.maps.get(id >>> 0);
    if (map === undefined) return 0x80000007;
    const [nodeCount] = this.dimensions(map);
    source >>>= 0;
    destination >>>= 0;
    if ((source | 0) < 0 || source >= nodeCount) return 0x8000000a;
    if ((destination | 0) < 0 || destination >= nodeCount) return 0x80000010;
    const costs = new Float32Array(nodeCount),
      parents = new Int32Array(nodeCount).fill(-1);
    let head: SearchEntry | null = null,
      tail: SearchEntry | null = null;
    const enqueue = (node: number, parent: number, cost: number): void => {
      if (map.nodes[node] === undefined) return;
      // Zero is the native unseen sentinel, including after a zero-length route.
      if (cost < costs[node]! || costs[node] === 0) {
        costs[node] = cost;
        parents[node] = parent;
        const entry: SearchEntry = {node, cost, next: null};
        if (tail === null) head = entry;
        else tail.next = entry;
        tail = entry;
      }
    };
    if (map.nodes[source] === undefined) return 0x8000000a;
    enqueue(source, -1, 0);
    while (head !== null) {
      const entry: SearchEntry = head;
      const node = map.nodes[entry.node]!;
      // The native std::map visits destination indices in ascending signed order.
      for (const next of [...node.edges.keys()].sort((a, b) => a - b)) {
        const other = map.nodes[next];
        if (other === undefined) continue;
        const edge = node.edges.get(next)!;
        const weight = edge.overrides.get(type | 0) ?? edge.weight;
        enqueue(
          next,
          entry.node,
          f32(f32(weight * distance(node.position, other.position)) + entry.cost),
        );
      }
      // Pop only after processing: enqueue may append to this very entry.
      head = entry.next;
      if (head === null) tail = null;
    }
    if (!(costs[destination]! > 0)) return 0x80000010;
    const reversed: number[] = [];
    for (let node = destination; node !== source; node = parents[node]! >>> 0) {
      if (node >= nodeCount) throw new Error('Buriko world-map invalid native parent pointer');
      reversed.push(node);
    }
    reversed.reverse();
    outputWord(countOutput, reversed.length);
    if (reversed.length !== 0) {
      if (pathOutput === null) throw new Error('Buriko world-map null path output');
      const output = pointerView(pathOutput, reversed.length * 4);
      for (let i = 0; i < reversed.length; i++) output.setUint32(i * 4, reversed[i]!, true);
    }
    return 0;
  }
}
