import type {OpcodeExecution} from './types.js';

interface WaveTable {
  readonly count: number;
  readonly records: number;
}

const primary: WaveTable = {count: 0x545654, records: 0x54d270};
const secondary: WaveTable = {count: 0x56ce4c, records: 0x56ce50};
const overlay: WaveTable = {count: 0x545224, records: 0x5494e0};

function values(h: OpcodeExecution): number[] {
  const first = h.expression(),
    second = h.expression(),
    third = h.expression(),
    fourth = h.expression(),
    fifth = h.expression();
  // 14005b4b0 evaluates initial phase before temporal step, but stores the
  // native record as mask, amplitude, temporal step, phase, spatial step.
  return [first, second, fourth, third, fifth];
}

function append(h: OpcodeExecution, table: WaveTable): void {
  const record = values(h),
    index = h.state.get(table.count);
  for (let field = 0; field < record.length; field++)
    h.state.put(table.records + index * 20 + field * 4, record[field]!);
  // The assembly publishes the increment after all five fields. This is
  // observable for the native signed index -1, whose last field aliases count.
  h.state.put(table.count, index + 1);
}

function update(h: OpcodeExecution, table: WaveTable): void {
  const index = h.expression(),
    record = values(h);
  for (let field = 0; field < record.length; field++)
    if (record[field]! >= 0) h.state.put(table.records + index * 20 + field * 4, record[field]!);
}

/** 10/30, 14005b4b0: configure the three native scene-wave parameter tables. */
export function sceneWave(h: OpcodeExecution): void {
  h.skip(2);
  switch (h.byte()) {
    case 0:
      h.state.put(primary.count, 0);
      break;
    case 1:
      append(h, primary);
      break;
    case 2:
      h.state.put(secondary.count, 0);
      break;
    case 3:
      append(h, secondary);
      break;
    case 4:
      update(h, primary);
      break;
    case 5:
      update(h, secondary);
      break;
    case 10:
      h.state.put(overlay.count, 0);
      break;
    case 11:
      append(h, overlay);
      break;
    case 12:
      update(h, overlay);
      break;
    // Selectors 6-9 and every value above 12 consume only the selector byte.
  }
}
