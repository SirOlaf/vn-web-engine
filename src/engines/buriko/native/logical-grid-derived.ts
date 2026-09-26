import {pointerView} from '../bp/memory.js';
import type {BurikoBpPointer} from '../bp/memory.js';
import {BurikoLogicalGridVisibility} from './logical-grid-visibility.js';
import {gridAllocation, gridOutput, gridRead} from './logical-grid-path.js';
import {sameGridAbilityRequest} from './logical-grid.js';
import type {BurikoLogicalGridManager} from './logical-grid.js';

/** 14009e610: build each distinct five-DWORD ability's directional reachability maps. */
export function buildGridAbilityMaps(
  manager: BurikoLogicalGridManager,
  agentId: number,
  maximumClimb: number,
  budget: number,
  requestCount: number,
  requests: BurikoBpPointer | null,
  stampAgents: number,
  extendedMovement: number,
): number {
  const agent = manager.agent(agentId);
  if (agent === undefined) return 0x80000003;
  agent.abilityMaps.length = 0;
  budget |= 0;
  const doubledBudget = (budget * 2) | 0;
  manager.search(
    agentId,
    maximumClimb,
    extendedMovement === 0 ? budget : doubledBudget,
    -1,
    -1,
    stampAgents !== 0,
  );
  const {width, height} = manager.dimensions();
  const positions = gridAllocation(width, height, 8, true);
  const visiblePositions = gridAllocation(width, height, 8, true);
  // The native cache is a zeroed pointer array accompanied by DWORD counts.
  gridAllocation(width, height, 8, true);
  const areaCounts = gridAllocation(width, height, 4, true);
  const ordinary = gridAllocation(width, height, 28, true);
  const extended = gridAllocation(width, height, 28, true);
  const temporary = new Uint8Array(12),
    countOutput = {bytes: temporary, offset: 0},
    visibleCount = {bytes: temporary, offset: 4},
    costOutput = {bytes: temporary, offset: 8},
    values = new DataView(temporary.buffer);
  if (manager.copyReachable({bytes: positions, offset: 8}, countOutput, agentId) !== 0)
    throw new Error('Buriko logical-grid ability map reads uninitialized reachable count');
  const length = (values.getUint32(0, true) + 1) >>> 0;
  gridOutput({bytes: positions, offset: 0}, agent.x);
  gridOutput({bytes: positions, offset: 0}, agent.y, 4);
  const visibility = new BurikoLogicalGridVisibility(manager);
  for (let requestIndex = 0; requestIndex < requestCount >>> 0; requestIndex++) {
    const request =
      requests === null
        ? null
        : {bytes: requests.bytes, offset: requests.offset + requestIndex * 20};
    if (agent.abilityMaps.some((entry) => sameGridAbilityRequest(request, entry.request))) continue;
    ordinary.fill(0);
    extended.fill(0);
    areaCounts.fill(0);
    const areas = new Map<number, Uint8Array>();
    const parameter = (word: number): number => {
      if (request === null) throw new Error('Buriko logical-grid ability map null request');
      return pointerView({bytes: request.bytes, offset: request.offset + word * 4}, 4).getInt32(
        0,
        true,
      );
    };
    for (let positionIndex = 0; positionIndex < length; positionIndex++) {
      const position = pointerView({bytes: positions, offset: positionIndex * 8}, 8),
        x = position.getInt32(0, true),
        y = position.getInt32(4, true);
      if (manager.copyMetric(costOutput, agentId, x, y) !== 0)
        throw new Error('Buriko logical-grid ability map reads uninitialized movement cost');
      const cost = values.getInt32(8, true);
      if (!(
        cost <= budget ||
        (extendedMovement !== 0 && parameter(0) === 0 && cost <= doubledBudget)
      ))
        continue;
      const selected = cost <= budget ? ordinary : extended;
      // The allocated grid and native reachable coordinates make this call initialize its count.
      const status = visibility.collect(
        {bytes: visiblePositions, offset: 0},
        null,
        visibleCount,
        x,
        y,
        parameter(1),
        parameter(2),
        parameter(3),
        0,
        Number(stampAgents === 0),
        true,
      );
      if (status !== 0)
        throw new Error('Buriko logical-grid ability map reads uninitialized visible count');
      for (let visibleIndex = 0; visibleIndex < values.getUint32(4, true); visibleIndex++) {
        const point = pointerView({bytes: visiblePositions, offset: visibleIndex * 8}, 8),
          hitX = point.getInt32(0, true),
          hitY = point.getInt32(4, true),
          hitIndex = manager.index(hitX, hitY),
          areaRange = parameter(4);
        if (areaRange === 0) {
          incrementDirection(selected, hitIndex, manager.directionBetween(x, y, hitX, hitY));
        } else if (areaRange > 0) {
          let area = areas.get(hitIndex);
          if (area === undefined) {
            area = gridAllocation(width, height, 8, true);
            areas.set(hitIndex, area);
            visibility.collect(
              {bytes: area, offset: 0},
              null,
              {bytes: areaCounts, offset: hitIndex * 4},
              hitX,
              hitY,
              areaRange,
              0,
              0,
              0,
              0,
              true,
            );
          }
          const count = pointerView({bytes: areaCounts, offset: hitIndex * 4}, 4).getUint32(
            0,
            true,
          );
          for (let areaIndex = 0; areaIndex < count; areaIndex++) {
            const point = pointerView({bytes: area, offset: areaIndex * 8}, 8),
              targetX = point.getInt32(0, true),
              targetY = point.getInt32(4, true),
              direction =
                targetX === hitX && targetY === hitY
                  ? manager.directionBetween(x, y, hitX, hitY)
                  : manager.directionBetween(hitX, hitY, targetX, targetY);
            incrementDirection(selected, manager.index(targetX, targetY), direction);
          }
        }
      }
    }
    const requestBytes = gridRead(request, 20),
      copiedOrdinary = gridAllocation(width, height, 28, true);
    copiedOrdinary.set(ordinary);
    const copiedExtended =
      extendedMovement !== 0 && parameter(0) === 0 ? gridAllocation(width, height, 28, true) : null;
    if (copiedExtended !== null) copiedExtended.set(extended);
    agent.abilityMaps.push({
      request: requestBytes,
      ordinary: copiedOrdinary,
      extended: copiedExtended,
    });
  }
  return 0;
}

function incrementDirection(bytes: Uint8Array, cell: number, direction: number): void {
  const counterOffset = cell * 28 + ((direction - 2) >>> 0) * 4 + 4,
    counter = pointerView({bytes, offset: counterOffset}, 4);
  counter.setInt32(0, (counter.getInt32(0, true) + 1) | 0, true);
  gridOutput({bytes, offset: cell * 28}, 1);
}
