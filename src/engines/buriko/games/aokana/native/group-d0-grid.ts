import {pop32, push32} from '../bp/state.js';
import {aokanaLogicalStatus} from './logical-status.js';
import {gridOutput} from './logical-grid-path.js';
import type {AokanaLogicalGridManager, AokanaLogicalGridManagers} from './logical-grid.js';
import {AokanaLogicalGridVisibility} from './logical-grid-visibility.js';
import type {
  AokanaBpOpcodeContext,
  AokanaBpOpcodeHandler,
  AokanaNativeSlotDefinition,
} from './types.js';

/** DCTELgclGrdFldMngr's complete 19 direct native wrappers. */
export function createGroupD0Grid(
  managers: AokanaLogicalGridManagers,
): AokanaNativeSlotDefinition[] {
  const pointer = (h: AokanaBpOpcodeContext) => h.memory.resolve(h.thread, pop32(h.thread));
  const use = (id: number, operation: (manager: AokanaLogicalGridManager) => number) => {
    const manager = managers.get(id);
    return aokanaLogicalStatus(manager === undefined ? 0x80000000 : operation(manager));
  };
  const entries: [number, number, string, AokanaBpOpcodeHandler][] = [
    [
      0x00,
      0x1400d3e60,
      'CreateLogicalGrid',
      (h) => {
        const divisor = pop32(h.thread),
          kind = pop32(h.thread),
          output = pointer(h);
        push32(h.thread, managers.create(output, kind, divisor));
        return 0;
      },
    ],
    [
      0x01,
      0x1400d3e30,
      'DestroyLogicalGrid',
      (h) => {
        push32(h.thread, managers.destroy(pop32(h.thread)));
        return 0;
      },
    ],
    [
      0x04,
      0x1400d3dd0,
      'SetLogicalGridCells',
      (h) => {
        const cells = pointer(h),
          height = pop32(h.thread),
          width = pop32(h.thread),
          id = pop32(h.thread);
        push32(
          h.thread,
          use(id, (manager) => manager.setCells(width, height, cells)),
        );
        return 0;
      },
    ],
    [
      0x05,
      0x1400d3d70,
      'AddLogicalGridCostPlane',
      (h) => {
        const cells = pointer(h),
          id = pop32(h.thread),
          output = pointer(h);
        push32(
          h.thread,
          use(id, (manager) => manager.addCostPlane(output, cells)),
        );
        return 0;
      },
    ],
    [
      0x10,
      0x1400d3d20,
      'CreateLogicalGridAgent',
      (h) => {
        const id = pop32(h.thread),
          output = pointer(h);
        push32(
          h.thread,
          use(id, (manager) => manager.createAgent(output)),
        );
        return 0;
      },
    ],
    [
      0x11,
      0x1400d3ce0,
      'RemoveLogicalGridAgent',
      (h) => {
        const agent = pop32(h.thread),
          id = pop32(h.thread);
        push32(
          h.thread,
          use(id, (manager) => manager.removeAgent(agent)),
        );
        return 0;
      },
    ],
    [
      0x12,
      0x1400d3ca0,
      'ClearLogicalGridPath',
      (h) => {
        const agent = pop32(h.thread),
          id = pop32(h.thread);
        push32(
          h.thread,
          use(id, (manager) => manager.clearPath(agent)),
        );
        return 0;
      },
    ],
    [
      0x14,
      0x1400d3c50,
      'SetLogicalGridAgentPosition',
      (h) => {
        const y = pop32(h.thread),
          x = pop32(h.thread),
          agent = pop32(h.thread),
          id = pop32(h.thread);
        push32(
          h.thread,
          use(id, (manager) => manager.setPosition(agent, x, y)),
        );
        return 0;
      },
    ],
    [
      0x15,
      0x1400d3c00,
      'SetLogicalGridAgentSize',
      (h) => {
        const width = pop32(h.thread),
          height = pop32(h.thread),
          agent = pop32(h.thread),
          id = pop32(h.thread);
        push32(
          h.thread,
          use(id, (manager) => manager.setSize(agent, height, width)),
        );
        return 0;
      },
    ],
    [
      0x16,
      0x1400d3bb0,
      'SetLogicalGridAgentMasks',
      (h) => {
        const masks = pointer(h),
          agent = pop32(h.thread),
          id = pop32(h.thread);
        push32(
          h.thread,
          use(id, (manager) => manager.setMasks(agent, masks)),
        );
        return 0;
      },
    ],
    [
      0x17,
      0x1400d3b60,
      'SelectLogicalGridCostPlane',
      (h) => {
        const plane = pop32(h.thread),
          agent = pop32(h.thread),
          id = pop32(h.thread);
        push32(
          h.thread,
          use(id, (manager) => manager.selectCostPlane(agent, plane)),
        );
        return 0;
      },
    ],
    [
      0x18,
      0x1400d3b10,
      'SetLogicalGridAgentDirection',
      (h) => {
        const direction = pop32(h.thread),
          agent = pop32(h.thread),
          id = pop32(h.thread);
        push32(
          h.thread,
          use(id, (manager) => manager.setDirection(agent, direction)),
        );
        return 0;
      },
    ],
    [
      0x20,
      0x1400d3a90,
      'SearchLogicalGrid',
      (h) => {
        const targetY = pop32(h.thread),
          targetX = pop32(h.thread),
          budget = pop32(h.thread),
          maximumClimb = pop32(h.thread),
          agent = pop32(h.thread),
          id = pop32(h.thread);
        push32(
          h.thread,
          use(id, (manager) => manager.search(agent, maximumClimb, budget, targetX, targetY)),
        );
        return 0;
      },
    ],
    [
      0x21,
      0x1400d39f0,
      'CopyLogicalGridRoute',
      (h) => {
        const y = pop32(h.thread),
          x = pop32(h.thread),
          agent = pop32(h.thread),
          id = pop32(h.thread),
          count = pointer(h),
          output = pointer(h);
        push32(
          h.thread,
          use(id, (manager) => manager.copyRoute(output, count, agent, x, y)),
        );
        return 0;
      },
    ],
    [
      0x22,
      0x1400d3990,
      'CopyLogicalGridSearchRecords',
      (h) => {
        const agent = pop32(h.thread),
          id = pop32(h.thread),
          output = pointer(h);
        push32(
          h.thread,
          use(id, (manager) => manager.copyResults(output, agent)),
        );
        return 0;
      },
    ],
    [
      0x23,
      0x1400d3910,
      'CopyLogicalGridReachableCells',
      (h) => {
        const agent = pop32(h.thread),
          id = pop32(h.thread),
          count = pointer(h),
          output = pointer(h);
        push32(
          h.thread,
          use(id, (manager) => manager.copyReachable(output, count, agent)),
        );
        return 0;
      },
    ],
    [
      0x28,
      0x1400d3800,
      'CollectLogicalGridVisibleCells',
      (h) => {
        const ignoreAgents = pop32(h.thread),
          onlyAgents = pop32(h.thread),
          curvature = pop32(h.thread),
          heightFactor = pop32(h.thread),
          range = pop32(h.thread),
          y = pop32(h.thread),
          x = pop32(h.thread),
          id = pop32(h.thread),
          count = pointer(h),
          distances = pointer(h),
          output = pointer(h);
        push32(
          h.thread,
          use(id, (manager) =>
            new AokanaLogicalGridVisibility(manager).collect(
              output,
              distances,
              count,
              x,
              y,
              range,
              heightFactor,
              curvature,
              onlyAgents,
              ignoreAgents,
            ),
          ),
        );
        return 0;
      },
    ],
    [
      0x2c,
      0x1400d3770,
      'GetLogicalGridFacingAngle',
      (h) => {
        const agent = pop32(h.thread),
          id = pop32(h.thread),
          y = pop32(h.thread),
          x = pop32(h.thread),
          output = pointer(h);
        push32(
          h.thread,
          use(id, (manager) => manager.facingAngle(output, x, y, agent)),
        );
        return 0;
      },
    ],
    [
      0x2d,
      0x1400d36d0,
      'GetLogicalGridDirectionBetween',
      (h) => {
        const targetY = pop32(h.thread),
          targetX = pop32(h.thread),
          y = pop32(h.thread),
          x = pop32(h.thread),
          id = pop32(h.thread),
          output = pointer(h);
        push32(
          h.thread,
          use(id, (manager) => {
            gridOutput(output, manager.directionBetween(x, y, targetX, targetY));
            return 0;
          }),
        );
        return 0;
      },
    ],
  ];
  return entries.map(([secondary, nativeAddress, name, execute]) => ({
    primary: 0xd0,
    secondary,
    nativeAddress,
    name,
    execute,
  }));
}
