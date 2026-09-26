import {pointerView} from '../bp/memory.js';
import {gridAllocation} from './logical-grid-path.js';
import {BurikoLogicalGridVisibility} from './logical-grid-visibility.js';
import {buildGridAbilityMaps} from './logical-grid-derived.js';
import {
  gridEvaluatorAbilityRequest,
  gridEvaluatorAffinity,
  gridEvaluatorEffect,
  gridEvaluatorFacing,
  gridEvaluatorModifiers,
} from './grid-evaluator-math.js';
import type {BurikoLogicalGridManager} from './logical-grid.js';
import type {
  BurikoGridEvaluatorRecord,
  BurikoGridEvaluatorRecords,
} from './grid-evaluator-records.js';

const add = (a: number, b: number): number => (a + b) | 0;
const subtract = (a: number, b: number): number => (a - b) | 0;
const multiply = Math.imul;
const percent = (value: number, rate: number): number => Math.trunc(multiply(value, rate) / 100);

/** 1400a5670: one atomic native work callback after claiming a 0x4c-byte candidate. */
export function simulateGridEvaluation(
  state: BurikoGridEvaluatorRecords,
  grid: BurikoLogicalGridManager,
  selectedIndex: number,
  job: DataView,
  initialOrder: Int32Array,
): void {
  const records = state.records.map((record) => record.copy()),
    actor = records[selectedIndex];
  if (actor === undefined)
    throw new Error('Buriko grid simulation selected actor outside allocation');
  const record = (index: number): BurikoGridEvaluatorRecord => {
    const result = records[index];
    if (result === undefined) throw new Error('Buriko grid simulation actor outside allocation');
    return result;
  };
  const j = (word: number): number => job.getInt32(word * 4, true),
    setJ = (word: number, value: number): void => job.setInt32(word * 4, value, true),
    scratch = new Uint8Array(128),
    values = new DataView(scratch.buffer),
    pointer = (offset = 0) => ({bytes: scratch, offset}),
    visibility = new BurikoLogicalGridVisibility(grid),
    order = new Int32Array(128),
    orderAt = (index: number): number => {
      if (index < 0 || index >= order.length)
        throw new Error('Buriko grid simulation turn list exceeds native stack allocation');
      return order[index]!;
    },
    find = (x: number, y: number): BurikoGridEvaluatorRecord => {
      const result = state.findPosition(x, y, records);
      if (result === null) throw new Error('Buriko grid simulation dereferences missing target');
      return result;
    };
  order.set(initialOrder);
  const opponent = actor.word(3) < 0 ? null : record(actor.word(3));
  actor.setWord(0x20d, j(0));
  actor.setWord(0x20e, j(1));
  for (const entry of records) if (entry.id !== 0) grid.setPosition(entry.id, entry.x, entry.y);
  const modifiers = (
    source: BurikoGridEvaluatorRecord,
    target: BurikoGridEvaluatorRecord | null,
    type: number,
  ): void => {
    gridEvaluatorModifiers(pointer(), type, source.pointer(), target?.pointer() ?? null);
  };
  const facing = (target: BurikoGridEvaluatorRecord, x: number, y: number): number => {
    if (grid.facingAngle(pointer(8), x, y, target.id) !== 0)
      throw new Error('Buriko grid simulation reads uninitialized facing angle');
    return gridEvaluatorFacing(values.getInt32(8, true), state.facingMultiplier);
  };
  const effect = (
    source: BurikoGridEvaluatorRecord,
    target: BurikoGridEvaluatorRecord,
    type: number,
    additions: number,
    orientation: number,
  ): number => {
    const affinity = gridEvaluatorAffinity(
      source.word(2),
      target.word(2),
      state.typeCount,
      state.weights,
    );
    gridEvaluatorEffect(
      pointer(12),
      type,
      source.pointer(0x2c),
      source.pointer(additions * 4),
      values.getInt32(0, true),
      target.pointer(0x2c),
      values.getInt32(4, true),
      affinity,
      orientation,
    );
    return values.getInt32(12, true);
  };
  const ordinaryAttack = (
    source: BurikoGridEvaluatorRecord,
    target: BurikoGridEvaluatorRecord,
    x: number,
    y: number,
  ): number => {
    modifiers(source, target, source.word(0x98));
    return effect(source, target, source.word(0x98), 0x99, facing(target, x, y));
  };
  let duration = j(11),
    score = 0,
    lockedDirection = -1;
  if (j(2) === 0) {
    duration = add(duration, actor.word(0x93));
    score = actor.word(0x94);
  } else if (j(2) === 6) {
    const target = find(j(4), j(5)),
      oldHealth = target.word(7);
    const damage = Math.min(oldHealth, ordinaryAttack(actor, target, j(0), j(1)));
    target.setWord(7, subtract(oldHealth, damage));
    duration = add(add(duration, actor.word(0x9d)), j(9) !== 0 ? actor.word(0x9e) : 0);
    score = add(
      add(multiply(actor.word(0xa0), damage), actor.word(0x9f)),
      target.word(7) < 1 ? actor.word(0xa1) : 0,
    );
    lockedDirection = grid.directionBetween(j(4), j(5), j(0), j(1)) - 2;
  } else if (j(2) === 7) {
    const ability = j(3),
      offset = ability * 0x16,
      areaRange = actor.word(0xba + offset),
      type = actor.word(0xae + offset),
      positions = new Uint8Array(512);
    let count = 0;
    if (areaRange < 0) score = actor.word(0x9f);
    else {
      if (areaRange === 0) {
        const view = new DataView(positions.buffer);
        view.setInt32(0, j(4), true);
        view.setInt32(4, j(5), true);
        count = 1;
      } else {
        visibility.collect(
          {bytes: positions, offset: 0},
          null,
          pointer(16),
          j(4),
          j(5),
          areaRange,
          0,
          0,
          1,
          0,
          j(4) !== j(0) || j(5) !== j(1),
        );
        count = values.getUint32(16, true);
      }
      for (let i = 0; i < count; i++) {
        const position = pointerView({bytes: positions, offset: i * 8}, 8),
          x = position.getInt32(0, true),
          y = position.getInt32(4, true),
          target = find(x, y),
          effectType = actor.word(0xb0 + offset);
        modifiers(actor, target, effectType);
        const orientation =
          type === 0
            ? facing(
                target,
                x === j(4) && y === j(5) ? j(0) : j(4),
                x === j(4) && y === j(5) ? j(1) : j(5),
              )
            : 65536;
        let amount = effect(actor, target, effectType, 0xb1 + offset, orientation);
        const scoreOffset = ((actor.word(1) & target.word(1)) !== 0 ? 0xbd : 0xc0) + offset;
        let changedStatus = false;
        if (type === 0) {
          amount = Math.min(target.word(7), amount);
          target.setWord(7, subtract(target.word(7), amount));
          score = add(
            score,
            add(
              add(
                multiply(actor.word(scoreOffset + 1), amount),
                target.word(7) < 1 ? actor.word(scoreOffset + 2) : 0,
              ),
              actor.word(scoreOffset),
            ),
          );
        } else if (type === 1) {
          amount = Math.min(subtract(target.word(8), target.word(7)), amount);
          target.setWord(7, add(target.word(7), amount));
          score = add(
            score,
            add(multiply(actor.word(scoreOffset + 1), amount), actor.word(scoreOffset)),
          );
        } else if (type === 2) {
          const statusIndex = actor.word(0xaf + offset),
            old = target.word(0x4d + statusIndex);
          amount = Math.min(old, amount);
          target.setWord(0x4d + statusIndex, subtract(old, amount));
          changedStatus = true;
          score = add(
            score,
            add(multiply(actor.word(scoreOffset + 1), amount), actor.word(scoreOffset)),
          );
        } else if (type === 3 || type === 4) {
          const statusIndex = actor.word(0xaf + offset);
          target.setWord(0x4d + statusIndex, actor.word(0xb5 + offset));
          target.setWord(0x6d + statusIndex, amount);
          changedStatus = true;
          score = add(
            score,
            add(multiply(actor.word(scoreOffset + 1), amount), actor.word(scoreOffset)),
          );
        }
        if (changedStatus && target.id !== actor.id) {
          const statusIndex = actor.word(0xaf + offset);
          if ((statusIndex - 8) >>> 0 < 2 || statusIndex === 31) {
            modifiers(target, null, 0x100);
            const nextTime = Math.max(
              0,
              add(subtract(target.word(0x6c), values.getInt32(0, true)), target.word(0x4b)),
            );
            if (nextTime !== target.word(0x4b))
              retimeActor(order, state.findId(target, records), nextTime, records);
          }
        }
      }
    }
    duration = add(
      add(duration, actor.word(0xbb + offset)),
      j(9) === 0 ? 0 : actor.word(0xbc + offset),
    );
    lockedDirection = grid.directionBetween(j(4), j(5), j(0), j(1)) - 2;
  }
  score = add(score, multiply(actor.word(0x92), j(9)));
  if (j(10) !== 0)
    score = add(
      score,
      multiply(
        actor.word(0xac),
        j(10) < 0 ? add(grid.dimensions().width, grid.dimensions().height) : j(10),
      ),
    );
  let followAttack = false;
  if (j(12) !== 0) {
    score = add(score, add(multiply(multiply(actor.word(5), j(9)), j(9)), actor.word(4)));
    followAttack = j(2) === 0 && actor.word(0x95) === 1;
  }
  actor.setWord(0x4b, duration);
  modifiers(actor, null, 0x100);
  const finishTime = add(duration, subtract(actor.word(0x6c), values.getInt32(0, true))),
    directionalScores = new Int32Array(4),
    health = new Int32Array(4).fill(actor.word(7)),
    {width, height} = grid.dimensions(),
    computed = gridAllocation(width, height, 28),
    cellIndex = grid.index(j(0), j(1)),
    abilityRequest = pointer(32),
    attackDirections = new Int32Array(4),
    abilityDirections = Array.from({length: 16}, () => new Int32Array(4));
  const mapValue = (
    entry: BurikoGridEvaluatorRecord,
    ability: number,
    extended: boolean,
    cell: number,
    lane = 0,
  ): number => {
    const map = entry.map(ability, extended);
    if (map === null) throw new Error('Buriko grid simulation dereferences null precomputed map');
    return pointerView({bytes: map, offset: cell * 28 + lane * 4}, 4).getInt32(0, true);
  };
  const recompute = (entry: BurikoGridEvaluatorRecord, ability: number): void => {
    gridEvaluatorAbilityRequest(abilityRequest, entry.pointer(), ability);
    buildGridAbilityMaps(
      grid,
      entry.id,
      entry.word(0x8d),
      entry.word(0x8e),
      1,
      abilityRequest,
      1,
      0,
    );
    grid.copyAbilityMap({bytes: computed, offset: 0}, entry.id, abilityRequest, 0);
  };
  const adjacentFacing = (target: BurikoGridEvaluatorRecord, direction: number): number => {
    if (grid.copyAdjacentPosition(pointer(64), target.id, direction, true) !== 0)
      throw new Error('Buriko grid simulation reads uninitialized adjacent position');
    return facing(target, values.getInt32(64, true), values.getInt32(68, true));
  };
  for (let cursor = 0; orderAt(cursor) >= 0; cursor++) {
    const currentIndex = orderAt(cursor),
      current = record(currentIndex);
    if (current.word(7) <= 0) continue;
    if (
      finishTime < current.word(0x4b) ||
      (finishTime === current.word(0x4b) && selectedIndex < currentIndex)
    )
      break;
    if ((actor.word(1) & current.word(1)) === 0) {
      const moved = current.word(0x214) !== 0,
        active = new Int32Array(16);
      let attack = false;
      if (mapValue(current, 0, moved, cellIndex) !== 0) {
        recompute(current, 0);
        attack = selectGridThreatDirections(
          state,
          attackDirections,
          computed,
          cellIndex,
          lockedDirection,
        );
      }
      let any = attack;
      for (let ability = 0; ability < 16; ability++) {
        const offset = ability * 0x16;
        if (
          current.word(0xad + offset) !== 0 &&
          mapValue(current, ability + 1, moved, cellIndex) !== 0
        ) {
          recompute(current, ability + 1);
          if (current.word(0xae + offset) === 0)
            active[ability] = Number(
              selectGridThreatDirections(
                state,
                abilityDirections[ability]!,
                computed,
                cellIndex,
                lockedDirection,
              ),
            );
          else if (current.word(0xae + offset) === 4)
            active[ability] = pointerView({bytes: computed, offset: cellIndex * 28}, 4).getInt32(
              0,
              true,
            );
          if (active[ability] !== 0) any = true;
        }
      }
      const probability = !moved
        ? 100
        : actor.word(0xab) === 0
          ? state.fallbackMovedPercent
          : actor.word(0xab);
      for (let direction = 0; direction < 4; direction++) {
        if (lockedDirection >= 0 && lockedDirection !== direction) continue;
        grid.setDirection(actor.id, direction + 2);
        if (attack) {
          const oldHealth = health[direction]!;
          modifiers(current, actor, current.word(0x98));
          const damage = effect(
            current,
            actor,
            current.word(0x98),
            0x99,
            adjacentFacing(actor, attackDirections[direction]!),
          );
          health[direction] = subtract(oldHealth, damage);
          const death = health[direction]! < 1 && oldHealth > 0 ? actor.word(0xa4) : 0;
          directionalScores[direction] = add(
            directionalScores[direction]!,
            percent(
              add(add(multiply(actor.word(0xa3), damage), actor.word(0xa2)), death),
              probability,
            ),
          );
        }
        for (let ability = 0; ability < 16; ability++) {
          if (active[ability] === 0) continue;
          const offset = ability * 0x16,
            type = current.word(0xae + offset),
            effectType = current.word(0xb0 + offset);
          if (type === 0) {
            const oldHealth = health[direction]!;
            modifiers(current, actor, effectType);
            const damage = effect(
              current,
              actor,
              effectType,
              0xb1 + offset,
              adjacentFacing(actor, abilityDirections[ability]![direction]!),
            );
            health[direction] = subtract(oldHealth, damage);
            const death = health[direction]! < 1 && oldHealth > 0 ? actor.word(0xa7) : 0;
            directionalScores[direction] = add(
              directionalScores[direction]!,
              percent(
                add(add(multiply(actor.word(0xa6), damage), actor.word(0xa5)), death),
                probability,
              ),
            );
          } else if (type === 4) {
            modifiers(current, actor, effectType);
            const amount = effect(current, actor, effectType, 0xb1 + offset, 65536),
              statusIndex = current.word(0xaf + offset);
            actor.setWord(0x4d + statusIndex, current.word(0xb5 + offset));
            actor.setWord(0x6d + statusIndex, amount);
            directionalScores[direction] = add(
              directionalScores[direction]!,
              percent(add(multiply(actor.word(0xa9), amount), actor.word(0xa8)), probability),
            );
          }
        }
      }
      if (!any && !moved) {
        const nextTime = add(
          add(
            multiply(multiply(current.word(0x8e), 3) >> 2, current.word(0x90)),
            current.word(0x8f),
          ),
          current.word(0x4b),
        );
        current.setWord(0x4b, nextTime);
        insertActorLater(order, cursor, nextTime, records);
        current.setWord(0x214, 1);
        if (current.word(3) >= 0) {
          current.setWord(0x20d, current.word(0x212));
          current.setWord(0x20e, current.word(0x213));
        }
      }
      if (j(2) === 0 && any && j(7) < 0) {
        const counts = new Uint32Array(4);
        for (let direction = 0; direction < 4; direction++) {
          counts[direction] = mapValue(current, 0, moved, cellIndex, direction + 1);
          for (let ability = 0; ability < 16; ability++) {
            if (active[ability] !== 0 && current.word(0xae + ability * 0x16) === 0)
              counts[direction] =
                (counts[direction]! +
                  mapValue(current, ability + 1, moved, cellIndex, direction + 1)) >>>
                0;
          }
        }
        const maximum = Math.max(...counts),
          matching = [...counts].map((value) => value === maximum);
        let preferred = matching.lastIndexOf(true);
        if (matching.filter(Boolean).length !== 1) {
          const toward = grid.directionBetween(current.x, current.y, j(0), j(1)) - 2;
          if (matching[toward]) preferred = toward;
        }
        setJ(7, preferred);
      }
    } else if (opponent !== null) {
      const targetCell = grid.index(opponent.x, opponent.y);
      if (mapValue(current, 0, false, targetCell) !== 0) {
        recompute(current, 0);
        if (
          selectGridThreatDirections(
            state,
            attackDirections,
            computed,
            targetCell,
            opponent.word(0x20f),
          )
        ) {
          const oldHealth = opponent.word(7);
          modifiers(current, opponent, current.word(0x98));
          const direction = opponent.word(0x20f);
          if (direction < 0 || direction >= attackDirections.length)
            throw new Error('Buriko grid simulation cached direction outside stack array');
          let damage = effect(
            current,
            opponent,
            current.word(0x98),
            0x99,
            adjacentFacing(opponent, attackDirections[direction]!),
          );
          if (opponent.word(7) < damage) damage = oldHealth > 0 ? opponent.word(7) : 0;
          opponent.setWord(7, subtract(opponent.word(7), damage));
          score = add(
            score,
            add(
              add(multiply(actor.word(0xa0), damage), actor.word(0x9f)),
              opponent.word(7) < 1 && oldHealth > 0 ? actor.word(0xa1) : 0,
            ),
          );
        }
      }
    }
  }
  if (followAttack) {
    if (opponent === null)
      throw new Error('Buriko grid simulation follow-up attack dereferences null opponent');
    grid.search(actor.id, actor.word(0x8d), actor.word(0x8e), -1, -1, true);
    const steps = pointer(64),
      coordinates = new Uint8Array(48);
    grid.copyNeighborPaths(
      steps,
      {bytes: coordinates, offset: 0},
      actor.id,
      opponent.x,
      opponent.y,
    );
    let maximum = -0x80000000;
    for (let direction = 0; direction < 4; direction++) {
      if (values.getInt32(64 + direction * 4, true) < 0) continue;
      const position = pointerView({bytes: coordinates, offset: direction * 8}, 8),
        oldHealth = opponent.word(7);
      let damage = ordinaryAttack(
        actor,
        opponent,
        position.getInt32(0, true),
        position.getInt32(4, true),
      );
      if (opponent.word(7) < damage) damage = oldHealth > 0 ? opponent.word(7) : 0;
      opponent.setWord(7, subtract(opponent.word(7), damage));
      maximum = Math.max(
        maximum,
        add(
          add(multiply(actor.word(0xa0), damage), actor.word(0x9f)),
          opponent.word(7) < 1 && oldHealth > 0 ? actor.word(0xa1) : 0,
        ),
      );
    }
    if (maximum !== -0x80000000) score = add(score, percent(maximum, state.fallbackAttackPercent));
  }
  for (let direction = 0; direction < 4; direction++)
    if (lockedDirection < 0 || lockedDirection === direction)
      setJ(13 + direction, add(directionalScores[direction]!, score));
}

