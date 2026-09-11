import type {Sc3Runtime} from './runtime.js';
/** 14005f6c0 and 14005f0e0: group-list collection, cutoff and native swap sort. */
export function sceneDrawContexts(vm: Pick<Sc3Runtime, 'state' | 'context'>): DataView[] {
  const s = vm.state,
    out: DataView[] = [],
    cutoff = s.get(0x17ac228),
    nativeBase = 0x140000000,
    pool = 0x17a2f00;
  for (let group = 0; group < 12; group++) {
    if (!(s.get(0x17ab880 + group * 4) & 0x20000000)) continue;
    const head = 0x17a0dd0 + group * 0x2c0,
      tail = head + 0x160;
    let address = Number(s.view(head + 0x148, 8).getBigUint64(0, true)) - nativeBase;
    for (let count = 0; address !== tail; count++) {
      const id = (address - pool) / 0x160;
      if (count >= 100 || !Number.isInteger(id) || id < 0 || id >= 100)
        throw new Error('Invalid scene context group list');
      const c = vm.context(id);
      if (c.getUint32(0, true) & 0x20000000 && (!cutoff || cutoff <= c.getInt32(0x80, true)))
        out.push(c);
      address = Number(c.getBigUint64(0x148, true)) - nativeBase;
    }
  }
  for (let i = 0; i < out.length; i++)
    for (let j = i + 1; j < out.length; j++)
      if (out[j]!.getInt32(0x80, true) < out[i]!.getInt32(0x80, true))
        [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
}
