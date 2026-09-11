import type {CpkArchive, CpkEntry} from '../../../../formats/cri/cpk.js';

const banks = ['bg.cpk', 'chara.cpk', 'system.cpk', 'script.cpk', 'mes00.cpk', 'mask.cpk'] as const;
const localized: ReadonlyMap<string, string> = new Map([
  ['bg.cpk', 'bg_eng.cpk'],
  ['system.cpk', 'system_eng.cpk'],
  ['mes00.cpk', 'mes01.cpk'],
  ['manual.cpk', 'manual_eng.cpk'],
  ['movie.cpk', 'movie_eng.cpk'],
] as const);

/** The five native CPK selectors at +0x18c are switched together by 00/5e.
 * Codes 10/11 deliberately preserve their previous selector, as Game.exe does. */
export class NoahArchives {
  private selection: 0 | 1 = 0;
  constructor(readonly find: (name: string) => CpkArchive | undefined) {}
  selectLanguage(language: number): void {
    if (language === 0 || language === 1) this.selection = language;
  }
  private names(name: string): readonly string[] {
    const base = name.toLowerCase(),
      languageName = this.selection === 1 ? localized.get(base) : undefined;
    return languageName ? [languageName, base] : [base];
  }
  resolve(name: string): CpkArchive {
    for (const candidate of this.names(name)) {
      const archive = this.find(candidate);
      if (archive) return archive;
    }
    throw new Error(`Missing native archive ${name}`);
  }
  bank(bank: number): CpkArchive {
    const name = banks[bank];
    if (!name) throw new Error(`Unknown native archive bank ${bank}`);
    return this.resolve(name);
  }
  asset(bank: number | string, id: number): {archive: CpkArchive; entry: CpkEntry} {
    const name = typeof bank === 'number' ? banks[bank] : bank;
    if (!name) throw new Error(`Unknown native archive bank ${bank}`);
    let foundArchive = false;
    for (const candidate of this.names(name)) {
      const archive = this.find(candidate);
      foundArchive ||= archive !== undefined;
      const entry = archive?.byId.get(id);
      if (archive && entry) return {archive, entry};
    }
    if (!foundArchive) throw new Error(`Missing native archive ${name}`);
    throw new Error(
      `Missing archive ${typeof bank === 'number' ? `bank ${bank}` : name}, asset ${id}`,
    );
  }
  size(bank: number | string, id: number): number {
    return this.asset(bank, id).entry.size;
  }
  read(bank: number | string, id: number): Promise<Uint8Array> {
    const {archive} = this.asset(bank, id);
    return archive.read(id);
  }
}