/** 1400a5580 uses the grid's direction-priority permutation for each allowed facing. */
function selectGridThreatDirections(
  state: BurikoGridEvaluatorRecords,
  output: Int32Array,
  map: Uint8Array,
  cell: number,
  selected: number,
): boolean {
  const view = pointerView({bytes: map, offset: cell * 28}, 28);
  if (view.getInt32(0, true) === 0) return false;
  const bytes = new Uint8Array(32),
    order = new DataView(bytes.buffer),
    grid = state.requireGrid();
  for (let direction = 0; direction < 4; direction++) {
    if (selected >= 0 && selected !== direction) continue;
    grid.directionOrder({bytes, offset: 0}, direction, true);
    for (let i = 0; i < 4; i++) {
      const candidate = order.getUint32(i * 4, true);
      if (view.getInt32((candidate + 1) * 4, true) !== 0) {
        output[direction] = candidate;
        break;
      }
    }
  }
  return true;
}

/** 1400a5cxx moves the affected actor with two native memcpy operations over a temporary list. */
function retimeActor(
  order: Int32Array,
  actor: number,
  time: number,
  records: BurikoGridEvaluatorRecord[],
): void {
  let shift = 0,
    start = -1,
    end = -1,
    cursor = 0;
  for (; cursor < order.length && order[cursor]! >= 0; cursor++) {
    const current = order[cursor]!;
    if (current === actor) {
      if (start >= 0) {
        end = cursor - 1;
        break;
      }
      shift = -1;
      start = cursor + 1;
    } else if (shift < 1) {
      const record = records[current];
      if (record === undefined)
        throw new Error('Buriko grid simulation retiming actor outside allocation');
      if (time < record.word(0x4b)) {
        if (start >= 0) {
          end = cursor - 1;
          break;
        }
        shift = 1;
        start = cursor;
      }
    }
  }
  if (cursor >= order.length)
    throw new Error('Buriko grid simulation retiming reads beyond native stack list');
  if (start === end) return;
  const last = end >= 0 ? end : cursor - 1,
    copy = order.slice(0, cursor + 1),
    insertion = shift === 1 ? start : last,
    count = last - start + 1;
  if (insertion < 0 || insertion >= copy.length || shift + start < 0 || count < 0)
    throw new Error('Buriko grid simulation retiming uses invalid native copy range');
  copy[insertion] = actor;
  copy.set(order.subarray(start, start + count), shift + start);
  order.set(copy);
}

/** 1400a659f inserts a second occurrence after the already processed slot, including the sentinel. */
function insertActorLater(
  order: Int32Array,
  cursor: number,
  time: number,
  records: BurikoGridEvaluatorRecord[],
): void {
  const actor = order[cursor];
  if (actor === undefined) throw new Error('Buriko grid simulation reads beyond native turn list');
  let insertion = 0,
    end = cursor + 1;
  for (; end < order.length && order[end]! >= 0; end++) {
    const entry = records[order[end]!];
    if (entry === undefined) throw new Error('Buriko grid simulation actor outside allocation');
    if (insertion === 0 && time < entry.word(0x4b)) insertion = end;
  }
  if (end + 1 >= order.length)
    throw new Error('Buriko grid simulation reinsertion exceeds native turn list');
  if (insertion === 0) insertion = end;
  for (let index = end; index >= insertion; index--) order[index + 1] = order[index]!;
  order[insertion] = actor;
}
