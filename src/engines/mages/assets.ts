import {ascii} from '../../core/binary.js';
import type {CpkArchive, CpkEntry} from '../../formats/cri/cpk.js';
export interface AssetKind {
  name: string;
  mime?: string;
  extension: string;
}
export function identifyAsset(b: Uint8Array): AssetKind {
  const starts = (s: string) => b.length >= s.length && ascii(b, 0, s.length) === s;
  if (starts('\x89PNG\r\n\x1a\n')) return {name: 'PNG image', mime: 'image/png', extension: 'png'};
  if (b.length >= 12 && starts('RIFF') && ascii(b, 8, 4) === 'WEBP')
    return {name: 'WebP image', mime: 'image/webp', extension: 'webp'};
  if (b.length >= 4 && b.subarray(0, 4).every((v, i) => (v & 0x7f) === [72, 67, 65, 0][i]))
    return {name: 'CRI HCA audio', extension: 'hca'};
  if (starts('CRID')) return {name: 'CRI USM movie', extension: 'usm'};
  if (starts('DXBC')) return {name: 'DirectX shader bytecode', extension: 'dxbc'};
  if (starts('SC3\0')) return {name: 'SC3 script bytecode', extension: 'sc3'};
  if (starts('MVL1')) return {name: 'MVL1 character meshes', extension: 'mvl'};
  if (starts('MES\0')) return {name: 'Message data (text decoding pending)', extension: 'mes'};
  return {name: 'Binary asset', extension: 'bin'};
}
/** Generic ordered-overlay resolver. Game-specific routing belongs under `games`. */
export class AssetGroup {
  constructor(readonly mounts: readonly CpkArchive[]) {}
  resolve(id: number): {archive: CpkArchive; entry: CpkEntry} | undefined {
    for (let i = this.mounts.length - 1; i >= 0; i--) {
      const archive = this.mounts[i]!,
        entry = archive.byId.get(id);
      if (entry) return {archive, entry};
    }
    return undefined;
  }
  async read(id: number): Promise<Uint8Array> {
    const result = this.resolve(id);
    if (!result) throw new Error(`Unresolved asset ID ${id}`);
    return result.archive.read(id);
  }
}
