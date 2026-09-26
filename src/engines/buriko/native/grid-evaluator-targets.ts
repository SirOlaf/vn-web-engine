import {pointerView} from '../bp/memory.js';
import {gridAllocation} from './logical-grid-path.js';
import {BurikoLogicalGridVisibility} from './logical-grid-visibility.js';
import type {BurikoGridEvaluatorRecords} from './grid-evaluator-records.js';

/** 1400a7090 chooses each actor's enemy and cached destination using native grid costs. */
export function chooseGridEvaluatorTarget(
  state: BurikoGridEvaluatorRecords,
  index: number,
): number {
  index >>>= 0;
  if (index >= state.records.length) return 0x90000003;
  const actor = state.records[index]!;
  if (actor.id === 0) return 0x90000003;
  const grid = state.requireGrid(),
    count = state.records.length,
    costs = new Int32Array(count),
    targets: ([number, number] | undefined)[] = Array(count),
    scratch = new Uint8Array(128),
    values = new DataView(scratch.buffer),
    pointer = (offset = 0) => ({bytes: scratch, offset});
  grid.search(actor.id, actor.word(0x8d), 0, -1, -1, false);
  if (actor.word(0x95) === 1) {
    for (let i = 0; i < count; i++) {
      const candidate = state.records[i]!;
      if ((actor.word(1) & candidate.word(1)) !== 0 || candidate.id === 0) continue;
      if (grid.copyPosition(pointer(), candidate.id) !== 0)
        throw new Error('Buriko grid evaluator target has uninitialized grid coordinates');
      let x = values.getInt32(0, true),
        y = values.getInt32(4, true),
        cost = 0x7fffffff;
      if (grid.copyNeighborPaths(pointer(8), pointer(32), actor.id, x, y) !== 0)
        throw new Error('Buriko grid evaluator target reads uninitialized neighbor paths');
      for (let direction = 0; direction < 6; direction++) {
        if (values.getInt32(8 + direction * 4, true) < 0) continue;
        const nx = values.getInt32(32 + direction * 8, true),
          ny = values.getInt32(36 + direction * 8, true);
        if (grid.copyMetric(pointer(96), actor.id, nx, ny) !== 0)
          throw new Error('Buriko grid evaluator target reads uninitialized neighbor cost');
        const next = values.getInt32(96, true);
        if (next < cost) {
          cost = next;
          x = nx;
          y = ny;
        }
      }
      if (cost < 0x7fffffff) targets[i] = [x, y];
      else cost = -1;
      costs[i] = cost;
    }
  } else {
    const enemyPositions: ([number, number] | undefined)[] = Array(count);
    for (let i = 0; i < count; i++) {
      const candidate = state.records[i]!;
      if ((actor.word(1) & candidate.word(1)) !== 0 || candidate.id === 0) continue;
      if (grid.copyPosition(pointer(), candidate.id) !== 0)
        throw new Error('Buriko grid evaluator target has uninitialized grid coordinates');
      enemyPositions[i] = [values.getInt32(0, true), values.getInt32(4, true)];
      costs[i] = -1;
    }
    const {width, height} = grid.dimensions(),
      positions = gridAllocation(width, height, 8),
      visible = new Uint8Array(0x200),
      visibility = new BurikoLogicalGridVisibility(grid);
    if (grid.copyReachable({bytes: positions, offset: 0}, pointer(), actor.id, true) !== 0)
      throw new Error('Buriko grid evaluator target reads uninitialized reachable count');
    const length = values.getUint32(0, true);
    for (let positionIndex = 0; positionIndex < length; positionIndex++) {
      const point = pointerView({bytes: positions, offset: positionIndex * 8}, 8),
        x = point.getInt32(0, true),
        y = point.getInt32(4, true);
      if (grid.copyMetric(pointer(), actor.id, x, y) !== 0)
        throw new Error('Buriko grid evaluator target reads uninitialized movement cost');
      visibility.collect(
        {bytes: visible, offset: 0},
        null,
        pointer(4),
        x,
        y,
        actor.word(0x95),
        actor.word(0x96),
        actor.word(0x97),
        1,
        1,
        true,
      );
      for (let hit = 0; hit < values.getUint32(4, true); hit++) {
        const position = pointerView({bytes: visible, offset: hit * 8}, 8),
          hx = position.getInt32(0, true),
          hy = position.getInt32(4, true);
        for (let i = 0; i < count; i++) {
          const enemy = enemyPositions[i];
          if (costs[i]! < 0 && enemy !== undefined && enemy[0] === hx && enemy[1] === hy) {
            costs[i] = values.getInt32(0, true);
            targets[i] = [x, y];
            break;
          }
        }
      }
      if (!costs.some((cost) => cost < 0)) break;
    }
  }
  let selected = actor.word(3),
    selectedType = -1,
    selectedCost = 0;
  if (selected >= 0) {
    if (selected >= costs.length)
      throw new Error('Buriko grid evaluator target index outside stack cost array');
    if (costs[selected]! > 0) {
      selectedType = state.record(selected).word(2);
      selectedCost = costs[selected]!;
    }
  }
  for (let i = 0; i < count; i++) {
    const cost = costs[i]!;
    if (cost <= 0) continue;
    const typeCount = state.typeCount;
    if (typeCount === undefined)
      throw new Error('Buriko grid evaluator uninitialized affinity type count');
    const type = state.records[i]!.word(2),
      sourceType = actor.word(2),
      forward = ((sourceType + 1) | 0) % typeCount,
      backward = ((sourceType + typeCount - 1) | 0) % typeCount,
      neutral = type !== forward && type !== backward,
      selectedNeutral = selectedType !== forward && selectedType !== backward;
    let retain: boolean;
    if (cost < selectedCost) {
      retain =
        (type !== forward || (selectedType === forward && selectedCost < ((cost * 2) | 0))) &&
        (!neutral ||
          (selectedType !== backward && (!selectedNeutral || selectedCost < ((cost * 2) | 0))));
    } else {
      retain =
        ((actor.word(0x8e) + selectedCost) | 0) <= cost ||
        ((type !== forward || selectedType === forward) && (!neutral || selectedType !== backward));
    }
    if (retain && selectedCost !== 0) continue;
    const target = targets[i];
    if (target === undefined)
      throw new Error('Buriko grid evaluator target reads uninitialized destination');
    selected = i;
    selectedType = type;
    selectedCost = cost;
    actor.setWord(3, i);
    actor.setWord(0x210, target[0]);
    actor.setWord(0x211, target[1]);
  }
  if (
    selected >= 0 &&
    grid.copyRoute(null, pointer(), actor.id, actor.word(0x210), actor.word(0x211)) === 0
  ) {
    const length = values.getInt32(0, true),
      coordinates = gridAllocation(length, 1, 8);
    grid.copyRouteCoordinates(
      {bytes: coordinates, offset: 0},
      pointer(),
      actor.id,
      actor.word(0x210),
      actor.word(0x211),
    );
    for (let i = 0; i < length; i++) {
      const position = pointerView({bytes: coordinates, offset: i * 8}, 8),
        x = position.getInt32(0, true),
        y = position.getInt32(4, true);
      grid.copyMetric(pointer(4), actor.id, x, y);
      if (values.getInt32(4, true) <= actor.word(0x8e)) {
        actor.setWord(0x212, x);
        actor.setWord(0x213, y);
      }
    }
  }
  return 0;
}
