import {pointerView} from '../bp/memory.js';
import {gridAllocation, gridOutput} from './logical-grid-path.js';
import {BurikoLogicalGridVisibility} from './logical-grid-visibility.js';
import {chooseGridEvaluatorTarget} from './grid-evaluator-targets.js';
import type {
  BurikoGridEvaluatorRecord,
  BurikoGridEvaluatorRecords,
} from './grid-evaluator-records.js';

/** The native candidate allocation holds 0x4c-byte records, initially 4096 entries. */
export class BurikoGridEvaluatorJobs {
  bytes: Uint8Array = new Uint8Array(0x4c000);
  length = 0;
  private capacity = 0x1000;
  append(value: Int32Array, checked: boolean): void {
    if (checked && this.length >= this.capacity) {
      this.capacity = (this.capacity * 2) >>> 0;
      const next = gridAllocation(this.capacity, 1, 0x4c, true);
      next.set(this.bytes.subarray(0, this.length * 0x4c));
      this.bytes = next;
    }
    // The initial no-action candidate is written without the growth check used by added actions.
    const output = pointerView({bytes: this.bytes, offset: this.length * 0x4c}, 0x4c);
    for (let i = 0; i < 19; i++) output.setInt32(i * 4, value[i]!, true);
    this.length = (this.length + 1) >>> 0;
  }
  job(index: number): DataView {
    return pointerView({bytes: this.bytes, offset: index * 0x4c}, 0x4c);
  }
}

export type BurikoGridEvaluationCandidates = {
  jobs: BurikoGridEvaluatorJobs;
  turnOrder: Int32Array;
};

/** 1400a7c90 through worker setup: enumerate native no-action, attack and ability candidates. */
export function prepareGridEvaluation(
  state: BurikoGridEvaluatorRecords,
  selectedIndex: number,
): BurikoGridEvaluationCandidates {
  for (let i = 0; i < state.records.length; i++) chooseGridEvaluatorTarget(state, i);
  const grid = state.requireGrid(),
    {width, height} = grid.dimensions(),
    positions = gridAllocation(width, height, 8, true),
    visible = gridAllocation(width, height, 8, true),
    records = state.records.map((record) => record.copy()),
    actor = records[selectedIndex],
    scratch = new Uint8Array(32),
    values = new DataView(scratch.buffer),
    pointer = (offset = 0) => ({bytes: scratch, offset});
  if (actor === undefined)
    throw new Error('Buriko grid evaluator selected actor address outside allocation');
  const visibility = new BurikoLogicalGridVisibility(grid),
    area = new Uint8Array(680);
  let route: Uint8Array | null = null,
    opponent: BurikoGridEvaluatorRecord | null = null;
  if (actor.word(3) >= 0) {
    grid.search(actor.id, actor.word(0x8d), 0, -1, -1, false);
    if (grid.copyRoute(null, pointer(), actor.id, actor.word(0x210), actor.word(0x211)) === 0) {
      const length = values.getInt32(0, true);
      route = gridAllocation(length, 1, 8);
      grid.copyRouteCoordinates(
        {bytes: route, offset: 0},
        pointer(),
        actor.id,
        actor.word(0x210),
        actor.word(0x211),
      );
    }
    opponent = records[actor.word(3)] ?? null;
    if (opponent === null)
      throw new Error('Buriko grid evaluator opponent address outside allocation');
    grid.search(opponent.id, opponent.word(0x8d), 0, -1, -1, false);
  }
  grid.search(actor.id, actor.word(0x8d), actor.word(0x8e), -1, -1, true);
  if (grid.copyReachable({bytes: positions, offset: 0}, pointer(), actor.id, true) !== 0)
    throw new Error('Buriko grid evaluator reads uninitialized candidate-position count');
  const length = values.getUint32(0, true);
  grid.copyPosition({bytes: positions, offset: length * 8}, actor.id);
  const jobs = new BurikoGridEvaluatorJobs();
  let direction = 6;
  for (let positionIndex = 0; positionIndex <= length; positionIndex++) {
    const position = pointerView({bytes: positions, offset: positionIndex * 8}, 8),
      x = position.getInt32(0, true),
      y = position.getInt32(4, true);
    grid.setPosition(actor.id, x, y);
    actor.setWord(0x20d, x);
    actor.setWord(0x20e, y);
    const base = new Int32Array(19);
    base[0] = x;
    base[1] = y;
    base[3] = -1;
    base[4] = base[5] = -1;
    base[6] = -0x80000000;
    base[7] = -1;
    base.fill(-0x80000000, 13);
    gridOutput(pointer(), direction);
    grid.copyMetric(pointer(), actor.id, x, y, true);
    direction = values.getInt32(0, true);
    base[8] = (direction - 2) | 0;
    if (grid.copyMetric(pointer(), actor.id, x, y) !== 0)
      throw new Error('Buriko grid evaluator reads uninitialized candidate movement cost');
    const cost = values.getInt32(0, true);
    base[9] = cost;
    if (opponent !== null) {
      if (grid.copyMetric(pointer(), opponent.id, x, y) !== 0) base[10] = -1;
      else base[10] = values.getInt32(0, true);
    }
    base[11] = cost === 0 ? 0 : (Math.imul(actor.word(0x90), cost) + actor.word(0x8f)) | 0;
    if (route !== null) {
      for (let offset = 0; offset < route.length; offset += 8) {
        const point = pointerView({bytes: route, offset}, 8);
        if (point.getInt32(0, true) === x && point.getInt32(4, true) === y) base[12] = 1;
      }
    }
    jobs.append(base, false);
    const action = base.slice();
    action[2] = 6;
    visibility.collect(
      {bytes: visible, offset: 0},
      null,
      pointer(),
      x,
      y,
      actor.word(0x95),
      actor.word(0x96),
      actor.word(0x97),
      1,
      0,
      true,
    );
    const targets = values.getUint32(0, true);
    for (let hit = 0; hit < targets; hit++) {
      const point = pointerView({bytes: visible, offset: hit * 8}, 8),
        hx = point.getInt32(0, true),
        hy = point.getInt32(4, true),
        target = state.findPosition(hx, hy, records);
      if (target !== null && (actor.word(1) & target.word(1)) === 0) {
        action[4] = hx;
        action[5] = hy;
        jobs.append(action, true);
      }
    }
    for (let ability = 0; ability < 16; ability++) {
      const offset = ability * 0x16;
      if (actor.word(0xad + offset) === 0) continue;
      const action = base.slice();
      action[2] = 7;
      action[3] = ability;
      const areaRange = actor.word(0xba + offset),
        type = actor.word(0xae + offset);
      if (areaRange < 0) {
        jobs.append(action, true);
        continue;
      }
      visibility.collect(
        {bytes: visible, offset: 0},
        null,
        pointer(),
        x,
        y,
        actor.word(0xb7 + offset),
        actor.word(0xb8 + offset),
        actor.word(0xb9 + offset),
        Number(areaRange === 0),
        0,
        false,
      );
      const targets = values.getUint32(0, true);
      for (let hit = 0; hit < targets; hit++) {
        const point = pointerView({bytes: visible, offset: hit * 8}, 8),
          hx = point.getInt32(0, true),
          hy = point.getInt32(4, true);
        let accept = true;
        if (areaRange === 0) {
          const target = state.findPosition(hx, hy, records);
          if (target === null)
            throw new Error('Buriko grid evaluator dereferences missing ability target');
          const ally = (actor.word(1) & target.word(1)) !== 0;
          if (type === 0 || type === 4) accept = !ally;
          else if (type > 0 && type < 4) accept = ally;
        } else {
          visibility.collect(
            {bytes: area, offset: 0},
            null,
            pointer(4),
            hx,
            hy,
            areaRange,
            0,
            0,
            1,
            0,
            false,
          );
          let allies = 0,
            enemies = 0;
          const areaCount = values.getUint32(4, true);
          if (areaCount === 0) continue;
          for (let i = 0; i < areaCount; i++) {
            const point = pointerView({bytes: area, offset: i * 8}, 8),
              target = state.findPosition(
                point.getInt32(0, true),
                point.getInt32(4, true),
                records,
              );
            if (target === null)
              throw new Error('Buriko grid evaluator dereferences missing area target');
            if ((actor.word(1) & target.word(1)) === 0) enemies++;
            else allies++;
          }
          if (type === 0 || type === 4) accept = enemies !== 0;
          else if (type > 0 && type < 4) accept = allies !== 0;
        }
        if (accept) {
          action[4] = hx;
          action[5] = hy;
          jobs.append(action, true);
        }
      }
    }
  }
  const visited = new Uint8Array(records.length),
    turnOrder = new Int32Array(records.length);
  visited[selectedIndex] = 1;
  for (let i = 0; i < records.length; i++) {
    let selected = -1,
      time = 0x7fffffff;
    for (let j = 0; j < records.length; j++) {
      if (visited[j] !== 0) continue;
      const record = records[j]!;
      if (record.id === 0) {
        visited[j] = 1;
        continue;
      }
      const candidate = (record.word(0x6c) + record.word(0x4b)) | 0;
      if (candidate < time) {
        selected = j;
        time = candidate;
      }
    }
    turnOrder[i] = selected;
    if (selected < 0) break;
    visited[selected] = 1;
  }
  return {jobs, turnOrder};
}
